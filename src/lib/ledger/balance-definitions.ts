/**
 * THE balance module. One definition of each balance question, and every
 * other balance function in this system is a call into this file.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 *
 * On 2026-09-11 this system had four answers to "what is available", and two
 * of them printed at the same instant, on two screens, for the same account:
 *
 *   the accounts console   $6,734.83
 *   the funding screen    $31,775.53
 *
 * A $25,040.70 disagreement between two functions in the same library. It was
 * not a rounding artefact and it was not a race — they were asking different
 * questions and neither said which. `docs/BALANCE-DEFINITIONS.md` has the
 * measured before/after table for every one of them.
 *
 * "Derived, never stored" does not survive four derivations. A balance that is
 * derived four ways is a stored lie with extra steps: the number the customer
 * sees still depends on which code path reached them, which is precisely the
 * property a stored balance has and a derived one is supposed not to.
 *
 * ===========================================================================
 * THE THREE QUESTIONS, NAMED BECAUSE THEY ARE GENUINELY DIFFERENT
 * ===========================================================================
 *
 *   Q1  settledBalanceCents(account, snapshot)
 *       The settled ledger balance at a value date AND a booking watermark.
 *       Two axes, both load-bearing, independent of each other. This is the
 *       bitemporal claim and everything else is built on it.
 *
 *   Q2  accountAvailability(account, snapshot)
 *       available = settled ledger
 *                 − active holds
 *                 − uncleared credits
 *                 − committed future-dated debits
 *
 *   Q3  believedBalanceCents(account, valueDate, bookingWatermark)
 *       What we believed about a business day, at a point in transaction
 *       time. Mechanically Q1 with a past watermark — named separately
 *       because the caller's INTENT is different, and because the live-fire
 *       question ("prove what you believed on Wednesday") is asked in those
 *       words.
 *
 * ===========================================================================
 * THE DEFINITION IS IN POSTGRES, NOT HERE
 * ===========================================================================
 *
 * Every function below is a call to `ledger_availability()` or
 * `ledger_settled_cents()` (migration 0022). The SQL view
 * `v_available_balance` is a call to the same body. So the view and this
 * module cannot drift, because neither of them CONTAINS a definition — the
 * way `v_hold_drift` keeps the hold model and its view honest, except by
 * construction rather than by invariant, which is strictly stronger.
 *
 * `v_balance_definition_drift` is the invariant anyway, for the one seam
 * that is still two bodies: this function's release predicate against
 * `v_hold_state`'s. It must return zero rows.
 *
 * ===========================================================================
 * NO EAGER `./db` IMPORT
 * ===========================================================================
 *
 * `import type { Sql }` is erased at compile time and nothing here opens a
 * socket, so this module can be imported by a test that holds no credentials
 * — which is what CI is, deliberately. `balances.ts` is the layer that binds
 * the default connection.
 */

import "server-only";

import type { Sql } from "./db";

export type { Sql };

/* -------------------------------------------------------------------------- */
/* The point in the two clocks                                                */
/* -------------------------------------------------------------------------- */

/**
 * One instant, one watermark, one business day — taken once and passed into
 * every question below.
 *
 * Three reads taken against three separate `now()` calls drift by however long
 * the round trips took, and an entry booked in that window appears in one
 * answer and not another. A snapshot makes the answers a consistent set rather
 * than a collage.
 */
export interface LedgerSnapshot {
  /** Wall clock at the moment the snapshot was taken (transaction time). */
  readonly asOf: Date;
  /** Today in book time, `YYYY-MM-DD`. The VALUE axis. */
  readonly valueDate: string;
  /** The highest `booking_seq` we have learned. The BOOKING axis. */
  readonly bookingWatermark: bigint;
}

/**
 * The live point: today's business day, everything we have learned, now.
 *
 * `clock_timestamp()`, NOT `now()`. Inside a transaction `now()` is the
 * transaction's START, and `ledger_append()` stamps `booking_time` from
 * `clock_timestamp()`. A watermark of "MAX(booking_seq) WHERE booking_time <=
 * now()" read inside the transaction that just posted an entry therefore
 * EXCLUDES that entry, and the balance comes back as though the posting had
 * not happened. Standing orders and pot transfers both funds-check inside the
 * transaction that posts, so this is not hypothetical.
 *
 * The live watermark has no time predicate at all: MVCC already decides what
 * this transaction can see, and MAX over that is exactly "everything we have
 * learned". The time predicate belongs on the HISTORICAL watermark — see
 * `bookingWatermarkAt`, where it is the entire point.
 *
 * `valueDate` comes from the database's own `book_date()`, so the business-day
 * boundary is the Fed/ACH one (America/New_York) and there is one definition
 * of it rather than two.
 */
