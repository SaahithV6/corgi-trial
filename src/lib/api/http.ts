/**
 * Wire plumbing: responses, query parsing, cursors.
 *
 * ===========================================================================
 * MONEY CROSSES THE WIRE AS A DECIMAL STRING OF INTEGER CENTS
 * ===========================================================================
 *
 * Every money field in every response is
 *
 *     { "cents": "-1234", "display": "-$12.34" }
 *
 * and `cents` is a STRING, always, including zero. This is the same shape the
 * MCP surface uses and it is produced by the same function (`money()` in
 * `@/lib/mcp/validate`), so the two surfaces cannot drift on the rendering of
 * an amount any more than they can on the value of one.
 *
 * The string is not decoration. `JSON.parse` produces a double; a double stops
 * being able to represent consecutive integers above 2^53, which is about
 * $90 trillion in cents — not a fantasy figure for a gross settlement total,
 * and there is no warning when it happens. The number simply comes back
 * different. This codebase is `bigint` cents end to end, and the wire format
 * is the one place that discipline could be quietly dropped.
 *
 * `display` is there because the alternative is every integrator writing their
 * own formatter, and half of them writing it with a float.
 *
 * ===========================================================================
 * BIGINT NEVER REACHES JSON.stringify
 * ===========================================================================
 *
 * `JSON.stringify` throws on a `bigint` — a genuinely good default, because
 * the alternative implementations all silently lose precision. Rather than
 * install a replacer that stringifies bigints everywhere (which would let a
 * raw cents value leak onto the wire as an unlabelled string), every
 * serialiser in `src/lib/api/**` converts explicitly at the point it knows
 * what the number MEANS: `money()` for an amount, `.toString()` for a
 * sequence number. `assertNoBigint` below is the backstop, and it fails the
 * request rather than shipping a 500 from the JSON encoder.
 */

import { money, type Money } from "@/lib/mcp/validate";

import { type ApiError, badRequest } from "./errors";

export { money };
export type { Money };

/** Every response carries this. `x-request-id` echoes it in the headers too. */
export interface Envelope {
  readonly request_id: string;
}

export const API_VERSION = "v1";

/**
 * Headers on every response, success or refusal.
 *
 * `cache-control: no-store` is not a performance oversight. A cached answer
 * about someone's balance is a wrong answer about it, and an intermediary that
 * caches a payment creation is an intermediary that can replay one.
 */
export function baseHeaders(requestId: string): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-request-id": requestId,
    "x-corgi-api-version": API_VERSION,
  };
}

/**
 * A `bigint` anywhere in the payload is a bug in a serialiser, and it is
 * caught here rather than as a `TypeError` out of `JSON.stringify`.
 *
 * Bounded depth and breadth so that this is a guard rather than a second pass
 * over a large page.
 */
function assertNoBigint(value: unknown, path: string, depth: number): void {
  if (depth > 12) return;
  if (typeof value === "bigint") {
    throw new Error(
      `serialiser leaked a bigint at ${path}; convert it with money() for an amount or .toString() for a sequence`,
    );
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && i < 2000; i += 1) {
      assertNoBigint(value[i], `${path}[${i}]`, depth + 1);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      assertNoBigint(inner, `${path}.${key}`, depth + 1);
    }
  }
}

export function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): Response {
  assertNoBigint(body, "$", 0);
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...baseHeaders(requestId), ...extraHeaders },
  });
}

export function errorResponse(error: ApiError, requestId: string): Response {
  return jsonResponse(
    { error: error.payload(), request_id: requestId },
    error.status,
    requestId,
    error.headers,
  );
}

/* -------------------------------------------------------------------------- */
/* Query parameters                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Refuse a query parameter this endpoint does not declare.
 *
 * The same choice `mcp/validate.ts` makes about tool arguments, for the same
 * reason: a caller who sends `?business_id=...` and is quietly served their
 * OWN business's data walks away believing the parameter worked, and the next
 * call they write is the dangerous one. Being told plainly that no such
 * parameter exists is the only answer that does not teach a lie.
 */
export function rejectUnknownParams(url: URL, allowed: readonly string[]): void {
  const unknown = [...url.searchParams.keys()].filter((k) => !allowed.includes(k));
  if (unknown.length === 0) return;
  throw badRequest(
    "UNKNOWN_QUERY_PARAMETER",
    `this endpoint does not accept ${unknown.map((u) => `"${u}"`).join(", ")}`,
    "every query parameter is one this endpoint declares",
    `Remove it. This endpoint accepts: ${allowed.join(", ") || "(none)"}. Parameters are refused rather than ignored, so that a caller never believes a filter took effect when it did not.`,
    { unknown, accepted: allowed },
  );
}

/**
 * Parameter names no endpoint may ever accept.
 *
 * The tenant boundary written as data, exactly as `mcp/tools.ts` writes it.
 * Scope comes from the token and from nowhere else; an endpoint that took a
 * business or account identifier from the caller would be taking its scope
 * from the caller. `boundary.test.ts`'s sibling in this directory asserts this
 * over every route file, so the guard fails at `pnpm test` rather than in
 * production.
 */
export const FORBIDDEN_QUERY_PARAMETERS: readonly string[] = [
  "business_id",
  "businessId",
  "entity_id",
  "entityId",
  "account_id",
  "accountId",
  "actor_id",
  "actorId",
  "customer_id",
  "tenant_id",
  "requested_by",
  "approver_id",
];

