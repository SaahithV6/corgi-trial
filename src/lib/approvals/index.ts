/**
 * Maker-checker on money out — the public surface.
 *
 * Import from here, not from the individual modules, with one exception noted
 * below. Four things live behind this barrel:
 *
 *   requestPayment()   THE MCP WRITE TOOL'S ENTRY POINT. Raises an instruction
 *                      from any actor, agent included, into the same queue
 *                      under the same policy version.
 *   listQueue()        the pending queue, folded from events.
 *   approve/reject()   record a decision. The database refuses the ones that
 *                      must be refused; `classifyRefusal` makes that legible.
 *   releasePayment()   posts to the journal and records the release, in one
 *                      transaction, idempotent on the instruction id.
 *
 * THE EXCEPTION: `./types`, `./hash` and `./state` are pure and are imported
 * directly by tests and by the screen's data contract. Everything else in this
 * directory carries `import "server-only"` and cannot be pulled into a client
 * bundle even by accident.
 */

export {
  requestPayment,
  listQueue,
  getPayment,
  type QueueQuery,
  type RequestedPayment,
} from "./instructions";

export {
  approvePayment,
  rejectPayment,
  cancelPayment,
  type Decision,
  type DecisionInput,
} from "./decide";

export {
  releasePayment,
  releaseIdempotencyKey,
  type ReleaseInput,
  type Released,
} from "./release";

export { effectivePolicyFor, listPolicies } from "./policy-store";

export { pickEffectivePolicy, approvalsRequired, requiresApproval } from "./policy";

export { decisionGate, releaseGate, type Gate, type GateCode, type GateActor } from "./gate";

export { resolveActor, currentActor, agentActor, type SessionActor } from "./session";

export {
  classifyRefusal,
  refuse,
  isRefusal,
  rawMessage,
  sqlState,
  REFUSAL_CODES,
  type RefusalCode,
} from "./refusal";

export {
  contentHash,
  contentPreimage,
  canonicalJson,
  requireContentHash,
  isContentHash,
  approvalApplies,
  CONTENT_HASH_VERSION,
  type PaymentContent,
} from "./hash";

export {
  foldState,
  isPending,
  isTerminal,
  canTransition,
  nextKinds,
  normaliseKind,
  STATE_LABEL,
  STATE_DESCRIPTION,
  TERMINAL_STATES,
} from "./state";

export * from "./types";