export async function readSnapshot(conn: Sql): Promise<LedgerSnapshot> {
  const rows = await conn<
    { as_of: Date; value_date: string; booking_watermark: bigint }[]
  >`
    SELECT clock_timestamp()                                   AS as_of,
           to_char(book_date(clock_timestamp()), 'YYYY-MM-DD') AS value_date,
           COALESCE((SELECT MAX(e.booking_seq) FROM journal_entry e), 0)::bigint
                                                               AS booking_watermark`;

  const row = rows[0];
  if (row === undefined) {
    throw new Error("snapshot query returned no row");
  }
  return {
    asOf: row.as_of,
    valueDate: row.value_date,
    bookingWatermark: row.booking_watermark,
  };
}

/**
 * The booking watermark for a wall-clock instant: the highest `booking_seq` we
 * had recorded by then. Turns "what did you believe on Wednesday" into a
 * number Q1 and Q3 can use.
 *
 * This one DOES filter on `booking_time`, because a past watermark is exactly
 * the question "what had we learned by this instant".
 */
export async function bookingWatermarkAt(at: Date, conn: Sql): Promise<bigint> {
  const rows = await conn<{ seq: bigint }[]>`
    SELECT COALESCE(MAX(booking_seq), 0)::bigint AS seq
      FROM journal_entry WHERE booking_time <= ${at.toISOString()}::timestamptz`;
  return rows[0]?.seq ?? 0n;
}

/** A snapshot pinned to a past business day and a past watermark. */
export function historicSnapshot(
  valueDate: string,
  bookingWatermark: bigint,
  asOf: Date,
): LedgerSnapshot {
  return { asOf, valueDate, bookingWatermark };
}

/* -------------------------------------------------------------------------- */
/* Q1 — the settled ledger balance                                            */
/* -------------------------------------------------------------------------- */

/**
 * Q1. Σ amount_cents × normal_side over the account's lines, with
 *
 *     value_date  <= snapshot.valueDate       which business days count
 *     booking_seq <= snapshot.bookingWatermark what we had learned by then
 *
 * FUTURE-DATED ENTRIES ARE EXCLUDED. A settlement booked today for tomorrow's
 * business day is a fact we know; it is not money the customer has. What
 * happens to a future-dated DEBIT is the subject of Q2, and the asymmetry
 * there is what makes this exclusion safe rather than merely tidy.
 *
 * Sign: lines are stored debit-positive / credit-negative, so a customer with
 * $100 on deposit has lines summing to −10000 (a liability of the bank). The
 * `× normal_side` in the SQL body turns that into the +10000 a human means.
 */
export async function settledBalanceCents(
  accountId: string,
  snapshot: LedgerSnapshot,
  conn: Sql,
): Promise<bigint> {
  const rows = await conn<{ cents: bigint }[]>`
    SELECT ledger_settled_cents(
             ${accountId}::uuid,
             ${snapshot.valueDate}::date,
             ${snapshot.bookingWatermark}::bigint) AS cents`;
  return rows[0]?.cents ?? 0n;
}

/* -------------------------------------------------------------------------- */
/* Q3 — what we believed                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Q3. The balance of a business day AS WE BELIEVED IT at a point in
 * transaction time.
 *
 * The published live-fire question is "a merchant reverses Tuesday's
 * settlement on Thursday — show Tuesday's statement now, and prove what you
 * believed on Wednesday." The first is Q1 with today's watermark. The second
 * is this, with `valueDate` = Tuesday and `bookingWatermark` = Wednesday's
 * watermark. Both are true, neither overwrote the other, nothing was edited.
 *
 * Mechanically identical to Q1 and deliberately not collapsed into it: a
 * caller reaching for "what did we believe" should not have to know that the
 * answer is the same query with a different argument.
 */
