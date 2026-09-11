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
  MonthRow,
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

/**
 * Load the screen.
 *
 * One entry point, so the schedules, the months, the days and the invariants
 * are consistent as of one read rather than four that could interleave with a
 * concurrent tick.
 */
export async function loadAccrualView(
  query: AccrualQuery = {},
): Promise<Result<AccrualView, ErrorShape>> {
  try {
    const asOf = new Date().toISOString();

    const [bookDate, schedules, postings, months, invariants] = await Promise.all([
      bookToday(),
      listSchedules(50),
      listPostings(240),
      listMonths(60),
      readInvariants(),
    ]);

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
