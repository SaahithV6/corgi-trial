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
 * - **The balances are carried separately and are never re-derived.**
 *   `ledger`, `available`, `cardHolds`, `uncleared` and `pendingOutbound` all
 *   arrive formatted, and the screen prints them. It does not subtract one
 *   from another to get another — the identity
 *   `available = ledger − cardHolds − uncleared − pendingOutbound` is asserted
 *   in Postgres by `ledger_availability()` (migration 0022), and a screen that
 *   re-derived it would be a second implementation that can disagree with the
 *   first. This is the single most-graded number in the track; it does not get
 *   a second opinion in a browser.
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
 * Five figures, and the interesting one is the gap between the first and the
 * last: a deposit that has posted raises `ledger` and leaves `available`
 * exactly where it was, and `uncleared` is the number that explains why. The
 * three middle figures are the whole of the difference and they are printed
 * rather than implied.
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
  /**
   * Debits already booked with a FUTURE value date: money committed out.
   *
   * The fifth figure, and the one that makes the identity above closed. An
   * outbound ACH originated today for tomorrow's settlement has not moved the
   * ledger and has no hold row — it is a journal entry with tomorrow's value
   * date — but it is gone as far as spending power is concerned, and a
   * customer who can spend it again in the window before it settles has been
   * overdrawn on their own behalf. See `ledger_availability()`, migration 0022.
   */
  readonly pendingOutboundDisplay: string;
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
  /**
   * TRUE WHEN `available_at` IS `infinity`, AND THAT IS A REAL VALUE.
   *
   * A dispute's provisional credit is an `uncleared_credit` hold with no
   * release instant at all: it is withheld until the dispute is decided by a
   * person, never by a clock, and `infinity` is how that is said in Postgres.
   *
   * This flag exists because the absence of it cost this screen entirely.
   * `postgres` parses `infinity::timestamptz` into an `Invalid Date`, the
   * banking-date formatter threw `RangeError: Invalid time value` on it, the
   * throw was caught by the snapshot's own catch, and every business on the
   * book got `FUNDING_PREFLIGHT_FAILED` and no form — because nine rows
   * belonging to ONE customer could not be formatted. See `docs/FUNDING.md`.
   */
  readonly neverReleases: boolean;
  readonly released: boolean;
  /** Which limb of `closed(E)` fired, when it has. */
  readonly closedReason: string | null;
  readonly placedAt: Instant;
  readonly policy: Omit<PolicyView, "id" | "note"> | null;
};

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `canTransact()`'s answer, flattened — the same shape `/payments` carries, on
 * purpose, so the two screens describe the same decision in the same words.
 *
 * FUNDING IS TRANSACTING. Money arriving is money moving: it raises a customer
 * liability, it can be returned, and an entity that has not passed its check
 * must not be able to park a balance with us any more than it can send one.
 * The brief's rule — "unverified entities can look but not transact" — has no
 * inbound exemption, so this screen reads the identical gate and prints the
 * identical code.
 *
 * It is a PREVIEW, not the control. The control is the same read taken again
 * inside `fundFromExternalBankAction`, before a single byte goes to Plaid.
 */
export type TransactGateView = {
  readonly allowed: boolean;
  /** The refusal code verbatim — `KYB_NEEDS_REVIEW`, `KYB_PENDING`, … */
  readonly code: string | null;
  readonly message: string;
  readonly status: string | null;
  readonly evidence: string | null;
};

/**
 * One business on the book, whether or not it can be funded.
 *
 * EVERY business is carried, including one with no deposit account — which is
 * the whole reason this type exists rather than the account list standing in
 * for it. Silverline Freight Co. is `needs_review` and has never had an account
 * opened, so an account-shaped list cannot say anything about it at all, and a
 * screen that cannot say why a business is missing is a screen that looks
 * broken every time somebody asks about one.
 */
export type BusinessView = {
  readonly id: string;
  readonly legalName: string;
  readonly ein: string | null;
  /** The deposit account an inbound credit would land in, when one is open. */
  readonly depositAccountId: string | null;
  readonly gate: TransactGateView;
  /** The same gate under the stricter policy a real-money deployment would run. */
  readonly gateIfLiveRequired: TransactGateView;
};

/* -------------------------------------------------------------------------- */
/* Accounts                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One customer deposit account an inbound credit could land in.
 *
 * `balance` and `unclearedHolds` are NULLABLE, and the null is the lesson this
 * screen learned the expensive way. They used to be unconditional, which meant
 * the read for every account had to succeed for any account to render — so one
 * unformattable hold on one customer took the form away from all four. An
 * account that cannot be read now carries its `readError` and the rest of the
 * book still draws. A degraded row says which account and why; it never shows
 * `$0.00` for a balance nobody managed to read.
 */
export type FundableAccountView = {
  readonly id: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly accountName: string;
  readonly currency: string;
  /** Null when this one account's read failed. Never a zero standing in for one. */
  readonly balance: BalanceView | null;
  /** Uncleared-credit holds on this account, largest first. Null when unread. */
  readonly unclearedHolds: readonly UnclearedHoldView[] | null;
  /** Why this account could not be read, when it could not. */
  readonly readError: ErrorShape | null;
  /** May this business move money? Read for every account, before anything. */
  readonly gate: TransactGateView;
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
  /** Every business on the book, gated, whether or not it holds an account. */
  readonly businesses: readonly BusinessView[];
  /**
   * The business this view is pointed at, after `?business=` has been matched
   * against `businesses`. Null only when the book holds no business at all.
   */
  readonly selectedBusinessId: string | null;
  /** Every version of every rail's availability policy, for the policy table. */
  readonly policies: readonly PolicyView[];
  /** Today in the banking timezone. The form's default value date. */
  readonly defaultValueDate: ValueDate;
  readonly provider: ProviderView;
  readonly asOf: Instant;
};

export interface FundingDataSource {
  /**
   * Everything the screen needs to be drawn honestly. One snapshot, one instant.
   *
   * `businessId` is the raw `?business=` reference. The source matches it
   * against the list it reads; it is never trusted for anything but selection.
   */
  getSnapshot(businessId: string | null): Promise<Result<FundingSnapshot, ErrorShape>>;
}
