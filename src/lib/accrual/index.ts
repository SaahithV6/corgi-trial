/**
 * The accrual feature's public surface.
 *
 * One import for the route, the screen and the tests, so nothing outside this
 * directory has to know that the arithmetic lives in `types.ts`, the SQL in
 * `store.ts` and the tick in `accrue.ts`.
 *
 * `./store` is deliberately NOT re-exported. Everything in it either takes a
 * live `Sql` handle or writes a claim row, and both belong to the tick rather
 * than to a caller — the one legitimate outside use, `bookToday()`, is
 * re-exported by name below.
 */

export { runAccrual, type AccrualRunOptions } from "./accrue";
export { bookToday } from "./store";
export { hasDatabase, loadAccrualView } from "./screen";

/**
 * The interest leg. `runInterest()` is exported for the integration suite and
 * for an operator who wants one leg without the other; production runs it
 * through `runAccrual()`, on the same tick, so that the platform fee for a
 * business date is booked before that date's closing balance is priced.
 *
 * `./interest-store` is deliberately NOT re-exported, for `./store`'s reason:
 * everything in it either takes a live `Sql` handle or writes a claim row.
 */
export { runInterest, type InterestRunOptions } from "./interest";
export {
  BPS_SCALE,
  DEFAULT_DAY_COUNT,
  INTEREST_EXPENSE_CODE,
  INTEREST_INCOME_CODE,
  NO_INTEREST,
  InterestInputError,
  bpsToPercent,
  centsToPlainUsd,
  computeDailyInterest,
  explainInterest,
  roundHalfEven,
  roundingOf,
  sideOf,
  type DailyInterest,
  type InterestDayReport,
  type InterestDisposition,
  type InterestInvariants,
  type InterestMonth,
  type InterestPosting,
  type InterestRatePolicy,
  type InterestRounding,
  type InterestRunReport,
  type InterestSchedule,
  type InterestSide,
} from "./interest-types";
export {
  CATCH_UP_WINDOW_DAYS,
  DEFAULT_RUN_LIMIT,
  FEE_INCOME_CODE,
  AccrualInputError,
  accrualRunInputSchema,
  allocateDay,
  allocateForDate,
  dayOfMonth,
  daysInMonth,
  explainAllocation,
  monthOf,
  type AccrualDisposition,
  type AccrualInvariants,
  type AccrualMonth,
  type AccrualPosting,
  type AccrualProduct,
  type AccrualRunInput,
  type AccrualRunResult,
  type AccrualSchedule,
  type DailyAllocation,
  type DayReport,
} from "./types";
