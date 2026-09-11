/**
 * The sources `/payments` uses on a deployment with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a form. This is a refusal to draw one.
 *
 * WHAT THE DEFECT WAS, AND IT WAS NOT A BAD FALLBACK — IT WAS NO FALLBACK.
 * `PaymentsView.tsx` opened with
 * `import { createLivePaymentsSource } from "@/app/(app)/payments/live-source"`,
 * and `page.tsx` imported `PaymentsView`, so the chain from the route to
 * `@/lib/ledger/db` -> `@/lib/env` was static. Without `APP_DATABASE_URL` the
 * page MODULE threw while it was being loaded. There was no render to guard.
 *
 * The three fixture states went with it. `?state=loading`, `?state=empty` and
 * `?state=error` read nothing and wanted no database, and all three answered
 * with the framework's error page because they live behind the same module.
 * That is why the repair is an import moved rather than a branch added.
 *
 * WHY THIS SCREEN IS A PARTICULARLY BAD PLACE TO DRAW ONE ANYWAY. Its own
 * error panel already states the rule: "the one thing worse than refusing to
 * draw a payment form is drawing one that quotes a threshold it made up". A
 * form drawn with no database would offer a "Pay from" list nobody read, a
 * green `may transact` beside a KYB verdict nobody fetched, and a threshold
 * from a policy table nobody opened — under a live submit button. Two of this
 * screen's five states are live for exactly that reason: the edge case is a
 * payment you can actually raise ON the $2,500.00 boundary, and a drawn one
 * proves nothing about the comparison it exists to exercise.
 *
 * AND THE EMPTY BOOK IS NOT THE SAME THING. `EmptyBook` says "No account on
 * this book can originate a payment" and then "Not an error" — a true and
 * useful statement about a book that WAS read and holds no payable account,
 * because a deposit account exists only after a business is onboarded. From an
 * unread book it is the same sentence about accounts nobody counted. The
 * refusal draws no panel rather than a panel reading nought.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database, and `ErrorPanel` drops the retry control when a failure says so.
 */

import { fail } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type { ActorSource, PaymentsDataSource, PaymentsSnapshot } from "./data-contract";

export const PAYMENTS_BOOK_UNREADABLE: ErrorShape = {
  code: "PAYMENTS_BOOK_UNREADABLE",
  message:
    "No database is configured for this deployment. This screen did not read the account list, the KYB gate or the threshold policy, so it cannot say which account may originate a payment, whose verification is in force, or how many approvers an amount would need. No instruction was raised — but nothing here is a statement about what raising one would do.",
  details: {
    retryable: false,
    source: "payments.live-source",
    operation: "the payment origination form",
  },
};

/**
 * A source that reads nothing and says so.
 *
 * It is a `PaymentsDataSource` rather than a branch in the page so the refusal
 * arrives through the same channel as every other failure: one component
 * renders the form, one component renders the refusal, and there is no second
 * path on which this screen could be drawn from nothing.
 */
export function createUnreadablePaymentsSource(
  error: ErrorShape = PAYMENTS_BOOK_UNREADABLE,
): PaymentsDataSource {
  return {
    getFormData(): Promise<Result<PaymentsSnapshot, ErrorShape>> {
      return Promise.resolve(fail(error.code, error.message, error.details));
    },
  };
}

/**
 * Who this session would be raising an instruction as, when there is no actor
 * table to resolve it against.
 *
 * Nobody, and the header prints `unresolved` for it — the same answer it gives
 * a session whose role cookie matches no seeded actor. It is not a second
 * identity path: `currentActor()` is a SELECT, and a SELECT with no database
 * behind it has no result to report other than this one.
 */
export const UNRESOLVED_ACTOR: ActorSource = {
  current: () => Promise.resolve(null),
};
