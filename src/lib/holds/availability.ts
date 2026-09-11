/**
 * The availability sweep: the uncleared credit a clock released and nobody
 * booked.
 *
 * ─── What this is for ───────────────────────────────────────────────────────
 *
 * `expiry.ts` is the clock at the end of a card authorisation's life.
 * `completion.ts` is the opening whose memo posting never landed. This is the
 * third corner and the only one on the FUNDING path: an inbound credit is
 * withheld until `funds_availability_policy` says it is spendable, that instant
 * arrives, and the money becomes spendable — correctly, on the instant, with
 * nothing running — while the memo book is still carrying the withholding.
 *
 * `v_hold_state.is_released` has three arms and only one of them fires here:
 *
 *     a standing hold_closure row            — not written; there is none
 *     the card fold (kind = 'card_auth')     — wrong kind
 *     kind = 'uncleared_credit' AND now() >= h.available_at        ← this one
 *
 * `ledger_availability()` re-derives that arm at a parameterised instant, which
 * is what makes the money genuinely spendable rather than merely reported so.
 * So THE CUSTOMER IS ALREADY RIGHT and running this never is safe — the same
 * claim `expiry.ts` and docs/FUNDING.md §4.3 make. What is wrong is the memo
 * book, and `v_hold_release_drift` is the alarm that says so.
 *
 * ─── Why this is mechanical where migration 0036 §3 said it was not ─────────
 *
 * 0036 kept `v_hold_release_drift` out of its sweeper because a row there can
 * mean two things — "the posting never landed" or "the closure should never
 * have been written" — and posting the release answers the first while hiding
 * the second. That reasoning is correct and is not overturned.
 *
 * The ambiguity exists because a closure exists. `v_uncleared_release_due`
 * (migration 0048) admits only holds with NO `hold_closure` row at all, of kind
 * `uncleared_credit`. Nobody decided anything: `is_released` came from
 * `now() >= available_at`, over a column written once at funding on a table
 * nothing may UPDATE. There is no act of judgement behind the release that
 * could be the thing that is wrong, so there is no question for a human, and
 * the repair is the opening direction's repair one hold kind over.
 *
 * ─── The value date is the POLICY'S, not the sweeper's ──────────────────────
 *
 * `releaseAvailableCredits()` in `rails/plaid/adapter.ts` — the older trigger
 * for this same keyed append, called from `drainOnce()` — books at
 * `bookDateOf(now)`, the day the sweeper happened to run. Every uncleared
 * credit on the ACH rail matures at 09:00 America/New_York; `/api/drain` runs
 * at 00:17 ET and `/api/cron/holds` at 04:11 ET. Both scheduled triggers fire
 * BEFORE the maturity every day, so a run-dated release is guaranteed to land
 * on the following banking day and the statement for the release day shows
 * money withheld that the policy had already freed.
 *
 * This sweep books at `book_date(hold.available_at)` — the day the POLICY
 * released the money. Derived from immutable data, identical on every run for
 * ever, independent of when anybody notices. `booking_time` is still now(),
 * which is the honest bitemporal split: it happened at the policy instant, we
 * recorded it when the sweep ran.
 *
 * ─── Exactly-once, without a lock ───────────────────────────────────────────
 *
 * There is no row lock here and there cannot be: `corgi_app` holds no `UPDATE`
 * on `hold`, so `FOR UPDATE` is not expressible, and unlike a card
 * authorisation there is no SECURITY DEFINER helper for one. The guarantee is
 * the one the rest of this codebase uses:
 *
 *   1. `hold_closure` has `PRIMARY KEY (hold_id)` — there is no second row to
 *      write, so there is no flag anybody can set twice;
 *   2. the release entry's idempotency key is derived from the hold id and its
 *      immutable `available_at`, so two sweeps racing one hold compute the same
 *      key and Postgres refuses the second;
 *   3. the amount is read from the memo book inside the transaction and a zero
 *      balance posts nothing at all.
 *
 * The key is BYTE-IDENTICAL to `releaseAvailableCredits()`'s. That is
 * deliberate and it is what makes the two triggers one append rather than two
 * mechanisms: whichever runs first writes the entry, and the other finds the
 * closure already standing and the memo balance already zero.
 *
 * ─── Order: closure first, posting second ──────────────────────────────────
 *
 * `availableBalance()` in `ledger/balances.ts` reads "released" as the closure
 * row existing and does not know about `available_at`. Writing the closure
 * first means a process that dies between the two leaves the customer's
 * available balance already correct on every reader, and the posting lands on
 * the next sweep. The reverse order would leave a window in which the memo book
 * says free and one reader still says withheld.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { postEntry, type Rail } from "@/lib/ledger/post";
import { rootLogger } from "@/lib/log";

import {
  MEMO_CONTRA_CODE,
  closeHold,
  houseAccountId,
  ledgerPosterActorId,
  memoHoldBalance,
} from "./store";

/**
 * The release entry's idempotency key.
 *
 * Derived from the hold id and its `available_at`, both immutable, so it is the
 * same string on every sweep for ever. Identical to the key
 * `releaseAvailableCredits()` builds — see the header: the two triggers must
 * produce one append, not two.
 */
