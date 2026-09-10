import "server-only";
import { sql, type Sql } from "./db";

/**
 * Balances. Every one of these is a SUM over immutable rows.
 *
 * There is no balance column in this schema. Not on account, not on business,
 * not anywhere — `pnpm db:check` fails the build if one appears. That is the
 * requirement ("derived and provable from events, never a second stored number
 * that drifts and gets fixed by a cron job") and it is also the only way the
 * bitemporal queries below can be correct: a stored balance has one value, and
 * the whole point is that the answer depends on WHICH DAY YOU ASK ABOUT and
 * WHEN YOU ASK IT, independently.
 *
 * Sign handling, once, here: lines are stored debit-positive / credit-negative.
 * Multiplying by the account's normal_side turns the raw sum into the number a
 * human expects — a customer with $100 on deposit has lines summing to -10000
 * (a liability of the bank) and a balance of +10000.
 */

export interface Balance {
  readonly accountId: string;
  readonly balanceCents: bigint;
}

/**
 * Booked balance for a business day, using everything we know NOW.
 *
 * This is the "what does the ledger say about Tuesday, today" question — the
 * one a corrected statement must answer with the CORRECTED figure.
 */
export async function ledgerBalanceAsOf(
  accountId: string,
  asOfValueDate: string,
  conn: Sql = sql,
): Promise<bigint> {
  const rows = await conn<{ balance_cents: bigint }[]>`
    SELECT COALESCE(SUM(l.amount_cents), 0)::bigint * a.normal_side AS balance_cents
      FROM account a
      LEFT JOIN journal_line l
             ON l.account_id = a.id
            AND l.value_date <= ${asOfValueDate}::date
     WHERE a.id = ${accountId}::uuid
     GROUP BY a.normal_side`;
  return rows[0]?.balance_cents ?? 0n;
}

/**
 * Balance for a business day AS WE BELIEVED IT at a point in transaction time.
 *
 * Two predicates, two axes. This is the entire bitemporal model:
 *
 *   value_date  <= X   which business days count
 *   booking_seq <= Y   what we had learned by then
 *
 * The published live-fire question is "a merchant reverses Tuesday's
 * settlement on Thursday — show Tuesday's statement now, and prove what you
 * believed on Wednesday." The first is ledgerBalanceAsOf(tuesday). The second
 * is this, with asOfValueDate = Tuesday and asOfBookingSeq = Wednesday's
 * watermark. Both are true; neither overwrote the other; nothing was edited.
 */
export async function balanceAsBelieved(
  accountId: string,
  asOfValueDate: string,
  asOfBookingSeq: bigint,
  conn: Sql = sql,
): Promise<bigint> {
  const rows = await conn<{ balance_cents: bigint }[]>`
    SELECT COALESCE(SUM(l.amount_cents), 0)::bigint * a.normal_side AS balance_cents
      FROM account a
      LEFT JOIN journal_line l
             ON l.account_id = a.id
            AND l.value_date  <= ${asOfValueDate}::date
            AND l.booking_seq <= ${asOfBookingSeq}
     WHERE a.id = ${accountId}::uuid
     GROUP BY a.normal_side`;
  return rows[0]?.balance_cents ?? 0n;
}

/**
 * The booking watermark for a wall-clock instant: the highest booking_seq we
 * had recorded by then. Turns "what did you believe on Wednesday" into a
 * number the query above can use.
 */
export async function bookingWatermarkAt(at: Date, conn: Sql = sql): Promise<bigint> {
  const rows = await conn<{ seq: bigint }[]>`
    SELECT COALESCE(MAX(booking_seq), 0)::bigint AS seq
      FROM journal_entry WHERE booking_time <= ${at.toISOString()}::timestamptz`;
  return rows[0]?.seq ?? 0n;
}

export interface AvailableBalance {
  readonly ledgerCents: bigint;
  readonly holdsCents: bigint;
  readonly unclearedCents: bigint;
  readonly availableCents: bigint;
}

/**
 * available = ledger - active holds - uncleared credits.
 *
 * A hold contributes its memo balance unless it has been released. Release is
 * one row in hold_closure with PRIMARY KEY (hold_id) — so "released" is a
 * primary-key existence check, which is what makes release exactly-once by
 * construction rather than by a flag someone could set twice.
 *
 * ...and one row in hold_closure_reversal un-does it, because a primary-key
 * existence check in an append-only table has no other way back. Three holds
 * in this database carried a closure row reading "authorisation fully
 * reversed" whose authorisation was never reversed — residue of a bug fixed
 * long before, still freeing $60.00 of authorised money, because fixing the
 * writer does not unwrite what it wrote. See migration 0011.
 *
 * Note what is NOT here: any reference to a provider's transaction status.
 * Lithic reports SETTLED while a partial hold is still outstanding (measured;
 * DECISIONS 006). A system that released holds on that field would free money
 * that is still authorised. The hold's size is a function of the event set,
 * and its release is a row, and neither asks the provider's opinion.
 */
