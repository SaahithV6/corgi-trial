/**
 * The payments screen's data contract.
 *
 * Same rule as the account, approvals and onboarding contracts: the screen
 * depends on this interface and on nothing else. The live implementation is
 * `src/app/(app)/payments/live-source.ts`; `fixtures.ts` implements it three
 * more times, once per non-live demo state. Nothing under `src/components/**`
 * opens a connection or imports `postgres`.
 *
 * Shape notes, and one of them is different from every other contract in this
 * codebase:
 *
 * - **THERE IS NO CENT COUNT ON THIS CONTRACT AT ALL.** Every other screen
 *   carries `Cents` as a `number` and formats it where it renders. This one
 *   carries `thresholdDisplay: string`, already formatted by
 *   `src/lib/format/money.ts` on the server, and no numeric amount. The reason
 *   is narrow and deliberate: the form that consumes this contract is a CLIENT
 *   component, and a client component holding a cent count is a client
 *   component one careless line away from comparing, dividing or rounding it.
 *   The amount a person types is parsed to `bigint` cents in the server action
 *   and nowhere else; the threshold is compared to it inside
 *   `requestPayment()`, in Postgres's transaction, and nowhere else. Handing
 *   the browser a number it has no correct use for is how that stops being
 *   true.
 * - **Every instant is an ISO 8601 UTC string.** Value dates are `YYYY-MM-DD`
 *   and are a different kind of fact (§5) — a date, not a moment.
 * - **Failure is a value, not a throw**, so the error state is a branch.
 * - **The screen decides nothing.** `gate` on an account is the output of
 *   `canTransact()`, computed on the server and rendered verbatim. It is a
 *   PREVIEW of what `requestPayment()` will do, not permission: the real gate
 *   runs inside the same transaction that writes the instruction, and the
 *   server action sends every submission to it whatever this said.
 */

import type { Evidence, KybStatus, TransactDenialCode } from "@/lib/kyb";
import type { ActorKind, PayoutRail } from "@/lib/approvals/types";
import type { ErrorShape, Result } from "@/lib/result";

export type Instant = string;
export type ValueDate = string;

/** Who this session is acting as. Demo identity — see `lib/approvals/session.ts`. */
export type ActorView = {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ActorKind;
  readonly canApprove: boolean;
};

/** `canTransact()`'s answer, flattened for rendering. Never re-derived here. */
export type TransactGateView = {
  readonly allowed: boolean;
  /** Null exactly when `allowed` is true. */
  readonly code: TransactDenialCode | null;
  readonly message: string;
  readonly status: KybStatus | null;
  readonly evidence: Evidence | null;
};

/**
 * One account the money could leave from.
 *
 * Accounts that the gate will refuse are STILL LISTED, and listing them is the
 * point of the screen. An unverified business that is invisible teaches
 * nothing; an unverified business you can select, submit, and be refused with a
 * code teaches the whole control in one click.
 */
export type SourceAccountView = {
  readonly id: string;
  readonly name: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly currency: string;
  /** `canTransact()` under THIS deployment's policy — the one that will run. */
  readonly gate: TransactGateView;
  /**
   * The same predicate under `requireLiveEvidence: true` — what this account
   * would do in a deployment that touches real money. Shown beside the first
   * so an approval on simulated evidence is never mistaken for a verified one.
   */
  readonly gateIfLiveRequired: TransactGateView;
};

/**
 * One version of one rail's `approval_policy` row.
 *
 * Every version is sent, not just the one in force today, because the form has
 * to answer "what will judge a payment dated the 30th?" and that is an
 * effective-date question the browser can answer from the same rows Postgres
 * would use — by comparing `YYYY-MM-DD` strings, which is the identical
 * ordering `effectivePolicyFor()` gets from `ORDER BY effective_from DESC`.
 *
 * The threshold is a STRING because of the note at the top of this file.
 */
export type PolicyOptionView = {
  readonly id: string;
  /** `ach@2026-01-01` — the (rail, effective_from) unique key, printed. */
  readonly version: string;
  readonly rail: PayoutRail;
  readonly effectiveFrom: ValueDate;
  /** Already formatted: `$2,500.00`. No cent count crosses to the client. */
  readonly thresholdDisplay: string;
  readonly requiredApprovals: number;
  readonly note: string;
};