export function stringParam(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function dateParam(url: URL, name: string): string | null {
  const raw = stringParam(url, name);
  if (raw === null) return null;
  if (!ISO_DATE.test(raw) || !isRealDate(raw)) {
    throw badRequest(
      "INVALID_DATE",
      `${name}="${raw}" is not a calendar date`,
      `${name} matches YYYY-MM-DD and names a real day`,
      "Dates in this API are business dates in book time (America/New_York), written YYYY-MM-DD. Instants, where an endpoint takes one, are ISO 8601 with a zone.",
      { parameter: name, received: raw },
    );
  }
  return raw;
}

export function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function instantParam(url: URL, name: string): Date | null {
  const raw = stringParam(url, name);
  if (raw === null) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw badRequest(
      "INVALID_INSTANT",
      `${name}="${raw}" is not an ISO 8601 instant`,
      `${name} parses as an ISO 8601 instant`,
      'Send something like "2026-09-10T18:30:00Z". This is the "what did you believe at that moment" axis; the "which day did it happen on" axis is a date parameter.',
      { parameter: name, received: raw },
    );
  }
  return at;
}

export function enumParam<T extends string>(
  url: URL,
  name: string,
  allowed: readonly T[],
): T | null {
  const raw = stringParam(url, name);
  if (raw === null) return null;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw badRequest(
      "INVALID_ENUM_VALUE",
      `${name}="${raw}" is not one of ${allowed.join(", ")}`,
      `${name} is one of: ${allowed.join(", ")}`,
      `Send one of the listed values, or omit ${name} entirely to leave the filter off.`,
      { parameter: name, received: raw, accepted: allowed },
    );
  }
  return raw as T;
}

export function boolParam(url: URL, name: string): boolean | null {
  const raw = stringParam(url, name);
  if (raw === null) return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw badRequest(
    "INVALID_BOOLEAN",
    `${name}="${raw}" is not "true" or "false"`,
    `${name} is the literal string "true" or "false"`,
    'Send ?flag=true or ?flag=false. "1", "yes" and "on" are refused rather than guessed at.',
    { parameter: name, received: raw },
  );
}

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 200;

export function limitParam(url: URL, fallback: number = DEFAULT_LIMIT): number {
  const raw = stringParam(url, "limit");
  if (raw === null) return fallback;
  if (!/^[0-9]{1,4}$/.test(raw)) {
    throw badRequest(
      "INVALID_LIMIT",
      `limit="${raw}" is not a whole number`,
      "limit is an integer between 1 and " + String(MAX_LIMIT),
      `Send a plain integer. The default is ${fallback} and the ceiling is ${MAX_LIMIT}; page with the cursor rather than asking for everything.`,
      { received: raw },
    );
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < 1 || parsed > MAX_LIMIT) {
    throw badRequest(
      "INVALID_LIMIT",
      `limit=${parsed} is outside 1..${MAX_LIMIT}`,
      `1 <= limit <= ${MAX_LIMIT}`,
      `Ask for at most ${MAX_LIMIT} rows and follow page.next_cursor for the rest.`,
      { received: parsed, maximum: MAX_LIMIT },
    );
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Cursors                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The cursor is opaque on purpose.
 *
 * Underneath it is a booking sequence — the ledger's own monotonic order — and
 * an integrator who learns that will start constructing cursors arithmetically
 * and will be wrong the first time the underlying key changes. Base64url of a
 * versioned JSON object keeps the shape ours to change, and a tampered cursor
 * is refused with a message that says so rather than silently paging from the
 * top, which is the failure that quietly skips rows.
 */
interface CursorPayload {
  readonly v: 1;
  /** Exclusive upper bound on booking_seq, as a decimal string. */
  readonly s: string;
}

export function encodeCursor(bookingSeq: bigint): string {
  const payload: CursorPayload = { v: 1, s: bookingSeq.toString() };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(raw: string | null): bigint | null {
  if (raw === null) return null;
  const reject = (): never => {
    throw badRequest(
      "INVALID_CURSOR",
      "the cursor is not one this API issued",
      "cursor is a value copied verbatim from a previous response's page.next_cursor",
      "Cursors are opaque: copy the whole string, do not construct or edit one. Omit the parameter to start from the newest row. A cursor is refused rather than ignored, because silently starting from the top is how a paging loop skips rows without anyone noticing.",
      { received: raw.slice(0, 64) },
    );
  };
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return reject();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return reject();
  }
  if (typeof parsed !== "object" || parsed === null) return reject();
  const candidate = parsed as Partial<CursorPayload>;
  if (candidate.v !== 1 || typeof candidate.s !== "string" || !/^[0-9]{1,20}$/.test(candidate.s)) {
    return reject();
  }
  return BigInt(candidate.s);
}

/** The page wrapper every list endpoint returns. */
export interface Page<T> {
  readonly object: "list";
  readonly data: readonly T[];
  readonly page: {
    readonly limit: number;
    readonly has_more: boolean;
    readonly next_cursor: string | null;
  };
}

export function page<T>(
  data: readonly T[],
  limit: number,
  nextCursor: string | null,
): Page<T> {
  return {
    object: "list",
    data,
    page: { limit, has_more: nextCursor !== null, next_cursor: nextCursor },
  };
}