export async function believedBalanceCents(
  accountId: string,
  valueDate: string,
  bookingWatermark: bigint,
  conn: Sql,
): Promise<bigint> {
  const rows = await conn<{ cents: bigint }[]>`
    SELECT ledger_settled_cents(
             ${accountId}::uuid,
             ${valueDate}::date,
             ${bookingWatermark}::bigint) AS cents`;
  return rows[0]?.cents ?? 0n;
}

/* -------------------------------------------------------------------------- */
/* Q2 — availability                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The decomposition. Every term is a separate fact and the screen shows all of
 * them, because "available is $X" is not an answer an operator can check and
 * "ledger $A less holds $B less uncleared $C less committed $D" is.
 */
export interface Availability {
  /** Q1 at the same snapshot. */
  readonly ledgerCents: bigint;
  /** Active card authorisations and manual holds. Positive = withheld. */
  readonly holdsCents: bigint;
  /** Active uncleared-credit holds. Positive = withheld. */
  readonly unclearedCents: bigint;
  /**
   * Debits already booked with a future value date. Positive = committed out.
   * Money that has left as far as spending power is concerned.
   */
  readonly pendingOutboundCents: bigint;
  /** ledger − holds − uncleared − pendingOutbound. May be negative. */
  readonly availableCents: bigint;
}

/**
 * Q2. Available for ONE account, at one snapshot.
 *
 * ===========================================================================
 * THE FUTURE-DATED QUESTION, DECIDED
 * ===========================================================================
 *
 * Does "available" include an entry dated tomorrow? The answer is different
 * for a credit and for a debit, and the asymmetry is the point.
 *
 *   A FUTURE-DATED CREDIT IS NOT AVAILABLE. A customer cannot spend
 *   tomorrow's settlement today. `availableBalance()` used to include it: on
 *   the demo account that handed the customer $8,421.30 of standing-order
 *   credits value-dated 2027, today, as spendable money. There is no reading
 *   of "available" under which that is true.
 *
 *   A FUTURE-DATED DEBIT IS SUBTRACTED ANYWAY. Money already booked to leave
 *   has been committed. An outbound ACH originated today for tomorrow's
 *   settlement is gone as far as spending power goes, and a customer who can
 *   spend it again in the window before it settles is a customer we have
 *   overdrawn on their behalf. $37,212.00 of such debits sit on the demo
 *   account right now.
 *
 * These are not opposite rules. They are the same rule — available is the
 * money you could spend right now without relying on something that has not
 * happened yet — applied to two cases where prudence points opposite ways.
 * Symmetry here would be the mistake: a definition symmetric in VALUE DATE is
 * asymmetric in RISK, and the risk is whose money it is.
 *
 * The pending-outbound term is a DERIVED hold. It needs no hold row because
 * the journal entry is already there, and it cannot double-count against a
 * memo hold because the two live in different books.
 *
 * ===========================================================================
 * THE HOLD TERMS
 * ===========================================================================
 *
 * A hold only withholds from its OWN value date. A hold value-dated tomorrow
 * guards a credit that is not in the ledger term yet either, and deducting it
 * charges the customer twice for the same dollar — once by leaving the credit
 * out, once by subtracting the hold. That bug was live on the funding screen
 * at $3,750.00.
 *
 * Manual holds count. The old `availableBalance()` bucketed `card_auth` and
 * `uncleared_credit` and silently dropped `manual` — an operator hold that
 * freed the money it was placed to withhold.
 *
 * Release is `v_hold_state`'s predicate evaluated at `snapshot.asOf`: the
 * closure row less its reversal (migration 0011), the card model as a fold
 * over the event SET, and the clock for an uncleared credit. Never a
 * provider's status field — Lithic reports SETTLED while a partial hold is
 * still outstanding (measured; DECISIONS 006).
 */
export async function accountAvailability(
  accountId: string,
  snapshot: LedgerSnapshot,
  conn: Sql,
): Promise<Availability> {
  const rows = await conn<
    {
      ledger_cents: bigint;
      hold_cents: bigint;
      uncleared_cents: bigint;
      pending_outbound_cents: bigint;
      available_cents: bigint;
    }[]
  >`
    SELECT * FROM ledger_availability(
      ${accountId}::uuid,
      ${snapshot.valueDate}::date,
      ${snapshot.bookingWatermark}::bigint,
      ${snapshot.asOf.toISOString()}::timestamptz)`;

  const row = rows[0];
  return {
    ledgerCents: row?.ledger_cents ?? 0n,
    holdsCents: row?.hold_cents ?? 0n,
    unclearedCents: row?.uncleared_cents ?? 0n,
    pendingOutboundCents: row?.pending_outbound_cents ?? 0n,
    availableCents: row?.available_cents ?? 0n,
  };
}

