/**
 * The source `/accruals` uses on a deployment with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a book. This is a refusal to draw one, and on an
 * ACCRUAL screen the difference is what somebody bills a customer on.
 * `page.tsx` answered "there is no database" with
 * `createFixtureAccrualSource("default")` — schedules, priced days, a month
 * table and the four invariant counts — on a deployment that had not read a
 * single row.
 *
 * WHAT THE FIXTURE CLAIMED. `SummaryTiles` renders the invariants as a verdict,
 * and the verdict from an empty fixture is the word EXACT beside "no closed
 * month is a cent out · 0 claimed and undecided". Those two are not small
 * numbers, they are absent ones. `v_accrual_month_drift` reading nought means a
 * complete month summed to its price to the cent; it means that because the
 * view was QUERIED and returned nothing. Nought from a deployment that opened
 * no connection is a clean bill on a book nobody looked at. The `gap` tile is
 * the same failure with the opposite consequence: "days are owed that nothing
 * has claimed" is the line that tells an operator the tick has stopped, and a
 * gap of nought from an unread book is the reason nobody goes to look.
 *
 * It never actually reached that fallback. The guard destructured
 * `hasDatabase` off `await import("@/lib/accrual/screen")`, and that module
 * reaches `@/lib/ledger/db` -> `@/lib/env`, which throws `EnvironmentError` at
 * module scope without `APP_DATABASE_URL`. The import on the line above only
 * succeeds when a database IS configured; the predicate on the line below
 * returns false only when one is not. Measured with the variable deleted, the
 * render threw and the operator got the framework's error page. Both halves
 * were wrong, in the same way the screens repaired before it were wrong: the
 * guard could not run, and what it would have done was worse than the crash.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database, and `AccrualErrorPanel` drops the retry control when a failure says
 * so.
 */

import { fail } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type { AccrualDataSource, AccrualView } from "./data-contract";

export const ACCRUAL_LEDGER_UNREADABLE: ErrorShape = {
  code: "ACCRUAL_LEDGER_UNREADABLE",
  message:
    "No database is configured for this deployment, so no schedule was listed, no accrued day was read and no invariant view was counted. Nothing on this screen is a statement about what accrued. An empty day table here is not a tick that had nothing to do, and a drift count reading nought is not a month that summed to its price — it is a view nobody queried.",
  details: {
    retryable: false,
    source: "accrual.screen",
    operation: "the accrual ledger",
  },
};

/**
 * A source that reads nothing and says so.
 *
 * It is an `AccrualDataSource` rather than a branch in the page so the refusal
 * arrives through the same channel as every other failure: one component
 * renders the ladder, one component renders the refusal, and there is no second
 * path on which this screen could be drawn from nothing.
 */
export function createUnreadableAccrualSource(
  error: ErrorShape = ACCRUAL_LEDGER_UNREADABLE,
): AccrualDataSource {
  return {
    load(): Promise<Result<AccrualView, ErrorShape>> {
      return Promise.resolve(fail(error.code, error.message, error.details));
    },
  };
}
