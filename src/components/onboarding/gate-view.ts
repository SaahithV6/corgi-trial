/**
 * `canTransact()`'s answer, flattened for rendering.
 *
 * Pure, and deliberately the only transformation applied to a `TransactDecision`
 * anywhere: the live source (`src/lib/kyb/wire.ts`) and the fixtures both go
 * through this function, so a fixture row and a live row are described in the
 * same words. It adds no judgement — a denial's code and message are carried
 * verbatim, and the only sentence written here is the one `canTransact` does
 * not supply, which is the wording of an ALLOWANCE.
 *
 * That wording matters. An approval resting on simulated evidence is still an
 * approval under this deployment's policy, and the screen has to say what it
 * rests on rather than render a green tick over a value it was handed and
 * ignored.
 */

import type { TransactDecision } from "@/lib/kyb";

import type { TransactGateView } from "./data-contract";

export function gateView(decision: TransactDecision): TransactGateView {
  if (decision.allowed) {
    return {
      allowed: true,
      code: null,
      message:
        decision.evidence === "live"
          ? "Approved on live third-party evidence. This business may raise a payment."
          : "Approved, but on simulated evidence: this deployment's policy allows it, and the label says exactly what it rests on.",
      status: decision.status,
      evidence: decision.evidence,
    };
  }
  return {
    allowed: false,
    code: decision.code,
    message: decision.message,
    status: decision.status,
    evidence: decision.evidence,
  };
}