/**
 * The business's main deposit leaf — `code = '2100'`, exactly one per
 * business.
 *
 * Pot sub-accounts carry a qualified code (`2100.<uuid>`, migration 0015), so
 * the bare code is the spendable leaf and pots are excluded by construction
 * rather than by a predicate someone has to remember.
 */
export async function mainDepositAccountId(
  businessId: string,
  conn: Sql,
): Promise<string | null> {
  const rows = await conn<{ id: string }[]>`
    SELECT id FROM account
     WHERE code = '2100'
       AND book = 'financial'
       AND business_id = ${businessId}::uuid
     LIMIT 1`;
  return rows[0]?.id ?? null;
}

/* -------------------------------------------------------------------------- */
/* Q2 reached by business — and the one answer that is not a number           */
/* -------------------------------------------------------------------------- */

/**
 * The named state for "there was no account, so nothing was read".
 *
 * House form, the same one `PAYEE_BOOK_UNREADABLE` and `TRIAGE_NO_DATABASE`
 * take: a code a caller can branch on, a message safe to show, and `details`
 * shaped so it drops straight into `ErrorShape` and out through whichever
 * refusal channel the screen already has. It is deliberately NOT an
 * `Availability` — see `businessAvailability`.
 */
export const LEDGER_NO_DEPOSIT_ACCOUNT = "LEDGER_NO_DEPOSIT_ACCOUNT";

export interface NoDepositAccount {
  readonly code: typeof LEDGER_NO_DEPOSIT_ACCOUNT;
  readonly message: string;
  readonly details: {
    readonly businessId: string;
    /** A refresh does not open a deposit account. */
    readonly retryable: false;
    readonly source: "ledger.businessAvailability";
    readonly operation: "the business deposit balance";
  };
}

/**
 * What Q2 answers when it is asked by business id: either the decomposition,
 * or the reason there isn't one. Never both, and never a stand-in for one
 * dressed as the other.
 */
export type BusinessAvailability = Availability | NoDepositAccount;

/**
 * The narrowing every caller must pass through before it can read a term.
 *
 * A type guard rather than a `code in x` written at each call site, so that
 * the discriminant has one definition here too.
 */
export function isLedgerRead(result: BusinessAvailability): result is Availability {
  return !("code" in result);
}

/** The refusal, or `null` if this was a real read. The other half of the pair. */
export function noDepositAccountRefusal(
  result: BusinessAvailability,
): NoDepositAccount | null {
  return "code" in result ? result : null;
}

/**
 * The bridge for a caller whose own signature already promised a number.
 *
 * `balances.ts`'s `availableBalance()` returns `Promise<AvailableBalance>` and
 * is called from eleven places that read `.availableCents` directly. Until
 * those eleven narrow for themselves, this is what that layer wraps the call
 * in: it hands back the decomposition when there was one, and THROWS when
 * there was not. It never invents one.
 *
 * A throw, not a zero, because the two are not equally wrong. A screen that
 * catches this shows an error; a screen handed five zeros shows a balance. The
 * error is recoverable by a human reading it. The balance is not, because
 * nobody can tell it is wrong.
 *
 * This is a migration aid and it is the weaker half of the pair — prefer
 * `isLedgerRead()` at the call site, which makes the state part of the type
 * rather than part of the control flow.
 */
export function unwrapLedgerRead(result: BusinessAvailability): Availability {
  if (isLedgerRead(result)) return result;
  throw Object.assign(new Error(result.message), {
    code: result.code,
    details: result.details,
  });
}

