import "server-only";

/**
 * The live implementation of the accruals screen's data contract.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SCREEN SHOWS, AND WHY IT SHOWS THE WORKING
 * ---------------------------------------------------------------------------
 *
 * Four things, and the third is the one the whole feature is about:
 *
 *   the schedules     who is enrolled, at what monthly price, since when
 *   the months        price vs accrued, and how many residual pennies landed
 *   the days          one row per accrual date, WITH THE ARITHMETIC
 *   the invariants    month drift, ledger drift, unresolved, gap
 *
 * "A number a customer cannot reproduce by hand is a number they will dispute."
 * So a day row does not say "84¢". It says $25.00 ÷ 30 = 83¢ with 10¢ left
 * over, day 10 is one of the first 10, therefore 84¢, month-to-date $8.40,
 * $16.60 still to come — and every one of those integers is a column the
 * database re-derived with `accrual_daily_share()` before it would store the
 * row.
 *
 * ---------------------------------------------------------------------------
 * `bigint` NARROWS HERE, ONCE
 * ---------------------------------------------------------------------------
 *
 * Everything in `src/lib/accrual/**` is `bigint` cents. The contract is
 * `number` cents, because these values cross to the client and `bigint` does
 * not survive JSON. `toCents` is the single conversion site and it refuses
 * rather than silently rounds.
 */

import { fail, ok, type ErrorShape, type Result } from "@/lib/result";
import type {
  AccrualQuery,
  AccrualView,
  Arithmetic,
  DayRow,
  InterestArithmetic,
  InterestDayRow,
  InterestMonthRow,
  InterestPanelView,
  InterestScheduleRow,
  MonthRow,
  RateCardRow,
  ScheduleRow,
} from "@/components/accrual/data-contract";

import {
  bookToday,
  listMonths,
  listPostings,
  listSchedules,
  readInvariants,
} from "./store";
import {
  explainAllocation,
  type AccrualMonth,
  type AccrualPosting,
  type AccrualSchedule,
  type DailyAllocation,
} from "./types";
import {
  listInterestMonths,
  listInterestPostings,
  listInterestSchedules,
  listRateCard,
  readInterestInvariants,
} from "./interest-store";
import {
  explainInterest,
  type DailyInterest,
  type InterestMonth,
  type InterestPosting,
  type InterestRatePolicy,
  type InterestSchedule,
} from "./interest-types";

/** The one bigint -> number narrowing in the read path. Refuses, never rounds. */
function toCents(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `${value} cents is past Number.MAX_SAFE_INTEGER; widen Cents to bigint before rendering it`,
    );
  }
  return Number(value);
}

function toArithmetic(allocation: DailyAllocation): Arithmetic {
  return {
    monthlyCents: toCents(allocation.monthlyCents),
    daysInMonth: allocation.daysInMonth,
    dayOfMonth: allocation.dayOfMonth,
    baseShareCents: toCents(allocation.baseShareCents),
    residualPennies: allocation.residualPennies,
    residualApplied: allocation.residualApplied,
    amountCents: toCents(allocation.amountCents),
    cumulativeCents: toCents(allocation.cumulativeCents),
    remainingCents: toCents(allocation.remainingCents),
    // Built from the same integers the ledger used, not re-derived from the
    // narrowed numbers — so the sentence and the figures cannot disagree.
    explanation: explainAllocation(allocation),
  };
}

function toScheduleRow(schedule: AccrualSchedule): ScheduleRow {
  return {
    id: schedule.id,
    accountId: schedule.accountId,
    accountName: schedule.accountName,
    businessName: schedule.businessName,
    product: schedule.product,
    planName: schedule.planName,
    monthlyCents: toCents(schedule.monthlyCents),
    currency: schedule.currency,
    startDate: schedule.startDate,
    endDate: schedule.endDate,
    scheduleKey: schedule.scheduleKey,
    createdAt: schedule.createdAt,
    nextDueDate: schedule.nextDueDate,
  };
}

function toDayRow(posting: AccrualPosting): DayRow {
  return {
    accrualDayId: posting.accrualDayId,
    scheduleId: posting.scheduleId,
    planName: posting.planName,
    accountId: posting.accountId,
    businessName: posting.businessName,
    accrualDate: posting.accrualDate,
    idempotencyKey: posting.idempotencyKey,
    claimedAt: posting.claimedAt,
    claimedBy: posting.claimedBy,
    disposition: posting.disposition,
    entryId: posting.entryId,
    skipReason: posting.skipReason,
    arithmetic: posting.allocation === null ? null : toArithmetic(posting.allocation),
    decidedAt: posting.decidedAt,
    decidedByRun: posting.decidedByRun,
  };
}

