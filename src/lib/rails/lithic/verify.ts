/**
 * Lithic webhook signature verification — Standard Webhooks (the Svix scheme).
 *
 * Lithic does not have a bespoke signing scheme: the official `lithic-node` SDK
 * imports `standardwebhooks` and calls `wh.verify(body, headers)`. Standard
 * Webhooks is the specification Svix authored and open-sourced, so a
 * Svix-compatible verifier is byte-compatible with Lithic. This is a
 * dependency-free reimplementation of exactly that algorithm, using node:crypto.
 *
 * The same three headers and the same algorithm are used for Auth Stream Access
 * (ASA) requests and Tokenization Decisioning, so this function covers those too.
 *
 * ALGORITHM
 *   signedContent = `${webhook-id}.${webhook-timestamp}.${rawBody}`
 *   key           = base64Decode(secret without the "whsec_" prefix)
 *   expected      = base64(HMAC_SHA256(key, utf8(signedContent)))
 *   valid         iff some space-delimited `v1,<sig>` entry of `webhook-signature`
 *                 constant-time-equals `expected`, AND
 *                 |now - timestamp| <= 300 seconds
 *
 * THE ONE WAY TO GET THIS WRONG
 *   `rawBody` must be the request body byte-for-byte as received. On the
 *   Next.js App Router that is `await req.text()`. `await req.json()` followed
 *   by `JSON.stringify` produces a different byte string — Lithic's own
 *   published example body is `{"test": 2432232314}`, and re-serialising it
 *   drops the space after the colon and changes the signature completely. Every
 *   verification then fails, and it looks like a secret problem.
 *
 * Correctness is proved, not asserted: `STANDARD_WEBHOOKS_TEST_VECTOR` below is
 * the canonical vector published by the Standard Webhooks project, and the same
 * signature string appears in Lithic's own "example header with multiple
 * signatures" documentation. `verify.test.ts` runs it, and
 * `runStandardWebhooksSelfTest()` runs it inline at any call site.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** Standard Webhooks reference tolerance: 5 minutes either side. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const WHSEC_PREFIX = 'whsec_';

/** Lithic's header names, with the Svix aliases accepted as a fallback. */
const HEADER_ALIASES = {
  id: ['webhook-id', 'svix-id'],
  timestamp: ['webhook-timestamp', 'svix-timestamp'],
  signature: ['webhook-signature', 'svix-signature'],
} as const;

export type WebhookRejectionReason =
  /** One of webhook-id / webhook-timestamp / webhook-signature was absent. */
  | 'missing_headers'
  /** webhook-timestamp was not a base-10 integer. */
  | 'invalid_timestamp'
  /** Older than the tolerance window — a replay. */
  | 'timestamp_too_old'
  /** Further in the future than the tolerance window — a forged or skewed clock. */
  | 'timestamp_too_new'
  /** No `v1,` entry matched. Tampered body, wrong secret, or a version we do not speak. */
  | 'no_matching_signature';

export type WebhookVerificationResult =
  | {
      ok: true;
      /** Stable across Lithic's 8 retries — THE idempotency key. Unique-index it. */
      webhookId: string;
      /** Unix seconds, parsed. */
      timestamp: number;
    }
  | { ok: false; reason: WebhookRejectionReason };

export interface VerifyOptions {
  /** Override the ±300s window. Only do this in tests. */
  toleranceSeconds?: number;
  /** Injectable clock in milliseconds since the epoch. Defaults to `Date.now()`. */
  nowMs?: number;
}

/**
 * Thrown when the *secret* is unusable — an empty string, or something that
 * base64-decodes to zero bytes.
 *
 * This throws rather than returning `{ ok: false }` on purpose. A bad secret is
 * a deployment error, not a hostile request: if it were folded into the normal
 * rejection path, a missing `LITHIC_WEBHOOK_SECRET` would present as "every
 * webhook is a forgery" and the handler would silently drop live traffic while
 * returning a perfectly healthy 401.
 */
