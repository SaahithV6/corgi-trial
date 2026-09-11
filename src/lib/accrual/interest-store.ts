import "server-only";

/**
 * Every SQL statement the interest leg issues, in one file.
 *
 * `store.ts`'s rule, applied again: **no date arithmetic happens in
 * TypeScript.** Which dates an enrolment still owes is answered by
 * `interest_due_dates()` in migration 0024 §15, what day it is is answered by
 * the database, and — new here — **what the balance was** is answered by
 * `ledger_settled_cents()` from 0022, which is THE balance definition in this
 * system rather than a fifth private copy of one.
 *
 * The one thing this module does NOT do is write a journal line. Postings go
 * through `postEntry()` and nothing else; what is written here is the claim and
 * the audit of the decision, which are not money rows and are append-only
 * anyway (0024 §17).
 */

import { sql, type Sql } from "@/lib/ledger/db";
import {
  currentBookingWatermark,
  findAccount,
  listBusinesses,
  type BusinessRow,
} from "@/lib/ledger/queries";

import { CATCH_UP_WINDOW_DAYS } from "./types";
import {
  computeDailyInterest,
  type DailyInterest,
  type InterestDisposition,
  type InterestInvariants,
  type InterestMonth,
  type InterestPosting,
  type InterestRatePolicy,
  type InterestRounding,
  type InterestSchedule,
  type InterestSide,
} from "./interest-types";

/* -------------------------------------------------------------------------- */
/* The rate card                                                              */
/* -------------------------------------------------------------------------- */

/** Every version of every rate card, newest first. `v_interest_rate_card`. */
export async function listRateCard(limit = 40, conn: Sql = sql): Promise<InterestRatePolicy[]> {
  const rows = await conn<
    {
      id: string;
      tier: string;
      tier_description: string;
      effective_from: string;
      superseded_on: string | null;
      credit_rate_bps: number;
      overdraft_rate_bps: number;
      day_count_denominator: number;
      note: string;
      created_at: Date;
      days_priced: bigint;
    }[]
  >`
    SELECT id, tier, tier_description,
           effective_from::text AS effective_from,
           superseded_on::text  AS superseded_on,
           credit_rate_bps, overdraft_rate_bps, day_count_denominator,
           note, created_at, days_priced
      FROM v_interest_rate_card
     ORDER BY tier, effective_from DESC
     LIMIT ${limit}`;

  return rows.map((r) => ({
    id: r.id,
    tier: r.tier,
    tierDescription: r.tier_description,
    effectiveFrom: r.effective_from,
    supersededOn: r.superseded_on,
    creditRateBps: r.credit_rate_bps,
    overdraftRateBps: r.overdraft_rate_bps,
    dayCountDenominator: r.day_count_denominator,
    note: r.note,
    createdAt: r.created_at.toISOString(),
    daysPriced: Number(r.days_priced),
  }));
}

/**
 * The rate card as it stood on a business date.
 *
 * `interest_rate_at()` is the ONLY definition of this and it resolves on the
 * ACCRUAL date, so a replay of an old date re-derives the old rate by
 * construction rather than by anybody remembering to. The tick asks it, the
 * lifecycle trigger asks it again before it will store the row, and
 * `v_interest_rate_drift` asks it of the whole book afterwards.
 */
export async function rateAt(
  tier: string,
  isoDate: string,
  conn: Sql = sql,
): Promise<{
  readonly policyId: string;
  readonly effectiveFrom: string;
  readonly creditRateBps: number;
  readonly overdraftRateBps: number;
  readonly dayCount: number;
} | null> {
  const [row] = await conn<
    {
      id: string;
      effective_from: string;
      credit_rate_bps: number;
      overdraft_rate_bps: number;
      day_count_denominator: number;
    }[]
  >`
    SELECT id, effective_from::text AS effective_from,
           credit_rate_bps, overdraft_rate_bps, day_count_denominator
      FROM interest_rate_at(${tier}, ${isoDate}::date)
     WHERE id IS NOT NULL`;

  return row === undefined
    ? null
    : {
        policyId: row.id,
        effectiveFrom: row.effective_from,
        creditRateBps: row.credit_rate_bps,
        overdraftRateBps: row.overdraft_rate_bps,
        dayCount: row.day_count_denominator,
      };
}

