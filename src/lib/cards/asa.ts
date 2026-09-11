/**
 * Lithic Auth Stream Access: the wire, and nothing else.
 *
 * Verification, parsing and the response body. No database, no decision, no
 * clock beyond the one the caller passes in — `decide()` is next door and this
 * module's only job is to turn 4 KB of provider JSON into the six fields a
 * control decision needs, and a verdict back into the object Lithic expects.
 *
 * ─── Verification ───────────────────────────────────────────────────────────
 *
 * ASA is Standard Webhooks, the same scheme as the asynchronous Lithic events
 * this system already ingests: `webhook-id`, `webhook-timestamp`,
 * `webhook-signature`, HMAC-SHA256 over `id.timestamp.rawbody`, secret is
 * base64 after stripping `whsec_`. So `standardWebhooksVerifier` from the
 * inbox is REUSED rather than re-implemented — a second HMAC implementation is
 * a second place for a timing leak and a second thing to get wrong during a
 * secret rotation, and that module already handles multi-secret rotation and
 * constant-time comparison.
 *
 * TWO THINGS ARE GENUINELY DIFFERENT AND BOTH ARE MEASURED FACTS, not guesses:
 *
 *   1. THE SECRET IS NOT `LITHIC_WEBHOOK_SECRET`. ASA has its own HMAC secret,
 *      retrieved from `GET /v1/auth_stream/secret`. Measured on the sandbox
 *      program on 2026-09-10: that endpoint returns 200 with a distinct
 *      `whsec_…` value. Signing an ASA request with the event-webhook secret
 *      would reject every real delivery.
 *
 *   2. THE HEADERS ARE OPT-IN. Lithic documents that ASA requests carry NO
 *      signature headers by default, and that retrieving the secret is what
 *      turns them on ("headers will appear within minutes"). That makes
 *      "signature absent" a state this code has to have an opinion about, and
 *      the opinion is in `verifyAsaSignature`: absent is a refusal, because a
 *      request we cannot authenticate is a request that must not be allowed to
 *      approve a card payment. What actually arrived is recorded on every
 *      decision row, so the claim "signatures are verified" is answerable with
 *      data instead of with this comment.
 *
 * ─── Why this does not go through the webhook inbox ─────────────────────────
 *
 * `src/lib/webhooks/inbox.ts` is a STORE-THEN-ACK pipeline: verify, persist the
 * raw event, return 2xx, process later. That is exactly right for an event
 * that reports something which already happened, and exactly wrong for a call
 * that is holding a cardholder at a terminal. ASA is DECIDE-AND-ANSWER: the
 * response body IS the side effect. Filing an ASA request in the inbox would
 * add a write to the critical path in order to defer work that cannot be
 * deferred. The two paths therefore share the verifier and share nothing else,
 * and the decision's own durable record is `card_auth_decision`.
 */

import { standardWebhooksVerifier, type VerifyOutcome } from "@/lib/webhooks/inbox";
import type { HeaderLookup } from "@/lib/webhooks/rawbody";

import { isMcc } from "./mcc";
import {
  ASA_REQUEST_STATUSES,
  type AsaRequestStatus,
  type AuthRequest,
  type Verdict,
} from "./types";

/* -------------------------------------------------------------------------- */
/* 1. Verification                                                            */
/* -------------------------------------------------------------------------- */

/** The three headers Standard Webhooks signs with. */
export const ASA_SIGNATURE_HEADERS = [
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
] as const;

/**
 * Five minutes, matching `DEFAULT_TOLERANCE_SECONDS` in the inbox.
 *
 * Worth a sentence because the number looks absurd next to a 6000 ms provider
 * timeout: it is a REPLAY window, not a latency budget. It bounds how long a
 * captured request stays useful to an attacker; it says nothing about how long
 * we may take to answer one.
 */
export const ASA_TOLERANCE_SECONDS = 300;

export type SignatureCheck =
  | { readonly ok: true; readonly webhookId: string | null }
  | { readonly ok: false; readonly reason: string; readonly headersPresent: boolean };

/**
 * Authenticate the RAW bytes of an ASA request.
 *
 * `raw` must be the bytes as received. Anything that re-serialises a parsed
 * body changes key order and whitespace and fails every signature, which is
 * why the route reads `await request.text()` once and passes the string
 * through untouched.
 */
export function verifyAsaSignature(params: {
  readonly raw: string;
  readonly headers: HeaderLookup;
  readonly secrets: readonly string[];
  readonly now: Date;
}): SignatureCheck {
  const headersPresent = ASA_SIGNATURE_HEADERS.every(
    (h) => (params.headers(h) ?? "") !== "",
  );

  if (params.secrets.length === 0) {
    return {
      ok: false,
      reason: "no ASA HMAC secret is available to verify against",
      headersPresent,
    };
  }

  if (!headersPresent) {
    return {
      ok: false,
      reason:
        "ASA request carried no webhook-id / webhook-timestamp / webhook-signature",
      headersPresent: false,
    };
  }

  const verifier = standardWebhooksVerifier({
    provider: "lithic-asa",
    secret: params.secrets,
    secretEncoding: "base64",
    toleranceSeconds: ASA_TOLERANCE_SECONDS,
    // Never used on this path — ASA is not filed in the inbox — but the
    // interface requires it and a lie here would be a trap for whoever wires
    // it somewhere else later.
    identify: ({ headers }) => ({
      providerEventId: headers("webhook-id") ?? "",
      eventType: "auth_stream.request",
    }),
  });

  // The inbox's verifier is declared as possibly-async (Plaid's fetches a key).
  // The Standard Webhooks one is not, and this path cannot afford to await a
  // promise it does not need, so the synchronous outcome is asserted rather
  // than awaited. If that ever stops being true this throws immediately in
  // tests rather than silently comparing a Promise to `{ok:true}`.
  const outcome = verifier.verify({
    raw: params.raw,
    headers: params.headers,
    now: params.now,
  }) as VerifyOutcome;

  if (outcome instanceof Promise) {
    throw new TypeError("the ASA verifier must be synchronous");
  }

  return outcome.ok
    ? { ok: true, webhookId: params.headers("webhook-id") }
    : { ok: false, reason: outcome.reason, headersPresent: true };
}