export async function availableBalance(
  businessId: string,
  conn: Sql = sql,
): Promise<AvailableBalance> {
  const rows = await conn<
    { ledger_cents: bigint; holds_cents: bigint; uncleared_cents: bigint }[]
  >`
    WITH deposit AS (
      SELECT id, normal_side FROM account
       WHERE code = '2100' AND business_id = ${businessId}::uuid
    ),
    booked AS (
      SELECT COALESCE(SUM(l.amount_cents), 0)::bigint * d.normal_side AS cents
        FROM deposit d LEFT JOIN journal_line l ON l.account_id = d.id
       GROUP BY d.normal_side
    ),
    active_holds AS (
      -- A hold's size is the balance of ITS OWN memo account only.
      --
      -- Two bugs lived here and both produced silent zeros rather than errors
      -- you would notice:
      --
      -- 1. The hold table has no business_id. It has account_id (the customer's
      --    deposit account) and memo_account_id (their 9100/9200). Tenancy is
      --    reached through the deposit account, not stored on the hold.
      -- 2. Summing every line of a hold's memo ENTRIES gives zero, always.
      --    assert_entry_balanced() applies to the memo book exactly as it does
      --    to the financial book, so both legs of a memo entry are in that sum
      --    and they cancel. The hold is one SIDE of that entry, so the sum has
      --    to be restricted to lines hitting hold.memo_account_id.
      SELECT h.id, h.kind,
             COALESCE(SUM(l.amount_cents), 0)::bigint AS cents
        FROM hold h
        JOIN account a ON a.id = h.account_id
        LEFT JOIN journal_entry e ON e.hold_id = h.id
        LEFT JOIN journal_line  l ON l.entry_id = e.id
                                 AND l.account_id = h.memo_account_id
       WHERE a.business_id = ${businessId}::uuid
         -- Released, and not un-released. A closure row that should never have
         -- been written is corrected by an append to hold_closure_reversal,
         -- never by a DELETE (migration 0011). This predicate is a duplicate of
         -- v_hold_state.is_released, so it has to learn the same thing or
         -- availability and the invariant views disagree about the same hold —
         -- which is exactly the state three holds were in before 0011.
         AND NOT EXISTS (
           SELECT 1 FROM hold_closure c
            WHERE c.hold_id = h.id
              AND NOT EXISTS (
                SELECT 1 FROM hold_closure_reversal r WHERE r.hold_id = c.hold_id
              )
         )
       GROUP BY h.id, h.kind
    )
    SELECT (SELECT COALESCE(cents, 0) FROM booked)                          AS ledger_cents,
           COALESCE((SELECT SUM(ABS(cents)) FROM active_holds
                      WHERE kind = 'card_auth'), 0)::bigint                 AS holds_cents,
           COALESCE((SELECT SUM(ABS(cents)) FROM active_holds
                      WHERE kind = 'uncleared_credit'), 0)::bigint          AS uncleared_cents`;

  const r = rows[0];
  const ledgerCents = r?.ledger_cents ?? 0n;
  const holdsCents = r?.holds_cents ?? 0n;
  const unclearedCents = r?.uncleared_cents ?? 0n;
  return {
    ledgerCents,
    holdsCents,
    unclearedCents,
    // Deliberately allowed to go negative. An over-captured fuel-pump
    // authorisation settles above the amount authorised, and the honest
    // answer is that the customer is overdrawn. Clamping to zero here would
    // hide a real overdraft behind a cosmetic floor.
    availableCents: ledgerCents - holdsCents - unclearedCents,
  };
}

/** Trial balance: every line in the financial book must sum to zero. */
export async function trialBalanceCents(conn: Sql = sql): Promise<bigint> {
  const rows = await conn<{ total: bigint }[]>`
    SELECT COALESCE(SUM(l.amount_cents), 0)::bigint AS total
      FROM journal_line l
      JOIN journal_entry e ON e.id = l.entry_id
     WHERE e.book = 'financial'`;
  return rows[0]?.total ?? 0n;
}