/* -------------------------------------------------------------------------- */
/* Enrolments, days and roll-ups — the read side                              */
/* -------------------------------------------------------------------------- */

/**
 * Every deposit leaf on the book, keyed by account id.
 *
 * `listBusinesses()` is the ledger's own reader for the `business` ⟕ `2100`
 * join — the one five modules had written for themselves — and it carries the
 * entity id, the legal name and the account name, which is exactly what an
 * enrolment row needs to be readable. Asking for it here rather than writing
 * `JOIN account` is what keeps this module on the right side of the ledger
 * boundary `src/lib/ledger/boundary.test.ts` enforces: a module that joins
 * `account` has, by definition, its own opinion about which account is which.
 */
async function depositLeaves(conn: Sql): Promise<ReadonlyMap<string, BusinessRow>> {
  const businesses = await listBusinesses(conn);
  const out = new Map<string, BusinessRow>();
  for (const b of businesses) {
    if (b.depositAccountId !== null) out.set(b.depositAccountId, b);
  }
  return out;
}

export async function listInterestSchedules(
  limit = 50,
  conn: Sql = sql,
): Promise<InterestSchedule[]> {
  const [leaves, watermark] = await Promise.all([
    depositLeaves(conn),
    currentBookingWatermark(conn),
  ]);

  const rows = await conn<
    {
      id: string;
      account_id: string;
      rate_tier: string;
      currency: string;
      start_date: string;
      end_date: string | null;
      schedule_key: string;
      created_at: Date;
      next_due_date: string | null;
      current_balance_cents: bigint;
    }[]
  >`
    SELECT s.id,
           s.account_id,
           s.rate_tier,
           s.currency,
           s.start_date::text AS start_date,
           s.end_date::text   AS end_date,
           s.schedule_key,
           s.created_at,
           (SELECT min(d)::text
              FROM interest_due_dates(
                     s.id, s.start_date,
                     LEAST(COALESCE(s.end_date, book_date(now())), book_date(now()))) AS d
           ) AS next_due_date,
           -- Context for the enrolment row, not a stored figure: the balance
           -- as 0022's canonical function answers it, at the live watermark,
           -- computed on every read and never written down.
           ledger_settled_cents(s.account_id, book_date(now()), ${watermark.toString()}::bigint)
             AS current_balance_cents
      FROM interest_schedule s
     ORDER BY s.start_date, s.id
     LIMIT ${limit}`;

  return rows
    .map((r) => {
      const leaf = leaves.get(r.account_id);
      return {
        id: r.id,
        accountId: r.account_id,
        accountName: leaf?.depositAccountName ?? r.account_id,
        businessId: leaf?.businessId ?? null,
        businessName: leaf?.legalName ?? null,
        rateTier: r.rate_tier,
        currency: r.currency,
        startDate: r.start_date,
        endDate: r.end_date,
        scheduleKey: r.schedule_key,
        createdAt: r.created_at.toISOString(),
        nextDueDate: r.next_due_date,
        currentBalanceCents: r.current_balance_cents,
      };
    })
    .sort((a, b) => (a.businessName ?? "").localeCompare(b.businessName ?? ""));
}

type DailyRow = {
  readonly interest_day_id: string;
  readonly schedule_id: string;
  readonly account_id: string;
  readonly business_name: string | null;
  readonly rate_tier: string;
  readonly accrual_date: string;
  readonly idempotency_key: string;
  readonly claimed_at: Date;
  readonly claimed_by: string;
  readonly disposition: InterestDisposition | null;
  readonly side: InterestSide | null;
  readonly policy_id: string | null;
  readonly policy_effective_from: string | null;
  readonly basis_balance_cents: bigint | null;
  readonly observed_booking_seq: bigint | null;
  readonly rate_bps: number | null;
  readonly day_count: number | null;
  readonly rounding: InterestRounding | null;
  readonly entry_id: string | null;
  readonly skip_reason: string | null;
  readonly decided_at: Date | null;
  readonly decided_by_run: string | null;
};