/* -------------------------------------------------------------------------- */
/* 2. Parsing                                                                 */
/* -------------------------------------------------------------------------- */

export class AsaParseError extends Error {
  override readonly name = "AsaParseError";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  if (source === null) return null;
  const value = source[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * An integer number of cents out of the payload, as `bigint`.
 *
 * Refuses anything that is not a safe integer. Lithic sends amounts as JSON
 * numbers; a value past 2^53 would already have been mangled by `JSON.parse`
 * before this function saw it, so the check cannot recover the true figure —
 * it can only refuse to pretend. A refusal here becomes a fail-closed decline
 * with the reason recorded, which is the correct outcome for "the amount on
 * this authorisation is not representable".
 */
function readCents(source: Record<string, unknown> | null, key: string): bigint | null {
  if (source === null) return null;
  const value = source[key];
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  if (!Number.isSafeInteger(value)) {
    throw new AsaParseError(
      `ASA amount at ${key} is ${value}, which is not a safe integer number of cents`,
    );
  }
  // Absolute value: direction lives in `status`, not in the sign, and Lithic's
  // own signs are inconsistent between the transaction and its events (see the
  // header of src/lib/holds/lithic-events.ts, which measured this).
  return BigInt(Math.abs(value));
}

function readStatus(payload: Record<string, unknown>): AsaRequestStatus {
  const raw = readString(payload, "status");
  const match = ASA_REQUEST_STATUSES.find((s) => s === raw);
  if (match === undefined) {
    throw new AsaParseError(
      `ASA request status ${raw === null ? "(absent)" : `"${raw.slice(0, 40)}"`} is not one Lithic documents`,
    );
  }
  return match;
}

/**
 * Turn one ASA request payload into the six facts a control decision needs.
 *
 * THE AMOUNT PRECEDENCE IS LOAD-BEARING and it follows the provider's own
 * deprecation notices rather than the field that happens to be populated:
 *
 *   1. `amounts.cardholder.amount`   the structured, current field.
 *   2. `amounts.merchant.amount`     same-currency fallback.
 *   3. `authorization_amount`        deprecated. Base amount + acquirer fee.
 *   4. `amount`                      deprecated, and documented as identical
 *                                    to `authorization_amount`.
 *
 * `amounts.hold.amount` is NOT read, and that omission is the interesting one.
 * Lithic's schema says the hold amount "may exceed the cardholder and merchant
 * amounts to account for anticipated final transaction amounts such as tips or
 * fuel fill-ups". Judging a $10 per-transaction limit against a $100
 * anticipated fuel hold would decline a $10 purchase. The limit is a limit on
 * what the cardholder is being asked to pay, so the cardholder amount is what
 * it is compared against — and the hold that follows is the ledger's problem,
 * on the asynchronous path, where `src/lib/holds/model.ts` already handles it.
 */
export function parseAsaRequest(payload: unknown): AuthRequest {
  const root = asRecord(payload);
  if (root === null) {
    throw new AsaParseError("ASA request body is not a JSON object");
  }

  const card = asRecord(root["card"]);
  const cardToken = readString(card, "token");
  if (cardToken === null) {
    throw new AsaParseError("ASA request carries no card.token");
  }

  const providerAuthToken = readString(root, "token");
  if (providerAuthToken === null) {
    throw new AsaParseError("ASA request carries no transaction token");
  }

  const amounts = asRecord(root["amounts"]);
  const amountCents =
    readCents(asRecord(amounts?.["cardholder"]), "amount") ??
    readCents(asRecord(amounts?.["merchant"]), "amount") ??
    readCents(root, "authorization_amount") ??
    readCents(root, "amount");

  if (amountCents === null) {
    throw new AsaParseError("ASA request carries no readable authorisation amount");
  }

  const merchant = asRecord(root["merchant"]);
  const rawMcc = readString(merchant, "mcc");

  return {
    providerAuthToken,
    card: {
      token: cardToken,
      lastFour: readString(card, "last_four"),
      memo: readString(card, "memo"),
      state: readString(card, "state"),
    },
    amountCents,
    // Not four digits is not an MCC. Recorded as null rather than coerced —
    // see the `mcc_blocked` rule in decide.ts for why the absence of an MCC
    // must never be treated as a match.
    mcc: isMcc(rawMcc) ? rawMcc : null,
    merchantDescriptor: readString(merchant, "descriptor"),
    requestStatus: readStatus(root),
  };
}

/* -------------------------------------------------------------------------- */
/* 3. The response                                                            */
/* -------------------------------------------------------------------------- */

export type AsaResponseBody = {
  readonly result: string;
  readonly token: string;
};

/**
 * The body Lithic expects.
 *
 * `result` is the only required field. `token` is echoed because Lithic
 * accepts it and because a response that names the transaction it answers is
 * one a network trace can be read against.
 *
 * Nothing else is sent. In particular `approved_amount` is NOT sent: setting
 * it means PARTIAL APPROVAL, and partially approving an authorisation that
 * broke a limit would create a hold for an amount the customer never agreed
 * to and a settlement the control never judged. A limit is a refusal, not a
 * negotiation.
 */
export function asaResponseBody(verdict: Verdict, request: AuthRequest): AsaResponseBody {
  return { result: verdict.result, token: request.providerAuthToken };
}
