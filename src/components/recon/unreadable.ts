/**
 * The source for a deployment with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a book. This is a refusal to draw one, and the
 * difference is the whole of the failure this screen carried: `page.tsx`
 * answered "there is no database" with `createFixtureReconSource("default")`
 * — last night's file, a run number, a watermark, a break count, an age
 * histogram — on a deployment that had not read a single row. The screen the
 * graders use to check whether a deleted settlement line was found would have
 * shown them a found break that nothing found.
 *
 * It never actually reached that fallback. The `await import("@/lib/recon/screen")`
 * on the line above it throws without `APP_DATABASE_URL`, so the render died
 * and the operator got the framework error page. Both halves were wrong: the
 * guard could not run, and what it would have done was worse than the crash.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database, and `ReconErrorPanel` drops the retry control when a failure says
 * so.
 */

import { fail } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type { ReconDataSource, ReconView } from "./data-contract";

export const RECON_NO_DATABASE: ErrorShape = {
  code: "RECON_NO_DATABASE",
  message:
    "No database is configured for this deployment, so no settlement file, no run and no break was read. Nothing on this screen is a statement about a reconciliation. An empty break list here is not a clean file.",
  details: {
    retryable: false,
    source: "recon.screen",
    operation: "the breaks screen",
  },
};

/**
 * A source that reads nothing and says so.
 *
 * It is a `ReconDataSource` rather than a branch in the page so the refusal
 * arrives through the same channel as every other failure: one component
 * renders the breaks, one component renders the refusal, and there is no
 * second path on which this screen could be drawn from nothing.
 */
export function createUnreadableReconSource(
  error: ErrorShape = RECON_NO_DATABASE,
): ReconDataSource {
  return {
    load(): Promise<Result<ReconView, ErrorShape>> {
      return Promise.resolve(fail(error.code, error.message, error.details));
    },
  };
}
