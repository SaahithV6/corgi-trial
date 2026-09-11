/**
 * What `/accounts/[accountId]` answers with on a deployment that has no
 * database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * This page module loads without a database — its chain is lazy-safe, every
 * import of `@/lib/ledger/queries` is a type or a function that opens its
 * connection on call. So the failure here is not a crash, it is a MISDIAGNOSIS.
 *
 * `createLiveAccountDataSource()` calls `ledgerConnection()` inside its
 * memoised `context()`, that throws `EnvironmentError`, and the `try/catch`
 * around every method turns the throw into `readFailure(...)` — a generic
 * `LEDGER_READ_FAILED` carrying `{ retryable: true }`, because every failure
 * that reaches that handler is a query that did not come back and those really
 * are retryable. This one is not a query that did not come back. There was
 * never a query. `ErrorPanel` printed "Retrying is safe" beside a live Retry
 * button, and the button re-ran a render that could only fail the same way.
 *
 * So the page resolves `hasDatabase()` itself — the predicate that imports
 * nothing, see its header — and answers with this instead. A named code, the
 * sentence that says what was not read, and `retryable: false`, which the
 * panel now honours.
 */

import { fail } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type { AccountDataSource } from "./data-contract";

export const ACCOUNT_NO_DATABASE: ErrorShape = {
  code: "ACCOUNT_NO_DATABASE",
  message:
    "No database is configured for this deployment, so no balance was folded, no hold was read and no posting was listed for this account. Nothing on this screen is a statement about an account. This is not the answer that the account does not exist, and an empty holds list here does not mean nothing is being withheld.",
  details: {
    retryable: false,
    source: "ledger.queries",
    operation: "the account screen",
  },
};

/**
 * A source that reads nothing and says so, on all three methods.
 *
 * An `AccountDataSource` rather than a branch in the page, so the refusal
 * arrives through the same seam as every other failure and `AccountView` needs
 * no second path. All three fail, because `AccountView` already refuses to
 * render a balance beside a hold list that did not load — one answer for the
 * screen, not three.
 */
export function createUnreadableAccountSource(
  error: ErrorShape = ACCOUNT_NO_DATABASE,
): AccountDataSource {
  const refuse = <T>(): Promise<Result<T, ErrorShape>> =>
    Promise.resolve(fail(error.code, error.message, error.details));

  return {
    getAccountSummary: () => refuse(),
    listHolds: () => refuse(),
    listPostings: () => refuse(),
  };
}
