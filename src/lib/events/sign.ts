/**
 * Signing what we send, in the same scheme we verify on the way in.
 *
 * ===========================================================================
 * THIS IS THE MIRROR OF `standardWebhooksVerifier` IN inbox.ts
 * ===========================================================================
 *
 * The inbound side of this build verifies Lithic and Increase with Standard
 * Webhooks: three headers, HMAC-SHA256 over `{id}.{timestamp}.{raw body}`,
 * base64, `v1,` prefixed, space-separated for rotation, ±300s replay window,
 * constant-time comparison. That code is in
 * `src/lib/webhooks/inbox.ts` and it is not to be edited.
 *
 * So this module produces exactly what that module accepts, and the proof is
 * not an assertion in a comment: `sign.test.ts` signs a body here and feeds
 * the result to `standardWebhooksVerifier` from `inbox.ts` — the SAME function
 * that checks real Lithic deliveries — and asserts `{ ok: true }`. Then it
 * changes one byte of the body and asserts `{ ok: false }`. A signature nobody
 * has watched reject something is not a signature.
 *
 * The practical consequence for a customer: they do not need us to publish a
 * verification snippet. Anything that speaks Standard Webhooks — the
 * `standardwebhooks` npm package, Svix's libraries in six languages, or the
 * verifier they may already have written for their Stripe or Lithic feed —
 * checks our signature with the secret and nothing else.
 *
 * ===========================================================================
 * THE THREE HEADERS, AND WHAT EACH ONE IS FOR
 * ===========================================================================
 *
 *   webhook-id         Our event id. STABLE ACROSS EVERY RETRY AND ACROSS
 *                      EVERY ENDPOINT OF THE SAME BUSINESS. This is the
 *                      customer's deduplication key, and it is the same
 *                      column our own inbox dedupes Lithic on
 *                      (`provider_event_id` = the `webhook-id` header). They
 *                      should do to us exactly what we do to Lithic: a unique
 *                      index on it, `ON CONFLICT DO NOTHING`, 2xx either way.
 *
 *   webhook-timestamp  Unix SECONDS at the moment of THIS attempt. It changes
 *                      per attempt, so the signature changes per attempt, and
 *                      that is correct: the timestamp exists to bound replay,
 *                      and a fixed timestamp across a retry that spans hours
 *                      would hand an attacker a signed message that stays
 *                      valid for the whole retry window.
 *
 *   webhook-signature  `v1,<base64 HMAC-SHA256>`. Space-separated list when
 *                      an endpoint has more than one live secret, which is
 *                      what makes rotation a non-event for the customer: both
 *                      signatures ride along until they confirm the new one.
 *                      `inbox.ts` already parses exactly this ("any match
 *                      wins"), because Lithic and Increase send it.
 *
 * The signed string is `{id}.{timestamp}.{body}` over the EXACT BYTES we will
 * put on the wire. `body` here is the string stored in `outbound_event.body`
 * and it is never re-serialised — see 0034 §5 and `rawbody.ts`'s header for
 * the measured demonstration that `JSON.parse`/`JSON.stringify` is not the
 * identity function and changes the signature.
 */

import { createHmac } from "node:crypto";

import { revealSecret, type SigningSecret } from "./secret";

/** The header names, lowercase. Standard Webhooks, verbatim. */
export const SIGNATURE_HEADERS = {
  id: "webhook-id",
  timestamp: "webhook-timestamp",
  signature: "webhook-signature",
} as const;

export interface SignedDelivery {
  /** Ready to spread into a request. Lowercase keys; HTTP/2 requires it and HTTP/1.1 does not care. */
  readonly headers: Readonly<Record<string, string>>;
  /** Unix seconds actually signed. Recorded on the attempt row. */
  readonly timestamp: number;
  /** The `webhook-id` value — the customer's dedup key. */
  readonly webhookId: string;
  /** Which secret version(s) produced the signature list, in order. */
  readonly secretVersions: readonly number[];
}

/**
 * Sign one attempt.
 *
 * `secrets` is ordered live-first. All of them sign, because an endpoint mid-
 * rotation has two live secrets and the customer may be verifying with either.
 */
export function signDelivery(input: {
  readonly webhookId: string;
  readonly body: string;
  readonly secrets: readonly SigningSecret[];
  readonly now: Date;
}): SignedDelivery {
  if (input.secrets.length === 0) {
    // Not a signature we could weaken; a state we refuse to be in. Sending an
    // unsigned body would be worse than sending nothing, because the customer
    // would have to write a code path that accepts one.
    throw new Error("refusing to sign: the endpoint has no live signing secret");
  }

  const timestamp = Math.floor(input.now.getTime() / 1000);
  const signedContent = `${input.webhookId}.${timestamp}.${input.body}`;

  const parts = input.secrets.map((secret) => {
    // The key is the base64-DECODED secret body, per the Standard Webhooks
    // spec and per `lithicVerifier`'s `secretEncoding: 'base64'`. Increase's
    // own implementation uses the raw string instead, which is why `inbox.ts`
    // makes that an explicit required argument with no default. We are the
    // issuer here, so we get to pick one, and we pick the spec's.
    const key = Buffer.from(revealSecret(secret).replace(/^whsec_/, ""), "base64");
    return `v1,${createHmac("sha256", key).update(signedContent, "utf8").digest("base64")}`;
  });

  return {
    headers: {
      [SIGNATURE_HEADERS.id]: input.webhookId,
      [SIGNATURE_HEADERS.timestamp]: String(timestamp),
      [SIGNATURE_HEADERS.signature]: parts.join(" "),
      "content-type": "application/json; charset=utf-8",
      // Names us without naming a version of anything a customer might pin to.
      "user-agent": "Corgi-Webhooks/1",
    },
    timestamp,
    webhookId: input.webhookId,
    secretVersions: input.secrets.map((s) => s.version),
  };
}
