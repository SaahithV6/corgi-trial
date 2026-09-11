/**
 * TIME TRAVEL ACROSS THE CONSOLE — the one import surface.
 *
 * `?asOf=<date>&asKnownAt=<timestamp>` re-renders a screen at a point on both
 * axes of the bitemporal ledger. The pieces, in the order a request meets them:
 *
 *   params.ts     parse and VALIDATE the two parameters. Pure; refuses rather
 *                 than coerces, because a coerced time coordinate is invisible.
 *   clock.ts      what "now" means for this request. Injected, never read at
 *                 the point of use — see its header for the defect that taught
 *                 this system the difference.
 *   integrity.ts  the cut's safety rule: a watermark may never land inside one
 *                 atomic write, because that state was never observable.
 *   point.ts      the two coordinates resolved into a `LedgerSnapshot`.
 *   read.ts       one account read at that point, composed from named readers.
 *   landmarks.ts  the instants on the booking axis worth standing at.
 *
 * `docs/TIMETRAVEL.md` is the prose version, including what the cut is defined
 * on, what this can and cannot prove, and the readers that are missing.
 *
 * `params` and `clock` are pure and are re-exported here for the screens.
 * Everything below them imports `server-only` and is imported by path, so a
 * client component reaching for a parser cannot accidentally drag a database
 * connection into the bundle behind it.
 */

export {
  AS_KNOWN_AT_PARAM,
  AS_OF_PARAM,
  CLOCK_SKEW_TOLERANCE_MS,
  bankingDayOf,
  endOfBankingDay,
  parseTimeTravelParams,
  startOfBankingDay,
  timeTravelQuery,
  withTimeTravel,
  type ParsedTimeTravel,
  type RefusalCode,
  type TimeTravelPatch,
  type TimeTravelRefusal,
  type TimeTravelRequest,
} from "./params";

export { fixedClock, systemClock, type RequestClock } from "./clock";
