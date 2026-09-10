/**
 * The content hash an approval must cite.
 *
 * ============================================================================
 * WHY THIS EXISTS: an approver approves a payment, not a row id.
 *
 * "Dana approved instruction 9f3a…" is worth nothing on its own. Between the
 * moment Dana read $4,200 to Ridgeline's supplier and the moment the money
 * left, the amount, the destination or the rail could have become something
 * else, and the audit trail would still say Dana approved it.
 *
 * So the instruction carries `sha256` over the five fields that ARE the payment
 * — account, rail, amount, destination, value date — the approval carries that
 * same 32 bytes, and `assert_maker_checker()` in 0001 refuses any `approved`
 * event whose `approved_content_hash` is not the instruction's own:
 *
 *     IF NEW.approved_content_hash IS DISTINCT FROM v_pi.content_hash THEN
 *       RAISE EXCEPTION 'approval for % cites the wrong content hash', ...
 *
 * `payment_instruction` is append-only and carries the no-UPDATE trigger from
 * 0001 §13, so those five fields cannot be edited: changing any of them means
 * INSERTing a new instruction, which computes a new hash, which every existing
 * approval fails to cite. A stale approval is therefore not "overridden" or
 * "invalidated" by any code — it simply does not apply to the payment that is
 * about to be released, and the database is the thing that says so.
 * ============================================================================
 *
 * The canonical form below is deliberately a readable, line-oriented string
 * rather than `JSON.stringify(object)`. Two reasons: object key order is a
 * property of how the object was built, and a hash that changes when a field is
 * assigned in a different order is a hash that will one day void an approval
 * for no reason; and an operator investigating a refused release needs to be
 * able to reconstruct the preimage by hand.
 */

import { createHash } from "node:crypto";

import type { PaymentDestination, PaymentRail } from "./types";

/**
 * Version tag on the preimage.
 *
 * If the set of hashed fields ever changes, this changes with it. Old
 * instructions keep hashing the old way because their hash is stored, not
 * recomputed — but a new instruction and a new approval will never
 * accidentally agree with an old one across a definition change.
 */
export const CONTENT_HASH_VERSION = "corgi.payment.v1";

export type PaymentContent = {
  readonly accountId: string;
  readonly rail: PaymentRail;
  readonly amountCents: bigint;
  readonly currency: string;
  readonly destination: PaymentDestination;
  /** `YYYY-MM-DD`. */
  readonly valueDate: string;
};

/**
 * Deterministic JSON: object keys sorted at every depth, arrays left in order
 * (their order is meaning), no whitespace.
 *
 * `bigint` is rejected rather than coerced. Nothing inside a destination is
 * money, and a bigint reaching here means someone put an amount somewhere it
 * does not belong — where `JSON.stringify` would have thrown and a silent
 * `String(value)` would have hashed a different preimage on a different day.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") {
    throw new TypeError("canonicalJson: bigint has no canonical JSON form");
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * The exact bytes that get hashed. Public so a test can assert the preimage
 * rather than only the digest — a hash test that only checks "the same input
 * gives the same output" would pass on a function that hashed nothing.
 */
export function contentPreimage(content: PaymentContent): string {
  return [
    CONTENT_HASH_VERSION,
    `account=${content.accountId}`,
    `rail=${content.rail}`,
    `amount=${content.amountCents.toString()}`,
    `currency=${content.currency}`,
    `value_date=${content.valueDate}`,
    `destination=${canonicalJson(content.destination)}`,
  ].join("\n");
}

/** 64 lowercase hex characters — 32 bytes, exactly what the `bytea` CHECK wants. */
export function contentHash(content: PaymentContent): string {
  return createHash("sha256").update(contentPreimage(content), "utf8").digest("hex");
}

const HEX_32 = /^[0-9a-f]{64}$/;

export function isContentHash(value: unknown): value is string {
  return typeof value === "string" && HEX_32.test(value);
}

/**
 * Normalise anything that claims to be a content hash into the one form the
 * rest of the system uses, or refuse it.
 *
 * Called on the way in from a form field and on the way out of `bytea`, so an
 * uppercase digest, a `\x`-prefixed Postgres literal and a truncated string all
 * fail here — at the boundary, with the offending value named — rather than
 * silently failing to match inside a trigger.
 */
export function requireContentHash(value: unknown, label = "content hash"): string {
  const normalised =
    typeof value === "string" ? value.trim().replace(/^\\x/i, "").toLowerCase() : value;
  if (!isContentHash(normalised)) {
    throw new TypeError(`${label}: expected 64 hex characters, received ${String(value)}`);
  }
  return normalised;
}

/**
 * Does this approval apply to this payment?
 *
 * The application asks this to render an honest screen. It is NOT the control:
 * the control is the trigger, and this function existing does not let a caller
 * skip it. Compare `release.ts`, which never calls this and lets the database
 * decide.
 */
export function approvalApplies(instructionHash: string, approvedHash: string | null): boolean {
  return approvedHash !== null && instructionHash === approvedHash;
}
