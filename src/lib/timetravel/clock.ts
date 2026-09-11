/**
 * WHAT "NOW" MEANS FOR A REQUEST — one place, injected everywhere.
 *
 * ===========================================================================
 * WHY THIS EXISTS AT ALL
 * ===========================================================================
 *
 * A screen reading the clock directly is the bug, and it has already been one
 * here. `readSnapshot()` took its point from `now()`; inside a transaction
 * `now()` is the transaction's START, while `ledger_append()` stamps
 * `booking_time` from `clock_timestamp()`. A watermark of
 *
 *     MAX(booking_seq) WHERE booking_time <= now()
 *
 * read inside the transaction that had just posted an entry therefore EXCLUDED
 * that entry, and the balance came back as though the posting had not
 * happened. Standing orders and pot transfers both funds-check inside the
 * transaction that posts, so it was not hypothetical. See
 * `docs/BALANCE-DEFINITIONS.md` §5 and DECISIONS, `readSnapshot`.
 *
 * The fix there was to pick the right clock. The lesson here is stronger: when
 * "now" is read at the point of use, there is no single place to be wrong in,
 * and no single place to make right. A time-travelling console has THREE
 * candidate nows in play at once — the wall clock, the instant the reader
 * asked about, and the instant the ledger last learned something — and a
 * screen that reaches for `new Date()` in the middle of that has silently
 * chosen one of them.
 *
 * So the clock is a value. It is taken ONCE per request, at the top, and
 * passed down. Nothing under `src/lib/timetravel/**`, `src/components/timetravel/**`
 * or the screens wired to them calls `new Date()` with no argument.
 *
 * ===========================================================================
 * WHAT THIS IS NOT
 * ===========================================================================
 *
 * It is not the LEDGER'S clock. `LedgerSnapshot.asOf` comes from Postgres's
 * `clock_timestamp()` and the book's today comes from Postgres's `book_date()`,
 * because there must be exactly one definition of a business-day boundary and
 * it is the database's. This clock decides what the REQUEST considers now:
 * whether an `asKnownAt` is in the future, and what instant a screen labels
 * itself with when the reader pinned no instant at all.
 */

/** The request's wall clock. One method, because one is all that is needed. */
export interface RequestClock {
  now(): Date;
}

/**
 * The real clock. The only place in this feature that calls `new Date()`
 * with no argument.
 */
export const systemClock: RequestClock = {
  now: () => new Date(),
};

/**
 * A clock stopped at an instant.
 *
 * Returns a fresh `Date` each call so a caller mutating the result cannot move
 * everybody else's now — which is the sort of thing that happens once, in a
 * test, at two in the morning.
 */
export function fixedClock(at: Date): RequestClock {
  const ms = at.getTime();
  return { now: () => new Date(ms) };
}
