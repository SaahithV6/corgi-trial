/**
 * The source for a deployment with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN
 * `./screen-fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a book. This is a refusal to draw one, and on this
 * screen the difference is sharper than anywhere else in the console.
 *
 * `page.tsx` answered "there is no database" with
 * `createFixtureStatementsScreen("default")`, and that guard DID run — this
 * page's module graph happens not to reach `@/lib/env` at module scope, so it
 * was the one of the six that reached its fallback. What it rendered, measured
 * with `APP_DATABASE_URL` deleted, was a complete statement: Ridgeline
 * Robotics, a closing balance of $19,006.55 read twice, a day close at seq
 * 485, a version history, and the words
 *
 *     "It was re-derived from the ledger on this page load and hashed to the
 *      stored value"
 *     "HASH REPRODUCED"
 *
 * on a deployment that had opened no connection. That is not a cosmetic
 * problem. The entire claim of this screen is that the two figures are derived
 * from the journal at request time and that the hash proves it; a drawn
 * statement making that claim is the most misleading artefact this repository
 * could produce, and the FIXTURE DATA badge twelve lines below it did not
 * withdraw the sentence above.
 *
 * So there is no statement here. No account, no day, no reading, no hash — a
 * refusal, rendered by `StatementsErrorPanel` the same way a failed read is.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database, and the panel drops the retry control when a failure says so.
 */

import { fail } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type { StatementsScreenSource, StatementsScreenView } from "./data-contract";

export const STATEMENTS_NO_DATABASE: ErrorShape = {
  code: "STATEMENTS_NO_DATABASE",
  message:
    "No database is configured for this deployment, so no value date was read, no reading was derived and no hash was recomputed. Nothing on this screen is a statement about a real book, and no figure here was reproduced from anything.",
  details: {
    retryable: false,
    source: "statements.screen",
    operation: "both readings",
  },
};

/**
 * A source that reads nothing and says so.
 *
 * It is a `StatementsScreenSource` rather than a branch in the page so the
 * refusal arrives through the same channel as every other failure: one
 * component renders the document, one component renders the refusal, and there
 * is no second path on which this screen could be drawn from nothing.
 */
export function createUnreadableStatementsScreen(
  error: ErrorShape = STATEMENTS_NO_DATABASE,
): StatementsScreenSource {
  return {
    load(): Promise<Result<StatementsScreenView, ErrorShape>> {
      return Promise.resolve(fail(error.code, error.message, error.details));
    },
  };
}