/**
 * The stored working, turned back into a `DailyInterest`.
 *
 * Only the three INPUTS are read back — balance, rate, day count — and every
 * derived field is recomputed by `computeDailyInterest()`. Same reasoning as
 * `toAllocation()` in `store.ts`: the screen cannot render a numerator, a
 * remainder or a rounding direction that disagrees with the rule, because it
 * renders the rule's own output. The stored columns are still checked, by
 * `interest_posting_arithmetic`, which is what makes reading only three of
 * them safe — and the stored `rounding` is asserted against the recomputed one
 * here rather than merely ignored, so a disagreement is loud.
 */
function toInterest(row: DailyRow): DailyInterest | null {
  if (row.basis_balance_cents === null || row.rate_bps === null || row.day_count === null) {
    return null;
  }
  const computed = computeDailyInterest({
    balanceCents: row.basis_balance_cents,
    rateBps: row.rate_bps,
    dayCount: row.day_count,
  });
  if (row.rounding !== null && row.rounding !== computed.rounding) {
    throw new Error(
      `interest day ${row.interest_day_id} stored rounding '${row.rounding}' but the rule recomputes '${computed.rounding}' — interest_posting_arithmetic should have refused this row`,
    );
  }
  return computed;
}

/** Every claimed day and its decision, newest accrual date first. */
export async function listInterestPostings(
  limit = 240,
  conn: Sql = sql,
): Promise<InterestPosting[]> {
  const rows = await conn<DailyRow[]>`
    SELECT interest_day_id, schedule_id, account_id, business_name, rate_tier,
           accrual_date::text AS accrual_date,
           idempotency_key, claimed_at, claimed_by,
           disposition::text AS disposition,
           side::text        AS side,
           policy_id,
           policy_effective_from::text AS policy_effective_from,
           basis_balance_cents, observed_booking_seq,
           rate_bps, day_count,
           rounding::text    AS rounding,
           entry_id, skip_reason, decided_at, decided_by_run
      FROM v_interest_daily
     ORDER BY accrual_date DESC, business_name NULLS LAST
     LIMIT ${limit}`;

  return rows.map((row) => ({
    interestDayId: row.interest_day_id,
    scheduleId: row.schedule_id,
    accountId: row.account_id,
    businessName: row.business_name,
    rateTier: row.rate_tier,
    accrualDate: row.accrual_date,
    idempotencyKey: row.idempotency_key,
    claimedAt: row.claimed_at.toISOString(),
    claimedBy: row.claimed_by,
    disposition: row.disposition,
    entryId: row.entry_id,
    skipReason: row.skip_reason,
    interest: toInterest(row),
    policyId: row.policy_id,
    policyEffectiveFrom: row.policy_effective_from,
    observedBookingSeq: row.observed_booking_seq,
    decidedAt: row.decided_at === null ? null : row.decided_at.toISOString(),
    decidedByRun: row.decided_by_run,
  }));
}

