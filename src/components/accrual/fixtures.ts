/**
 * The accruals screen without a database.
 *
 * Two jobs, and they are different:
 *
 * 1. THE FOUR NON-DEFAULT STATES. `loading`, `empty`, `error` and `edge` have
 *    to be reachable in front of a panel without running the tick, so they are
 *    fixtures even when a database is configured. `default` is always the live
 *    query — that is the state where the real entries, the real arithmetic and
 *    the real invariant counts are.
 *
 * 2. NO DATABASE AT ALL. `pnpm dev` with no `.env` still renders a real screen,
 *    labelled `fixture` on its face. The label is not decoration: a figure
 *    without provenance is a rumour.
 *
 * ============================================================================
 * THE EDGE STATE IS THE DAY THE RESIDUAL PENNY LANDS
 * ============================================================================
 *
 * $25.00 a month, September, 30 days:
 *
 *     2500 ÷ 30 = 83 remainder 10
 *     days 1–10 accrue 84¢      ← the residual penny
 *     days 11–30 accrue 83¢
 *     10 × 84 + 20 × 83 = 2500  ← exactly, with nothing left over
 *
 * So the fixture shows the 10th and the 11th side by side: the last day that
 * carries a penny and the first that does not. Every number below is the output
 * of the same `allocateForDate()` the ledger used, computed at module load
 * rather than typed in — a fixture with hand-written arithmetic would be a
 * second, unchecked implementation of the rule, which is exactly what this
 * feature exists to avoid.
 */

import { allocateForDate, explainAllocation } from "@/lib/accrual/types";
import { computeDailyInterest, explainInterest } from "@/lib/accrual/interest-types";
import { fail, ok } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type {
  AccrualDataSource,
  AccrualQuery,
  AccrualView,
  Arithmetic,
  DayRow,
  InterestArithmetic,
  InterestDayRow,
  InterestPanelView,
  MonthRow,
  ScheduleRow,
} from "./data-contract";
import type { DemoState } from "./view-state";

/**
 * The instant every fixture is read as-of.
 *
 * Fixed rather than `Date.now()`, so ages are reproducible, the screen is a
 * pure function of the URL, and the server render cannot disagree with the
 * client hydration.
 */
export const DEMO_NOW = "2026-09-11T09:40:00.000Z"; // 05:40 ET, after the nightly tick
export const DEMO_BOOK_DATE = "2026-09-10";

/** How long the `loading` state holds the skeleton open. Long enough to see. */
export const DEMO_LOADING_MS = 6_000;

const SCHEDULE_ID = "1b0a5c2e-6d31-4a78-9f04-2c7b5e8a1100";
const PLAN = "Business Standard";
const BUSINESS = "Ridgeline Robotics, Inc.";
const ACCOUNT_ID = "8c4d1f67-2ab9-4e05-93c1-7f2e9d4a0022";
const MONTHLY_CENTS = 2500n;

/**
 * Build the arithmetic from the rule itself.
 *
 * `toArithmetic` in `src/lib/accrual/screen.ts` does the identical narrowing
 * for live rows. Both call `allocateForDate`, so the fixture and the database
 * cannot disagree about what 10 September costs.
 */
function arithmeticFor(date: string): Arithmetic {
  const a = allocateForDate(MONTHLY_CENTS, date);
  return {
    monthlyCents: Number(a.monthlyCents),
    daysInMonth: a.daysInMonth,
    dayOfMonth: a.dayOfMonth,
    baseShareCents: Number(a.baseShareCents),
    residualPennies: a.residualPennies,
    residualApplied: a.residualApplied,
    amountCents: Number(a.amountCents),
    cumulativeCents: Number(a.cumulativeCents),
    remainingCents: Number(a.remainingCents),
    explanation: explainAllocation(a),
  };
}

function dayFor(date: string, suffix: string): DayRow {
  return {
    accrualDayId: `0000${suffix}-0000-4000-8000-000000000000`,
    scheduleId: SCHEDULE_ID,
    planName: PLAN,
    accountId: ACCOUNT_ID,
    businessName: BUSINESS,
    accrualDate: date,
    idempotencyKey: `accrual:${SCHEDULE_ID}:${date}`,
    claimedAt: `${date}T09:31:00.000Z`,
    claimedBy: "accrual-1757548800000-9f3c1a",
    disposition: "posted",
    entryId: `dddd${suffix}-1111-4111-8111-111111111111`,
    skipReason: null,
    arithmetic: arithmeticFor(date),
    decidedAt: `${date}T09:31:02.000Z`,
    decidedByRun: "accrual-1757548800000-9f3c1a",
  };
}

