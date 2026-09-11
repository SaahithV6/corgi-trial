/**
 * What `/client/payouts` reads, stated as data before anything renders it.
 *
 * Pure: no `server-only`, no `postgres`, no React. The live reader fills it in
 * and the view consumes it, and neither of them is the place where the shape is
 * decided — the same split `@/components/client/contract` keeps for the other
 * five client screens.
 *
 * ── ONE BUSINESS, AND NOT AS A FILTER ───────────────────────────────────────
 *
 * Every collection below is already scoped when it arrives: the quotes come
 * from `WHERE business_id = $1` inside Postgres, and the availability figure
 * comes from `ledger_availability()` for that business's own `2100` leaf. There
 * is no field here that could hold another customer's row for a component to
 * remember to drop.
 */

import type { QuoteLine } from "./state";

/** A quote on this customer's book, as the list shows it. */
export type QuoteRow = {
  readonly quoteRef: string;
  /** `open`, `expired`, `accepted`, `lapsed`, `settled`. Derived, never stored. */
  readonly state: string;
  readonly destination: string;
  readonly beneficiaryRef: string;
  /** What leaves the account. The commitment, once accepted. */
  readonly sellCents: bigint;
  /** `"MXN 16,772.40"`. Formatted against the currency's own minor unit. */
  readonly deliveryDisplay: string;
  /** `"16.8588"` — the rate the customer was offered, not the mid. */
  readonly rateDisplay: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Set once accepted. The instant we stop honouring the rate. */
  readonly settleBy: string | null;
  /** A row a test wrote. Labelled, never hidden. */
  readonly isFixture: boolean;
};

/**
 * A quote this customer has accepted and not yet settled.
 *
 * This is money already spoken for: since migration 0053 an acceptance places
 * an ordinary `manual` hold on the customer's `2100` leaf for `sell_cents`, and
 * `ledger_availability()` subtracts it through the hold term it already had.
 * The figure below is therefore ALREADY out of `availableCents`; it is listed
 * so a customer can see what took it, not so anybody can subtract it twice.
 */
export type StandingCommitment = {
  readonly quoteRef: string;
  readonly withheldCents: bigint;
  readonly deliveryDisplay: string;
  readonly beneficiaryRef: string;
  readonly acceptedAt: string;
  readonly settleBy: string | null;
};

export type PayoutsScreen = {
  readonly businessId: string;
  readonly legalName: string;
  /** ISO instant every figure on the page was read at. One instant, not five. */
  readonly asOf: string;
  /** `ledger_availability()`'s own answer. Never re-derived here. */
  readonly availableCents: bigint;
  readonly ledgerCents: bigint;
  /** The sum of `standing`. Shown as what is withheld, not subtracted again. */
  readonly committedCents: bigint;
  readonly standing: readonly StandingCommitment[];
  readonly quotes: readonly QuoteRow[];
  /**
   * The customer switcher. This build has no sign-in; see `view-state.ts`.
   *
   * `hasAccount` is carried because every other client screen's picker suffixes
   * "— no account yet" and this one did not, so the ONE screen where choosing
   * the wrong customer commits money was the one screen that did not say the
   * customer you were about to choose has nothing to commit from.
   */
  readonly businesses: readonly {
    readonly id: string;
    readonly legalName: string;
    readonly hasAccount: boolean;
  }[];
  /** The corridors this bank will quote. A closed list, not a currency table. */
  readonly corridors: readonly {
    readonly currency: string;
    readonly name: string;
    readonly destination: string;
  }[];
};

/** Re-exported so a view imports one module for the whole vocabulary. */
export type { QuoteLine };
