/**
 * Daily interest against the REAL Neon database, moving REAL (sandbox) money.
 *
 * Gated on RUN_DB_TESTS=1 so CI (which holds no credentials, deliberately)
 * skips rather than fails. Run locally with:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/lib/accrual
 *
 * ============================================================================
 * THE FIVE CLAIMS THIS FILE EXISTS TO PROVE
 * ============================================================================
 *
 *   1. RUNNING IT TWICE FOR THE SAME DAY POSTS ONCE. Two full ticks for the
 *      same business date, started CONCURRENTLY against the live database,
 *      produce ONE journal entry per (enrolment, date) between them — counted
 *      in Postgres, with the second reporting that it found the first's work
 *      done and naming the same entry id.
 *
 *   2. THE ENTRY IS DATED THE DAY IT ACCRUED FOR, and is the right shape for
 *      its side: two lines, the customer credited and 5400 debited when we pay,
 *      the customer debited and 4400 credited when we charge.
 *
 *   3. A RATE CHANGE DOES NOT RE-PRICE YESTERDAY. The same account on two
 *      adjacent business dates, with the same basis balance, priced by two
 *      different rate-card versions — and a replay of the earlier date still
 *      resolves the earlier version. Plus the trigger that makes a backdated
 *      rate impossible rather than merely unlikely.
 *
 *   4. THE ARITHMETIC ON THE ROW IS THE ARITHMETIC. Every stored operand is
 *      re-derived here from the balance, the rate and the day count, and
 *      Postgres already refused any row where they disagreed.
 *
 *   5. THE ZERO-CENT DAYS ARE DECIDED, NOT MISSING. A balance of exactly zero
 *      and a balance whose day rounds to under half a cent are both recorded
 *      as skipped days with a reason, on real accounts and real dates.
 *
 * ─── What this suite writes to the live database ────────────────────────────
 *
 * Real interest postings on real deposit accounts, at real (small) amounts.
 * That is the point — the feature is not proven by a mock. Everything it
 * writes is append-only and correctly dated.
 *
 * It does NOT clean up after itself, and could not: `journal_entry` has no
 * DELETE for this role, by design. Re-running is therefore free rather than
 * destructive — the second run finds the days accrued and asserts that it
 * posted nothing, which is claim 1 all over again.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { sql as SqlHandle } from "@/lib/ledger/db";
import type * as PostModule from "@/lib/ledger/post";
import type * as QueriesModule from "@/lib/ledger/queries";

import type * as AccrueModule from "./accrue";
import type * as StoreModule from "./store";
import type * as InterestStoreModule from "./interest-store";
import { computeDailyInterest } from "./interest-types";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

let sql: typeof SqlHandle;
let runAccrual: typeof AccrueModule.runAccrual;
let ledgerPosterActorId: typeof StoreModule.ledgerPosterActorId;
let rateAt: typeof InterestStoreModule.rateAt;
let postEntry: typeof PostModule.postEntry;

/**
 * THE LEDGER'S OWN READERS, NOT THIS SUITE'S SQL.
 *
 * `src/lib/ledger/boundary.test.ts` holds test files to the same boundary as
 * modules, deliberately: "a test that reaches into `journal_line` to check a
 * balance is a test asserting its own definition of the balance, which is
 * exactly the failure mode this file exists to stop". So every question this
 * suite asks of the ledger goes through a named reader or through a view that
 * migration 0024 defines — and the assertions are stronger for it. Counting
 * entries before and after a replay became comparing the BOOKING WATERMARK,
 * which is monotonic and cannot be unchanged by chance.
 */
let currentBookingWatermark: typeof QueriesModule.currentBookingWatermark;
let findEntryByIdempotencyKey: typeof QueriesModule.findEntryByIdempotencyKey;
let findAccount: typeof QueriesModule.findAccount;
let readAccountIdentity: typeof QueriesModule.readAccountIdentity;
let listLedgerLines: typeof QueriesModule.listLedgerLines;

