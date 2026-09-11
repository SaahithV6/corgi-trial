/**
 * The source `/payees` uses on a deployment with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a payee book. This is a refusal to draw one, and
 * on this screen the difference is the product. `/payees` is the confirmation
 * step in front of an outbound payment: it exists to say which destinations
 * were checked, what the check found, and which findings nobody has signed
 * for. Every one of those is a claim about rows, and a claim about rows needs
 * rows.
 *
 * WHAT THIS SCREEN CARRIED WAS NOT AN UNREACHABLE GUARD. It was no guard at
 * all. `page.tsx` imported `@/lib/payees/store` and `@/lib/payees/screen` at
 * the top of the file; both reach `@/lib/ledger/db` -> `@/lib/env`, which
 * parses `process.env` at module scope and throws `EnvironmentError` without
 * `APP_DATABASE_URL`. The page MODULE failed to load, so the operator got the
 * framework's error page and this screen never ran. The five sibling screens
 * repaired before it at least reached a fallback; there was nothing here to
 * reach.
 *
 * AND THE COUNTS ARE THE SHARP PART. `unsigned warnings 0` says that nobody on
 * this book is waiting for a human to put their name to a name mismatch, and
 * `typos caught 2` says the arithmetic stopped two destinations. Those are
 * statements about a book. Drawn from an unread one they are the same
 * characters saying something nobody checked, which is why the refusal draws
 * no tile rather than a tile reading nought.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database, and `PayeeErrorPanel` drops the retry control when a failure says
 * so. It used to offer one on every failure this screen can have.
 */

import { fail } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type { PayeeBookView, PayeeDataSource } from "./data-contract";

export const PAYEE_BOOK_UNREADABLE: ErrorShape = {
  code: "PAYEE_BOOK_UNREADABLE",
  message:
    "No database is configured for this deployment, so no payee, no check and no signature was read. Nothing on this screen is a statement about a destination. An empty book here is not a customer with no beneficiaries, and no warning shown is not no warning outstanding.",
  details: {
    retryable: false,
    source: "payees.screen",
    operation: "the payee book",
  },
};

/**
 * A source that reads nothing and says so.
 *
 * It is a `PayeeDataSource` rather than a branch in the page so the refusal
 * arrives through the same channel as every other failure: one component
 * renders the book, one component renders the refusal, and there is no second
 * path on which this screen could be drawn from nothing.
 */
export function createUnreadablePayeeSource(
  error: ErrorShape = PAYEE_BOOK_UNREADABLE,
): PayeeDataSource {
  return {
    load(): Promise<Result<PayeeBookView, ErrorShape>> {
      return Promise.resolve(fail(error.code, error.message, error.details));
    },
  };
}
