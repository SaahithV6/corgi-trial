/**
 * The shape `/client/funding` renders, and nothing else.
 *
 * No row here carries a tenant discriminator, deliberately and for the reason
 * `src/components/client/contract.ts` gives: if a view component could read
 * `row.businessId` it could also decide with it, and tenant isolation would
 * stop being a `WHERE` clause evaluated by Postgres and start being a step in a
 * program. Every row below was already scoped by the predicate that produced
 * it; there is nothing left on this side of the line to scope.
 *
 * NO `access_token` FIELD EXISTS ON ANY TYPE IN THIS FILE, and none can be
 * added by accident: the reader never puts key material in a row, and the one
 * function in the codebase that reads `plaid_item_secret` —
 * `liveAccessTokenFor()` — returns a wrapper whose `toJSON()` is `[redacted]`,
 * so even a stray spread could not serialise one into a React tree.
 *
 * Money is `bigint` cents here and is formatted at the very edge. It never
 * crosses into a client component in this shape.
 */

import type { BusinessRef } from "@/components/client/contract";
import type { PlaidItemState } from "@/lib/rails/plaid/item-store";

/** One external bank account the customer could pull money from. */
export type LinkedAccountLine = {
  /** Plaid's own account id. A reference, re-checked server-side before a write. */
  readonly plaidAccountId: string;
  readonly name: string;
  /** Last four, or null when the institution publishes none. */
  readonly mask: string | null;
  readonly subtype: string | null;
  /** Public bank routing data. Safe to print; the account number never is. */
  readonly routingNumber: string | null;
  readonly authMethod: string | null;
};

/** One linked bank — a Plaid Item — as the customer sees it. */
export type LinkedBankLine = {
  readonly itemId: string;
  readonly institutionName: string | null;
  /** `healthy` | `needs_reauth` | `revoked` | `orphaned`, from `v_plaid_item_state`. */
  readonly state: PlaidItemState;
  readonly linkedAt: string | null;
  readonly lastObservedAt: string;
  /** Plaid's own code, never one this codebase invented. */
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  /** Empty when the Item is not in a state anything may be pulled from. */
  readonly accounts: readonly LinkedAccountLine[];
};

/** The five terms of `ledger_availability()`, as read, in cents. */
export type AvailabilityTerms = {
  readonly ledgerCents: bigint;
  readonly holdsCents: bigint;
  readonly unclearedCents: bigint;
  readonly pendingOutboundCents: bigint;
  readonly availableCents: bigint;
};

/**
 * One deposit already pulled in from a linked bank, as its HOLD.
 *
 * The hold is the row that matters on this screen: it is what keeps the money
 * out of the spendable balance, it carries the instant it stops doing so, and
 * it is already returned — scoped — by the balance reader. Reading the journal
 * entry separately would be a second answer to a question that already has one.
 */
export type OriginatedDepositLine = {
  readonly holdId: string;
  readonly descriptor: string;
  readonly externalRef: string;
  readonly amountCents: bigint;
  /** What is still withheld. Falls to zero as the credit is released. */
  readonly remainingCents: bigint;
  readonly placedAt: string;
  /**
   * ISO instant, or `null` — and `null` covers two cases: no release clock at
   * all, and a clock set to `infinity`. `releaseWaitsOnAPerson` tells them
   * apart, because one unguarded `.toISOString()` on that `infinity` took a
   * whole account screen down once already.
   */
  readonly availableAt: string | null;
  readonly releaseWaitsOnAPerson: boolean;
};

export type ClientFundingScreen = {
  readonly subject: {
    readonly businessId: string;
    readonly legalName: string;
    readonly accountName: string | null;
    readonly asOf: string;
    readonly live: boolean;
    readonly businesses: readonly BusinessRef[];
  };
  readonly banks: readonly LinkedBankLine[];
  readonly terms: AvailabilityTerms;
  readonly deposits: readonly OriginatedDepositLine[];
  /** False when PLAID_CLIENT_ID / PLAID_SECRET are not both set. */
  readonly plaidConfigured: boolean;
};
