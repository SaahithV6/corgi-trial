/**
 * The source `/funding` uses on a deployment with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a book. This is a refusal to draw one, and this
 * screen had neither: it had no guard at all. `FundingView.tsx` opened with a
 * STATIC `import { createLiveFundingSource } from "@/app/(app)/funding/live-source"`,
 * that module opens with `import { sql } from "@/lib/ledger/db"`, and
 * `@/lib/env` throws `EnvironmentError` at module scope without
 * `APP_DATABASE_URL`. The page module therefore failed to evaluate and all five
 * states went down together — including `loading`, `empty` and `error`, which
 * are fixtures and need no database to be drawn. Measured with the variable
 * deleted, the render threw and the operator got the framework's error page.
 *
 * WHY A REFUSAL AND NOT THE `empty` FIXTURE, which is the shape the other
 * screens on this console were repaired away from. The `empty` state of this
 * screen is a FINDING, not a blank page: "no deposit account on this book for
 * an inbound credit to land in". An operator who reads that goes and opens an
 * account. From an unread book it is the wrong errand.
 *
 * AND THE FOUR NUMBERS ARE WORSE THAN THE ROW COUNT. The headline here is
 * `ledger − card holds − uncleared = available`, and the gap between the first
 * and the last is the entire product: an ACH credit inside its return window is
 * on the book and not yet spendable. Every one of those four reading nought
 * from a deployment that opened no connection is a position, stated in the one
 * place a reader looks to find out whether a customer's money is available.
 * `available 0` is also the answer that makes a support agent tell a customer
 * their deposit has not landed.
 *
 * THE GATE IS THE THIRD THING. This screen reads the KYB gate for the selected
 * business and draws the funding form only when it says the business may
 * transact. A gate that was never read is not a gate that refused and is not a
 * gate that allowed, so no form is drawn on this refusal — the write path
 * re-reads the gate anyway and fails closed, and a form offered here would be
 * inviting somebody to press a button whose preflight nobody ran.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database, and `ErrorPanel` drops the retry control when a failure says so.
 */

import { fail } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type { FundingDataSource, FundingSnapshot } from "./data-contract";

export const FUNDING_SCREEN_UNREADABLE: ErrorShape = {
  code: "FUNDING_SCREEN_UNREADABLE",
  message:
    "No database is configured for this deployment, so no account was listed, no balance was read, no hold was counted and no KYB gate was resolved. Nothing on this screen is a statement about a customer's position. An available balance of nought here is not money that has not landed, an empty hold list is not a deposit that has cleared, and no account on the list is not a book with no deposit accounts on it.",
  details: {
    retryable: false,
    source: "funding.live-source",
    operation: "the funding preflight read",
  },
};

/**
 * A source that reads nothing and says so.
 *
 * It is a `FundingDataSource` rather than a branch in the view so the refusal
 * arrives through the same channel as every other failure: one component draws
 * the position and the form, one component renders the refusal, and there is no
 * second path on which this screen could be drawn from nothing.
 */
export function createUnreadableFundingSource(
  error: ErrorShape = FUNDING_SCREEN_UNREADABLE,
): FundingDataSource {
  return {
    getSnapshot(): Promise<Result<FundingSnapshot, ErrorShape>> {
      return Promise.resolve(fail(error.code, error.message, error.details));
    },
  };
}
