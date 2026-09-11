/**
 * Closing a day, and issuing the documents pinned to it.
 *
 * ---------------------------------------------------------------------------
 * THE TWO WRITES IN THIS SYSTEM THAT ARE NOT MONEY
 * ---------------------------------------------------------------------------
 *
 * `book_day` and `statement` both carry the append-only triggers from 0001 and
 * `corgi_app` holds `SELECT, INSERT` on them and nothing else. So neither of
 * the operations below can be expressed as an edit even by a bug: closing a
 * day twice is a primary-key violation, and correcting a statement is a new
 * row with the next `version`. That is not a convention this module follows,
 * it is a capability the application does not have — `pnpm db:check` proves it
 * by attempting the forbidden thing and asserting refusal.
 *
 * ---------------------------------------------------------------------------
 * WHY BOTH OPERATIONS TAKE A LOCK, AND WHICH ONE
 * ---------------------------------------------------------------------------
 *
 * `closeDay` takes **the same advisory lock `ledger_append()` takes**,
 * `hashtext('ledger_append:' || entity)`. That is the load-bearing detail of
 * this whole track and it is worth being precise about.
 *
 * A watermark is only a freeze if no row can appear below it afterwards.
 * `booking_seq` is drawn from a sequence WHILE HOLDING that lock, so sequence
 * order is commit order (DESIGN §5.3) — but only against holders of the same
 * lock. Reading `MAX(booking_seq)` without taking it could observe 39 while
 * seq 38 is still in flight; 38 would then commit *below* a watermark already
 * published, and the "identical every time" guarantee would fail months later,
 * silently, in a way no test would catch. Taking the lock makes the read
 * mutually exclusive with every append, so the maximum is a true high-water
 * mark at the instant of the close.
 *
 * The watermark is scoped to the entity for the same reason the lock is. In
 * this single-entity build the entity-scoped and global maxima are the same
 * number; in a multi-entity build they are not, and the entity-scoped one is
 * the correct one, because `assert_entry_balanced()` refuses any entry whose
 * lines cross entities and a statement therefore only ever reads rows from its
 * own entity's book. DESIGN §5.3 names the per-entity sequence as the
 * scale-out path; this is the read side of that already being right.
 *
 * `publishStatement` and `reissueStatement` take a second, narrower lock on
 * `(account, period)`, which serialises version numbering the same way
 * `recon_run.run_no` is serialised. The `UNIQUE (account_id, period_start,
 * period_end, version)` constraint is still the guarantee; the lock only makes
 * the common case not fail.
 */

import { entityBookingWatermark, type Sql } from "@/lib/ledger/queries";

import {
  UnknownAccountError,
  contentWatermark,
  listStatementVersions,
  readBookDay,
  readStatementAccount,
  readStatementById,
  renderStatement,
  toPublishedStatement,
} from "./read";
import { STATEMENT_FORMAT, canonicalStatement, statementHash } from "./render";
import type {
  BookDay,
  BusinessDate,
  PublishResult,
  PublishedStatement,
  StatementDocument,
} from "./types";

export class DayNotClosedError extends Error {
  override readonly name = "DayNotClosedError";
  constructor(
    readonly entityId: string,
    readonly businessDate: BusinessDate,
  ) {
    super(
      `business day ${businessDate} is not closed for entity ${entityId}: ` +
        "a statement is a (period, watermark) pair and there is no watermark until the day is closed",
    );
  }
}

export class NotYetPublishedError extends Error {
  override readonly name = "NotYetPublishedError";
  constructor(
    readonly accountId: string,
    readonly businessDate: BusinessDate,
  ) {
    super(
      `no statement has been published for ${accountId} on ${businessDate}; ` +
        "publish v1 at the close watermark before issuing a corrected version",
    );
  }
}

/**
 * The re-render of a published watermark did not reproduce its stored hash.
 *
 * This is a P1, never a number to overwrite. Exactly two things can cause it:
 * a money row below the watermark changed — which the privilege layer, the
 * append-only triggers and the hash chain all separately forbid — or the
 * renderer changed without `STATEMENT_FORMAT` changing with it, which is a
 * deployment bug. Both deserve an exception rather than a fallback.
 */