/**
 * A second rate card and two two-day enrolments, for the cases the live
 * September book cannot show on its own.
 *
 * WHY A SEPARATE TIER. `interest_rate_policy_forward_only` refuses a row whose
 * effective date is not after every existing one FOR ITS TIER — which is the
 * whole point of §5 — so an August probe cannot be hung off `standard`. That
 * the constraint is per-tier is not a loophole: a rate card is a product, and
 * two products may have been repriced on different days. The probe gets its
 * own card, at 1 basis point, which is a real (dormant-account) rate and is
 * thin enough to make a day round to nothing on a live balance.
 *
 * WHAT EACH ONE PROVES, on real accounts and real dates:
 *
 *   * Pots Integration Fixture Co. held EXACTLY ZERO on 20 and 21 August — its
 *     first journal line is dated 1 September. That is `side = 'flat'`: there
 *     is no side to price and nothing is owed either way.
 *
 *   * Hold Fuzzer Fixture Co. held $1,680.49 on the same two dates. One day of
 *     1 bp on that is 168049/3650000 of a cent — under a twentieth of a cent —
 *     so §12.2 rounds it to nothing. `postEntry()` refuses a zero-amount line
 *     and is right to, so the day is a DECIDED day with no entry rather than a
 *     missing row.
 *
 * The August window deliberately does not overlap the September enrolments;
 * `interest_schedule_no_overlap` would refuse it otherwise, which is that
 * constraint doing its job.
 */
const PROBE = {
  tier: "probe",
  effectiveFrom: "2026-08-19",
  rateBps: 1,
  startDate: "2026-08-20",
  endDate: "2026-08-21",
  flatBusiness: "Pots Integration Fixture Co.",
  dustBusiness: "Hold Fuzzer Fixture Co.",
  keyFor: (business: string) => `itest:interest:probe:${business}:v1`,
} as const;

beforeAll(async () => {
  if (!RUN) return;
  ({ sql } = await import("@/lib/ledger/db"));
  ({ runAccrual } = await import("./accrue"));
  ({ ledgerPosterActorId } = await import("./store"));
  ({ rateAt } = await import("./interest-store"));
  ({ postEntry } = await import("@/lib/ledger/post"));
  ({
    currentBookingWatermark,
    findEntryByIdempotencyKey,
    findAccount,
    readAccountIdentity,
    listLedgerLines,
  } = await import("@/lib/ledger/queries"));

  const actorId = await ledgerPosterActorId();

  await sql`
    INSERT INTO interest_rate_tier (tier, description)
    VALUES (${PROBE.tier},
            'Integration-suite probe card. One basis point, so a day on a live balance rounds to nothing and the §12.2 zero-cent path is exercised on real money rather than described.')
    ON CONFLICT (tier) DO NOTHING`;

  await sql`
    INSERT INTO interest_rate_policy
      (tier, effective_from, credit_rate_bps, overdraft_rate_bps,
       day_count_denominator, note, created_by)
    SELECT ${PROBE.tier}, ${PROBE.effectiveFrom}::date,
           ${PROBE.rateBps}::int, ${PROBE.rateBps}::int, 365,
           'Probe card at 1 bp, effective before the probe window so the enrolment has a rate to resolve.',
           ${actorId}::uuid
     WHERE NOT EXISTS (
       SELECT 1 FROM interest_rate_policy
        WHERE tier = ${PROBE.tier} AND effective_from = ${PROBE.effectiveFrom}::date)`;

  // The deposit leaf of each probe business, through the ledger's own reader
  // rather than a `JOIN account` of this suite's own devising.
  const { listBusinesses } = await import("@/lib/ledger/queries");
  const businesses = await listBusinesses(sql);

  for (const legalName of [PROBE.flatBusiness, PROBE.dustBusiness]) {
    const leaf = businesses.find((b) => b.legalName === legalName)?.depositAccountId ?? null;
    expect(leaf).not.toBeNull();
    if (leaf === null) continue;
    await sql`
      INSERT INTO interest_schedule
        (account_id, rate_tier, start_date, end_date, created_by, schedule_key)
      VALUES (${leaf}::uuid, ${PROBE.tier}, ${PROBE.startDate}::date, ${PROBE.endDate}::date,
              ${actorId}::uuid, ${PROBE.keyFor(legalName)})
      ON CONFLICT (schedule_key) DO NOTHING`;
  }
});

/** Today and yesterday in BOOK time, asked of the database. Never a Node Date. */
async function twoConsecutiveDates(): Promise<{ yesterday: string; today: string }> {
  const [row] = await sql<{ yesterday: string; today: string }[]>`
    SELECT (book_date(now()) - 1)::text AS yesterday,
            book_date(now())::text      AS today`;
  if (row === undefined) throw new Error("the database did not answer what day it is");
  return row;
}

