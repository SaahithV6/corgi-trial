/**
 * Standing orders — the public surface.
 *
 * Deliberately narrow. `runStandingOrders()` is the only way to fire anything
 * and it is reachable from exactly one place in the application (the cron
 * route); everything else here reads. There is no exported helper that raises a
 * payment on its own, because a second way to move money on a schedule is the
 * thing this module exists not to be.
 */

export {
  DEFAULT_RUN_LIMIT,
  runStandingOrders,
  type StandingRunOptions,
} from "./fire";

export { hasDatabase, loadStandingView } from "./screen";

export {
  bookToday,
  cancelStandingOrder,
  countDoubleFires,
  countUnresolved,
  createStandingOrder,
  listOccurrences,
  listStandingOrders,
  type CreateStandingOrderInput,
} from "./store";

export {
  CATCH_UP_WINDOW_DAYS,
  INSUFFICIENT_FUNDS_CODE,
  INVALID_DESTINATION_CODE,
  STALE_AFTER_DAYS,
  STALE_OCCURRENCE_CODE,
  UNSCOPED_ACCOUNT_CODE,
  decideFreshness,
  decideFunding,
  type AvailabilitySnapshot,
  type OccurrenceReport,
  type StandingOrder,
  type StandingOrderOccurrence,
  type StandingRunResult,
} from "./types";