/** The month roll-ups, newest month first. `v_interest_month` in 0024 §16. */
export async function listInterestMonths(limit = 60, conn: Sql = sql): Promise<InterestMonth[]> {
  const rows = await conn<
    {
      schedule_id: string;
      account_id: string;
      business_name: string | null;
      rate_tier: string;
      month_start: string;
      days_claimed: bigint;
      days_decided: bigint;
      days_posted: bigint;
      days_skipped: bigint;
      days_credit: bigint;
      days_overdraft: bigint;
      days_rounded_up: bigint;
      days_rounded_down: bigint;
      days_tie_to_even: bigint;
      days_exact: bigint;
      credit_interest_cents: bigint;
      overdraft_interest_cents: bigint;
      min_basis_cents: bigint | null;
      max_basis_cents: bigint | null;
    }[]
  >`
    SELECT m.schedule_id, m.account_id, b.legal_name AS business_name, m.rate_tier,
           m.month_start::text AS month_start,
           m.days_claimed, m.days_decided, m.days_posted, m.days_skipped,
           m.days_credit, m.days_overdraft,
           m.days_rounded_up, m.days_rounded_down, m.days_tie_to_even, m.days_exact,
           m.credit_interest_cents::bigint    AS credit_interest_cents,
           m.overdraft_interest_cents::bigint AS overdraft_interest_cents,
           m.min_basis_cents, m.max_basis_cents
      FROM v_interest_month m
      LEFT JOIN business b ON b.id = m.business_id
     ORDER BY m.month_start DESC, b.legal_name NULLS LAST
     LIMIT ${limit}`;

  return rows.map((r) => ({
    scheduleId: r.schedule_id,
    accountId: r.account_id,
    businessName: r.business_name,
    rateTier: r.rate_tier,
    monthStart: r.month_start,
    daysClaimed: Number(r.days_claimed),
    daysDecided: Number(r.days_decided),
    daysPosted: Number(r.days_posted),
    daysSkipped: Number(r.days_skipped),
    daysCredit: Number(r.days_credit),
    daysOverdraft: Number(r.days_overdraft),
    daysRoundedUp: Number(r.days_rounded_up),
    daysRoundedDown: Number(r.days_rounded_down),
    daysTieToEven: Number(r.days_tie_to_even),
    daysExact: Number(r.days_exact),
    creditInterestCents: r.credit_interest_cents,
    overdraftInterestCents: r.overdraft_interest_cents,
    minBasisCents: r.min_basis_cents,
    maxBasisCents: r.max_basis_cents,
  }));
}

/**
 * The invariant counters, in one round trip.
 *
 * The last two are not invariants — they are THE MEASUREMENT, asked of the
 * live book rather than asserted from a brief. `overdrawnAccounts` is
 * `v_overdrawn_accounts` (today) and `overdrawnDaysInWindow` is the strong
 * form: how many (deposit account, value date) pairs inside the catch-up
 * window had a debit balance at the live watermark. Both were zero when this
 * feature shipped, which is why 4400 has no rows and the screen says so.
 */
export async function readInterestInvariants(conn: Sql = sql): Promise<InterestInvariants> {
  const [leaves, watermark] = await Promise.all([
    depositLeaves(conn),
    currentBookingWatermark(conn),
  ]);
  const openLeafIds = [...leaves.values()]
    .filter((b) => b.depositOpen && b.depositAccountId !== null)
    .map((b) => b.depositAccountId as string);

  const [row] = await conn<
    {
      ledger_drift: bigint;
      rate_drift: bigint;
      unresolved: bigint;
      gap: bigint;
      overdrawn_accounts: bigint;
      overdrawn_days_in_window: bigint;
      overdrawn_cents: bigint;
      priced_before_close: bigint;
      priced_before_close_cents: bigint;
      mispriced_uncorrected: bigint;
      adjustments: bigint;
      adjustment_drift: bigint;
    }[]
  >`
    WITH win AS (
      SELECT acct AS account_id, d::date AS value_date
        FROM unnest(${openLeafIds}::uuid[]) AS acct
        CROSS JOIN generate_series(
          (book_date(now()) - ${CATCH_UP_WINDOW_DAYS}::int)::timestamp,
          book_date(now())::timestamp,
          interval '1 day') AS d
    )
    SELECT (SELECT count(*) FROM v_interest_ledger_drift) AS ledger_drift,
           (SELECT count(*) FROM v_interest_rate_drift)   AS rate_drift,
           (SELECT count(*) FROM v_interest_unresolved)   AS unresolved,
           (SELECT count(*) FROM v_interest_gap)          AS gap,
           (SELECT count(*) FROM v_overdrawn_accounts)    AS overdrawn_accounts,
           (SELECT count(*) FROM win
             WHERE ledger_settled_cents(
                     win.account_id, win.value_date, ${watermark.toString()}::bigint) < 0)
                                                          AS overdrawn_days_in_window,
           (SELECT COALESCE(sum(overdraft_cents), 0)::bigint
              FROM v_overdrawn_accounts)                  AS overdrawn_cents,
           -- PRICED WHILE THE DAY WAS STILL OPEN. The claim's own timestamp,
           -- read in BOOK time, against the date it claimed: a day claimed on
           -- or before itself was priced on a balance that was not that date's
           -- closing balance, and UNIQUE (schedule, accrual_date) means it can
           -- never be priced again.
           (SELECT count(*)
              FROM interest_day d
              JOIN interest_posting p ON p.interest_day_id = d.id
             WHERE p.disposition = 'posted'
               AND (d.claimed_at AT TIME ZONE 'America/New_York')::date <= d.accrual_date)
                                                          AS priced_before_close,
           (SELECT COALESCE(sum(p.amount_cents), 0)::bigint
              FROM interest_day d
              JOIN interest_posting p ON p.interest_day_id = d.id
             WHERE p.disposition = 'posted'
               AND (d.claimed_at AT TIME ZONE 'America/New_York')::date <= d.accrual_date)
                                                          AS priced_before_close_cents,
           -- 0049. THE QUEUE, not an invariant: of those days, the ones whose
           -- date has now CLOSED, whose closed figure differs from what was
           -- posted, and which nothing has corrected. Zero while the mispriced
           -- dates are still open — the calendar, not health.
           (SELECT count(*) FROM v_interest_mispriced_uncorrected)
                                                          AS mispriced_uncorrected,
           (SELECT count(*) FROM interest_adjustment)     AS adjustments,
           -- MUST be 0. Check 5b's question, asked of interest_adjustment:
           -- every stored decision must still re-derive from the journal at
           -- its own watermark and the card effective on its own date.
           (SELECT count(*) FROM v_interest_adjustment_drift)
                                                          AS adjustment_drift`;

  if (row === undefined) throw new Error("interest: the invariant query returned no row");
  return {
    ledgerDrift: Number(row.ledger_drift),
    rateDrift: Number(row.rate_drift),
    unresolved: Number(row.unresolved),
    gap: Number(row.gap),
    overdrawnAccounts: Number(row.overdrawn_accounts),
    overdrawnDaysInWindow: Number(row.overdrawn_days_in_window),
    overdrawnCents: Number(row.overdrawn_cents),
    pricedBeforeClose: Number(row.priced_before_close),
    pricedBeforeCloseCents: Number(row.priced_before_close_cents),
    mispricedUncorrected: Number(row.mispriced_uncorrected),
    adjustments: Number(row.adjustments),
    adjustmentDrift: Number(row.adjustment_drift),
  };
}

