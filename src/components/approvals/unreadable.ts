/**
 * The sources `/approvals` uses on a deployment with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a queue. This is a refusal to draw one, and on a
 * maker-checker screen the difference is the whole control.
 *
 * WHAT THE DEFECT WAS, AND IT WAS NOT A BAD FALLBACK — IT WAS NO FALLBACK.
 * The four screens repaired before this one answered "there is no database"
 * with a fixture, behind a guard that could not run. This screen never got as
 * far as having an answer. `page.tsx` imported `ApprovalsView`, which imported
 * `@/lib/approvals/session` and `@/lib/approvals/screen` at module scope; both
 * reach `@/lib/ledger/db` -> `@/lib/env`, which parses `process.env` at module
 * scope and throws `EnvironmentError` without `APP_DATABASE_URL`. The page
 * MODULE never finished evaluating, so there was no render to guard, and the
 * operator got the framework's error page.
 *
 * It took the four fixture states down with it. `?state=loading`,
 * `?state=empty`, `?state=error` and `?state=edge` read nothing and were never
 * going to, and all four were unreachable, because they live behind the module
 * that could not load. That is why the repair is an import moved rather than a
 * branch added: the live source and `currentActor()` are now reached only
 * through `await import(...)`, on the branch that has already established
 * there is a database to read.
 *
 * WHY A DRAWN QUEUE WOULD HAVE BEEN WORSE THAN THE CRASH, had anyone written
 * one. This screen's claim is that two different people signed for money
 * leaving. Its rows carry an initiator, an approval count, a policy version
 * and a content hash, and its buttons are enabled or disabled by a gate that
 * restates what `assert_maker_checker()` will do. Invented rows under that
 * sentence teach an operator that the queue is a picture. It is a read.
 *
 * AND THE COUNTS ARE NOT ZERO, THEY ARE ABSENT. `0 awaiting decisions` is a
 * statement that nobody is waiting on a checker — `QueueList`'s empty panel
 * says in as many words that this is "the normal state of a payments desk, not
 * a failure". From an unread book it is the same sentence about a queue nobody
 * opened. The refusal draws no panel rather than a panel reading nought.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database, and `ErrorPanel` drops the retry control when a failure says so.
 */

import { fail } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type { ActorSource, ApprovalsDataSource, ApprovalsSnapshot } from "./data-contract";

export const APPROVALS_QUEUE_UNREADABLE: ErrorShape = {
  code: "APPROVALS_QUEUE_UNREADABLE",
  message:
    "No database is configured for this deployment. This screen did not read the approvals queue, the policy table or the actor table, so no payment is waiting on a checker here and none is not waiting either — nothing on this screen is a statement about money leaving. A queue drawn with no rows would mean nobody has raised anything; this one means nobody looked.",
  details: {
    retryable: false,
    source: "approvals.screen",
    operation: "the pending approvals queue",
  },
};

/**
 * A source that reads nothing and says so.
 *
 * It is an `ApprovalsDataSource` rather than a branch in the page so the
 * refusal arrives through the same channel as every other failure: one
 * component renders the queue, one component renders the refusal, and there is
 * no second path on which this screen could be drawn from nothing.
 */
export function createUnreadableApprovalsSource(
  error: ErrorShape = APPROVALS_QUEUE_UNREADABLE,
): ApprovalsDataSource {
  return {
    getQueue(): Promise<Result<ApprovalsSnapshot, ErrorShape>> {
      return Promise.resolve(fail(error.code, error.message, error.details));
    },
  };
}

/**
 * Who this session is, when there is no actor table to resolve it against.
 *
 * Nobody, and the header prints `unresolved` for it — the same answer it gives
 * a session whose role cookie matches no seeded actor. It is not a second
 * identity path: `currentActor()` is a SELECT, and a SELECT with no database
 * behind it has no result to report other than this one.
 */
export const UNRESOLVED_ACTOR: ActorSource = {
  current: () => Promise.resolve(null),
};
