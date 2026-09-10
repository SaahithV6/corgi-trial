/**
 * May this actor decide this payment, and if not, what do we tell them?
 *
 * ============================================================================
 * THIS IS A LEGIBILITY LAYER. IT IS NOT THE CONTROL.
 *
 * Every refusal computed here is also computed by a database trigger, and the
 * trigger is the one that holds. The point of this module is that a person
 * should learn they cannot approve their own payment BEFORE they press the
 * button, not after — a disabled control with the reason written next to it,
 * rather than a form that submits and comes back with an error.
 *
 * The two must agree, and they are kept honest by construction: the reasons
 * below are a restatement of `assert_maker_checker()`, the actions still send
 * every decision to the database whether this function allowed it or not, and
 * `gate.test.ts` walks the same cases the integration test walks against Neon.
 * If they ever disagree, the database wins and the screen is wrong — which is
 * the correct way round for a bank.
 * ============================================================================
 */

import type { ActorKind, PaymentState } from "./types";
import { isPending } from "./state";

export type GateCode =
  | "ok"
  /** The initiator is the signed-in actor. The trigger refuses this one. */
  | "self_initiated"
  /** This actor holds no approval rights — or is not human and never could. */
  | "not_an_approver"
  /** Nobody is signed in. */
  | "no_actor"
  /** Already decided or already released; there is nothing left to decide. */
  | "not_pending";

export type GateActor = {
  readonly id: string;
  readonly displayName: string;
  readonly kind: ActorKind;
  readonly canApprove: boolean;
};

export type Gate = {
  readonly allowed: boolean;
  readonly code: GateCode;
  /** Written for the person who is about to be refused. Always non-empty. */
  readonly reason: string;
};

export type GateInput = {
  readonly state: PaymentState;
  readonly initiatorActorId: string;
  readonly initiatorName: string;
  readonly actor: GateActor | null;
};

const ALLOWED: Gate = {
  allowed: true,
  code: "ok",
  reason: "You may record a decision on this payment.",
};

/**
 * The order of these branches is the order the facts matter in.
 *
 * `self_initiated` is checked BEFORE `not_an_approver` on purpose: if Dana
 * raised a payment and Dana is an approver, the honest reason is "you raised
 * this one", not "you cannot approve". And it is checked before `not_pending`
 * so that a released payment still shows the initiator why they were never the
 * one who could have released it.
 */
export function decisionGate(input: GateInput): Gate {
  const { actor } = input;

  if (actor === null) {
    return {
      allowed: false,
      code: "no_actor",
      reason:
        "No actor is resolved for this session, so nothing can be attributed. Every lifecycle event records who caused it; an unattributable decision is not one this system will write.",
    };
  }

  if (actor.id === input.initiatorActorId) {
    return {
      allowed: false,
      code: "self_initiated",
      reason:
        "You raised this payment, so you cannot approve it. The initiator is never the checker — and this is not a rule the screen is applying: assert_maker_checker() in the database refuses the INSERT with SQLSTATE 42501. The button is disabled so you learn it here rather than after pressing it.",
    };
  }

  if (actor.kind !== "human" || !actor.canApprove) {
    return {
      allowed: false,
      code: "not_an_approver",
      reason:
        actor.kind === "human"
          ? `Acting as ${actor.displayName}, who holds no approval rights. Approving money out is a separate role, and the database refuses an approved event from an actor whose can_approve is false.`
          : `Acting as ${actor.displayName}, an automated actor. actor_only_humans_approve makes an approving agent unrepresentable — there is no row shape in which this actor could approve.`,
    };
  }

  if (!isPending(input.state)) {
    return {
      allowed: false,
      code: "not_pending",
      reason:
        "This payment has already left the decision stage. The event stream is append-only, so a decision is added, never replaced.",
    };
  }

  return ALLOWED;
}

/**
 * May this actor RELEASE it? Same gate, plus the approvals the policy version
 * demands. Releasing is not approving — the releaser may be the initiator, and
 * on a below-threshold payment there may be no approver at all — so this is a
 * different question from `decisionGate` and is asked separately.
 */
export function releaseGate(
  input: GateInput & { readonly approvalsHeld: number; readonly approvalsRequired: number },
): Gate {
  const { actor } = input;

  if (actor === null) {
    return {
      allowed: false,
      code: "no_actor",
      reason: "No actor is resolved for this session, so nothing can be attributed.",
    };
  }
  if (!isPending(input.state)) {
    return {
      allowed: false,
      code: "not_pending",
      reason:
        input.state === "released" || input.state === "settled"
          ? "Already released. A second release would post nothing: the journal entry is keyed on the instruction id."
          : "This payment is closed and can never be released.",
    };
  }
  if (input.approvalsHeld < input.approvalsRequired) {
    return {
      allowed: false,
      code: "not_pending",
      reason: `Needs ${input.approvalsRequired} approval(s) under its policy version and holds ${input.approvalsHeld}. Approvals must come from distinct humans who are not ${input.initiatorName}.`,
    };
  }
  return {
    allowed: true,
    code: "ok",
    reason: "This payment has the approvals its policy version requires.",
  };
}
