/**
 * The narrow slice of the approval queue this surface needs.
 *
 * `src/lib/approvals` is owned by another worker. It did not exist when this
 * module was first written, so this file carried an interim adapter and a TODO
 * naming the function it expected. That module has since landed and its own
 * header says the same thing from the other side:
 *
 *     `requestPayment()` IS THE FUNCTION THE MCP WRITE TOOL CALLS.
 *
 * So the interim adapter is gone and `gateway.ts` calls the real thing. What
 * remains here is the PORT — the two-method interface the tool depends on —
 * which exists for one reason: it lets every test of the agent surface run
 * without a database while still exercising the same call shape.
 *
 * Three properties this surface depends on, verified by reading
 * `approvals/instructions.ts` and asserted in `mcp.integration.test.ts`:
 *
 *   1. `requestPayment` writes `payment_instruction` and its `requested` event
 *      in ONE transaction. An instruction with no requested event is a payment
 *      nobody can see in the queue.
 *   2. It computes `content_hash` itself, over its own canonical preimage
 *      (`approvals/hash.ts`, `corgi.payment.v1`). This module deliberately
 *      does NOT reimplement that: two canonicalisations that agree today and
 *      diverge tomorrow would silently stop approve-the-hash from binding.
 *   3. A duplicate `idempotencyKey` is a no-op that returns the ORIGINAL
 *      instruction, decided by the unique index rather than by an `if`. An
 *      agent retrying after a socket timeout cannot queue two payments.
 *
 * WHAT THIS PORT DELIBERATELY DOES NOT EXPOSE, and must never grow:
 * `approvePayment`, `rejectPayment`, `cancelPayment`, `releasePayment`, or
 * anything that writes an approval policy. All of those exist in
 * `@/lib/approvals` and are reachable from the human console. None of them is
 * reachable from a bearer token. See docs/AGENT-LIMITS.md for the reasoning,
 * one entry per operation.
 */

import type { QueuePaymentInput, QueuedPayment } from "./types";

export interface PaymentQueuePort {
  /** Raise an instruction into the human approval queue. Moves no money. */
  queuePayment(input: QueuePaymentInput): Promise<QueuedPayment>;
}

/**
 * Re-exported so that a caller of this surface never has to decide WHICH
 * canonicalisation to hash with. There is one, it lives in
 * `@/lib/approvals/hash`, and it is pure — no `server-only`, no database
 * handle — so tests and tools can both reach it.
 */
export { contentHash, contentPreimage, CONTENT_HASH_VERSION } from "@/lib/approvals/hash";
export type { PaymentContent } from "@/lib/approvals/hash";
