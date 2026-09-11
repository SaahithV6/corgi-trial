/**
 * The transactions screen without a database.
 *
 * ===========================================================================
 * WHY THERE IS SO LITTLE HERE
 * ===========================================================================
 *
 * Four of this screen's five URL states are LIVE, which is unusual for this
 * console and is the right trade for this particular screen:
 *
 *   default   live — today at the live watermark
 *   loading   live — the real read, held open, behind the real Suspense
 *             fallback. `?state=loading` slows the query rather than faking
 *             the render.
 *   empty     LIVE — the value axis pinned to a day before this book's first
 *             entry. Genuinely empty, genuinely derived, and it proves
 *             something a fixture cannot: that an empty answer and a missing
 *             answer are different, and the screen says which.
 *   edge      LIVE — the most recent correction act on the book, entered at
 *             the instant INSIDE its atomic write, so the guard fires in front
 *             of the reader.
 *   error     fixture — below.
 *
 * `error` is the only fixture because there is no honest way to make a live
 * read fail on demand. Breaking the connection would be a lie about the
 * system's health; planting a bad row is impossible on an append-only ledger
 * and would be a worse lie. So the error state carries a synthesised
 * `ErrorShape` and says `FIXTURE` on its face.
 *
 * `edge` and `empty` fall back to the fixture only when there is no database
 * configured at all, and say so when they do.
 */

import type { ErrorShape } from "@/lib/result";

/**
 * The failure the error state renders.
 *
 * A read failure, deliberately — not a write failure. Nothing on this screen
 * writes, the ledger is append-only, and a query cannot alter it. Saying so is
 * the whole content of the error state: the reader needs to know the balance
 * they cannot see is intact, not merely unavailable.
 */
export const FIXTURE_READ_FAILURE: ErrorShape = {
  code: "LEDGER_READ_FAILED",
  message:
    "The ledger could not be read at that point. Nothing moved — this screen only ever issues SELECTs, and the journal is append-only.",
  details: { retryable: true, source: "timetravel.transactions", fixture: true },
};

/** No database configured at all. A different fact from a failed read. */
export const NO_DATABASE: ErrorShape = {
  code: "NO_DATABASE",
  message:
    "No database is configured for this deployment, so there is no book to travel through. This is a configuration state, not a ledger failure.",
  details: { retryable: false, source: "timetravel.transactions" },
};

/**
 * The value date the `empty` state pins to.
 *
 * Before this book's first entry — its oldest value date is 1980-12-09 — so
 * the answer is a true zero rather than a fabricated one. Well inside the
 * range `params.ts` accepts, because a state that the validator refuses is not
 * a state.
 */
export const EMPTY_STATE_VALUE_DATE = "1979-01-02";