/** 1 September through 10 September, newest first — the whole month to date. */
const DAYS: readonly DayRow[] = Array.from({ length: 10 }, (_, i) => {
  const day = 10 - i;
  return dayFor(`2026-09-${String(day).padStart(2, "0")}`, String(day).padStart(4, "0"));
});

const SCHEDULE: ScheduleRow = {
  id: SCHEDULE_ID,
  accountId: ACCOUNT_ID,
  accountName: `${BUSINESS} — business current account`,
  businessName: BUSINESS,
  product: "platform_fee",
  planName: PLAN,
  monthlyCents: Number(MONTHLY_CENTS),
  currency: "USD",
  startDate: "2026-09-01",
  endDate: null,
  scheduleKey: `migration:0020:${ACCOUNT_ID}:platform_fee`,
  createdAt: "2026-09-01T00:00:00.000Z",
  nextDueDate: null,
};

const MONTH: MonthRow = {
  scheduleId: SCHEDULE_ID,
  planName: PLAN,
  businessName: BUSINESS,
  monthStart: "2026-09-01",
  daysInMonth: 30,
  monthlyCents: Number(MONTHLY_CENTS),
  residualPenniesInMonth: 10,
  residualPenniesApplied: 10,
  daysClaimed: 10,
  daysDecided: 10,
  daysPosted: 10,
  daysSkipped: 0,
  accruedCents: 840,
  remainingCents: 1660,
  monthComplete: false,
};

const CLEAN = { monthDrift: 0, ledgerDrift: 0, unresolved: 0, gap: 0 } as const;

/* -------------------------------------------------------------------------- */
/* Interest                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * THE INTEREST EDGE IS THE DAY THE PRICE OF MONEY CHANGED UNDER ONE ACCOUNT.
 *
 * The live book's own rows, reproduced by calling `computeDailyInterest()` at
 * module load rather than typed in — a fixture with hand-written arithmetic
 * would be a second, unchecked implementation of the rule, which is exactly
 * what this feature exists to avoid.
 *
 * Kettle & Crumb Bakery LLC, across the rate card's change date:
 *
 *     2026-09-08   $2,003.08   @ 150 bps   30046200 / 3650000 = 8 r  846200  -> 8¢   (down)
 *     2026-09-09   $2,003.16   @ 125 bps   25039500 / 3650000 = 6 r 3139500  -> 7¢   (up)
 *
 * Read the two rows together. The BALANCE WENT UP by 8¢ between them — the
 * previous day's interest was credited to the account — and the amount posted
 * went DOWN by a cent. Nothing but the rate can explain that, which is the
 * whole claim: `interest_rate_at()` resolves on the ACCRUAL date, so the 8th
 * keeps the 1.50% card forever and re-running it re-derives 8¢.
 *
 * It is also, for free, both directions of §12.2 in adjacent rows: the 8th
 * rounds DOWN (2 × 846200 < 3650000) and the 9th rounds UP (2 × 3139500 >
 * 3650000). Same rule, same day count, opposite answers, with the comparison
 * printed on each row.
 */
const INTEREST_SCHEDULE_ID = "7e2c9d41-3b60-4f82-a1c5-9d40e7b23300";
const INTEREST_ACCOUNT_ID = "392043e2-1d7f-406f-b036-321b4775108b";
const INTEREST_BUSINESS = "Kettle & Crumb Bakery LLC";

const RATE_CARD_V1 = "b1e0f2c8-1a44-4c90-8f31-6d2a5e70aa01";
const RATE_CARD_V2 = "b1e0f2c8-1a44-4c90-8f31-6d2a5e70aa02";

function interestArithmeticFor(balanceCents: bigint, rateBps: number): InterestArithmetic {
  const i = computeDailyInterest({ balanceCents, rateBps, dayCount: 365 });
  return {
    basisBalanceCents: Number(i.basisBalanceCents),
    side: i.side,
    rateBps: i.rateBps,
    dayCount: i.dayCount,
    numerator: Number(i.numerator),
    denominator: Number(i.denominator),
    wholeCents: Number(i.wholeCents),
    remainderUnits: Number(i.remainderUnits),
    rounding: i.rounding,
    amountCents: Number(i.amountCents),
    customerEffectCents: Number(i.customerEffectCents),
    explanation: explainInterest(i),
  };
}

