/**
 * The approvals screen's data contract.
 *
 * The screen depends on this interface and on nothing else. `src/lib/approvals`
 * implements it (`screen.ts`), and `fixtures.ts` implements it four more times
 * — once per demo state — so every state on the screen is reachable without
 * writing a row.
 *
 * Nothing in `src/components/**` opens a connection. The rule from the account
 * screen's contract holds here: if a component needs a value that is not on
 * these types, the fix is to widen the contract, not to import `postgres`.
 *
 * Shape notes, all of which are the same notes the account contract carries and
 * for the same reasons:
 *
 * - **Every amount is integer minor units (US cents)**, as `number`. The
 *   database column is `bigint` and `src/lib/ledger/db.ts` parses it as one;
 *   the narrowing happens once, in `screen.ts`, and is exact to ~$90tn.
 * - **Every instant is an ISO 8601 UTC string.** Value dates are `YYYY-MM-DD`
 *   and are a different type of fact (§5).
 * - **Failure is a value, not a throw**, so the error state is a branch.
 * - **The screen never decides anything.** `gate` on each row is a
 *   PRE-COMPUTED EXPLANATION of what the database will do, not permission. The
 *   server action sends every decision to Postgres regardless.
 */

import type { Gate } from "@/lib/approvals/gate";
import type { ActorKind, PaymentState, PayoutRail } from "@/lib/approvals/types";
import type { ErrorShape, Result } from "@/lib/result";

export type Cents = number;
export type Instant = string;
export type ValueDate = string;

/** Who this session is acting as. Demo identity — see `lib/approvals/session.ts`. */
export type ActorView = {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ActorKind;
  readonly canApprove: boolean;
};

/** One `approval_policy` row, as the screen shows it. */
export type PolicyView = {
  readonly id: string;
  /** `ach@2026-01-01` — the (rail, effective_from) unique key, printed. */
  readonly version: string;
  readonly rail: string;
  readonly effectiveFrom: ValueDate;
  readonly thresholdCents: Cents;
  readonly requiredApprovals: number;
  readonly note: string;
};

/** One decision already on the record, for the audit trail under each row. */
export type EventView = {
  readonly id: string;
  readonly kind: string;
  readonly actorName: string;
  readonly actorKind: ActorKind;
  readonly reason: string | null;
  readonly occurredAt: Instant;
  /** Present on `approved`. Truncated for display; the full hash is on the row. */
  readonly citedHash: string | null;
  /** Does this approval still apply to the payment as it stands? */
  readonly citesCurrentHash: boolean;
  readonly entryId: string | null;
};

export type QueueItem = {
  readonly id: string;
  readonly state: PaymentState;

  readonly amountCents: Cents;
  readonly currency: string;
  readonly rail: PayoutRail;

  /** One line an approver can check against a beneficiary they recognise. */
  readonly destination: string;
  readonly accountName: string;
  readonly businessName: string | null;

  readonly initiatorActorId: string;
  readonly initiatorName: string;
  readonly initiatorKind: ActorKind;
  readonly requestedAt: Instant;
  readonly valueDate: ValueDate;

  /**
   * The policy VERSION this payment was judged under — read from the row's own
   * `policy_id`, never re-picked from today's table.
   */
  readonly policy: PolicyView;
  readonly aboveThreshold: boolean;
  readonly approvalsHeld: number;
  readonly approvalsRequired: number;

  /** 64 hex characters. Carried into the approval, which is refused without it. */
  readonly contentHash: string;

  readonly events: readonly EventView[];

  /** Why the approve/reject controls are enabled or disabled, for this actor. */
  readonly gate: Gate;
  /** Why release is or is not available, for this actor. */
  readonly releaseGate: Gate;
};

export type ApprovalsSnapshot = {
  readonly actor: ActorView | null;
  readonly queue: readonly QueueItem[];
  /** Every version of every policy, newest first. Shown as provenance. */
  readonly policies: readonly PolicyView[];
  readonly asOf: Instant;
};

export interface ApprovalsDataSource {
  /** The pending queue plus everything needed to explain it. One call. */
  getQueue(actor: ActorView | null): Promise<Result<ApprovalsSnapshot, ErrorShape>>;
}
