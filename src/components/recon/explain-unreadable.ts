/**
 * The source `/breaks` uses on a deployment with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN
 * `./explain-fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a book. This is a refusal to draw one, and the
 * difference is the whole of the failure this screen carried: `page.tsx`
 * answered "there is no database" with `createFixtureExplainSource("default")`
 * — a settlement file, a run number, a booking watermark, four classified
 * break tiles and a causal timeline — on a deployment that had not read a
 * single row.
 *
 * It never actually reached that fallback. The
 * `await import("@/lib/recon/explained-view")` on the line above it evaluates
 * `@/lib/ledger/db` -> `@/lib/env`, which throws `EnvironmentError` without
 * `APP_DATABASE_URL`, so the render died and the operator got the framework
 * error page. Both halves were wrong, in the same way the four screens
 * repaired before it were wrong: the guard could not run, and what it would
 * have done was worse than the crash.
 *
 * WHY THIS SCREEN IS THE WORST PLACE TO DRAW A FIXTURE. `/reconciliation`
 * claims a diff. This one claims a RECONSTRUCTION — "the causal history of a
 * discrepancy, out of immutable journal rows" — and prints a timeline of entry
 * ids and booking sequences to back it. Rows invented for a demo, rendered
 * under that sentence on a deployment with no journal to read, teach an
 * operator that the narration is free. It is not; it is a read.
 *
 * AND THE COUNTS ARE NOT ZERO, THEY ARE ABSENT. `Correction in flight 0` is a
 * statement that no discrepancy on this book is mid-correction. From an unread
 * book it is the same character saying something nobody checked. The refusal
 * draws no tile rather than a tile reading nought.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database, and `ReconErrorPanel` drops the retry control when a failure says
 * so.
 */

import { fail } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type { ExplainedDataSource, ExplainedView } from "./explain-contract";

export const EXPLAIN_NO_DATABASE: ErrorShape = {
  code: "EXPLAIN_NO_DATABASE",
  message:
    "No database is configured for this deployment, so no settlement file, no run and no journal entry was read. Nothing on this screen is a statement about a reconciliation or a correction. An empty class tile here is not a count of nought, and the absence of a timeline is not the absence of a correction.",
  details: {
    retryable: false,
    source: "recon.explained-view",
    operation: "the explained breaks screen",
  },
};

/**
 * A source that reads nothing and says so.
 *
 * It is an `ExplainedDataSource` rather than a branch in the page so the
 * refusal arrives through the same channel as every other failure: one
 * component renders the classified breaks, one component renders the refusal,
 * and there is no second path on which this screen could be drawn from
 * nothing.
 */
export function createUnreadableExplainSource(
  error: ErrorShape = EXPLAIN_NO_DATABASE,
): ExplainedDataSource {
  return {
    load(): Promise<Result<ExplainedView, ErrorShape>> {
      return Promise.resolve(fail(error.code, error.message, error.details));
    },
  };
}
