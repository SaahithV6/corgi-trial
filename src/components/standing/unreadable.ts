/**
 * The source for a deployment with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a book. This is a refusal to draw one, and the
 * difference is the whole of the failure this screen carried: `page.tsx`
 * answered "there is no database" with `createFixtureStandingSource("default")`
 * — mandates, occurrences, a book date, and the two invariant tiles reading
 * `unresolved: 0` and `doubleFires: 0`. Those two figures are the screen's
 * entire claim, and a deployment that had read nothing rendered both of them
 * as zero. "No occurrence fired twice" and "I could not look" are not the same
 * sentence, and that board said the first one.
 *
 * It never actually reached that fallback. The `await import("@/lib/standing/screen")`
 * on the line above it throws without `APP_DATABASE_URL`, so the render died
 * and the operator got the framework error page. Both halves were wrong: the
 * guard could not run, and what it would have done was worse than the crash.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database, and `StandingErrorPanel` drops the retry control when a failure
 * says so.
 */

import { fail } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type { StandingDataSource, StandingView } from "./data-contract";

export const STANDING_NO_DATABASE: ErrorShape = {
  code: "STANDING_NO_DATABASE",
  message:
    "No database is configured for this deployment, so no mandate, no occurrence and no invariant was read. Nothing on this screen is a statement about the schedule. No double fire is reported here because nothing was counted, not because nothing fired twice.",
  details: {
    retryable: false,
    source: "standing.screen",
    operation: "the schedule",
  },
};

/**
 * A source that reads nothing and says so.
 *
 * It is a `StandingDataSource` rather than a branch in the page so the refusal
 * arrives through the same channel as every other failure: one component
 * renders the schedule, one component renders the refusal, and there is no
 * second path on which this screen could be drawn from nothing.
 */
export function createUnreadableStandingSource(
  error: ErrorShape = STANDING_NO_DATABASE,
): StandingDataSource {
  return {
    load(): Promise<Result<StandingView, ErrorShape>> {
      return Promise.resolve(fail(error.code, error.message, error.details));
    },
  };
}