function toMonthRow(month: AccrualMonth): MonthRow {
  return {
    scheduleId: month.scheduleId,
    planName: month.planName,
    businessName: month.businessName,
    monthStart: month.monthStart,
    daysInMonth: month.daysInMonth,
    monthlyCents: toCents(month.monthlyCents),
    residualPenniesInMonth: month.residualPenniesInMonth,
    residualPenniesApplied: month.residualPenniesApplied,
    daysClaimed: month.daysClaimed,
    daysDecided: month.daysDecided,
    daysPosted: month.daysPosted,
    daysSkipped: month.daysSkipped,
    accruedCents: toCents(month.accruedCents),
    remainingCents: toCents(month.remainingCents),
    monthComplete: month.monthComplete,
  };
}

/* -------------------------------------------------------------------------- */
/* Interest                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `toCents`'s sibling for the two operands of the exact fraction.
 *
 * They are COUNTS OF SCALED UNITS and not money — `|balance| × rateBps` and
 * `10000 × dayCount` — so they get their own narrowing with its own name,
 * rather than being pushed through a function called `toCents` that would make
 * a reader think a numerator was a sum of money. The range check is the same,
 * and it refuses rather than rounds for the same reason.
 */
function toScaledUnits(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `${value} scaled units is past Number.MAX_SAFE_INTEGER; the fraction cannot be rendered exactly`,
    );
  }
  return Number(value);
}

function toInterestArithmetic(i: DailyInterest): InterestArithmetic {
  return {
    basisBalanceCents: toCents(i.basisBalanceCents),
    side: i.side,
    rateBps: i.rateBps,
    dayCount: i.dayCount,
    numerator: toScaledUnits(i.numerator),
    denominator: toScaledUnits(i.denominator),
    wholeCents: toCents(i.wholeCents),
    remainderUnits: toScaledUnits(i.remainderUnits),
    rounding: i.rounding,
    amountCents: toCents(i.amountCents),
    customerEffectCents: toCents(i.customerEffectCents),
    // Built from the same integers the ledger used, not re-derived from the
    // narrowed numbers — so the sentence and the figures cannot disagree.
    explanation: explainInterest(i),
  };
}

function toRateCardRow(p: InterestRatePolicy): RateCardRow {
  return {
    id: p.id,
    tier: p.tier,
    tierDescription: p.tierDescription,
    effectiveFrom: p.effectiveFrom,
    supersededOn: p.supersededOn,
    creditRateBps: p.creditRateBps,
    overdraftRateBps: p.overdraftRateBps,
    dayCountDenominator: p.dayCountDenominator,
    note: p.note,
    createdAt: p.createdAt,
    daysPriced: p.daysPriced,
  };
}

function toInterestScheduleRow(s: InterestSchedule): InterestScheduleRow {
  return {
    id: s.id,
    accountId: s.accountId,
    accountName: s.accountName,
    businessName: s.businessName,
    rateTier: s.rateTier,
    currency: s.currency,
    startDate: s.startDate,
    endDate: s.endDate,
    scheduleKey: s.scheduleKey,
    nextDueDate: s.nextDueDate,
    currentBalanceCents: toCents(s.currentBalanceCents),
  };
}

function toInterestDayRow(p: InterestPosting): InterestDayRow {
  return {
    interestDayId: p.interestDayId,
    scheduleId: p.scheduleId,
    accountId: p.accountId,
    businessName: p.businessName,
    rateTier: p.rateTier,
    accrualDate: p.accrualDate,
    idempotencyKey: p.idempotencyKey,
    claimedAt: p.claimedAt,
    claimedBy: p.claimedBy,
    disposition: p.disposition,
    entryId: p.entryId,
    skipReason: p.skipReason,
    arithmetic: p.interest === null ? null : toInterestArithmetic(p.interest),
    policyId: p.policyId,
    policyEffectiveFrom: p.policyEffectiveFrom,
    // A decimal STRING, not a number: a booking sequence is an identity, it is
    // never added to anything, and rendering it through `Number` would be the
    // one place in this file where precision could be lost for no gain.
    observedBookingSeq: p.observedBookingSeq === null ? null : p.observedBookingSeq.toString(),
    decidedAt: p.decidedAt,
    decidedByRun: p.decidedByRun,
  };
}