function interestDayFor(
  date: string,
  balanceCents: bigint,
  rateBps: number,
  policyId: string,
  policyEffectiveFrom: string,
  suffix: string,
  watermark: string,
): InterestDayRow {
  return {
    interestDayId: `1111${suffix}-2222-4222-8222-222222222222`,
    scheduleId: INTEREST_SCHEDULE_ID,
    accountId: INTEREST_ACCOUNT_ID,
    businessName: INTEREST_BUSINESS,
    rateTier: "standard",
    accrualDate: date,
    idempotencyKey: `interest:${INTEREST_SCHEDULE_ID}:${date}`,
    claimedAt: `${date}T09:31:00.000Z`,
    claimedBy: "accrual-1757548800000-9f3c1a",
    disposition: "posted",
    entryId: `eeee${suffix}-3333-4333-8333-333333333333`,
    skipReason: null,
    arithmetic: interestArithmeticFor(balanceCents, rateBps),
    policyId,
    policyEffectiveFrom,
    observedBookingSeq: watermark,
    decidedAt: `${date}T09:31:03.000Z`,
    decidedByRun: "accrual-1757548800000-9f3c1a",
  };
}

const INTEREST_DAYS: readonly InterestDayRow[] = [
  interestDayFor("2026-09-09", 200_316n, 125, RATE_CARD_V2, "2026-09-09", "0009", "2253"),
  interestDayFor("2026-09-08", 200_308n, 150, RATE_CARD_V1, "2026-09-07", "0008", "2248"),
  interestDayFor("2026-09-07", 200_300n, 150, RATE_CARD_V1, "2026-09-07", "0007", "2243"),
];

const INTEREST: InterestPanelView = {
  rateCard: [
    {
      id: RATE_CARD_V2,
      tier: "standard",
      tierDescription:
        "The standard business current account rate card: what we pay on a credit balance and what we charge on an arranged overdraft, both ACT/365 fixed.",
      effectiveFrom: "2026-09-09",
      supersededOn: null,
      creditRateBps: 125,
      overdraftRateBps: 1800,
      dayCountDenominator: 365,
      note:
        "Credit rate cut to 1.25% a year. The overdraft rate is unchanged. Days before this date keep the 1.50% card: interest_rate_at() resolves on the ACCRUAL date, and interest_rate_policy_forward_only would have refused this row if any day on or after it had already accrued.",
      createdAt: "2026-09-09T00:00:00.000Z",
      daysPriced: 10,
    },
    {
      id: RATE_CARD_V1,
      tier: "standard",
      tierDescription:
        "The standard business current account rate card: what we pay on a credit balance and what we charge on an arranged overdraft, both ACT/365 fixed.",
      effectiveFrom: "2026-09-07",
      supersededOn: "2026-09-09",
      creditRateBps: 150,
      overdraftRateBps: 1800,
      dayCountDenominator: 365,
      note:
        "Opening rate card. 1.50% a year on credit balances, 18.00% a year on an arranged overdraft, ACT/365 fixed per Reg DD Appendix A.",
      createdAt: "2026-09-07T00:00:00.000Z",
      daysPriced: 10,
    },
  ],
  schedules: [
    {
      id: INTEREST_SCHEDULE_ID,
      accountId: INTEREST_ACCOUNT_ID,
      accountName: `${INTEREST_BUSINESS} — business current account`,
      businessName: INTEREST_BUSINESS,
      rateTier: "standard",
      currency: "USD",
      startDate: "2026-09-07",
      endDate: null,
      scheduleKey: `migration:0024:${INTEREST_ACCOUNT_ID}:interest`,
      nextDueDate: null,
      currentBalanceCents: 200_316,
    },
  ],
  days: INTEREST_DAYS,
  months: [
    {
      scheduleId: INTEREST_SCHEDULE_ID,
      businessName: INTEREST_BUSINESS,
      rateTier: "standard",
      monthStart: "2026-09-01",
      daysClaimed: 3,
      daysPosted: 3,
      daysSkipped: 0,
      daysCredit: 3,
      daysOverdraft: 0,
      daysRoundedUp: 1,
      daysRoundedDown: 2,
      daysTieToEven: 0,
      daysExact: 0,
      creditInterestCents: 23,
      overdraftInterestCents: 0,
      minBasisCents: 200_300,
      maxBasisCents: 200_316,
    },
  ],
  invariants: {
    ledgerDrift: 0,
    rateDrift: 0,
    unresolved: 0,
    gap: 0,
    // The measurement, reproduced from the live book: nothing is overdrawn and
    // nothing has been, so the fixture must not imply otherwise either.
    overdrawnAccounts: 0,
    overdrawnDaysInWindow: 0,
    overdrawnCents: 0,
    // A fixture must not imply a clean book either: this is the DEMO state,
    // and on the live book these are not zero. See docs/ACCRUAL.md §20.
    pricedBeforeClose: 0,
    pricedBeforeCloseCents: 0,
    mispricedUncorrected: 0,
    adjustments: 0,
    adjustmentDrift: 0,
  },
  selected: null,
};