export function unclearedReleaseKey(holdId: string, availableAt: Date): string {
  return `hold:${holdId}:after:availability:${availableAt.toISOString()}`;
}

/** The `hold_closure.reason` this sweep writes. Prefix shared with 0040 §2. */
export function unclearedReleaseReason(availableAt: Date): string {
  return `funds availability reached at ${availableAt.toISOString()}`;
}

/** One row of `v_uncleared_release_due`. */
export interface UnclearedReleaseDue {
  readonly holdId: string;
  readonly accountId: string;
  readonly entityId: string;
  readonly memoAccountId: string;
  /** What the memo book is still withholding, in natural (positive) terms. */
  readonly memoBalanceCents: bigint;
  /** The policy instant. The release's identity, and half its idempotency key. */
  readonly availableAt: Date;
  /** `book_date(available_at)` — the day the POLICY released the money. */
  readonly releaseValueDate: string;
  /** The value date of the credit this hold was opened against. */
  readonly creditValueDate: string;
  readonly externalRef: string;
  /** The rail of the hold's own opening memo entry, or null if it had none. */
  readonly rail: Rail | null;
  /** How long the memo book has been behind the clock. */
  readonly ageSeconds: number;
}

export interface UnclearedReleaseResult {
  readonly holdId: string;
  /** True if THIS call wrote the closure row. */
  readonly closurePosted: boolean;
  /** Cents handed back to the customer's memo book. Zero means it self-healed. */
  readonly releasedCents: bigint;
  readonly entryId: string | null;
}

export interface UnclearedReleaseSweepResult {
  readonly examined: number;
  /** Holds where this call wrote the closure row. */
  readonly closed: number;
  /** Holds where a release entry was actually appended. */
  readonly released: number;
  /** Net cents returned to customers' available balances in the memo book. */
  readonly releasedCents: bigint;
  readonly failures: readonly { holdId: string; error: string }[];
}

/**
 * The uncleared credits the clock has released and the memo book has not.
 *
 * Reads `v_uncleared_release_due`, which is defined FROM `v_hold_release_drift`,
 * so this cannot range over rows the invariant cannot see. Migration 0048 §2
 * asserts the equality over that sub-population in both directions, at apply
 * time, and names the residue it deliberately leaves with the guard.
 */
export async function findUnclearedReleasesDue(
  opts: {
    readonly minAgeSeconds?: number;
    readonly limit?: number;
    readonly conn?: Sql;
  } = {},
): Promise<UnclearedReleaseDue[]> {
  const conn = opts.conn ?? sql;
  const minAge = opts.minAgeSeconds ?? 0;
  const limit = opts.limit ?? 100;

  const rows = await conn<
    {
      hold_id: string;
      account_id: string;
      entity_id: string;
      memo_account_id: string;
      memo_balance_cents: string;
      available_at: Date;
      release_value_date: string;
      credit_value_date: string;
      external_ref: string;
      rail: Rail | null;
      age_seconds: number;
    }[]
  >`
    SELECT hold_id, account_id, entity_id, memo_account_id,
           memo_balance_cents,
           available_at,
           release_value_date::text        AS release_value_date,
           credit_value_date::text         AS credit_value_date,
           external_ref,
           rail::text                      AS rail,
           EXTRACT(epoch FROM age)::float8 AS age_seconds
      FROM v_uncleared_release_due
     WHERE EXTRACT(epoch FROM age) >= ${minAge}
     ORDER BY available_at, hold_id
     LIMIT ${limit}`;

  return rows.map((r) => ({
    holdId: r.hold_id,
    accountId: r.account_id,
    entityId: r.entity_id,
    memoAccountId: r.memo_account_id,
    memoBalanceCents: BigInt(r.memo_balance_cents),
    availableAt: new Date(r.available_at),
    releaseValueDate: r.release_value_date,
    creditValueDate: r.credit_value_date,
    externalRef: r.external_ref,
    rail: r.rail,
    ageSeconds: Number(r.age_seconds),
  }));
}

/**
 * Release one matured uncleared credit.
 *
 * Nothing is decided here. The amount is the memo book's own balance, read
 * inside the transaction; the value date is `book_date(available_at)`, read
 * from the hold; the key is derived from both. A second call computes a zero
 * balance and appends nothing.
 */
