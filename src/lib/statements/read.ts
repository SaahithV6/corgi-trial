/**
 * The read path: everything a statement is rendered from.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE WRITES
 * ---------------------------------------------------------------------------
 *
 * Rendering a statement is a query. Publishing one is a different operation in
 * a different module (`publish.ts`) because it takes an actor, writes a row and
 * has to be idempotent. Keeping them apart is what lets the screen re-derive
 * any historical document on every page load — proving the hash — without the
 * risk that looking at a statement issues one.
 *
 * ---------------------------------------------------------------------------
 * THE TWO PREDICATES, EVERY TIME
 * ---------------------------------------------------------------------------
 *
 *     value_date  BETWEEN :start AND :end   which business days count
 *     booking_seq <= :watermark             what we had learned by then
 *
 * That is the whole bitemporal model (DESIGN §5). The watermark is what makes
 * a rendering reproducible: `booking_seq` is drawn under an advisory lock so
 * sequence order is commit order, and therefore no row can ever appear BELOW a
 * watermark after the fact. A rectangle in the (value, booking) plane, fixed
 * forever once both edges are fixed.
 *
 * ---------------------------------------------------------------------------
 * `server-only` IS DELIBERATELY ABSENT
 * ---------------------------------------------------------------------------
 *
 * Same reason as `src/lib/ledger/queries.ts`: every function here takes its
 * connection as an argument and this module imports no driver, so it can be
 * exercised against a fake `Sql` in an environment that holds no credentials —
 * which is exactly the environment CI runs in, deliberately. `db.ts` carries
 * `server-only`, and reaching a real connection means going through it.
 */

import type { Sql } from "@/lib/ledger/queries";

import { foldClosing, sortLines, withRunningBalances } from "./render";
import type {
  BookDay,
  BusinessDate,
  EntryType,
  LatePosting,
  PublishedStatement,
  StatementDocument,
  StatementLine,
} from "./types";

