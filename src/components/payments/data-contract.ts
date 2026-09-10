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
  /** Today in the banking timezone. The form's default value date. */
  readonly defaultValueDate: ValueDate;
  readonly asOf: Instant;
};

export interface PaymentsDataSource {
  /** Everything the form needs to be drawn honestly. One call. */
  getFormData(actor: ActorView | null): Promise<Result<PaymentsSnapshot, ErrorShape>>;
}
