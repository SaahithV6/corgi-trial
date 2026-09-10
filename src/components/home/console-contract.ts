/**
 * The operator console's data contract.
 *
 * ============================================================================
 * The front door renders this type and nothing else. Every figure it shows is
 * a field below; there is no literal on the page that is a number.
 * ============================================================================
 *
 * `console-source.ts` implements it against the live book and
 * `console-fixtures.ts` implements it four more times, once per non-default
 * URL state. The components import this file and never open a connection —
 * the same rule the account and approvals contracts carry, for the same
 * reason: a component that can reach the database is a component that can
 * quietly disagree with the screen it links to.
 *
 * **Money is `bigint` cents, all the way to the renderer.** The account
 * screen's contract narrows to `number` at its boundary and documents the
 * safe-integer assertion that makes that exact; this one does not narrow at
 * all, because the front door sums across every account on the book and a
 * total is the one figure where the narrowing has no upper bound to lean on.
 * `<Money>` takes `bigint` directly, so nothing is lost on the way out.
 */

import type { Gate } from "@/lib/approvals/gate";
import type { ActorKind } from "@/lib/approvals/types";
import type { ErrorShape, Result } from "@/lib/result";

/** Integer minor units (US cents), exactly as the `int8` column holds them. */
export type Cents = bigint;

/** ISO 8601 UTC. */
export type Instant = string;

/** `YYYY-MM-DD`. A business date is a different kind of fact (§5). */
export type ValueDate = string;

/* -------------------------------------------------------------------------- */
/* Positions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One business's money, as the console lists it.
 *
 * Both balances come from the same fold the account screen renders, so a row
 * here and the page it links to cannot quote different numbers. `ledger −
 * available` is `activeHolds + unclearedCredits` by construction, and the
 * table prints all four rather than asking the reader to do the subtraction.
 */
export type AccountPosition = {
  readonly accountId: string;
  readonly accountName: string;
  readonly businessName: string;
  /** Last four of the internal account handle. There is no account number. */
  readonly last4: string;

  /** Settled position. Negative means overdrawn — rendered, never clamped. */
  readonly ledgerCents: Cents;
  /** `ledger − Σ active holds`. May be negative after an over-capture (§10). */
  readonly availableCents: Cents;
  /** Card-auth and manual holds still withholding money. */
  readonly activeHoldsCents: Cents;
  /** Credits received but not yet available under the funds-availability policy. */
  readonly unclearedCreditsCents: Cents;
};

/** The book, folded. Every field is a sum over `positions` and nothing else. */
export type BookTotals = {
  readonly ledgerCents: Cents;
  readonly availableCents: Cents;
  /** `ledger − available`, folded per account then summed. */
  readonly withheldCents: Cents;
  readonly accounts: number;
  readonly businesses: number;
  /** Accounts whose available balance is below zero. */
  readonly negativeAvailable: number;
};

/* -------------------------------------------------------------------------- */
/* Money movement                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One line of one journal entry that touched a customer's deposit account.
 *
 * `amountCents` is signed FROM THE CUSTOMER'S SIDE: positive is money in.
 * The underlying line on a credit-normal liability is the other way round, and
 * the query multiplies by `normal_side` so the renderer never has to know —
 * the same trick `v_ledger_balance` uses, for the same reason.
 */
export type Movement = {
  readonly entryId: string;
  /** `booking_seq`, as text. The total order we learned things in (§5.3). */
  readonly bookingSeq: string;
  readonly bookingTime: Instant;
  readonly valueDate: ValueDate;
  /** `original`, `reversal`, `rebook`, … — correction lineage, shown plainly. */
  readonly entryType: string;
  readonly description: string;
  readonly rail: string | null;
  readonly externalRef: string | null;
  readonly amountCents: Cents;
  readonly accountId: string;
  readonly businessName: string;
};

/* -------------------------------------------------------------------------- */
/* Work                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The oldest payment still awaiting a decision, with the gates that explain
 * what this actor may do to it.
 *
 * The gates are a PRE-COMPUTED EXPLANATION of what `assert_maker_checker()`
 * will do, never permission. The form below still sends every decision to
 * Postgres and Postgres still refuses it. See `lib/approvals/gate.ts`.
 */
export type PendingPayment = {
  readonly id: string;
  readonly amountCents: Cents;
  readonly currency: string;
  readonly rail: string;
  readonly state: string;
  /** One line an approver can check against a beneficiary they recognise. */
  readonly destination: string;
  readonly accountName: string;
  readonly businessName: string | null;
  readonly initiatorName: string;
  readonly initiatorKind: string;
  readonly requestedAt: Instant;
  readonly valueDate: ValueDate;
  /** `ach@2026-01-01` — the policy VERSION this row was judged under. */
  readonly policyVersion: string;
  readonly thresholdCents: Cents;
  readonly aboveThreshold: boolean;
  readonly approvalsHeld: number;
  readonly approvalsRequired: number;
  /** 64 hex characters. Carried into the approval, which is refused without it. */
  readonly contentHash: string;
  readonly gate: Gate;
  readonly releaseGate: Gate;
};

/**
 * Everything currently waiting on a person, counted.
 *
 * Counts only. Each one links to the screen that works it, because a front
 * door that tries to be every screen at once is a front door nobody can read.
 */
export type Attention = {
  readonly pendingPayments: number;
  /** True when the queue read hit its page limit, so the count is a floor. */
  readonly pendingCapped: boolean;
  readonly oldestPendingAt: Instant | null;
  /** `v_overdrawn_accounts` — ledger balance below zero. */
  readonly overdrawnAccounts: number;
  /** Deliveries waiting on an entity we have not seen. Not an error, not a drop. */
  readonly parkedWebhooks: number;
  /** Retry budget exhausted. Visible in `v_webhook_dead_letter`. */
  readonly deadLetteredWebhooks: number;
  /** Businesses whose KYB is not `approved`, and so cannot transact. */
  readonly businessesNotApproved: number;
};

/* -------------------------------------------------------------------------- */
/* The snapshot                                                               */
/* -------------------------------------------------------------------------- */

/** Who this session is acting as. Demo identity — see `lib/approvals/session.ts`. */
export type ConsoleActor = {
  readonly id: string;
  readonly displayName: string;
  /** `human` | `agent` | `system`. Only a human can ever hold approval rights. */
  readonly kind: ActorKind;
  readonly canApprove: boolean;
};

export type ConsoleSnapshot = {
  /** `now()` from the database on the live path; a fixed instant on a fixture. */
  readonly readAt: Instant;
  /** `MAX(booking_seq)`, as text. Provenance, so a screenshot is reproducible. */
  readonly bookingWatermark: string;
  readonly actor: ConsoleActor | null;
  readonly positions: readonly AccountPosition[];
  readonly totals: BookTotals;
  readonly movements: readonly Movement[];
  readonly attention: Attention;
  readonly oldestPending: PendingPayment | null;
  /**
   * False on every fixture state.
   *
   * Load-bearing: it is passed to the decision form, which will not offer to
   * write against a row that has no database row behind it, and it drives the
   * LIVE/FIXTURE badge. A screen that let a fixture look live would be the
   * exact failure the integration table exists to prevent, one screen over.
   */
  readonly live: boolean;
};

export interface ConsoleDataSource {
  /** The whole front door. One call, so every figure describes one instant. */
  read(actor: ConsoleActor | null): Promise<Result<ConsoleSnapshot, ErrorShape>>;
}