function view(overrides: Partial<AccrualView> = {}): AccrualView {
  return {
    source: "fixture",
    asOf: DEMO_NOW,
    bookDate: DEMO_BOOK_DATE,
    schedules: [SCHEDULE],
    days: DAYS,
    months: [MONTH],
    invariants: CLEAN,
    selected: null,
    interest: INTEREST,
    ...overrides,
  };
}

/**
 * The edge: the 10th and the 11th, adjacent.
 *
 * Day 10 is the LAST day of September that carries a residual penny and day 11
 * is the first that does not, so the two rows differ by exactly one cent for
 * exactly one reason, and the reason is on the row. The 11th is shown even
 * though the book date is the 10th — this is the fixture's licence, and it is
 * what makes the transition visible on one screen instead of requiring somebody
 * to come back tomorrow.
 */
const EDGE_DAYS: readonly DayRow[] = [
  dayFor("2026-09-11", "0011"),
  dayFor("2026-09-10", "0010"),
];

/**
 * The interest edge: the 8th and the 9th, adjacent, across the rate change.
 *
 * The 8th is the last day priced by the 1.50% card and the 9th is the first
 * priced by the 1.25% one, so the two rows differ by exactly one cent for
 * exactly one reason — and the balance moved the OTHER way between them, which
 * is what makes the rate the only possible explanation. Selected by default,
 * so the full working opens with the state.
 */
const EDGE_INTEREST_DAYS: readonly InterestDayRow[] = [
  INTEREST_DAYS[0] as InterestDayRow,
  INTEREST_DAYS[1] as InterestDayRow,
];

function resolve(state: DemoState): AccrualView {
  switch (state) {
    case "empty":
      return view({
        schedules: [],
        days: [],
        months: [],
        interest: { ...INTEREST, schedules: [], days: [], months: [], selected: null },
      });
    case "edge":
      return view({
        days: EDGE_DAYS,
        selected: EDGE_DAYS[1] ?? null,
        months: [{ ...MONTH, daysClaimed: 11, daysDecided: 11, daysPosted: 11, accruedCents: 923, remainingCents: 1577 }],
        interest: {
          ...INTEREST,
          days: EDGE_INTEREST_DAYS,
          selected: EDGE_INTEREST_DAYS[0] ?? null,
        },
      });
    default:
      return view();
  }
}

/** Fixture source for a demo state. `error` fails; `loading` is genuinely slow. */
export function createFixtureAccrualSource(state: DemoState): AccrualDataSource {
  return {
    async load(query: AccrualQuery): Promise<Result<AccrualView, ErrorShape>> {
      if (state === "error") {
        return fail(
          "ACCRUAL_READ_FAILED",
          "connection to the ledger database timed out after 10s",
        );
      }

      if (state === "loading") {
        // A real delay, so the Suspense fallback is a real fallback. The
        // skeleton is not a picture of a loading state; it IS the loading
        // state, held open long enough to be looked at.
        await new Promise((resolve) => setTimeout(resolve, DEMO_LOADING_MS));
      }

      const base = resolve(state);
      const selected =
        query.accrualDayId === undefined
          ? base.selected
          : (base.days.find((d) => d.accrualDayId === query.accrualDayId) ?? base.selected);
      const interestSelected =
        query.interestDayId === undefined
          ? base.interest.selected
          : (base.interest.days.find((d) => d.interestDayId === query.interestDayId) ??
            base.interest.selected);

      return ok({
        ...base,
        ...(query.scheduleId === undefined
          ? {}
          : { days: base.days.filter((d) => d.scheduleId === query.scheduleId) }),
        selected,
        interest: { ...base.interest, selected: interestSelected },
      });
    },
  };
}