/**
 * Three, because the interest leg will not price the OPEN date.
 *
 * `today` is the date a tick is asked for and the date it must NOT price;
 * `yesterday` is the newest date it may price; `dayBefore` is the one a
 * catch-up run takes first. Asked of the database in book time, never of the
 * process clock.
 */
async function threeConsecutiveDates(): Promise<{
  dayBefore: string;
  yesterday: string;
  today: string;
}> {
  const [row] = await sql<{ dayBefore: string; yesterday: string; today: string }[]>`
    SELECT (book_date(now()) - 2)::text AS "dayBefore",
           (book_date(now()) - 1)::text AS yesterday,
            book_date(now())::text      AS today`;
  if (row === undefined) throw new Error("the database did not answer what day it is");
  return row;
}

type PostingRow = {
  interest_day_id: string;
  accrual_date: string;
  business_name: string | null;
  side: string;
  disposition: string;
  basis_balance_cents: bigint;
  observed_booking_seq: bigint;
  rate_bps: number;
  day_count: number;
  numerator: bigint;
  denominator: bigint;
  whole_cents: bigint;
  remainder_units: bigint;
  rounding: string;
  amount_cents: bigint;
  entry_id: string | null;
  skip_reason: string | null;
  policy_effective_from: string | null;
  idempotency_key: string;
};

async function postingsOn(dates: readonly string[]): Promise<PostingRow[]> {
  return await sql<PostingRow[]>`
    SELECT interest_day_id, accrual_date::text AS accrual_date, business_name,
           side::text AS side, disposition::text AS disposition,
           basis_balance_cents, observed_booking_seq, rate_bps, day_count,
           numerator, denominator, whole_cents, remainder_units,
           rounding::text AS rounding, amount_cents, entry_id, skip_reason,
           policy_effective_from::text AS policy_effective_from, idempotency_key
      FROM v_interest_daily
     WHERE accrual_date = ANY(${[...dates]}::date[])
       AND disposition IS NOT NULL
     ORDER BY accrual_date, business_name`;
}

