/**
 * What the card & hold console renders, independent of where it came from.
 *
 * Money is `bigint` cents at every point in this file and every point that
 * reads it. There is no `number` amount anywhere in the console: a float that
 * reaches a balance sheet produces `734.0000000000001`, and the only reliable
 * way to prevent that is to never let one exist. Formatting happens once, in
 * `src/lib/format/money.ts`, at the point of render.
 *
 * These types are shared by the live source and by the four fixture states,
 * which is the whole point of having them: `?state=edge` and the bare live URL
 * put the same shape through the same components, so the over-capture story is
 * told by the same arithmetic that tells the real one.
 */

import type { HoldClosedReason, HoldKindRow } from "@/lib/ledger/queries";
import type { CardEventKind, HoldState } from "@/lib/holds";

/** A customer the console can operate on: one 2100 leaf, one 9100 leaf. */
export type ConsoleBusiness = {
  readonly businessId: string;
  readonly legalName: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly currency: string;
  readonly cardCount: number;
};

/**
 * The four figures the whole screen exists to contrast.
 *
 * `availableCents` is `ledger − holds − uncleared` and is DELIBERATELY allowed
 * to be negative — see the note in `availableBalance()`. Clamping it would
 * hide a real overdraft behind a cosmetic floor.
 */
export type ConsoleBalances = {
  readonly ledgerCents: bigint;
  readonly holdsCents: bigint;
  readonly unclearedCents: bigint;
  readonly availableCents: bigint;
};

/** A registered card. `provider_card_token` and `last_four`, never a PAN. */
export type ConsoleCard = {
  readonly cardId: string;
  readonly providerCardToken: string;
  readonly lastFour: string | null;
  readonly nickname: string | null;
  readonly createdAt: string;
};

/** One hold with the terms of `H(E)` kept apart rather than pre-added. */
export type ConsoleHold = {
  readonly holdId: string;
  readonly kind: HoldKindRow;
  readonly descriptor: string;
  readonly externalRef: string;
  /** The provider's transaction token, when a card authorisation backs this. */
  readonly providerAuthId: string | null;
  /** A(E) */
  readonly authorisedCents: bigint;
  /** C(E) */
  readonly clearedCents: bigint;
  /** H(E) = 0 if closed(E) else max(A − C, 0) */
  readonly remainingCents: bigint;
  /** What the memo book itself says. Provenance, not a second source of truth. */
  readonly memoBalanceCents: bigint;
  readonly closed: boolean;
  readonly closedReason: HoldClosedReason | null;
  /**
   * A `hold_closure` row exists AND a `hold_closure_reversal` un-wrote it.
   *
   * Migration 0011: three holds carried a closure reading "authorisation fully
   * reversed" whose authorisation was never reversed, written by a bug fixed
   * long before — and fixing the writer does not unwrite what it wrote. The
   * table is append-only, so the correction is an append.
   *
   * It matters here because the two library functions this screen reads
   * disagree about such a hold. `availableBalance()` checks for the reversal
   * and keeps withholding the money; `listHoldRows()` treats the presence of
   * any closure row as final and reports `H = 0`. Both figures are shown and
   * the difference is named. Picking a favourite would make the screen
   * disagree with the ledger it exists to explain.
   */
  readonly closureReversed: boolean;
  readonly placedAt: string;
  readonly expiresAt: string | null;
  readonly eventCount: number;
};

/** Everything the console shows for one business at one instant. */
export type ConsoleSnapshot = {
  readonly business: ConsoleBusiness;
  readonly balances: ConsoleBalances;
  readonly cards: readonly ConsoleCard[];
  readonly holds: readonly ConsoleHold[];
  /** The instant every figure above was folded as of. */
  readonly asOf: string;
  /** `booking_seq` watermark: what we had learned by `asOf`. */
  readonly bookingWatermark: bigint;
  /**
   * `Σ remaining over active card_auth holds on this account`, folded from the
   * table the screen renders. Compared against `balances.holdsCents`, which is
   * a business-wide aggregate computed by a different query. They should agree;
   * when they do not, the screen says so rather than picking a favourite.
   */
  readonly foldedCardHoldsCents: bigint;
};

/* -------------------------------------------------------------------------- */
/* The drill-down                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One member of `E`, with the running fold at that point.
 *
 * The running totals are not stored anywhere and are not read from anywhere.
 * They are computed by replaying `holdState()` over the prefix of the set, so
 * what the screen prints is what the model does — a fold, shown as a fold.
 */
export type HoldEventRow = {
  readonly providerEventId: string;
  readonly kind: CardEventKind;
  /** Magnitude, always >= 0. Direction lives in `kind`. */
  readonly amountCents: bigint;
  readonly isFinal: boolean;
  /** The card's LOCAL TRANSACTION date, not the settlement date. */
  readonly valueDate: string;
  readonly receivedAt: string;
  /** A(E) over every member up to and including this one. May be negative. */
  readonly runningAuthorisedCents: bigint;
  /** C(E) over every member up to and including this one. */
  readonly runningCapturedCents: bigint;
  /** H(E) over that prefix, under the same clock. */
  readonly runningHoldCents: bigint;
};

export type HoldDetail = {
  readonly holdId: string;
  readonly kind: HoldKindRow;
  readonly descriptor: string;
  readonly externalRef: string;
  readonly accountId: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly provider: string | null;
  readonly providerAuthId: string | null;
  readonly origin: string | null;
  readonly placedAt: string;
  readonly expiresAt: string | null;
  readonly firstSeenAt: string | null;
  /** `hold_closure` exists, and has not been reversed. */
  readonly closureRow: {
    readonly reason: string;
    readonly closedAt: string;
  } | null;
  readonly events: readonly HoldEventRow[];
  /** The model's answer over the whole set, under the authorisation's clock. */
  readonly state: HoldState;
  /** What the memo book says the hold is worth right now. */
  readonly memoBalanceCents: bigint;
  /** The instant `state` was evaluated at — `closed(E)` has a clock term. */
  readonly evaluatedAt: string;
};