/**
 * Q2, reached by business rather than by account.
 *
 * ===========================================================================
 * A BUSINESS WITH NO `2100` LEAF GETS A NAMED STATE, NOT FIVE ZEROS
 * ===========================================================================
 *
 * This function used to answer that case with five hardcoded `0n`, under the
 * argument that "this business holds no money" is an answer. It is an answer.
 * It is not one this function performed. `ledger_availability()` was never
 * called: there was no account id to call it with. The four terms the screen
 * prints — ledger, holds, uncleared, committed — were not small, they were
 * absent, and a caller handed `0n` in each of them has no way to tell that
 * from a deposit account that really does sum to zero. Silverline Freight Co.
 * is in this state on the live book right now, and the client surface drew a
 * green LIVE badge over "Ledger $0.00 − card holds $0.00 − uncleared $0.00 −
 * committed $0.00": four figures presented as a read of a ledger, none of
 * which anyone read.
 *
 * The zeros were also load-bearing in the wrong direction. A funds check that
 * reads `availableCents === 0n` declines, which is the safe outcome by luck
 * rather than by construction — the same five zeros say "no money here" to a
 * balance screen, which is a claim, and the claim is not ours to make.
 *
 * So: `ledger_availability()` is still the one definition, and this function
 * still contains none of it. What changed is that when there is nothing to
 * read, it says so by name instead of composing a result nobody computed.
 * `isLedgerRead()` is the gate to the numbers; `NoDepositAccount` is what is
 * on the other side of it.
 *
 * A REAL ZERO IS STILL A REAL ZERO. A business whose `2100` leaf exists and
 * sums to nothing returns five genuine `0n` from the function, as it always
 * did. Both halves are proved in `business-availability.integration.test.ts`,
 * because a fix that refuses everything is as wrong as the bug.
 */
export async function businessAvailability(
  businessId: string,
  snapshot: LedgerSnapshot,
  conn: Sql,
): Promise<BusinessAvailability> {
  const accountId = await mainDepositAccountId(businessId, conn);
  if (accountId === null) {
    return {
      code: LEDGER_NO_DEPOSIT_ACCOUNT,
      message:
        "This business has no deposit account, so no ledger balance, no hold, no uncleared credit and no committed debit was read. Nothing here is a statement about money: an absent account is not a customer holding nothing.",
      details: {
        businessId,
        retryable: false,
        source: "ledger.businessAvailability",
        operation: "the business deposit balance",
      },
    };
  }
  return accountAvailability(accountId, snapshot, conn);
}

/**
 * A HOUSE account by chart code — `business_id IS NULL`, one per code.
 *
 * A named reader, so that a caller wanting "the house cash leaf" does not write
 * `SELECT id FROM account WHERE code = '1110'` of its own. That is the shape
 * `src/lib/ledger/boundary.test.ts` exists to stop spreading, and the way to
 * stop it spreading is to make the alternative shorter than the SQL.
 *
 * `null` rather than a throw: "this book has no such account" is an answer, and
 * a seeded database and an empty one are both legitimate states to be in.
 */
export async function houseAccountId(
  code: string,
  conn: Sql,
): Promise<string | null> {
  const rows = await conn<{ id: string }[]>`
    SELECT id FROM account
     WHERE code = ${code}
       AND business_id IS NULL
     ORDER BY id
     LIMIT 1`;
  return rows[0]?.id ?? null;
}

/* -------------------------------------------------------------------------- */
/* The book as a whole                                                        */
/* -------------------------------------------------------------------------- */

/** Trial balance: every line in the financial book must sum to zero. */
export async function trialBalanceCents(conn: Sql): Promise<bigint> {
  const rows = await conn<{ total: bigint }[]>`
    SELECT COALESCE(SUM(l.amount_cents), 0)::bigint AS total
      FROM journal_line l
      JOIN journal_entry e ON e.id = l.entry_id
     WHERE e.book = 'financial'`;
  return rows[0]?.total ?? 0n;
}

/**
 * The invariant that holds this module and `v_hold_state` equal.
 *
 * Returns the drifting rows, which must be none. Nothing repairs what it
 * reports — a row here is a bug in the posting path or in one of the two
 * release predicates, never a number to overwrite.
 */
export async function balanceDefinitionDrift(
  conn: Sql,
): Promise<readonly { accountId: string; availabilitySays: string; holdStateSays: string }[]> {
  const rows = await conn<
    { account_id: string; availability_says: string; hold_state_says: string }[]
  >`SELECT account_id, availability_says::text, hold_state_says::text
      FROM v_balance_definition_drift`;
  return rows.map((r) => ({
    accountId: r.account_id,
    availabilitySays: r.availability_says,
    holdStateSays: r.hold_state_says,
  }));
}