/* -------------------------------------------------------------------------- */
/* What is owed                                                               */
/* -------------------------------------------------------------------------- */

export type DueInterestDay = {
  readonly scheduleId: string;
  readonly accountId: string;
  readonly businessName: string | null;
  readonly rateTier: string;
  readonly entityId: string;
  readonly accrualDate: string;
};

/**
 * THE LAST BUSINESS DATE THAT HAS ACTUALLY ENDED.
 *
 * ===========================================================================
 * WHY THE INTEREST LEG MAY NOT PRICE THE CURRENT BOOK DATE
 * ===========================================================================
 *
 * The basis is defined — in docs/ACCRUAL.md §16 and in `basisAt()` below — as
 * "the settled ledger balance at the END of the business date". A date that
 * has not ended does not have one. What the tick can read while the date is
 * open is the balance AT THE MOMENT THE TICK RAN, which is a different number
 * and is not the one the product promises.
 *
 * That would be a small sin if the day could be re-priced later. It cannot.
 * `interest_day` is UNIQUE (schedule_id, accrual_date) — the property that
 * makes the tick exactly-once — so the first tick to touch an open date
 * FREEZES a mid-day balance as that date's end-of-day basis, for ever, and
 * the only repair available on an append-only ledger is an interest
 * adjustment (a reversal plus a re-book) which this system does not have
 * (§19).
 *
 * MEASURED, NOT THEORISED. On 2026-09-11 the tick priced that same date at
 * booking watermark 2265, when `Holds Integration Fixture Co.` stood at
 * +$145,315.17, and paid it 498¢ of CREDIT interest on `5400`. Three thousand
 * entries later the same account closed 2026-09-11 at −$858,941.45 — the
 * first debit balance this book has ever had — and the day that should have
 * priced on `4400 Interest income — overdraft` can never be taken again. All
 * five enrolments were priced that way on that date: four by a material
 * amount, one with the sign reversed.
 *
 * So the horizon is `book_date(now()) - 1`, in book time (America/New_York),
 * and a caller that asks for today is held rather than refused: the tick
 * prices every closed date it owes, reports `openDateHeld`, and takes today
 * on the first tick after midnight. Nothing is lost — a fee or an interest
 * day is owed whether or not the job ran, and the entry carries the date it
 * accrued FOR, not the date the job ran.
 *
 * THE FEE LEG IS DELIBERATELY NOT HELD BACK. A platform fee is `F`, `N` and
 * `d` — a price, a calendar and an ordinal. It does not read a balance, so
 * there is nothing about it that an open day can make wrong, and holding it
 * would delay a correct number for no reason.
 */
