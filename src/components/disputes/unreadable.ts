/**
 * The source for a deployment with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a book. This is a refusal to draw one, and the
 * difference is the whole of the failure this screen carried: `page.tsx`
 * answered "there is no database" with `createFixtureDisputesSource("default")`
 * — a customer, a ledger balance, an available balance, and a list of cases
 * with their states. Every one of those is a claim about somebody's money, and
 * a deployment that had read nothing printed them next to a name.
 *
 * It never actually reached that fallback. The `await import("@/lib/disputes/screen")`
 * on the line above it throws without `APP_DATABASE_URL`, so the page module
 * failed to load at all and the operator got the framework error page. Both
 * halves were wrong: the guard could not run, and what it would have done was
 * worse than the crash.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database, and `DisputesView` drops the retry control when a failure says so.
 */

import { fail } from "@/lib/result";
import type { ErrorShape } from "@/lib/result";

import type { DisputesDataSource, DisputesResult } from "./data-contract";

export const DISPUTES_NO_DATABASE: ErrorShape = {
  code: "DISPUTES_NO_DATABASE",
  message:
    "No database is configured for this deployment, so no case, no balance and no settled charge was read. Nothing on this screen is a statement about a customer's money, and an empty case list here does not mean nobody has disputed anything.",
  details: {
    retryable: false,
    source: "disputes.screen",
    operation: "the disputes screen",
  },
};

/**
 * A source that reads nothing and says so.
 *
 * It is a `DisputesDataSource` rather than a branch in the page so the refusal
 * arrives through the same channel as every other failure: one component
 * renders the cases, one component renders the refusal, and there is no second
 * path on which this screen could be drawn from nothing.
 */
export function createUnreadableDisputesSource(
  error: ErrorShape = DISPUTES_NO_DATABASE,
): DisputesDataSource {
  return {
    load(): Promise<DisputesResult> {
      return Promise.resolve(fail(error.code, error.message, error.details));
    },
  };
}