function toInterestMonthRow(m: InterestMonth): InterestMonthRow {
  return {
    scheduleId: m.scheduleId,
    businessName: m.businessName,
    rateTier: m.rateTier,
    monthStart: m.monthStart,
    daysClaimed: m.daysClaimed,
    daysPosted: m.daysPosted,
    daysSkipped: m.daysSkipped,
    daysCredit: m.daysCredit,
    daysOverdraft: m.daysOverdraft,
    daysRoundedUp: m.daysRoundedUp,
    daysRoundedDown: m.daysRoundedDown,
    daysTieToEven: m.daysTieToEven,
    daysExact: m.daysExact,
    creditInterestCents: toCents(m.creditInterestCents),
    overdraftInterestCents: toCents(m.overdraftInterestCents),
    minBasisCents: m.minBasisCents === null ? null : toCents(m.minBasisCents),
    maxBasisCents: m.maxBasisCents === null ? null : toCents(m.maxBasisCents),
  };
}

/**
 * Load the screen.
 *
 * One entry point, so the schedules, the months, the days and the invariants —
 * for BOTH products — are consistent as of one read rather than nine that
 * could interleave with a concurrent tick.
 */
export async function loadAccrualView(
  query: AccrualQuery = {},
): Promise<Result<AccrualView, ErrorShape>> {
  try {
    const asOf = new Date().toISOString();

    const [
      bookDate,
      schedules,
      postings,
      months,
      invariants,
      rateCard,
      interestSchedules,
      interestPostings,
      interestMonths,
      interestInvariants,
    ] = await Promise.all([
      bookToday(),
      listSchedules(50),
      listPostings(240),
      listMonths(60),
      readInvariants(),
      listRateCard(40),
      listInterestSchedules(50),
      listInterestPostings(240),
      listInterestMonths(60),
      readInterestInvariants(),
    ]);

    const allInterestDays = interestPostings.map(toInterestDayRow);
    const interestDays =
      query.scheduleId === undefined
        ? allInterestDays
        : allInterestDays.filter((row) => row.scheduleId === query.scheduleId);

    const interest: InterestPanelView = {
      rateCard: rateCard.map(toRateCardRow),
      schedules: interestSchedules.map(toInterestScheduleRow),
      days: interestDays,
      months: interestMonths.map(toInterestMonthRow),
      invariants: interestInvariants,
      selected:
        query.interestDayId === undefined
          ? null
          : (allInterestDays.find((row) => row.interestDayId === query.interestDayId) ?? null),
    };

    const allDays = postings.map(toDayRow);

    // Filtered here rather than in SQL: the whole history is a few hundred rows
    // at most, and a filtered query would make the tiles disagree with the
    // table because the tiles have to count what the filter is hiding.
    const days =
      query.scheduleId === undefined
        ? allDays
        : allDays.filter((row) => row.scheduleId === query.scheduleId);

    const selected =
      query.accrualDayId === undefined
        ? null
        : (allDays.find((row) => row.accrualDayId === query.accrualDayId) ?? null);

    return ok({
      source: "live",
      asOf,
      bookDate,
      schedules: schedules.map(toScheduleRow),
      days,
      months: months.map(toMonthRow),
      invariants,
      selected,
      interest,
    });
  } catch (thrown) {
    // A read failure is a VALUE here, so the screen's error state is a branch
    // and not a boundary. Nothing moved: this screen only reads, and the tick
    // is a cron and a POST, never a render.
    return fail(
      "ACCRUAL_READ_FAILED",
      thrown instanceof Error ? thrown.message : "the accrual query failed",
    );
  }
}

/**
 * Whether a database is configured at all.
 *
 * Used by the page to choose between the live source and the fixture, and to
 * label which one the operator is looking at. Reads the raw env rather than
 * `src/lib/env.ts`, because that module throws on a missing key at import time
 * and "no database configured" must be a renderable state, not a crash.
 */
export function hasDatabase(): boolean {
  const url = process.env["APP_DATABASE_URL"];
  return typeof url === "string" && url.trim() !== "";
}