export async function interestPricingHorizon(
  bookDate: string,
  conn: Sql = sql,
): Promise<{ readonly horizon: string; readonly openDateHeld: boolean }> {
  const [row] = await conn<{ last_closed: string }[]>`
    SELECT (book_date(now()) - 1)::text AS last_closed`;
  const lastClosed = row?.last_closed;
  if (lastClosed === undefined) {
    throw new Error("interest: the database would not say what the last closed book date is");
  }
  // String comparison is safe and exact on ISO `YYYY-MM-DD`, which is what
  // both sides are: no Date object, no timezone, no arithmetic.
  return bookDate <= lastClosed
    ? { horizon: bookDate, openDateHeld: false }
    : { horizon: lastClosed, openDateHeld: true };
}

/**
 * Every (enrolment, date) pair owed and not yet claimed, oldest first.
 *
 * `store.ts`'s `listDue()` exactly, against `interest_due_dates()`. Oldest
 * first so that a tick which hits the limit leaves the NEWEST days undone —
 * those are the ones the next tick will certainly see, because a month-old
 * date is about to fall out of the window and a recent one is not.
 *
 * `bookDate` here is the PRICING HORIZON, not the run's book date: the caller
 * passes what `interestPricingHorizon()` returned, so the open date is already
 * out of the window. See that function for why.
 */
