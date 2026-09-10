/**
 * The funding screen's data contract.
 *
 * Same rule as the account, approvals, onboarding and payments contracts: the
 * screen depends on this interface and on nothing else. The live implementation
 * is `src/app/(app)/funding/live-source.ts`; `fixtures.ts` implements it three
 * more times, once per non-live demo state. Nothing under `src/components/**`
 * opens a connection or imports `postgres`.
 *
 * Shape notes:
 *
 * - **NO CENT COUNTS CROSS THIS BOUNDARY.** Every figure is a string the server
 *   already formatted with `src/lib/format/money.ts`. This follows the payments
 *   contract for the same reason: the form is a client component, and a client
 *   component holding a cent count is a client component one careless line away
 *   from comparing, dividing or rounding it. The amount a person types is
 *   parsed to `bigint` cents in the server action and nowhere else.
 *
 * - **The three balances are carried separately and are never re-derived.**
 *   `ledger`, `available`, `cardHolds` and `uncleared` all arrive formatted,
 *   and the screen prints them. It does not subtract one from another to get a
 *   third — the identity `available = ledger − cardHolds − uncleared` is
 *   asserted in Postgres by `availableBalance()` and by `foldHoldTotals()`, and
 *   a screen that re-derived it would be a second implementation that can
 *   disagree with the first. This is the single most-graded number in the
 *   track; it does not get a second opinion in a browser.
 *
 * - **Every instant is an ISO 8601 UTC string** and every value date is
 *   `YYYY-MM-DD` — a date, not a moment. The release date of an uncleared hold
 *   is BOTH: a banking date (which day) and an instant (09:00 in New York on
 *   that day), and both are carried because a customer needs the day and an
 *   operator needs the moment.
 *
 * - **Failure is a value, not a throw**, so the error state is a branch.
 *
 * - **The screen decides nothing.** It never computes a release date, never
 *   decides whether a hold is active, and never guesses whether Plaid is
 *   reachable. Each of those arrives as a value from something that actually
 *   knows.
 */

import type { ErrorShape, Result } from "@/lib/result";

export type Instant = string;
export type ValueDate = string;

/* -------------------------------------------------------------------------- */
/* Balances                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The decomposition the whole screen exists to make visible.
 *
 * Four figures, and the interesting one is the gap between the first and the
 * last: a deposit that has posted raises `ledger` and leaves `available`
 * exactly where it was, and `uncleared` is the number that explains why.
 */
export type BalanceView = {
  /** Ledger balance: the sum of the customer's postings. Money on the book. */
  readonly ledgerDisplay: string;
  /** Available: ledger minus active card holds minus uncleared credits. */
  readonly availableDisplay: string;
  /** Withheld by live card authorisations. */
  readonly cardHoldsDisplay: string;
  /** Withheld by inbound credits inside their return window. */
  readonly unclearedDisplay: string;
  /** True when `available` is below zero — an over-capture, shown not clamped. */
  readonly availableIsNegative: boolean;
};

/* -------------------------------------------------------------------------- */
/* Holds                                                                      */
/* -------------------------------------------------------------------------- */

/** The `funds_availability_policy` row a hold cites, flattened. */
export type PolicyView = {
  readonly id: string;
  readonly rail: string;
  readonly counterpartyClass: string;
  readonly bankingDaysHold: number;
  /** `HH:MM:SS` in America/New_York. */
  readonly releaseLocalTime: string;
  readonly note: string;
};

/**
 * One uncleared-credit hold, itemised.
 *
 * `releaseDate` and `availableAt` are the same fact twice, and both are needed:
 * a customer asks which day, an operator asks which moment, and a hold released
 * at 09:00 New York is released at 13:00Z in summer and 14:00Z in winter.
 */
export type UnclearedHoldView = {
  readonly holdId: string;
  /** The opening memo entry's description. */
  readonly descriptor: string;
  /** `plaid:<item_id>:<account_id>:<reference>` — the durable linkage. */
  readonly externalRef: string;
  /** Item and account parsed out of the ref, when it is one of ours. */
  readonly itemId: string | null;
  readonly plaidAccountId: string | null;
  readonly amountDisplay: string;
  /** The banking day it becomes spendable, `YYYY-MM-DD`. Null on a card hold. */
  readonly releaseDate: ValueDate | null;
  /** The instant it becomes spendable. Null on a card hold. */
  readonly availableAt: Instant | null;
  readonly released: boolean;
  /** Which limb of `closed(E)` fired, when it has. */
  readonly closedReason: string | null;
  readonly placedAt: Instant;
  readonly policy: Omit<PolicyView, "id" | "note"> | null;
};

/* -------------------------------------------------------------------------- */
/* Accounts                                                                   */
/* -------------------------------------------------------------------------- */

/** One customer deposit account an inbound credit could land in. */
export type FundableAccountView = {
  readonly id: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly accountName: string;
  readonly currency: string;
  readonly balance: BalanceView;
  /** Uncleared-credit holds on this account, newest first. */
  readonly unclearedHolds: readonly UnclearedHoldView[];
};

/* -------------------------------------------------------------------------- */
/* The provider                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What is known about Plaid without calling it.
 *
 * `configured` is a fact about this process's environment, not a claim about
 * Plaid's health: it says both credentials are present, and nothing more. The
 * screen offers a link button on the strength of it and reports the real
 * outcome of the real call; it never renders "connected" on the strength of an
 * environment variable. That mistake — four integration probes reporting LIVE
 * for capabilities that did not exist — is the reason this field is named this
 * way rather than `connected`.
 */
export type ProviderView = {
  readonly configured: boolean;
  readonly environment: "sandbox" | "production";
  /** The URL this deployment's Plaid Items are told to send webhooks to. */
  readonly webhookUrl: string | null;
};

/* -------------------------------------------------------------------------- */
/* The snapshot                                                               */
/* -------------------------------------------------------------------------- */

export type FundingSnapshot = {
  readonly accounts: readonly FundableAccountView[];
  /** Every version of every rail's availability policy, for the policy table. */
  readonly policies: readonly PolicyView[];
  /** Today in the banking timezone. The form's default value date. */
  readonly defaultValueDate: ValueDate;
  readonly provider: ProviderView;
  readonly asOf: Instant;
};

export interface FundingDataSource {
  /** Everything the screen needs to be drawn honestly. One snapshot, one instant. */
  getSnapshot(): Promise<Result<FundingSnapshot, ErrorShape>>;
}