/** The app's pooled handle, resolved lazily so importing this opens no socket. */
export async function statementConnection(): Promise<Sql> {
  const { sql } = await import("@/lib/ledger/db");
  return sql;
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

export interface StatementAccount {
  readonly accountId: string;
  readonly entityId: string;
  readonly businessId: string;
  readonly accountName: string;
  readonly legalName: string;
  readonly currency: string;
}

/**
 * The account a statement is for, plus the entity whose book-days govern it.
 *
 * A statement is scoped to an ACCOUNT, but the close it is pinned to is
 * recorded per ENTITY — `book_day`'s primary key is `(entity_id,
 * business_date)`. Signing off a business day is an act of the legal entity's
 * finance function, not of one customer's account, and every account in the
 * book inherits the same watermark from it. So every read here starts by
 * resolving one to the other rather than letting a caller pass an entity that
 * does not own the account.
 */
export async function readStatementAccount(
  accountId: string,
  conn: Sql,
): Promise<StatementAccount | null> {
  const rows = await conn<
    {
      account_id: string;
      entity_id: string;
      business_id: string;
      account_name: string;
      legal_name: string;
      currency: string;
    }[]
  >`
    SELECT a.id          AS account_id,
           a.entity_id   AS entity_id,
           a.business_id AS business_id,
           a.name        AS account_name,
           b.legal_name  AS legal_name,
           a.currency    AS currency
      FROM account a
      JOIN business b ON b.id = a.business_id
     WHERE a.id = ${accountId}::uuid
       AND a.code = '2100'
       AND a.book = 'financial'
       AND a.business_id IS NOT NULL`;

  const row = rows[0];
  if (row === undefined) return null;
  return {
    accountId: row.account_id,
    entityId: row.entity_id,
    businessId: row.business_id,
    accountName: row.account_name,
    legalName: row.legal_name,
    currency: row.currency,
  };
}

/* -------------------------------------------------------------------------- */
/* Day close                                                                  */
/* -------------------------------------------------------------------------- */

function toBookDay(row: {
  entity_id: string;
  business_date: string;
  closed_at: Date;
  booking_watermark: bigint;
  closed_by: string;
}): BookDay {
  return {
    entityId: row.entity_id,
    businessDate: row.business_date,
    closedAt: row.closed_at.toISOString(),
    bookingWatermark: row.booking_watermark,
    closedBy: row.closed_by,
  };
}

/** The close for one business day, or `null` if the day is still open. */
export async function readBookDay(
  entityId: string,
  businessDate: BusinessDate,
  conn: Sql,
): Promise<BookDay | null> {
  const rows = await conn<
    {
      entity_id: string;
      business_date: string;
      closed_at: Date;
      booking_watermark: bigint;
      closed_by: string;
    }[]
  >`
    SELECT entity_id,
           to_char(business_date, 'YYYY-MM-DD') AS business_date,
           closed_at,
           booking_watermark,
           closed_by
      FROM book_day
     WHERE entity_id = ${entityId}::uuid
       AND business_date = ${businessDate}::date`;

  const row = rows[0];
  return row === undefined ? null : toBookDay(row);
}

/**
 * One closed day, as the day-picker needs it.
 *
 * `versionCount` and `lineCount` are what let the picker be honest about three
 * genuinely different situations that a naive list would blur together: a day
 * with a published statement, a closed day with activity but nothing published
 * yet, and a closed day on which this account simply did nothing.
 */
export interface StatementDay {
  readonly businessDate: BusinessDate;
  /** ISO 8601 instant. */
  readonly closedAt: string;
  readonly bookingWatermark: bigint;
  /** Statement versions published for this account and this day. */
  readonly versionCount: number;
  /** Lines on this account with this value date, as known NOW. */
  readonly lineCount: number;
  /** Lines with this value date booked ABOVE the close watermark. */
  readonly latePostingCount: number;
}

/**
 * Closed days this account has something to show for, newest first.
 *
 * "Something to show for" means a published statement OR at least one posting.
 * A day the entity closed on which this particular customer did nothing is
 * excluded — not because it is unanswerable (its statement is an opening
 * balance, no lines, the same closing balance, and it is derivable on demand
 * like any other) but because a book with a nightly close has hundreds of them
 * and they would crowd out every day worth opening. The date is still URL
 * state, so a day off this list is one query-string edit away rather than
 * unreachable.
 */
export async function listStatementDays(
  args: {
    readonly accountId: string;
    readonly entityId: string;
    readonly limit?: number;
  },
  conn: Sql,
): Promise<readonly StatementDay[]> {
  const limit = args.limit ?? 90;
  const rows = await conn<
    {
      business_date: string;
      closed_at: Date;
      booking_watermark: bigint;
      version_count: number;
      line_count: number;
      late_posting_count: number;
    }[]
  >`
    SELECT to_char(bd.business_date, 'YYYY-MM-DD') AS business_date,
           bd.closed_at,
           bd.booking_watermark,
           (SELECT count(*)::int FROM statement s
             WHERE s.account_id   = ${args.accountId}::uuid
               AND s.period_start = bd.business_date
               AND s.period_end   = bd.business_date)          AS version_count,
           (SELECT count(*)::int FROM journal_line l
             WHERE l.account_id = ${args.accountId}::uuid
               AND l.value_date = bd.business_date)            AS line_count,
           (SELECT count(*)::int FROM journal_line l
             WHERE l.account_id  = ${args.accountId}::uuid
               AND l.value_date  = bd.business_date
               AND l.booking_seq > bd.booking_watermark)       AS late_posting_count
      FROM book_day bd
     WHERE bd.entity_id = ${args.entityId}::uuid
       AND (EXISTS (SELECT 1 FROM statement s
                     WHERE s.account_id   = ${args.accountId}::uuid
                       AND s.period_start = bd.business_date
                       AND s.period_end   = bd.business_date)
            OR EXISTS (SELECT 1 FROM journal_line l
                        WHERE l.account_id = ${args.accountId}::uuid
                          AND l.value_date = bd.business_date))
     ORDER BY bd.business_date DESC
     LIMIT ${limit}`;

  return rows.map((row) => ({
    businessDate: row.business_date,
    closedAt: row.closed_at.toISOString(),
    bookingWatermark: row.booking_watermark,
    versionCount: row.version_count,
    lineCount: row.line_count,
    latePostingCount: row.late_posting_count,
  }));
}

/**
 * The highest `booking_seq` in the book right now.
 *
 * This is the "as corrected" watermark: read the same period at this number
 * and you get what the ledger says the day was, today. It moves; the published
 * watermark does not. That asymmetry is the whole design.
 */
export async function currentWatermark(conn: Sql): Promise<bigint> {
  const rows = await conn<{ watermark: bigint }[]>`
    SELECT COALESCE(MAX(booking_seq), 0)::bigint AS watermark FROM journal_entry`;
  return rows[0]?.watermark ?? 0n;
}

/**
 * The LOWEST watermark that still produces the document's current content.
 *
 * ---------------------------------------------------------------------------
 * WHY A CORRECTED VERSION IS NOT PINNED TO `MAX(booking_seq)`
 * ---------------------------------------------------------------------------
 *
 * The watermark is part of the content hash, so pinning a reissue to "the book
 * right now" makes its hash a function of unrelated activity: a card clearing
 * for a different customer moves the maximum, the hash changes, the "nothing
 * has changed" check fails, and a new version is issued for a document that
 * says exactly what the last one said. The version history then fills with
 * noise, which is the failure the reissue path exists to avoid. This was found
 * by the integration suite, not by reading the code: the demo day reached v3
 * across two runs with no correction between them.
 *
 * The fix is to pin a version to the highest booking position that could
 * AFFECT it — every line on this account with a value date at or before the
 * period end, because those are exactly the rows the opening balance and the
 * body are folded from. Nothing above that number can change the rendering, so
 * rendering at it and rendering at `MAX(booking_seq)` produce identical
 * documents, and this is the smaller of the two.
 *
 * Note the predicate is `<=` the period END, not "inside the period". An entry
 * backdated to BEFORE the period and booked after the close changes the
 * opening balance, and therefore the closing balance, without ever appearing
 * as a line. Missing that was the second bug the suite caught.
 */
export async function contentWatermark(
  args: { readonly accountId: string; readonly periodEnd: BusinessDate },
  conn: Sql,
): Promise<bigint> {
  const rows = await conn<{ watermark: bigint }[]>`
    SELECT COALESCE(MAX(l.booking_seq), 0)::bigint AS watermark
      FROM journal_line l
     WHERE l.account_id = ${args.accountId}::uuid
       AND l.value_date <= ${args.periodEnd}::date`;
  return rows[0]?.watermark ?? 0n;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

export interface RenderRequest {
  readonly accountId: string;
  readonly periodStart: BusinessDate;
  readonly periodEnd: BusinessDate;
  readonly bookingWatermark: bigint;
}

/**
 * Render a statement for a (period, watermark) pair.
 *
 * Two queries, one rectangle each:
 *
 *   opening — everything strictly BEFORE the period, at the watermark
 *   lines   — everything INSIDE the period, at the watermark
 *
 * and `closing = opening + Σ lines`, folded in TypeScript by `foldClosing` so
 * the stored figure has exactly one definition. Running a `SUM` for the
 * closing balance as a third query would introduce a second definition that
 * could disagree with the first two, which is the kind of thing that shows up
 * once, in production, on a statement.
 *
 * `book = 'financial'` is asserted on the line join even though it cannot
 * fail: `assert_entry_balanced()` refuses any entry whose line hits an account
 * in a different book, and a customer's 2100 is a financial account, so a memo
 * posting can never land here. The opening-balance query leaves the predicate
 * off deliberately, to keep the `(account_id, value_date, booking_seq)`
 * covering index in play for an index-only scan. Both are the same set for the
 * reason just given; the asymmetry is a performance choice, not an oversight.
 */
export async function renderStatement(
  request: RenderRequest,
  conn: Sql,
): Promise<StatementDocument> {
  const watermark = request.bookingWatermark;

  const [openingRows, lineRows] = await Promise.all([
    conn<{ opening_cents: bigint }[]>`
      SELECT COALESCE(SUM(l.amount_cents), 0)::bigint * a.normal_side AS opening_cents
        FROM account a
        LEFT JOIN journal_line l
               ON l.account_id  = a.id
              AND l.value_date  < ${request.periodStart}::date
              AND l.booking_seq <= ${watermark}
       WHERE a.id = ${request.accountId}::uuid
       GROUP BY a.normal_side`,

    conn<
      {
        entry_id: string;
        value_date: string;
        booking_seq: bigint;
        ordinal: number;
        entry_type: EntryType;
        description: string;
        external_ref: string | null;
        rail: string | null;
        reverses_entry_id: string | null;
        correction_group_id: string | null;
        signed_cents: bigint;
      }[]
    >`
      SELECT e.id                                       AS entry_id,
             to_char(l.value_date, 'YYYY-MM-DD')        AS value_date,
             l.booking_seq                              AS booking_seq,
             l.ordinal                                  AS ordinal,
             e.entry_type::text                         AS entry_type,
             e.description                              AS description,
             e.external_ref                             AS external_ref,
             e.rail::text                               AS rail,
             e.reverses_entry_id                        AS reverses_entry_id,
             e.correction_group_id                      AS correction_group_id,
             (l.amount_cents * a.normal_side)::bigint   AS signed_cents
        FROM journal_line  l
        JOIN journal_entry e ON e.id = l.entry_id
        JOIN account       a ON a.id = l.account_id
       WHERE l.account_id  = ${request.accountId}::uuid
         AND l.value_date BETWEEN ${request.periodStart}::date AND ${request.periodEnd}::date
         AND l.booking_seq <= ${watermark}
         AND e.book = 'financial'
       ORDER BY l.value_date, l.booking_seq, l.ordinal`,
  ]);

  if (openingRows[0] === undefined) {
    // GROUP BY on a LEFT JOIN from `account` returns one row for an account
    // with no lines at all, so no row means no such account.
    throw new UnknownAccountError(request.accountId);
  }
  const openingBalanceCents = openingRows[0].opening_cents;

  const bare = lineRows.map((row): Omit<StatementLine, "runningBalanceCents"> => ({
    entryId: row.entry_id,
    valueDate: row.value_date,
    bookingSeq: row.booking_seq,
    ordinal: row.ordinal,
    entryType: row.entry_type,
    description: row.description,
    externalRef: row.external_ref,
    rail: row.rail,
    reversesEntryId: row.reverses_entry_id,
    correctionGroupId: row.correction_group_id,
    signedCents: row.signed_cents,
  }));

  const lines = sortLines(withRunningBalances(openingBalanceCents, bare));

  return {
    accountId: request.accountId,
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
    bookingWatermark: watermark,
    openingBalanceCents,
    closingBalanceCents: foldClosing(openingBalanceCents, lines),
    lineCount: lines.length,
    lines,
  };
}

export class UnknownAccountError extends Error {
  override readonly name = "UnknownAccountError";
  constructor(readonly accountId: string) {
    super(`no such account ${accountId}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Late postings — the "why it differs" list                                  */
/* -------------------------------------------------------------------------- */

/**
 * Entries with a value date inside the period, booked ABOVE the watermark.
 *
 * `queries.draft.sql` §4e. These are the entries that force a new version, and
 * they are the entire explanation of the gap between as-published and
 * as-corrected. Rolled up per ENTRY rather than per line, because a reversal
 * is one act even when it negates four lines, and an operator reading "why is
 * Tuesday different" wants the acts.
 */
export async function listLatePostings(
  args: {
    readonly accountId: string;
    readonly periodStart: BusinessDate;
    readonly periodEnd: BusinessDate;
    readonly sinceWatermark: bigint;
  },
  conn: Sql,
): Promise<readonly LatePosting[]> {
  const rows = await conn<
    {
      entry_id: string;
      value_date: string;
      booking_seq: bigint;
      booking_time: Date;
      entry_type: EntryType;
      description: string;
      external_ref: string | null;
      reverses_entry_id: string | null;
      correction_group_id: string | null;
      signed_cents: bigint;
    }[]
  >`
    SELECT e.id                                          AS entry_id,
           to_char(e.value_date, 'YYYY-MM-DD')           AS value_date,
           e.booking_seq                                 AS booking_seq,
           e.booking_time                                AS booking_time,
           e.entry_type::text                            AS entry_type,
           e.description                                 AS description,
           e.external_ref                                AS external_ref,
           e.reverses_entry_id                           AS reverses_entry_id,
           e.correction_group_id                         AS correction_group_id,
           SUM(l.amount_cents * a.normal_side)::bigint   AS signed_cents
      FROM journal_line  l
      JOIN journal_entry e ON e.id = l.entry_id
      JOIN account       a ON a.id = l.account_id
     WHERE l.account_id  = ${args.accountId}::uuid
       AND l.value_date <= ${args.periodEnd}::date
       AND l.booking_seq > ${args.sinceWatermark}
       AND e.book = 'financial'
     GROUP BY e.id, e.value_date, e.booking_seq, e.booking_time, e.entry_type,
              e.description, e.external_ref, e.reverses_entry_id, e.correction_group_id
     ORDER BY e.booking_seq`;

  return rows.map((row) => ({
    entryId: row.entry_id,
    valueDate: row.value_date,
    bookingSeq: row.booking_seq,
    bookingTime: row.booking_time.toISOString(),
    entryType: row.entry_type,
    description: row.description,
    externalRef: row.external_ref,
    reversesEntryId: row.reverses_entry_id,
    correctionGroupId: row.correction_group_id,
    signedCents: row.signed_cents,
    // Before the period, so it moved the OPENING balance rather than adding a
    // line. Same effect on the closing figure; a completely different thing to
    // read on a screen.
    affectsOpening: row.value_date < args.periodStart,
  }));
}

/* -------------------------------------------------------------------------- */
/* Published rows                                                             */
/* -------------------------------------------------------------------------- */

interface StatementRow {
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
}

export function toPublishedStatement(row: StatementRow): PublishedStatement {
  return {
    statementId: row.id,
    accountId: row.account_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    version: row.version,
    bookingWatermark: row.booking_watermark,
    openingBalanceCents: row.opening_balance_cents,
    closingBalanceCents: row.closing_balance_cents,
    lineCount: row.line_count,
    contentHash: row.content_hash,
    format: row.format,
    generatedAt: row.generated_at.toISOString(),
    generatedBy: row.generated_by,
  };
}

/**
 * Every version issued for one account and period, oldest first. The lineage.
 *
 * `content_hash` is `bytea` in the schema and comes back as hex here, because
 * a hash is compared and pasted far more often than it is byte-manipulated,
 * and a `Uint8Array` on a screen is nobody's idea of evidence.
 */
export async function listStatementVersions(
  args: {
    readonly accountId: string;
    readonly periodStart: BusinessDate;
    readonly periodEnd: BusinessDate;
  },
  conn: Sql,
): Promise<readonly PublishedStatement[]> {
  const rows = await conn<StatementRow[]>`
    SELECT id,
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
           generated_by
      FROM statement
     WHERE account_id   = ${args.accountId}::uuid
       AND period_start = ${args.periodStart}::date
       AND period_end   = ${args.periodEnd}::date
     ORDER BY version`;
  return rows.map(toPublishedStatement);
}

/** One published statement by id. */
export async function readStatementById(
  statementId: string,
  conn: Sql,
): Promise<PublishedStatement | null> {
  const rows = await conn<StatementRow[]>`
    SELECT id,
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
           generated_by
      FROM statement WHERE id = ${statementId}::uuid`;
  const row = rows[0];
  return row === undefined ? null : toPublishedStatement(row);
}
