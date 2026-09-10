/**
 * Raw body handling for inbound provider webhooks.
 *
 * THE FOOTGUN THIS MODULE EXISTS TO PREVENT
 * -----------------------------------------
 * Every provider we integrate signs the *bytes it sent*, not the JSON value
 * those bytes denote. `JSON.parse` followed by `JSON.stringify` is not the
 * identity function: it loses insignificant whitespace, reorders nothing but
 * renormalises everything, and can change number formatting. Measured, not
 * assumed — the canonical Standard Webhooks test vector:
 *
 *   raw bytes           {"test": 2432232314}   -> v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=
 *   JSON.stringify(...) {"test":2432232314}    -> v1,Vif40peJBP7Iyl0XGmu61n4MwdrcHov5CFREBpE0svs=
 *
 * One space. Completely different signature. A handler that re-serialises
 * rejects every genuine delivery, and the failure mode is "the provider's
 * signatures are broken", which is a bad day.
 *
 * In the Next.js App Router the only correct order is:
 *
 *   const { raw, headers } = await readRawDelivery(req);   // await req.text()
 *   verify(raw, headers);                                  // over the bytes
 *   const payload = parseVerifiedJson(raw);                // only now
 *
 * Never `await req.json()`. The request body is a one-shot stream: once it is
 * consumed by a JSON parser the bytes are gone and cannot be recovered, so
 * there is no way to fix this later in the handler. That is why reading the
 * text is the first statement in the route, before anything else.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** Minimal shape of a fetch `Headers`, or a plain object of header values. */
export type HeadersLike =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

/** Case-insensitive header reader. Returns null when the header is absent. */
export type HeaderLookup = (name: string) => string | null;

/** Minimal shape of a `Request` / `NextRequest`. Structural on purpose: it
 *  keeps this module free of a Next.js import and trivially fakeable in tests. */
export interface RawRequest {
  text(): Promise<string>;
  headers: HeadersLike;
}

export interface RawDelivery {
  /** The exact body bytes as received, decoded as UTF-8. Sign THIS. */
  raw: string;
  /** Case-insensitive access to the request headers. */
  headers: HeaderLookup;
}

export class WebhookPayloadParseError extends Error {
  constructor(cause: unknown) {
    super(`webhook body verified but is not valid JSON: ${String(cause)}`);
    this.name = 'WebhookPayloadParseError';
  }
}

/** Wrap any header container in a case-insensitive lookup. */
export function toHeaderLookup(headers: HeadersLike): HeaderLookup {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const h = headers as { get(name: string): string | null };
    // fetch `Headers.get` is already case-insensitive per the WHATWG spec.
    return (name: string) => h.get(name) ?? null;
  }
  // Plain object: normalise the keys once, then look up lowercased.
  const flat = new Map<string, string>();
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (v === undefined) continue;
    flat.set(k.toLowerCase(), Array.isArray(v) ? v.join(', ') : v);
  }
  return (name: string) => flat.get(name.toLowerCase()) ?? null;
}

/**
 * Read the body as raw text BEFORE any parsing, and return it alongside a
 * header lookup. This is the first thing a route handler does, always.
 */
export async function readRawDelivery(req: RawRequest): Promise<RawDelivery> {
  const raw = await req.text();
  return { raw, headers: toHeaderLookup(req.headers) };
}

/**
 * Parse a body that has ALREADY had its signature verified.
 *
 * The name is the documentation: if you are calling this before verifying,
 * you are doing it in the wrong order. Parsing is deliberately separated from
 * reading so that the type system cannot hand you a parsed object you have
 * not authenticated.
 */
export function parseVerifiedJson<T = unknown>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new WebhookPayloadParseError(err);
  }
}

/** Lowercase hex SHA-256 of the exact bytes given. Used by Plaid's scheme. */
export function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Constant-time string comparison.
 *
 * `crypto.timingSafeEqual` throws on a length mismatch, and letting that
 * exception escape is itself a timing/behaviour oracle. We hash both sides to
 * a fixed 32 bytes first, so every comparison is the same length and the same
 * cost regardless of what the attacker sent. Comparing digests is sound: the
 * digests are equal iff the inputs are (SHA-256 collision resistance).
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/** Base64url -> Buffer, for the JWT halves in Plaid's scheme. */
export function base64UrlDecode(segment: string): Buffer {
  return Buffer.from(segment, 'base64url');
}
