/**
 * The seam between the time-travel screens and what they render.
 *
 * ===========================================================================
 * WHY THERE IS NO `number` CENTS NARROWING HERE
 * ===========================================================================
 *
 * Every other screen contract in this console carries `number` cents, because
 * its view types cross to a CLIENT component and `bigint` does not survive
 * JSON. `src/components/statements/data-contract.ts` says so, and it narrows
 * once, at the edge, refusing rather than rounding.
 *
 * Nothing under `src/components/timetravel/**` is a client component. There is
 * no `"use client"` in this directory and no interactivity that would need
 * one: every control is a `<Link>` to the same route with a different query
 * string, which is the house rule anyway — every state reachable by URL.
 *
 * So money stays `bigint` from `journal_line.amount_cents` to the `<Money>`
 * element, and there is no narrowing site at all. Not one `/ 100`, not one
 * `toFixed`, and no place where a balance past `Number.MAX_SAFE_INTEGER` could
 * quietly lose its last digits. `Money` takes `CentsInput = number | bigint`
 * and formats through `src/lib/format/money.ts`.
 *
 * If a control here ever needs state a URL cannot hold, THAT is the moment to
 * add a narrowing edge — and to write down what it refuses.
 */

import type { Availability } from "@/lib/ledger/balance-definitions";
import type { AccountIdentity, LateEntry, PeriodLine } from "@/lib/ledger/readers";
import type { CutSafety, PendingAct } from "@/lib/timetravel/integrity";
import type { CorrectionLandmark } from "@/lib/timetravel/landmarks";
import type { TimePoint } from "@/lib/timetravel/point";
import type { Window } from "@/lib/timetravel/read";
import type { ErrorShape } from "@/lib/result";

export type { AccountIdentity, Availability, CutSafety, LateEntry, PendingAct };
export type { CorrectionLandmark, PeriodLine, TimePoint, Window };

/** Where the numbers came from. Rendered on the screen, always. */
export type TimeTravelSource = "live" | "fixture";

/** One account in the picker. */
export type AccountOption = {
  readonly accountId: string;
  readonly accountName: string;
  readonly legalName: string;
};

/**
 * One posting as the transactions table lists it.
 *
 * Both clocks on every row — `valueDate` and `bookingSeq` — because a row that
 * shows only one of them is the exact ambiguity this screen exists to remove.
 * `runningCents` is folded by the view from the opening balance, so the column
 * a reader adds up by eye is the same arithmetic the headline claims.
 */
export type PostingRow = {
  readonly line: PeriodLine;
  readonly runningCents: bigint;
  /**
   * Booked ABOVE the cut. Always false on this screen by construction — the
   * period read is bounded by the watermark — and carried anyway so the table
   * component can be pointed at a live reading without changing.
   */
  readonly late: boolean;
};

/** The whole transactions screen, in one read. */
export type TransactionsView = {
  readonly source: TimeTravelSource;
  readonly point: TimePoint;
  readonly window: Window;

  readonly accounts: readonly AccountOption[];
  readonly account: AccountIdentity;

  /** The value-date window this screen covers. */
  readonly from: string;
  readonly to: string;

  readonly openingCents: bigint;
  readonly postings: readonly PostingRow[];
  /** Closing at the cut: `opening + Σ postings`. */
  readonly closingCents: bigint;

  /** The same value date, read at the live watermark. The other reading. */
  readonly closingNowCents: bigint;
  /** `closingNow − closing`. The belief that changed. */
  readonly deltaCents: bigint;

  /** Everything learned after the cut about value dates at or before `to`. */
  readonly late: readonly LateEntry[];
  readonly lateNetCents: bigint;
  /** `delta === Σ late`. Rendered honestly when it does not hold. */
  readonly explained: boolean;

  /** The correcting acts standing above the cut. */
  readonly pending: readonly PendingAct[];

  /** Availability at the cut — all five terms, not a conclusion. */
  readonly availability: Availability;

  /** Correction acts on this account, with the instants worth standing at. */
  readonly landmarks: readonly CorrectionLandmark[];
};

export type TransactionsQuery = {
  readonly accountId: string | null;
  readonly window: Window;
  readonly point: TimePoint;
};

export interface TransactionsSource {
  load(query: TransactionsQuery): Promise<TransactionsResult>;
}

export type TransactionsResult =
  | { readonly ok: true; readonly value: TransactionsView }
  | { readonly ok: false; readonly error: ErrorShape };