export class LithicWebhookSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LithicWebhookSecretError';
  }
}

/** Convenience for a Next.js route: `headersToRecord(req.headers)`. */
export function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function lowercaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(headers)) {
    const value = headers[key];
    if (typeof value === 'string') out[key.toLowerCase()] = value;
  }
  return out;
}

function pickHeader(
  headers: Record<string, string>,
  names: ReadonlyArray<string>,
): string | undefined {
  for (const name of names) {
    const value = headers[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Decode the signing key. The `whsec_` prefix is a label, not part of the key:
 * strip it, then base64-DECODE the remainder to raw bytes. Using the string
 * itself as the key is the second most common way to fail this.
 */
function decodeSecret(secret: string): Buffer {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new LithicWebhookSecretError('Lithic webhook secret is empty or not a string');
  }
  const body = secret.startsWith(WHSEC_PREFIX) ? secret.slice(WHSEC_PREFIX.length) : secret;
  const key = Buffer.from(body, 'base64');
  if (key.length === 0) {
    throw new LithicWebhookSecretError('Lithic webhook secret base64-decoded to zero bytes');
  }
  return key;
}

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are checked
 * first. That leaks only the length of a base64 SHA-256 digest, which is always
 * 44 characters and therefore carries no secret information.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify a Lithic webhook (or ASA request) signature.
 *
 * @param rawBody The raw request body string, byte-for-byte as received.
 *                `await req.text()` — never a re-serialised object.
 * @param headers Request headers, any casing.
 * @param secret  `whsec_...` from `GET /v1/event_subscriptions/{token}/secret`
 *                (or `GET /v1/auth_stream/secret` for ASA). The prefix is
 *                optional.
 * @throws LithicWebhookSecretError if `secret` is structurally unusable.
 */
export function verifyLithicWebhook(
  rawBody: string,
  headers: Record<string, string>,
  secret: string,
  options: VerifyOptions = {},
): WebhookVerificationResult {
  // Decode the secret first: a configuration error must surface as a throw and
  // never be mistaken for a bad signature.
  const key = decodeSecret(secret);

  const h = lowercaseKeys(headers);
  const webhookId = pickHeader(h, HEADER_ALIASES.id);
  const rawTimestamp = pickHeader(h, HEADER_ALIASES.timestamp);
  const signatureHeader = pickHeader(h, HEADER_ALIASES.signature);
  if (!webhookId || !rawTimestamp || !signatureHeader) {
    return { ok: false, reason: 'missing_headers' };
  }

  // Replay window. Checked before the HMAC so a flood of stale replays costs
  // an integer parse rather than a hash.
  if (!/^-?\d+$/.test(rawTimestamp.trim())) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  const timestamp = Number.parseInt(rawTimestamp.trim(), 10);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (nowSeconds - timestamp > tolerance) return { ok: false, reason: 'timestamp_too_old' };
  if (timestamp - nowSeconds > tolerance) return { ok: false, reason: 'timestamp_too_new' };

  // NOTE: the timestamp is re-emitted from the ORIGINAL header string, not from
  // the parsed integer, so that a header of "01614265330" would not be silently
  // renormalised into a different signed payload.
  const signedContent = `${webhookId}.${rawTimestamp.trim()}.${rawBody}`;
  const expected = createHmac('sha256', key).update(signedContent, 'utf8').digest('base64');

  // Multiple signatures arrive during a secret rotation (the old key stays
  // valid for 24h). Any single matching v1 entry is sufficient; entries with a
  // version other than v1 are skipped, not failed, so a future v2 rollout
  // cannot break a v1 verifier.
  let matched = false;
  for (const entry of signatureHeader.split(' ')) {
    if (entry.length === 0) continue;
    const comma = entry.indexOf(',');
    if (comma === -1) continue;
    if (entry.slice(0, comma) !== 'v1') continue;
    // Deliberately no early `break`: every candidate is compared so the work
    // done does not depend on which entry matched.
    if (constantTimeEquals(entry.slice(comma + 1), expected)) matched = true;
  }

  if (!matched) return { ok: false, reason: 'no_matching_signature' };
  return { ok: true, webhookId, timestamp };
}

/** Boolean-only form, for call sites that do not need the rejection reason. */
export function isValidLithicWebhook(
  rawBody: string,
  headers: Record<string, string>,
  secret: string,
  options: VerifyOptions = {},
): boolean {
  return verifyLithicWebhook(rawBody, headers, secret, options).ok;
}

/**
 * Verify, then parse. Returns null on any verification failure so a route can
 * do `if (!result) return new Response(null, { status: 401 })`.
 *
 * `webhookId` is the deduplication key. Lithic retries on any non-2xx
 * (immediate → +5s → +5m → +30m → +2h → +5h → +10h → +10h, 8 attempts) reusing
 * the same id, so duplicate delivery is normal operation, not an error.
 */
export function parseVerifiedLithicWebhook<T>(
  rawBody: string,
  headers: Record<string, string>,
  secret: string,
  options: VerifyOptions = {},
): { event: T; webhookId: string; timestamp: number } | null {
  const result = verifyLithicWebhook(rawBody, headers, secret, options);
  if (!result.ok) return null;
  return {
    event: JSON.parse(rawBody) as T,
    webhookId: result.webhookId,
    timestamp: result.timestamp,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Canonical test vector
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The vector published by the Standard Webhooks project. The signature string
 * `v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=` is the same one Lithic
 * prints in its own multi-signature example, which is what ties this
 * implementation to Lithic specifically rather than to the spec in the
 * abstract.
 *
 * Note the space after the colon in `body`. It is load-bearing: it is what
 * makes this vector a proof that the RAW body must be signed.
 */
export const STANDARD_WEBHOOKS_TEST_VECTOR = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
} as const;

/** Headers exactly as they would arrive for the canonical vector. */
export function standardWebhooksTestVectorHeaders(): Record<string, string> {
  return {
    'webhook-id': STANDARD_WEBHOOKS_TEST_VECTOR.id,
    'webhook-timestamp': String(STANDARD_WEBHOOKS_TEST_VECTOR.timestamp),
    'webhook-signature': STANDARD_WEBHOOKS_TEST_VECTOR.signature,
  };
}

/**
 * Inline self-test against the canonical vector. Throws with a diagnostic if
 * this implementation has drifted.
 *
 * The vector's timestamp is from 2021, so verification is run with the clock
 * pinned to that timestamp — otherwise the replay window (correctly) rejects
 * it. This is the only place a pinned clock is legitimate.
 *
 * Safe to call at startup in development; `verify.test.ts` calls it too.
 */
export function runStandardWebhooksSelfTest(): true {
  const v = STANDARD_WEBHOOKS_TEST_VECTOR;
  const pinnedNowMs = v.timestamp * 1000;

  const good = verifyLithicWebhook(v.body, standardWebhooksTestVectorHeaders(), v.secret, {
    nowMs: pinnedNowMs,
  });
  if (!good.ok) {
    throw new Error(
      `Standard Webhooks self-test FAILED on the canonical vector: ${good.reason}. ` +
        'This implementation does not match the specification — do not deploy it.',
    );
  }

  // Re-serialising the same JSON drops the space after the colon and must NOT
  // verify. This is the assertion that catches a handler calling req.json().
  const reserialised = JSON.stringify(JSON.parse(v.body));
  if (reserialised === v.body) {
    throw new Error('Self-test precondition broken: the vector body is already canonical JSON');
  }
  const tampered = verifyLithicWebhook(reserialised, standardWebhooksTestVectorHeaders(), v.secret, {
    nowMs: pinnedNowMs,
  });
  if (tampered.ok) {
    throw new Error('Standard Webhooks self-test FAILED: a re-serialised body verified');
  }

  return true;
}