/**
 * One confirmed wire beneficiary the clerk may pick.
 *
 * WHY THE WIRE BRANCH IS A PICKER AND THE ACH BRANCH IS NOT. It is not a
 * convenience, and the asymmetry is the point.
 *
 * `originateApprovedWire()` REFUSES a beneficiary that is not on this
 * business's confirmed payee book (`WIRE_PAYEE_NOT_ON_BOOK`), because a wire
 * is final on receipt and business email compromise is a WELL-FORMED
 * instruction: a real-sounding beneficiary, a real bank, a valid ABA, sent
 * from a real employee's real mailbox. Nothing about it is wrong on its face,
 * and the only control that has ever worked against it is a second person who
 * was not in the email thread — which is `required_approvals = 2` — plus the
 * beneficiary having been checked BEFORE the urgency arrived.
 *
 * With a free-text field, that refusal arrives at ORIGINATION: after the
 * instruction is raised, after two humans have approved it, after the ledger
 * entry is posted. A clerk can raise a wire on this screen that cannot be
 * sent, and finds out two approvals too late. The picker moves the refusal to
 * the front, where it costs nobody anything.
 *
 * AND IT IS WRONG FOR ACH, deliberately. `gatePaymentOnPayee()` does not
 * require pre-registration there, because the costs of requiring it — the
 * one-off refund, the emergency supplier payment, the payment raised by the
 * MCP agent from an invoice — are costs of DELAY, and on ACH a delay is
 * recoverable because the entry is: two banking days of recall. On a wire it
 * is not. The asymmetry between these two branches is that one difference,
 * and nothing else.
 *
 * `wireRoutingNumber` crosses to the client, and that is not a leak: it is a
 * PUBLIC bank identifier, it is already printed on the ACH branch's own input,
 * and it is about to be submitted from this form anyway. The full account
 * number never appears — `accountNumberLast4` is all the book stores.
 */
export type WirePayeeOption = {
  readonly payeeId: string;
  readonly displayName: string;
  /** The name that goes on the Fedwire message. ISO 20022 `creditor.name`. */
  readonly holderName: string;
  /** The receiving bank's 9-digit WIRE ABA. Not its ACH ABA. */
  readonly wireRoutingNumber: string;
  readonly accountNumberLast4: string;
  readonly institutionName: string | null;
  /** `verified` / `warned` / null when nothing has ever been checked. */
  readonly outcome: string | null;
  /** True when a named human has signed for a standing warning. */
  readonly acknowledged: boolean;
  /** `fresh` / `ageing` / `stale` / `never`, derived by `v_payee_book`. */
  readonly freshness: string;
  /**
   * What `gatePaymentOnPayee()` will say about this beneficiary, predicted.
   * Null means it will not refuse. A PREDICTION: the gate re-decides inside
   * the transaction that writes the instruction, under its own snapshot.
   */
  readonly gateRefusalCode: string | null;
};

/** What the edge state puts in the form before anyone types. */
export type Prefill = {
  readonly accountId: string | null;
  readonly rail: PayoutRail;
  /** Dollars and cents as typed, e.g. `2500.00`. Parsed to bigint server-side. */
  readonly amount: string;
  readonly reference: string;
  readonly holderName: string;
  readonly routingNumber: string;
  readonly accountNumberLast4: string;
};

export type PaymentsSnapshot = {
  readonly actor: ActorView | null;
  readonly accounts: readonly SourceAccountView[];
  /** Every version of every payout rail's policy, newest first within a rail. */
  readonly policies: readonly PolicyOptionView[];
  /**
   * The confirmed wire beneficiaries, by the business whose account they
   * belong to. Keyed by `businessId` because the payee book is keyed by
   * business and the form's source account chooses which one is in scope —
   * a picker that offered another customer's beneficiaries would be a payee
   * book with no boundary.
   */
  readonly wirePayeesByBusiness: Readonly<Record<string, readonly WirePayeeOption[]>>;
  /** Today in the banking timezone. The form's default value date. */
  readonly defaultValueDate: ValueDate;
  readonly asOf: Instant;
};

export interface PaymentsDataSource {
  /** Everything the form needs to be drawn honestly. One call. */
  getFormData(actor: ActorView | null): Promise<Result<PaymentsSnapshot, ErrorShape>>;
}

/**
 * How the screen learns who this session would raise an instruction as.
 *
 * A seam for the same reason `PaymentsDataSource` is one, and added for the
 * same defect. `PaymentsView` used to call `currentActor()` directly, which
 * meant it imported `@/lib/approvals/session` at module scope, which reaches
 * `@/lib/ledger/db` -> `@/lib/env` and throws without `APP_DATABASE_URL` — so
 * the page module could not be loaded on a deployment with no database, and
 * neither could the three fixture states parked behind it. The live
 * implementation is now reached through `await import(...)` in `page.tsx`, on
 * the branch that has established there is a database; `unreadable.ts` holds
 * the one that resolves nobody.
 */
export interface ActorSource {
  current(): Promise<ActorView | null>;
}