export async function releaseOne(
  row: UnclearedReleaseDue,
  args: { readonly actorId: string; readonly conn?: Sql },
): Promise<UnclearedReleaseResult> {
  const conn = args.conn ?? sql;

  return conn.begin(async (raw) => {
    const tx = raw as unknown as Sql;

    // Closure FIRST, posting second — see the header. `availableBalance()`
    // reads "released" as this row existing, so a crash between the two leaves
    // the customer already correct on every reader.
    const closurePosted = await closeHold(
      row.holdId,
      unclearedReleaseReason(row.availableAt),
      args.actorId,
      tx,
      // Declared, unlike `releaseAvailableCredits()`'s, which predates
      // migration 0040's column and is outside its write scope. A closure that
      // declares its writer is one `v_hold_closure_census` can count by
      // construction instead of by matching English against `reason`.
      "availability_sweep",
    );

    // The memo book's own answer, read inside the transaction through the same
    // reader `apply.ts` uses. Not the view's answer: the queue was read outside
    // this transaction and something may have finished the job in between, in
    // which case the right amount of bookkeeping is none.
    const balance = await memoHoldBalance(row.holdId, row.memoAccountId, tx);
    if (balance === 0n) return { holdId: row.holdId, closurePosted, releasedCents: 0n, entryId: null };

    // Throws by name if the chart is missing the leaf. Caught per hold by the
    // sweep, so one entity's missing house account is one entity's problem.
    const contraId = await houseAccountId(MEMO_CONTRA_CODE, row.entityId, tx);

    const entryId = await postEntry(
      {
        entityId: row.entityId,
        // THE DAY THE POLICY RELEASED THE MONEY, not the day this ran. See the
        // header: every ACH maturity on this book is at 09:00 ET and every
        // scheduled trigger fires before it, so `bookDate(now)` is guaranteed
        // to be the following banking day and the statement for the release
        // day would show money withheld that the policy had freed.
        valueDate: row.releaseValueDate,
        book: "memo",
        description:
          `Uncleared credit released — funds availability reached ` +
          `${row.availableAt.toISOString()} (credit value date ${row.creditValueDate})`,
        idempotencyKey: unclearedReleaseKey(row.holdId, row.availableAt),
        actorId: args.actorId,
        ...(row.rail !== null ? { rail: row.rail } : {}),
        externalRef: row.externalRef,
        holdId: row.holdId,
        lines: [
          // Debit the customer's 9200 leaf back down to zero. The leaf is
          // credit-normal, so giving the money back is a POSITIVE amount_cents.
          { accountId: row.memoAccountId, amountCents: balance },
          { accountId: contraId, amountCents: -balance },
        ],
      },
      tx,
    );

    return { holdId: row.holdId, closurePosted, releasedCents: balance, entryId };
  });
}

/**
 * Release every uncleared credit whose availability instant has passed.
 *
 * `limit` bounds the batch so a serverless invocation finishes; call it again
 * until `examined` comes back below the limit. Total and idempotent: a second
 * run over the same holds reads a zero memo balance and appends nothing.
 *
 * A hold that throws is logged, counted and SKIPPED rather than aborting the
 * batch — the lesson docs/FUNDING.md §0 paid for, where one customer's
 * unformattable hold took the funding screen away from every other customer on
 * the book. One entity missing its 9900 house account must not stop ninety-nine
 * others getting their money back, and the row stays in `v_hold_release_drift`,
 * loudly, until someone looks.
 */
export async function sweepMaturedUnclearedCredits(
  opts: {
    readonly minAgeSeconds?: number;
    readonly limit?: number;
    readonly actorId?: string;
    readonly conn?: Sql;
  } = {},
): Promise<UnclearedReleaseSweepResult> {
  const conn = opts.conn ?? sql;
  const actorId = opts.actorId ?? (await ledgerPosterActorId(conn));

  const due = await findUnclearedReleasesDue({
    ...(opts.minAgeSeconds !== undefined ? { minAgeSeconds: opts.minAgeSeconds } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    conn,
  });

  let closed = 0;
  let released = 0;
  let releasedCents = 0n;
  const failures: { holdId: string; error: string }[] = [];

  for (const row of due) {
    try {
      const result = await releaseOne(row, { actorId, conn });
      if (result.closurePosted) closed += 1;
      if (result.releasedCents === 0n) continue;
      released += 1;
      releasedCents += result.releasedCents;
      rootLogger.info("holds.availability.released", {
        holdId: result.holdId,
        entryId: result.entryId,
        releasedCents: result.releasedCents.toString(),
        valueDate: row.releaseValueDate,
        availableAt: row.availableAt.toISOString(),
        ageSeconds: Math.round(row.ageSeconds),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rootLogger.error("holds.availability.failed", { holdId: row.holdId, error: message });
      failures.push({ holdId: row.holdId, error: message });
    }
  }

  return { examined: due.length, closed, released, releasedCents, failures };
}