export class StatementReproductionError extends Error {
  override readonly name = "StatementReproductionError";
  constructor(
    readonly statement: PublishedStatement,
    readonly recomputedHash: string,
  ) {
    super(
      `statement ${statement.statementId} (v${statement.version}, watermark ` +
        `${statement.bookingWatermark}) stored ${statement.contentHash} but re-rendering ` +
        `its own watermark produced ${recomputedHash}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Day close                                                                  */
/* -------------------------------------------------------------------------- */

export interface CloseDayInput {
  readonly entityId: string;
  readonly businessDate: BusinessDate;
  readonly actorId: string;
}

export interface CloseDayResult {
  readonly bookDay: BookDay;
  /** False when the day was already closed. A day is closed once. */
  readonly created: boolean;
}

/**
 * Close a business day: freeze a booking watermark.
 *
 * Everything booked up to the watermark is in that day's statement; everything
 * after is not, **no matter what value date it carries**. That last clause is
 * the point. Closing a day does NOT forbid later postings with that value
 * date — late and corrected entries are legal and expected (DESIGN §13). They
 * land above the watermark, appear in `v_late_postings`, and force a new
 * statement version. A ledger that refused them would push the correction into
 * the wrong business day, which is precisely the failure the bitemporal model
 * exists to prevent.
 *
 * Re-closing a closed day returns the existing row with `created: false`
 * rather than throwing. The caller learns nothing was written, and the
 * original `closed_at` and watermark are reported unchanged — which is the
 * honest answer to "close Tuesday" when Tuesday was closed on Tuesday.
 */
export async function closeDay(
  input: CloseDayInput,
  conn: Sql,
): Promise<CloseDayResult> {
  return conn.begin(async (tx) => {
    const scoped = tx as unknown as Sql;

    // The same lock ledger_append() holds. See the module note above: without
    // this the maximum is not a high-water mark, it is a guess.
    await tx`SELECT pg_advisory_xact_lock(hashtext('ledger_append:' || ${input.entityId}::text))`;

    const existing = await readBookDay(input.entityId, input.businessDate, scoped);
    if (existing !== null) return { bookDay: existing, created: false };

    // The entity's own high-water mark, read inside the advisory lock taken
    // above so it cannot move between the read and the insert. Asked of the
    // ledger rather than re-expressed as `MAX(e.booking_seq)` here: it is the
    // same aggregate over the same rows, and having it written down twice is
    // how two modules end up closing a day at two different numbers.
    const watermark = await entityBookingWatermark(input.entityId, scoped);

    const rows = await tx<
      {
        entity_id: string;
        business_date: string;
        closed_at: Date;
        booking_watermark: bigint;
        closed_by: string;
      }[]
    >`
      INSERT INTO book_day (entity_id, business_date, booking_watermark, closed_by)
      VALUES (${input.entityId}::uuid,
              ${input.businessDate}::date,
              ${watermark}::bigint,
              ${input.actorId}::uuid)
      RETURNING entity_id,
                to_char(business_date, 'YYYY-MM-DD') AS business_date,
                closed_at,
                booking_watermark,
                closed_by`;

    const row = rows[0];
    if (row === undefined) throw new Error("book_day insert returned no row");

    return {
      bookDay: {
        entityId: row.entity_id,
        businessDate: row.business_date,
        closedAt: row.closed_at.toISOString(),
        bookingWatermark: row.booking_watermark,
        closedBy: row.closed_by,
      },
      created: true,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Publishing                                                                 */
/* -------------------------------------------------------------------------- */

export interface PublishInput {
  readonly accountId: string;
  readonly businessDate: BusinessDate;
  readonly actorId: string;
}

/**
 * Publish the as-published statement for a closed day.
 *
 * Pinned to `book_day.booking_watermark` — the watermark frozen at the close,
 * which never moves. So this function is **idempotent forever**: call it
 * today, call it in year seven, and it renders the same document, computes the
 * same hash, finds the row it wrote the first time, and returns it with
 * `created: false`. It does not issue v2 just because it was called twice.
 *
 * The one thing it will not do quietly is disagree with itself. If a version
 * already exists at this watermark and its stored hash is not what re-rendering
 * produces, that is `StatementReproductionError` and the call fails. A publish
 * path that shrugged and wrote a new version would turn the single most
 * important alarm in this module into a row.
 */
export async function publishStatement(
  input: PublishInput,
  conn: Sql,
): Promise<PublishResult> {
  return conn.begin(async (tx) => {
    const scoped = tx as unknown as Sql;

    const account = await readStatementAccount(input.accountId, scoped);
    if (account === null) throw new UnknownAccountError(input.accountId);

    const bookDay = await readBookDay(account.entityId, input.businessDate, scoped);
    if (bookDay === null) {
      throw new DayNotClosedError(account.entityId, input.businessDate);
    }

    return writeVersion(
      {
        accountId: input.accountId,
        periodStart: input.businessDate,
        periodEnd: input.businessDate,
        bookingWatermark: bookDay.bookingWatermark,
        actorId: input.actorId,
        requireExisting: false,
      },
      scoped,
      tx as unknown as Sql,
    );
  });
}

/**
 * Issue a corrected version of a closed day's statement, at the current watermark.
 *
 * This is the other half of DESIGN §13. When Thursday's correction lands with
 * Tuesday's value date we do not touch v1 — we cannot, and would not want to.
 * We issue Tuesday **v2** at a later watermark, showing the corrected position,
 * and keep both. "Tuesday's statement shows the corrected position" is
 * satisfied by v2; "reproducible forever" is satisfied by v1 still hashing to
 * what it hashed to.
 *
 * Two refusals, both deliberate:
 *
 *  - **Nothing changed.** If the document at the current watermark is
 *    byte-identical to the latest version, no row is written. A version whose
 *    only difference from its predecessor is `generated_at` is noise in an
 *    audit trail, and an audit trail full of noise is one nobody reads.
 *  - **Nothing was published.** Reissuing before v1 exists would publish a
 *    "v1" pinned to now rather than to the close, quietly destroying the
 *    as-published figure that the whole module exists to preserve. That is
 *    `NotYetPublishedError`.
 */
export async function reissueStatement(
  input: PublishInput,
  conn: Sql,
): Promise<PublishResult> {
  return conn.begin(async (tx) => {
    const scoped = tx as unknown as Sql;

    const account = await readStatementAccount(input.accountId, scoped);
    if (account === null) throw new UnknownAccountError(input.accountId);

    const bookDay = await readBookDay(account.entityId, input.businessDate, scoped);
    if (bookDay === null) {
      throw new DayNotClosedError(account.entityId, input.businessDate);
    }

    // The same lock `closeDay` and `ledger_append()` hold, and for the same
    // reason: the watermark below is about to be FROZEN into a document, and a
    // maximum read without this lock is not a high-water mark. A lower
    // `booking_seq` could still be in flight and commit beneath a version that
    // has already been published, and that version would stop reproducing.
    await tx`SELECT pg_advisory_xact_lock(hashtext('ledger_append:' || ${account.entityId}::text))`;

    // Pinned to the lowest watermark that yields this content, never to
    // `MAX(booking_seq)`. See `contentWatermark` for why — in short, the
    // watermark is in the hash, so pinning to the book's global maximum makes
    // a customer's version history a function of other customers' activity.
    // Floored at the close watermark so a corrected version is never pinned
    // BELOW the document it corrects.
    const minimal = await contentWatermark(
      { accountId: input.accountId, periodEnd: input.businessDate },
      scoped,
    );
    const watermark =
      minimal > bookDay.bookingWatermark ? minimal : bookDay.bookingWatermark;

    return writeVersion(
      {
        accountId: input.accountId,
        periodStart: input.businessDate,
        periodEnd: input.businessDate,
        bookingWatermark: watermark,
        actorId: input.actorId,
        requireExisting: true,
      },
      scoped,
      tx as unknown as Sql,
    );
  });
}

/**
 * The shared body of both publish paths.
 *
 * `tx` is threaded separately from `scoped` only because the read helpers take
 * the public `Sql` type while the raw handle is what runs the INSERT; they are
 * the same transaction.
 */
async function writeVersion(
  args: {
    readonly accountId: string;
    readonly periodStart: BusinessDate;
    readonly periodEnd: BusinessDate;
    readonly bookingWatermark: bigint;
    readonly actorId: string;
    readonly requireExisting: boolean;
  },
  scoped: Sql,
  tx: Sql,
): Promise<PublishResult> {
  await tx`
    SELECT pg_advisory_xact_lock(hashtext(
      'statement:' || ${args.accountId}::text || ':' ||
      ${args.periodStart}::text || ':' || ${args.periodEnd}::text))`;

  const document = await renderStatement(
    {
      accountId: args.accountId,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      bookingWatermark: args.bookingWatermark,
    },
    scoped,
  );
  const hash = statementHash(document);

  const versions = await listStatementVersions(
    {
      accountId: args.accountId,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
    },
    scoped,
  );

  if (args.requireExisting && versions.length === 0) {
    throw new NotYetPublishedError(args.accountId, args.periodStart);
  }

  // Already issued at this exact watermark: the same document by construction.
  const atSameWatermark = versions.find(
    (v) => v.bookingWatermark === args.bookingWatermark,
  );
  if (atSameWatermark !== undefined) {
    // Same watermark, different hash, SAME renderer -> the inputs changed,
    // which cannot happen through any capability this application has. That is
    // the alarm. A row rendered by an older `format` is excluded, because its
    // hash was never comparable to ours in the first place (0009).
    if (
      atSameWatermark.contentHash !== hash &&
      atSameWatermark.format === STATEMENT_FORMAT
    ) {
      throw new StatementReproductionError(atSameWatermark, hash);
    }
    return { statement: atSameWatermark, created: false, document };
  }

  // There is deliberately no "same hash at a different watermark" fallback
  // here, because there cannot be one: the watermark is part of the preimage,
  // so two documents at different watermarks never share a hash. "Nothing has
  // changed" is decided by the watermark not having moved, which is why
  // `reissueStatement` computes the MINIMAL watermark for the content rather
  // than the book's global maximum. That is the whole mechanism, and putting a
  // hash comparison here as well would be a fallback that can never fire.

  const version = versions.reduce((max, v) => (v.version > max ? v.version : max), 0) + 1;

  const rows = await tx<
    {
      id: string;
      account_id: string;
      period_start: string;
      period_end: string;
      version: number;
      booking_watermark: bigint;
      opening_balance_cents: bigint;
      closing_balance_cents: bigint;
      line_count: number;
      content_hash: string;
      format: string;
      generated_at: Date;
      generated_by: string;
    }[]
  >`
    INSERT INTO statement
      (account_id, period_start, period_end, version, booking_watermark,
       opening_balance_cents, closing_balance_cents, line_count, content_hash,
       format, generated_by)
    VALUES (
      ${args.accountId}::uuid,
      ${args.periodStart}::date,
      ${args.periodEnd}::date,
      ${version},
      ${args.bookingWatermark.toString()}::bigint,
      ${document.openingBalanceCents.toString()}::bigint,
      ${document.closingBalanceCents.toString()}::bigint,
      ${document.lineCount},
      decode(${hash}, 'hex'),
      ${STATEMENT_FORMAT},
      ${args.actorId}::uuid
    )
    RETURNING id,
              account_id,
              to_char(period_start, 'YYYY-MM-DD') AS period_start,
              to_char(period_end,   'YYYY-MM-DD') AS period_end,
              version,
              booking_watermark,
              opening_balance_cents,
              closing_balance_cents,
              line_count,
              encode(content_hash, 'hex')         AS content_hash,
              format,
              generated_at,
              generated_by`;

  const row = rows[0];
  if (row === undefined) throw new Error("statement insert returned no row");

  return { statement: toPublishedStatement(row), created: true, document };
}

/* -------------------------------------------------------------------------- */
/* Verification                                                               */
/* -------------------------------------------------------------------------- */

export interface VerificationResult {
  readonly statement: PublishedStatement;
  /** The stored hash and the re-rendered hash agree. The reproducibility claim. */
  readonly reproduced: boolean;
  /**
   * The row was rendered by a DIFFERENT renderer than the one now running.
   *
   * When this is true, `reproduced` being false is a deployment fact and not a
   * ledger fact: the hashes are simply not comparable. Keeping the two apart is
   * the whole reason `statement.format` exists (0009). An alarm that fires on a
   * deploy is an alarm nobody reads, and a tamper alarm nobody reads is worse
   * than none.
   */
  readonly formatChanged: boolean;
  readonly storedHash: string;
  readonly recomputedHash: string;
  readonly document: StatementDocument;
  /** The exact bytes the recomputed hash was taken over. */
  readonly canonical: string;
}

/**
 * Re-derive a published statement from the ledger and check its hash.
 *
 * The statement equivalent of `verifyRun` in `src/lib/recon/run.ts` and of
 * `verify_chain` in 0001. It should be run over the whole table nightly. The
 * screen also runs it on every page load for the statement it is showing,
 * because a reproducibility guarantee that is only checked by a cron job is a
 * guarantee the person looking at the document cannot see.
 */
export async function verifyStatement(
  statementId: string,
  conn: Sql,
): Promise<VerificationResult | null> {
  const statement = await readStatementById(statementId, conn);
  if (statement === null) return null;

  const document = await renderStatement(
    {
      accountId: statement.accountId,
      periodStart: statement.periodStart,
      periodEnd: statement.periodEnd,
      bookingWatermark: statement.bookingWatermark,
    },
    conn,
  );

  const canonical = canonicalStatement(document);
  const recomputedHash = statementHash(document);

  return {
    statement,
    reproduced: recomputedHash === statement.contentHash,
    formatChanged: statement.format !== STATEMENT_FORMAT,
    storedHash: statement.contentHash,
    recomputedHash,
    document,
    canonical,
  };
}
