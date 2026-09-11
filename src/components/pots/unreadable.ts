/**
 * The source for a deployment with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a book. This is a refusal to draw one, and the
 * difference is the whole of the failure this screen carried: `page.tsx`
 * answered "there is no database" with `createFixturePotsSource("default")` —
 * named pots, balances, movements, and the identity panel showing the pot
 * total reconciling to the deposit liability. That identity is the screen's
 * claim, and a deployment that had read nothing rendered it as holding.
 *
 * It never actually reached that fallback. The `await import("@/lib/pots/screen")`
 * on the line above it throws without `APP_DATABASE_URL`, so the page module
 * failed to load at all and the operator got the framework error page. Both
 * halves were wrong: the guard could not run, and what it would have done was
 * worse than the crash.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database, and `PotsView` drops the retry control when a failure says so.
 */

import { fail } from "@/lib/result";
import type { ErrorShape } from "@/lib/result";

import type { PotsDataSource, PotsResult } from "./data-contract";

export const POTS_NO_DATABASE: ErrorShape = {
  code: "POTS_NO_DATABASE",
  message:
    "No database is configured for this deployment, so no pot, no balance and no internal transfer was read. Nothing on this screen is a statement about a ledger, and the identity between the pot total and the deposit liability was not checked — it is unknown here, not holding.",
  details: {
    retryable: false,
    source: "pots.screen",
    operation: "the pots screen",
  },
};

/**
 * A source that reads nothing and says so.
 *
 * It is a `PotsDataSource` rather than a branch in the page so the refusal
 * arrives through the same channel as every other failure: one component
 * renders the pots, one component renders the refusal, and there is no second
 * path on which this screen could be drawn from nothing.
 */
export function createUnreadablePotsSource(
  error: ErrorShape = POTS_NO_DATABASE,
): PotsDataSource {
  return {
    load(): Promise<PotsResult> {
      return Promise.resolve(fail(error.code, error.message, error.details));
    },
  };
}
