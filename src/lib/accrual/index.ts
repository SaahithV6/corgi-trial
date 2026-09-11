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