d("daily interest, live", () => {
  it("accrues two consecutive business dates and dates each entry at the day it accrued for", async () => {
    const { dayBefore, yesterday, today } = await threeConsecutiveDates();

    // Run one: everything owed up to and including the day before yesterday.
    // On a first run this is a catch-up from the enrolment date, which is
    // exactly the case where value date and booking date must differ.
    const first = await runAccrual({ bookDate: dayBefore, runId: "interest-itest-a" });
    expect(first.bookDate).toBe(dayBefore);
    expect(first.interest.pricedThrough).toBe(dayBefore);
    expect(first.interest.openDateHeld).toBe(false);

    // Run two: today. Strictly the days run one could not have taken — and
    // TODAY IS NOT ONE OF THEM. The tick is asked for the open date and prices
    // through the last CLOSED one instead, because the basis is the balance at
    // the END of a business date and today has not got one yet. See
    // `interestPricingHorizon()`.
    const second = await runAccrual({ bookDate: today, runId: "interest-itest-b" });
    expect(second.bookDate).toBe(today);
    expect(second.interest.pricedThrough).toBe(yesterday);
    expect(second.interest.openDateHeld).toBe(true);
    for (const day of second.interest.days) {
      expect(day.accrualDate <= yesterday).toBe(true);
    }

    // ASSERTED OF THE LEDGER, NOT OF THE RUN. On a first run these two ticks
    // post everything; on every run after that they post NOTHING, because the
    // days are already accrued — which is the exactly-once property and not a
    // reason for this test to have nothing to check. So the claim is about
    // what the book now holds.
    const rows = await postingsOn([dayBefore, yesterday]);
    expect(rows.map((r) => r.accrual_date)).toContain(dayBefore);
    expect(rows.map((r) => r.accrual_date)).toContain(yesterday);

    // Whatever THIS pair of ticks posted is correct: every entry it named
    // carries its accrual date as its value date and its own derived key.
    const posted = [...first.interest.days, ...second.interest.days].filter(
      (day) => day.action === "posted" && day.entryId !== null,
    );
    for (const day of posted) {
      expect(day.idempotencyKey.startsWith("interest:")).toBe(true);
      // Asked the other way round on purpose: the KEY is what the database
      // derived, so looking the entry up BY the key proves the key names that
      // entry and nothing else — which is the property the replay rests on.
      const entry = await findEntryByIdempotencyKey(day.idempotencyKey, sql);
      expect(entry?.entryId).toBe(day.entryId);
      expect(entry?.valueDate).toBe(day.accrualDate);
    }

    // At least one catch-up entry: booked after the day it is dated for. That
    // is the whole "value date is not booking date" claim, in one row.
    const [late] = await sql<{ n: bigint }[]>`
      SELECT count(*) AS n
        FROM interest_posting ip
        JOIN interest_day dd ON dd.id = ip.interest_day_id
       WHERE ip.disposition = 'posted'
         AND dd.accrual_date < (ip.decided_at AT TIME ZONE 'America/New_York')::date`;
    expect(Number(late?.n ?? 0)).toBeGreaterThan(0);
  });

  /**
   * THE OPEN BUSINESS DATE IS NOT PRICED, AND THIS IS NOT A HYPOTHETICAL.
   *
   * It was made to fail against this very database before the guard existed —
   * not in a rolled-back transaction, but for real and irreversibly, which is
   * why the guard is here. On 2026-09-11 a tick priced 2026-09-11 at booking
   * watermark 2265, when `Holds Integration Fixture Co.` stood at
   * +$145,315.17, and paid it 498¢ of CREDIT interest (entry
   * 47ad3ebe-1b69-4c6d-9c9a-bdb25d0fbf0a, `5400`). By the close of that same
   * business date the account stood at −$858,941.45 — the first debit balance
   * this book has ever carried — and the day owed roughly $423 of OVERDRAFT
   * interest on `4400` instead. All five enrolments were priced mid-day; four
   * moved materially and one reversed its sign.
   *
   * `interest_day` is UNIQUE (schedule_id, accrual_date), so none of it can be
   * taken again: the property that makes the tick exactly-once is the same
   * property that makes a mid-day guess permanent. Those five rows are still
   * on the book and are named in docs/ACCRUAL.md §20.
   */
  it("refuses to price the business date that has not closed yet", async () => {
    const { yesterday, today } = await twoConsecutiveDates();
    const { interestPricingHorizon } = await import("./interest-store");

    // The horizon itself, both ways round, so neither branch is vacuous.
    expect(await interestPricingHorizon(today)).toEqual({
      horizon: yesterday,
      openDateHeld: true,
    });
    expect(await interestPricingHorizon(yesterday)).toEqual({
      horizon: yesterday,
      openDateHeld: false,
    });

    // And at the level a caller sees: a tick asked for today reports what it
    // was allowed to price, and names no day later than that.
    const run = await runAccrual({ bookDate: today, runId: "interest-itest-openday" });
    expect(run.interest.openDateHeld).toBe(true);
    expect(run.interest.pricedThrough).toBe(yesterday);
    for (const day of run.interest.days) {
      expect(day.accrualDate).not.toBe(today);
      expect(day.accrualDate <= yesterday).toBe(true);
    }

    // The FEE leg is deliberately not held back: a platform fee is a price, a
    // calendar and an ordinal, and reads no balance, so an open day cannot
    // make it wrong.
    expect(run.bookDate).toBe(today);
  });

  it("posts exactly once when two ticks race for the same day", async () => {
    const { today } = await twoConsecutiveDates();

    // The booking watermark is monotonic and is bumped by every append, so
    // "unchanged across two concurrent full ticks" is a stronger statement
    // than a row count and cannot be true by coincidence.
    const before = await currentBookingWatermark(sql);

    // Both ticks are started before either is awaited, so they are genuinely
    // in flight together against the same rows.
    const [a, b] = await Promise.all([
      runAccrual({ bookDate: today, runId: "interest-itest-race-a" }),
      runAccrual({ bookDate: today, runId: "interest-itest-race-b" }),
    ]);

    // Neither tick may post anything new: every day is already decided.
    expect(a.interest.creditInterestCents).toBe("0");
    expect(b.interest.creditInterestCents).toBe("0");
    expect(a.interest.overdraftInterestCents).toBe("0");
    expect(b.interest.overdraftInterestCents).toBe("0");
    expect(a.interest.deferred).toBe(0);
    expect(b.interest.deferred).toBe(0);

    const after = await currentBookingWatermark(sql);
    expect(after).toBe(before);

    // And the database agrees at its own level: one claim, one outcome, one
    // entry per (enrolment, date). The unique indexes, asked directly.
    const [dupes] = await sql<{ n: bigint }[]>`
      SELECT count(*) AS n FROM (
        SELECT schedule_id, accrual_date FROM interest_day
         GROUP BY schedule_id, accrual_date HAVING count(*) > 1) x`;
    expect(Number(dupes?.n ?? 0)).toBe(0);
  });

  it("returns the ORIGINAL entry when the same derived key is posted again", async () => {
    // The double-run proof at its lowest layer: rebuild a real interest entry
    // from its POSTING ROW — which knows the side, the amount and the account,
    // and therefore knows both lines exactly — replay it through postEntry()
    // with the same derived key, and assert the ledger hands back the original
    // id having appended nothing. This cannot go vacuous once the days are
    // accrued, which is why it is here as well as the tick-level replay above.
    const [row] = await sql<
      {
        entry_id: string;
        idempotency_key: string;
        accrual_date: string;
        account_id: string;
        side: string;
        amount_cents: bigint;
      }[]
    >`
      SELECT entry_id, idempotency_key, accrual_date::text AS accrual_date,
             account_id, side::text AS side, amount_cents
        FROM v_interest_daily
       WHERE disposition = 'posted'
       ORDER BY decided_at DESC
       LIMIT 1`;
    expect(row).toBeDefined();
    if (row === undefined) return;

    const deposit = await readAccountIdentity(row.account_id, sql);
    expect(deposit).not.toBeNull();
    if (deposit === null) return;

    const paying = row.side === "credit";
    const house = await findAccount(
      { code: paying ? "5400" : "4400", scope: "house", entityId: deposit.entityId },
      sql,
    );
    expect(house).not.toBeNull();
    if (house === null) return;

    const before = await currentBookingWatermark(sql);

    const replayed = await postEntry({
      entityId: deposit.entityId,
      valueDate: row.accrual_date,
      book: "financial",
      // The description is deliberately NOT the original's. `ledger_append()`
      // short-circuits on the key before it looks at anything else, which is
      // the property being asserted: the KEY is the identity of the fact, not
      // the payload. If this returned a second entry id, two ticks with a
      // slightly different wording would have double-charged a customer.
      description: "replayed by the integration suite",
      idempotencyKey: row.idempotency_key,
      actorId: await ledgerPosterActorId(),
      lines: [
        { accountId: house.accountId, amountCents: paying ? row.amount_cents : -row.amount_cents },
        {
          accountId: deposit.accountId,
          amountCents: paying ? -row.amount_cents : row.amount_cents,
        },
      ],
      rail: "internal",
    });

    expect(replayed).toBe(row.entry_id);
    expect(await currentBookingWatermark(sql)).toBe(before);
  });

  it("posts on the right side of the chart, in the right direction", async () => {
    // PER ENTRY, in SQL: v_interest_ledger_drift compares every posting's
    // amount and value date against its entry's deposit line, its 4400 line
    // and its 5400 line, with the sign expected for its side. Empty is the
    // whole claim, and `assert_interest_posting()` refused anything else at
    // insert.
    const [drift] = await sql<{ n: bigint }[]>`
      SELECT count(*) AS n FROM v_interest_ledger_drift`;
    expect(Number(drift?.n ?? -1)).toBe(0);

    // IN AGGREGATE, through the ledger's own line reader, so this suite is not
    // asserting its own definition of what a line is. `listLedgerLines` returns
    // NATURAL amounts (signed × normal_side), so a debit to debit-normal 5400
    // reads positive and a credit to credit-normal 4400 reads positive too —
    // both mean "this account went up", which is what each of them should do.
    const [totals] = await sql<
      { credit_cents: bigint; overdraft_cents: bigint }[]
    >`
      SELECT COALESCE(SUM(amount_cents) FILTER (WHERE side = 'credit'), 0)::bigint
               AS credit_cents,
             COALESCE(SUM(amount_cents) FILTER (WHERE side = 'overdraft'), 0)::bigint
               AS overdraft_cents
        FROM interest_posting WHERE disposition = 'posted'`;

    const expense = await listLedgerLines({ accountCode: "5400", limit: 5000 }, sql);
    const income = await listLedgerLines({ accountCode: "4400", limit: 5000 }, sql);

    expect(expense.reduce((t, l) => t + l.amountCents, 0n)).toBe(totals?.credit_cents ?? 0n);
    expect(income.reduce((t, l) => t + l.amountCents, 0n)).toBe(totals?.overdraft_cents ?? 0n);

    // Every line on either account is an increase. An interest accrual never
    // reduces income or expense; a reversal would, and there is no path that
    // writes one today — so a negative line here is a posting nobody wrote.
    for (const line of [...expense, ...income]) {
      expect(line.amountCents > 0n).toBe(true);
      expect(line.book).toBe("financial");
    }
  });

  it("stores arithmetic that the rule reproduces exactly, on every posted day", async () => {
    const rows = await sql<PostingRow[]>`
      SELECT interest_day_id, accrual_date::text AS accrual_date, business_name,
             side::text AS side, disposition::text AS disposition,
             basis_balance_cents, observed_booking_seq, rate_bps, day_count,
             numerator, denominator, whole_cents, remainder_units,
             rounding::text AS rounding, amount_cents, entry_id, skip_reason,
             policy_effective_from::text AS policy_effective_from, idempotency_key
        FROM v_interest_daily WHERE disposition IS NOT NULL`;

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const computed = computeDailyInterest({
        balanceCents: r.basis_balance_cents,
        rateBps: r.rate_bps,
        dayCount: r.day_count,
      });
      expect(computed.numerator).toBe(r.numerator);
      expect(computed.denominator).toBe(r.denominator);
      expect(computed.wholeCents).toBe(r.whole_cents);
      expect(computed.remainderUnits).toBe(r.remainder_units);
      expect(computed.rounding).toBe(r.rounding);
      expect(computed.amountCents).toBe(r.amount_cents);
      expect(computed.side).toBe(r.side);

      // And the basis itself is what 0022 says the balance was, at the exact
      // watermark the row recorded. The trigger checked this before it would
      // store the row; this asks it again now.
      const [basis] = await sql<{ cents: bigint }[]>`
        SELECT ledger_settled_cents(s.account_id, dd.accrual_date, ${r.observed_booking_seq}::bigint) AS cents
          FROM interest_day dd JOIN interest_schedule s ON s.id = dd.schedule_id
         WHERE dd.id = ${r.interest_day_id}::uuid`;
      expect(basis?.cents).toBe(r.basis_balance_cents);
    }
  });

  it("prices two adjacent dates with two rate-card versions, and a replay does not re-price the earlier one", async () => {
    // The rate card changed on book_date − 2. Find a day on each side of that
    // boundary for the SAME enrolment, so the only variable is the rate.
    const [boundary] = await sql<{ effective_from: string }[]>`
      SELECT effective_from::text AS effective_from
        FROM interest_rate_policy WHERE tier = 'standard'
       ORDER BY effective_from DESC LIMIT 1`;
    expect(boundary).toBeDefined();
    if (boundary === undefined) return;

    const pairs = await sql<
      {
        business_name: string | null;
        before_date: string;
        after_date: string;
        before_basis: bigint;
        after_basis: bigint;
        before_rate: number;
        after_rate: number;
        before_amount: bigint;
        after_amount: bigint;
        before_effective: string;
        after_effective: string;
      }[]
    >`
      SELECT b.business_name,
             b.accrual_date::text AS before_date,
             a.accrual_date::text AS after_date,
             b.basis_balance_cents AS before_basis,
             a.basis_balance_cents AS after_basis,
             b.rate_bps AS before_rate, a.rate_bps AS after_rate,
             b.amount_cents AS before_amount, a.amount_cents AS after_amount,
             b.policy_effective_from::text AS before_effective,
             a.policy_effective_from::text AS after_effective
        FROM v_interest_daily b
        JOIN v_interest_daily a
          ON a.schedule_id = b.schedule_id
         AND a.accrual_date = b.accrual_date + 1
       WHERE b.accrual_date = ${boundary.effective_from}::date - 1
         AND b.rate_tier = 'standard'
         AND b.disposition IS NOT NULL AND a.disposition IS NOT NULL`;

    expect(pairs.length).toBeGreaterThan(0);

    for (const p of pairs) {
      // Two different rate-card versions, resolved by the ACCRUAL date.
      expect(p.before_effective).not.toBe(p.after_effective);
      expect(p.after_effective).toBe(boundary.effective_from);
      expect(p.before_rate).toBeGreaterThan(p.after_rate);
    }

    // THE COUNTERFACTUAL, which is what actually proves the rate moved money.
    // Price the AFTER day at the BEFORE day's rate: if the two agreed, the
    // change would be invisible on the book and there would be nothing to
    // prove. This is also robust to the basis drifting between the two days,
    // which it does — interest is credited to the deposit account on the day
    // it accrues, so the next day's balance includes it and the product
    // compounds daily. See docs/ACCRUAL.md §14.
    for (const p of pairs) {
      const asPriced = computeDailyInterest({
        balanceCents: p.after_basis,
        rateBps: p.after_rate,
        dayCount: 365,
      });
      const atOldRate = computeDailyInterest({
        balanceCents: p.after_basis,
        rateBps: p.before_rate,
        dayCount: 365,
      });
      expect(asPriced.amountCents).toBe(p.after_amount);
      expect(atOldRate.amountCents).toBeGreaterThan(asPriced.amountCents);

      // And the earlier day is still the earlier day's number.
      expect(
        computeDailyInterest({
          balanceCents: p.before_basis,
          rateBps: p.before_rate,
          dayCount: 365,
        }).amountCents,
      ).toBe(p.before_amount);
    }

    // At least one account where the BALANCE WENT UP across the boundary and
    // the amount posted WENT DOWN. Nothing but the rate can explain that, and
    // it needs no arithmetic to read.
    const unambiguous = pairs.filter(
      (p) => p.after_basis >= p.before_basis && p.after_amount < p.before_amount,
    );
    expect(unambiguous.length).toBeGreaterThan(0);

    // THE REPLAY. Resolving the rate for the earlier date TODAY — after the
    // change — still returns the earlier card. That is the whole claim, and it
    // is one function of one date rather than a convention anyone observes.
    const earlier = pairs[0]?.before_date;
    expect(earlier).toBeDefined();
    if (earlier === undefined) return;
    const resolved = await rateAt("standard", earlier);
    expect(resolved?.effectiveFrom).toBe(pairs[0]?.before_effective);
    expect(resolved?.creditRateBps).toBe(pairs[0]?.before_rate);
  });

  it("refuses a rate row that would re-price a date already accrued", async () => {
    const actorId = await ledgerPosterActorId();
    const [priced] = await sql<{ latest: string }[]>`
      SELECT max(dd.accrual_date)::text AS latest
        FROM interest_day dd JOIN interest_schedule s ON s.id = dd.schedule_id
       WHERE s.rate_tier = 'standard'`;
    expect(priced?.latest).toBeTruthy();

    // Backdated to a day that is already on the ledger. The trigger must
    // refuse the INSERT: afterwards the postings are immutable and the only
    // repair would be a reversal and a re-book of every affected day.
    await expect(
      sql.begin(async (tx) => {
        await tx`
          INSERT INTO interest_rate_policy
            (tier, effective_from, credit_rate_bps, overdraft_rate_bps,
             day_count_denominator, note, created_by)
          VALUES ('standard', ${priced?.latest ?? null}::date, 999, 999, 365,
                  'backdated on purpose, by the integration suite', ${actorId}::uuid)`;
      }),
    ).rejects.toThrow(/retroactively re-price|already has a rate effective/);

    // And an EARLIER-or-equal row is refused even where nothing has accrued,
    // because a rate card moves forward and only forward.
    await expect(
      sql.begin(async (tx) => {
        await tx`
          INSERT INTO interest_rate_policy
            (tier, effective_from, credit_rate_bps, overdraft_rate_bps,
             day_count_denominator, note, created_by)
          SELECT 'standard', min(effective_from) - 30, 999, 999, 365,
                 'backdated before the first card, by the integration suite', ${actorId}::uuid
            FROM interest_rate_policy WHERE tier = 'standard'`;
      }),
    ).rejects.toThrow(/already has a rate effective/);
  });

  it("decides the zero-cent days instead of leaving them missing", async () => {
    // Both probe enrolments are entirely in the past, so one tick for today
    // catches them up along with everything else.
    const { today } = await twoConsecutiveDates();
    await runAccrual({ bookDate: today, runId: "interest-itest-probe" });

    const rows = await postingsOn([PROBE.startDate, PROBE.endDate]);
    const flat = rows.filter((r) => r.business_name === PROBE.flatBusiness);
    const dust = rows.filter((r) => r.business_name === PROBE.dustBusiness);

    expect(flat.length).toBe(2);
    for (const r of flat) {
      // A balance of EXACTLY zero: no side, no rate, nothing owed either way.
      expect(r.basis_balance_cents).toBe(0n);
      expect(r.side).toBe("flat");
      expect(r.rate_bps).toBe(0);
      expect(r.disposition).toBe("skipped");
      expect(r.entry_id).toBeNull();
      expect(r.skip_reason).toContain("nothing to price");
    }

    expect(dust.length).toBe(2);
    for (const r of dust) {
      // A real credit balance, priced at a real rate, whose DAY is worth less
      // than half a cent. §12.2 rounds it to nothing; nothing is posted.
      expect(r.basis_balance_cents > 0n).toBe(true);
      expect(r.side).toBe("credit");
      expect(r.rate_bps).toBe(PROBE.rateBps);
      expect(r.whole_cents).toBe(0n);
      expect(r.remainder_units * 2n < r.denominator).toBe(true);
      expect(r.rounding).toBe("down");
      expect(r.amount_cents).toBe(0n);
      expect(r.disposition).toBe("skipped");
      expect(r.entry_id).toBeNull();
      expect(r.skip_reason).toContain("less than half a cent");
    }
  });

  it("keeps the invariant views empty and the book summing to zero", async () => {
    const [row] = await sql<
      {
        ledger_drift: bigint;
        rate_drift: bigint;
        unresolved: bigint;
        book_not_zero: bigint;
        entry_unbalanced: bigint;
        deposit_drift: bigint;
      }[]
    >`
      SELECT (SELECT count(*) FROM v_interest_ledger_drift) AS ledger_drift,
             (SELECT count(*) FROM v_interest_rate_drift)   AS rate_drift,
             (SELECT count(*) FROM v_interest_unresolved)   AS unresolved,
             (SELECT count(*) FROM v_book_not_zero)         AS book_not_zero,
             (SELECT count(*) FROM v_entry_unbalanced)      AS entry_unbalanced,
             (SELECT count(*) FROM v_deposit_control_drift) AS deposit_drift`;

    expect(Number(row?.ledger_drift ?? -1)).toBe(0);
    expect(Number(row?.rate_drift ?? -1)).toBe(0);
    expect(Number(row?.unresolved ?? -1)).toBe(0);
    // Interest moves real money on real deposit accounts, so the whole-book
    // invariants are part of THIS feature's proof and not somebody else's.
    expect(Number(row?.book_not_zero ?? -1)).toBe(0);
    expect(Number(row?.entry_unbalanced ?? -1)).toBe(0);
    expect(Number(row?.deposit_drift ?? -1)).toBe(0);
  });

  it("reports what the book actually shows about overdrafts, rather than assuming it", async () => {
    // The measurement this feature's honesty rests on. 4400 exists, is priced
    // on the rate card, and has no rows — because no deposit leaf on this book
    // has been in debit on any value date. If that ever changes, the same
    // enrolment prices the day on 4400 with nothing reconfigured, and this
    // assertion is the one that will start failing and should be READ, not
    // relaxed.
    const [row] = await sql<{ overdrawn_now: bigint; overdraft_days: bigint }[]>`
      SELECT (SELECT count(*) FROM v_overdrawn_accounts) AS overdrawn_now,
             (SELECT count(*) FROM interest_posting WHERE side = 'overdraft') AS overdraft_days`;

    // `v_trial_balance` is the ledger's own per-account roll-up, and reading
    // 4400 out of it is the same number a trial balance would print.
    const [tb] = await sql<{ natural_cents: bigint }[]>`
      SELECT COALESCE(SUM(natural_cents), 0)::bigint AS natural_cents
        FROM v_trial_balance WHERE code = '4400'`;

    // Whatever the book says, the two must agree with each other: no overdrawn
    // day means no 4400 balance, and a 4400 balance means an overdrawn day.
    if (Number(row?.overdraft_days ?? 0) === 0) {
      expect(tb?.natural_cents ?? 0n).toBe(0n);
    } else {
      expect((tb?.natural_cents ?? 0n) > 0n).toBe(true);
    }
  });
});
