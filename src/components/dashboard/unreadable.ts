/**
 * The source for a deployment with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a book. This is a refusal to draw one. The
 * difference is the whole of instance 26 of this repository's catalogued
 * failure: `page.tsx` used to answer "there is no database" with the EMPTY
 * fixture — a board with four invariant views holding, no queue, nothing
 * refused, under the headline "Nothing new." That is the shape of a clean
 * shift, served on a deployment that had not read a single row. The one screen
 * whose job is to say when something is wrong said nothing was, precisely when
 * it could not see anything at all.
 *
 * `TriageView` already refuses a failed read rather than falling back to a
 * fixture, for exactly this reason, and `src/lib/payees/gate.ts` refuses with
 * `PAYEE_BOOK_UNREADABLE` rather than reporting a payee as unchecked. An
 * unconfigured database is the same fact as an unreachable one — no rows were
 * read — so it takes the same path and the screen renders the refusal panel,
 * not a board.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database, and the panel drops the retry control when a failure says so.
 */

import { fail } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type { Triage, TriageDataSource } from "./data-contract";

export const NO_DATABASE: ErrorShape = {
  code: "TRIAGE_NO_DATABASE",
  message:
    "No database is configured for this deployment, so no invariant view, no queue and no audit row was read. Nothing on this screen is a statement about a ledger. This is a configuration state, not a reading of the book, and it is not an all-clear.",
  details: {
    retryable: false,
    source: "dashboard.triage",
    operation: "the triage board",
  },
};

/**
 * A source that reads nothing and says so.
 *
 * It is a `TriageDataSource` rather than a branch in the page so that the
 * refusal arrives through the same channel as every other failure: one
 * component renders the board, one component renders the refusal, and there is
 * no second path on which a screen could be drawn from nothing.
 */
export function createUnreadableTriageSource(
  error: ErrorShape = NO_DATABASE,
): TriageDataSource {
  return {
    read(): Promise<Result<Triage, ErrorShape>> {
      return Promise.resolve(fail(error.code, error.message, error.details));
    },
  };
}