export async function listInterestDue(
  bookDate: string,
  limit: number,
  conn: Sql = sql,
): Promise<DueInterestDay[]> {
  const leaves = await depositLeaves(conn);

  const rows = await conn<
    {
      schedule_id: string;
      account_id: string;
      rate_tier: string;
      accrual_date: string;
    }[]
  >`
    SELECT s.id          AS schedule_id,
           s.account_id,
           s.rate_tier,
           d::text       AS accrual_date
      FROM interest_schedule s
      CROSS JOIN LATERAL interest_due_dates(
        s.id,
        GREATEST(s.start_date, ${bookDate}::date - ${CATCH_UP_WINDOW_DAYS}::int),
        LEAST(COALESCE(s.end_date, ${bookDate}::date), ${bookDate}::date)
      ) AS d
     ORDER BY d ASC, s.id
     LIMIT ${limit}`;

  return rows.map((r) => {
    const leaf = leaves.get(r.account_id);
    if (leaf === undefined) {
      // An enrolment on an account `listBusinesses()` does not return is an
      // enrolment on something that is not a customer deposit leaf, which
      // `assert_interest_schedule()` refuses at INSERT. Reaching here means
      // that trigger is gone, and posting an entry we cannot attribute to an
      // entity is worse than refusing the day.
      throw new Error(
        `interest enrolment ${r.schedule_id} names account ${r.account_id}, which is not an open customer deposit leaf`,
      );
    }
    return {
      scheduleId: r.schedule_id,
      accountId: r.account_id,
      businessName: leaf.legalName,
      rateTier: r.rate_tier,
      entityId: leaf.entityId,
      accrualDate: r.accrual_date,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* The basis                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The settled ledger balance at the end of a business date, and the watermark
 * it was true at.
 *
 * `ledger_settled_cents()` is 0022's canonical answer to "what is the balance",
 * with both bitemporal predicates: `value_date <= the accrual date` and
 * `booking_seq <= the watermark`. The watermark comes from the ledger's own
 * `currentBookingWatermark()` rather than from a `max(booking_seq)` written
 * here — four modules had that line and this is not a fifth.
 *
 * TWO STATEMENTS, AND THE PAIR IS STILL REPRODUCIBLE. The second call is
 * PARAMETERISED BY the first's answer, so the balance it returns is a
 * deterministic function of a watermark this row then records. A concurrent
 * commit between them cannot make the pair describe a moment that never
 * existed; it can only mean the watermark is one behind, which is what the
 * lifecycle trigger's re-derivation catches — and the day rolls back and
 * retries rather than storing a number the ledger does not agree with.
 *
 * NOT the available balance. Available subtracts holds, and a hold is money we
 * have not yet been asked for: the customer still holds the funds, we still
 * owe them, so we still owe interest on them. A card authorisation is not a
 * withdrawal.
 *
 * Called INSIDE the day's transaction and BEFORE anything is posted, so the
 * interest entry this tick is about to write — value-dated the accrual date,
 * booked above this watermark — is excluded from its own basis.
 */
export async function basisAt(
  accountId: string,
  isoDate: string,
  conn: Sql,
): Promise<{ readonly balanceCents: bigint; readonly bookingSeq: bigint }> {
  const bookingSeq = await currentBookingWatermark(conn);
  const [row] = await conn<{ balance_cents: bigint }[]>`
    SELECT ledger_settled_cents(
             ${accountId}::uuid, ${isoDate}::date, ${bookingSeq.toString()}::bigint
           ) AS balance_cents`;
  if (row === undefined) {
    throw new Error(`interest: no settled balance for account ${accountId} on ${isoDate}`);
  }
  return { balanceCents: row.balance_cents, bookingSeq };
}

/* -------------------------------------------------------------------------- */
/* The claim                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The row lock, through the SECURITY DEFINER function 0024 §14 defines.
 *
 * `corgi_app` holds no UPDATE on `interest_schedule`, so it cannot write
 * `FOR UPDATE` itself — 0008's, 0012's and 0020's construction, unchanged.
 */
export async function lockInterestSchedule(scheduleId: string, conn: Sql): Promise<boolean> {
  const rows = await conn<{ locked: boolean }[]>`
    SELECT lock_interest_schedule(${scheduleId}::uuid) AS locked`;
  return rows[0]?.locked === true;
}

export type InterestClaim = {
  readonly interestDayId: string;
  readonly idempotencyKey: string;
  /** False when the row already existed — a concurrent run, or an earlier one. */
  readonly claimedNow: boolean;
};

/**
 * Claim one (enrolment, date): at most once, decided by Postgres.
 *
 * `ON CONFLICT DO NOTHING` with a row count, never SELECT-then-INSERT — the
 * latter has a race between its two statements and this has none. The
 * idempotency key is deliberately NOT an argument: it is a GENERATED column,
 * so there is no string here for a caller to get wrong.
 */
export async function claimInterestDay(
  args: {
    readonly scheduleId: string;
    readonly accrualDate: string;
    readonly runId: string;
  },
  conn: Sql,
): Promise<InterestClaim> {
  const inserted = await conn<{ id: string; idempotency_key: string }[]>`
    INSERT INTO interest_day (schedule_id, accrual_date, claimed_by)
    VALUES (${args.scheduleId}::uuid, ${args.accrualDate}::date, ${args.runId})
    ON CONFLICT (schedule_id, accrual_date) DO NOTHING
    RETURNING id, idempotency_key`;

  const row = inserted[0];
  if (row !== undefined) {
    return { interestDayId: row.id, idempotencyKey: row.idempotency_key, claimedNow: true };
  }

  const [existing] = await conn<{ id: string; idempotency_key: string }[]>`
    SELECT id, idempotency_key FROM interest_day
     WHERE schedule_id = ${args.scheduleId}::uuid
       AND accrual_date = ${args.accrualDate}::date`;
  if (existing === undefined) {
    throw new Error(
      `enrolment ${args.scheduleId} on ${args.accrualDate}: the claim conflicted but no row exists`,
    );
  }
  return {
    interestDayId: existing.id,
    idempotencyKey: existing.idempotency_key,
    claimedNow: false,
  };
}

/* -------------------------------------------------------------------------- */
/* The decision                                                               */
/* -------------------------------------------------------------------------- */

export async function interestPostingFor(
  interestDayId: string,
  conn: Sql,
): Promise<{
  readonly disposition: InterestDisposition;
  readonly entryId: string | null;
  readonly side: InterestSide;
} | null> {
  const [row] = await conn<
    { disposition: InterestDisposition; entry_id: string | null; side: InterestSide }[]
  >`
    SELECT disposition::text AS disposition, entry_id, side::text AS side
      FROM interest_posting WHERE interest_day_id = ${interestDayId}::uuid`;
  return row === undefined
    ? null
    : { disposition: row.disposition, entryId: row.entry_id, side: row.side };
}

export type RecordInterestInput = {
  readonly interestDayId: string;
  readonly runId: string;
  readonly policyId: string;
  readonly interest: DailyInterest;
  readonly observedBookingSeq: bigint;
} & (
  | { readonly disposition: "posted"; readonly entryId: string }
  | { readonly disposition: "skipped"; readonly skipReason: string }
);

/**
 * Write the outcome.
 *
 * Every bigint operand is sent as a decimal string and cast in SQL — `bigint`
 * does not survive JSON and `Number()` on a cent count is how a cent goes
 * missing. `interest_posting_arithmetic` re-derives all eight relations and
 * `assert_interest_posting()` checks the rate against the policy that
 * `interest_rate_at()` resolves for this day, the basis against
 * `ledger_settled_cents()` at the stored watermark, and the journal entry's
 * two lines against the side. If any of that disagrees, this INSERT fails and
 * the transaction rolls back, taking the claim and the entry with it.
 *
 * `ON CONFLICT DO NOTHING` on the primary key, returning a row count: a second
 * run that gets this far writes nothing and says so, rather than raising on a
 * duplicate that is the expected outcome of a replay.
 */
export async function recordInterestPosting(
  input: RecordInterestInput,
  conn: Sql,
): Promise<boolean> {
  const i = input.interest;
  const rows = await conn<{ interest_day_id: string }[]>`
    INSERT INTO interest_posting (
      interest_day_id, disposition, side, policy_id,
      basis_balance_cents, observed_booking_seq,
      rate_bps, day_count,
      numerator, denominator, whole_cents, remainder_units, rounding,
      amount_cents, entry_id, skip_reason, decided_by_run
    ) VALUES (
      ${input.interestDayId}::uuid,
      ${input.disposition}::accrual_disposition,
      ${i.side}::interest_side,
      ${input.policyId}::uuid,
      ${i.basisBalanceCents.toString()}::bigint,
      ${input.observedBookingSeq.toString()}::bigint,
      ${i.rateBps}::int,
      ${i.dayCount}::int,
      ${i.numerator.toString()}::bigint,
      ${i.denominator.toString()}::bigint,
      ${i.wholeCents.toString()}::bigint,
      ${i.remainderUnits.toString()}::bigint,
      ${i.rounding}::interest_rounding,
      ${i.amountCents.toString()}::bigint,
      ${input.disposition === "posted" ? input.entryId : null}::uuid,
      ${input.disposition === "skipped" ? input.skipReason : null},
      ${input.runId}
    )
    ON CONFLICT (interest_day_id) DO NOTHING
    RETURNING interest_day_id`;
  return rows.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Account resolution                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A house account by chart code — `4400` or `5400`.
 *
 * Resolved by query rather than memorised, so that a chart the seed did not
 * create is a loud failure at the posting boundary instead of a foreign-key
 * error three frames down. Scoped to the entity the customer's account belongs
 * to, because 0001 §2.4 forbids an entry crossing entities, and `closed_at IS
 * NULL` because a closed account is not somewhere to post.
 */
export async function houseInterestAccountId(
  entityId: string,
  code: string,
  conn: Sql = sql,
): Promise<string> {
  const account = await findAccount(
    { code, scope: "house", entityId, includeClosed: false },
    conn,
  );
  if (account === null) {
    throw new Error(
      `no account '${code}' in the chart for entity ${entityId}: interest cannot post without it. ` +
        `Migration 0024 §7 inserts 4400 and 5400; scripts/seed.mjs creates them from src/lib/ledger/chart.ts.`,
    );
  }
  return account.accountId;
}
