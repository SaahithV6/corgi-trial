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
import { fail, ok } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type {
  AccrualDataSource,
  AccrualQuery,
  AccrualView,
  Arithmetic,
  DayRow,
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

function resolve(state: DemoState): AccrualView {
  switch (state) {
    case "empty":
      return view({ schedules: [], days: [], months: [] });
    case "edge":
      return view({
        days: EDGE_DAYS,
        selected: EDGE_DAYS[1] ?? null,
        months: [{ ...MONTH, daysClaimed: 11, daysDecided: 11, daysPosted: 11, accruedCents: 923, remainingCents: 1577 }],
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

      return ok({
        ...base,
        ...(query.scheduleId === undefined
          ? {}
          : { days: base.days.filter((d) => d.scheduleId === query.scheduleId) }),
        selected,
      });
    },
  };
}
