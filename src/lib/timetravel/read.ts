/**
 * ONE ACCOUNT, READ AT A POINT IN BOTH CLOCKS.
 *
 * ===========================================================================
 * WHAT THIS COMPOSES, AND WHAT IT REFUSES TO DEFINE
 * ===========================================================================
 *
 * Nothing here is a definition. Every figure below comes out of a named reader
 * or out of `balance-definitions.ts`, with `point.snapshot` passed in as the
 * argument. That is the whole design: the time-travelled figure and the live
 * one are THE SAME FUNCTION with a different argument, so they cannot drift
 * into being two answers to one question — which is how this system once
 * acquired four definitions of `available` and printed two of them, at the
 * same instant, $25,040.70 apart.
 *
 * This module writes no SQL. `src/lib/ledger/boundary.test.ts` would catch it
 * if it did, and the reason the test exists is the reason the rule is worth
 * keeping: a module with its own idea of what a balance is will eventually
 * disagree with the screen, in front of a customer.
 *
 * ===========================================================================
 * THE IDENTITY THIS SCREEN STAKES ITSELF ON
 * ===========================================================================
 *
 *     closing(valueDate, NOW) − closing(valueDate, asKnownAt)
 *         = Σ (entries value-dated on or before valueDate, booked above the cut)
 *
 * Left side: the same business day, read twice, one argument changed. Right
 * side: the acts that landed in between, itemised. The screen prints both and
 * says whether they are equal. When they are not, it says so in the negative
 * colour rather than printing the delta and moving on — because an unexplained
 * difference between two readings of an immutable ledger is not a rounding
 * artefact, it is a bug in one of the two readers, and the screen is the only
 * place it would ever be visible.
 *
 * ===========================================================================
 * WHY THE LATE LIST IS CLIPPED TO THE LIVE WATERMARK
 * ===========================================================================
 *
 * `listEntriesAboveWatermark` has no upper bound: it is "everything since",
 * evaluated when the query runs. This book is written to continuously by
 * twelve other workers, so an entry can land between the snapshot that fixed
 * `liveWatermark` and the query that lists the late entries — and it would
 * then appear on the right-hand side of the identity above while being absent
 * from the left. The clip makes all three reads agree on where "now" is. It is
 * not defensive coding; it is the same argument as `LedgerSnapshot` itself.
 */

import "server-only";

import {
  accountAvailability,
  settledBalanceCents,
  historicSnapshot,
  type Availability,
  type Sql,
} from "@/lib/ledger/balance-definitions";
import {
  listEntriesAboveWatermark,
  readAccountIdentity,
  readAccountPeriod,
  NoSuchAccountError,
  type AccountIdentity,
  type AccountPeriod,
  type LateEntry,
  type PeriodLine,
} from "@/lib/ledger/readers";

import { pendingActs, type PendingAct } from "./integrity";
import type { TimePoint } from "./point";

export { NoSuchAccountError };
export type { AccountIdentity, LateEntry, PeriodLine, PendingAct };

/* -------------------------------------------------------------------------- */
/* The window on the value axis                                               */
/* -------------------------------------------------------------------------- */

export const WINDOWS = ["day", "week", "month"] as const;
export type Window = (typeof WINDOWS)[number];

export const WINDOW_DAYS: Record<Window, number> = { day: 1, week: 7, month: 30 };

export const WINDOW_LABELS: Record<Window, string> = {
  day: "That day",
  week: "That day and the six before it",
  month: "That day and the twenty-nine before it",
};

/**
 * The window's first value date, counted back from `asOf`.
 *
 * Calendar arithmetic in UTC on a bare `YYYY-MM-DD`, which is correct here and
 * would not be for an instant: a value date is a label on a business day, not
 * a moment, so it has no zone to get wrong. The book's business-day BOUNDARY
 * is `America/New_York` and that decision lives in Postgres's `book_date()`,
 * where there is one of it.
 */
export function windowStart(asOf: string, window: Window): string {
  const [year, month, day] = asOf.split("-").map(Number) as [number, number, number];
  const start = new Date(Date.UTC(year, month - 1, day));
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS[window] - 1));
  return start.toISOString().slice(0, 10);
}

/* -------------------------------------------------------------------------- */
/* The read                                                                   */
/* -------------------------------------------------------------------------- */

