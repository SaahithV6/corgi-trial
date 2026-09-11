/**
 * The transactions screen with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * It used to be. `NO_DATABASE` sat two exports below `FIXTURE_READ_FAILURE` in
 * the fixtures module, and the two are not the same kind of thing at all: a
 * fixture is a drawing of a book, and this is a refusal to draw one. Keeping
 * them in one file is how the distinction gets lost, which on the other five
 * screens in this pass is exactly what had happened — every one of them
 * answered "there is no database" by reaching for a fixture.
 *
 * This screen got that part right before this pass and the intent is
 * unchanged: with no database `/transactions` refuses, with this code, through
 * the same error panel a failed read uses. What was wrong here was smaller and
 * still worth fixing:
 *
 *   - the guard was reached through `await import("./live-source")`, which is
 *     the unreachable shape. It survived only by luck — that module's graph
 *     happens not to evaluate `@/lib/env` at module scope — and a single new
 *     import in it would have turned this screen into the framework error page
 *     without anybody touching this file. The page now asks
 *     `@/lib/has-database`, which imports nothing.
 *
 *   - the panel offered a Retry button beside `retryable: false`. A control
 *     offering to re-run a read that cannot succeed contradicts the line above
 *     it; a refresh does not configure a database.
 *
 *   - the demo-state bar badged the screen `live` while the refusal panel
 *     badged it `live` too, on a deployment that had read nothing. Both badges
 *     now derive from one value resolved once in `page.tsx`.
 */

import type { ErrorShape } from "@/lib/result";

export const TRANSACTIONS_NO_DATABASE: ErrorShape = {
  code: "TRANSACTIONS_NO_DATABASE",
  message:
    "No database is configured for this deployment, so there is no book to travel through: no account was listed, no posting was folded and no closing balance was derived. This is a configuration state, not a ledger failure, and it is not a reading of an empty book.",
  details: {
    retryable: false,
    source: "timetravel.transactions",
    operation: "the point in time",
  },
};