export interface AccountAtPoint {
  readonly account: AccountIdentity;
  readonly from: string;
  readonly to: string;

  /** The day, as it read at the cut. */
  readonly period: AccountPeriod;
  readonly closingCents: bigint;

  /** The whole availability decomposition, at the cut. */
  readonly availability: Availability;

  /** The same value date, at the live watermark. */
  readonly closingNowCents: bigint;

  /**
   * What we learned after the cut about value dates at or before `to`.
   * Clipped to the live watermark; see the header.
   */
  readonly late: readonly LateEntry[];
  /** Σ of `late`. Equal to `closingNowCents − closingCents` when all is well. */
  readonly lateNetCents: bigint;
  /** The identity holds. Rendered honestly when it does not. */
  readonly explained: boolean;

  /**
   * The correction acts standing ABOVE the cut — what this day is about to
   * learn. Not a warning: this is the demonstration. A cut between an
   * original and its reversal is a real, observable boundary between two
   * transactions, and crossing it is what makes the day read differently.
   *
   * The acts the cut must NOT run through the middle of are handled earlier,
   * on `point.cut`, and cannot reach this far.
   */
  readonly pending: readonly PendingAct[];
}

/**
 * Everything the transactions screen needs, for one account, at one point.
 *
 * Issued as three waves rather than one `Promise.all` because the late list
 * must be clipped to a watermark the first wave establishes, and because the
 * split detection consumes the late list rather than re-reading it.
 */
export async function readAccountAtPoint(
  args: {
    readonly accountId: string;
    readonly point: TimePoint;
    readonly window: Window;
  },
  conn: Sql,
): Promise<AccountAtPoint> {
  const { point } = args;
  const to = point.snapshot.valueDate;
  const from = windowStart(to, args.window);

  const account = await readAccountIdentity(args.accountId, conn);
  if (account === null) throw new NoSuchAccountError(args.accountId);

  const [period, availability, periodNow] = await Promise.all([
    readAccountPeriod(
      {
        accountId: args.accountId,
        from,
        to,
        bookingWatermark: point.snapshot.bookingWatermark,
      },
      conn,
    ),
    accountAvailability(args.accountId, point.snapshot, conn),
    // The same rectangle at the live watermark. `settledBalanceCents` would
    // give the closing figure in one call, but not the OPENING one, and the
    // screen shows both sides of `opening + Σ lines = closing` so that a
    // reader can check the arithmetic rather than trust it.
    readAccountPeriod(
      {
        accountId: args.accountId,
        from,
        to,
        bookingWatermark: point.liveWatermark,
      },
      conn,
    ),
  ]);

  const closingCents = foldClosing(period);
  const closingNowCents = foldClosing(periodNow);

  const lateRaw = await listEntriesAboveWatermark(
    {
      accountId: args.accountId,
      throughValueDate: to,
      sinceWatermark: point.snapshot.bookingWatermark,
    },
    conn,
  );
  const late = lateRaw.filter((entry) => entry.bookingSeq <= point.liveWatermark);

  let lateNetCents = 0n;
  for (const entry of late) lateNetCents += entry.signedCents;

  const pending = pendingActs(late);

  return {
    account,
    from,
    to,
    period,
    closingCents,
    availability,
    closingNowCents,
    late,
    lateNetCents,
    explained: closingNowCents - closingCents === lateNetCents,
    pending,
  };
}

/**
 * `closing = opening + Σ lines`, folded HERE and nowhere else.
 *
 * `readAccountPeriod` deliberately does not return a closing balance, for the
 * reason its own header gives: a third `SUM` in SQL would be a second
 * definition that could disagree with the first two, and that is the kind of
 * thing that shows up once, in production, on a statement.
 */
export function foldClosing(period: AccountPeriod): bigint {
  let total = period.openingBalanceCents;
  for (const line of period.lines) total += line.signedCents;
  return total;
}

/**
 * The same value date at a different watermark, without the lines.
 *
 * For the account directory, which needs one figure per account and would
 * otherwise read a whole period rectangle per row.
 */
export async function closingAt(
  args: {
    readonly accountId: string;
    readonly valueDate: string;
    readonly watermark: bigint;
    readonly instant: Date;
  },
  conn: Sql,
): Promise<bigint> {
  return settledBalanceCents(
    args.accountId,
    historicSnapshot(args.valueDate, args.watermark, args.instant),
    conn,
  );
}
