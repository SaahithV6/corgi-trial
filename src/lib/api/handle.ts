/**
 * The gate every `/api/v1/**` request passes through, in one function.
 *
 * ===========================================================================
 * THE ORDER IS THE DESIGN
 * ===========================================================================
 *
 *   1. size and shape   — refuse a body we will not read anyway
 *   2. authentication   — no token, no dispatch, ever
 *   3. rate limit       — per token, plus a much smaller budget for writes
 *   4. dispatch         — and only here does anything touch the database
 *   5. audit            — ALWAYS, including every refusal above
 *
 * Step 5 is why this is one function rather than a chain of middleware, and it
 * is the same argument `mcp/server.ts` makes: the audit record must be written
 * on every path out, including the throw nobody predicted, and a `finally` in
 * one place is easier to prove than a dozen route files that each promise to
 * log. It writes through the SAME sink, in the same `mcp.audit` shape, with
 * `surface: "api"` on the log line — because "what did the integration try"
 * and "what did the agent try" are the same question asked of two protocols,
 * and answering it should not mean joining two log formats.
 *
 * ===========================================================================
 * WHAT THIS FUNCTION DOES NOT DO
 * ===========================================================================
 *
 * It holds no database handle and knows no SQL. It is handed a `Gateway` — the
 * MCP surface's own interface, implemented by `mcp/gateway.ts`, where every
 * statement the tenant boundary governs lives in one reviewable file. The set
 * of queries an HTTP caller can cause is therefore a matter of reading that
 * one interface, and it is the same set an agent can cause.
 */

import {
  type ActorVerificationCache,
  type RateLimiter,
  UNAUTHENTICATED_LIMIT_PER_MINUTE,
  WRITE_LIMIT_PER_MINUTE,
  ToolError,
  bookDate,
  clientKey,
  redactArguments,
  type AuditOutcome,
  type AuditRecord,
  type AuditSink,
  type Gateway,
  type Grant,
  type TokenConfig,
} from "@/lib/mcp";
import { logger, requestIdFrom, type Logger } from "@/lib/log";

import { authenticateApiRequest } from "./auth";
import { ApiError, fromRefusal } from "./errors";
import { errorResponse, jsonResponse } from "./http";

/** 64 KB. A payment body is a few hundred bytes; anything larger is not one. */
export const MAX_BODY_BYTES = 64 * 1024;

/** Everything a route handler is allowed to touch. */
export interface ApiContext {
  readonly grant: Grant;
  readonly gateway: Gateway;
  readonly url: URL;
  readonly request: Request;
  readonly requestId: string;
  readonly log: Logger;
  /** Injected so tests are not a function of the wall clock. */
  readonly now: Date;
  /** Book-time today (America/New_York) as YYYY-MM-DD. */
  readonly bookToday: string;
  /** The parsed JSON body, for writes. `null` for reads. */
  readonly body: Record<string, unknown> | null;
}

export interface RouteResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
  /** Ids and counts worth having in the audit line. Never the payload. */
  readonly audit?: Record<string, unknown> | null;
}

export interface RouteSpec {
  /** `GET /api/v1/transactions`. Appears verbatim in the audit line. */
  readonly name: string;
  /** False for a write: costs a human's attention, so a stricter budget applies. */
  readonly readOnly: boolean;
  readonly run: (ctx: ApiContext) => Promise<RouteResult>;
}

export interface ApiDeps {
  readonly gateway: Gateway;
  readonly config: TokenConfig;
  readonly audit: AuditSink;
  readonly limiter: RateLimiter;
  readonly cache: ActorVerificationCache;
  readonly log?: Logger;
  readonly now?: () => Date;
}

/**
 * Run one route through the gate.
 *
 * Exported rather than inlined into each route file so that there is exactly
 * one place where authentication can be skipped, and it is a place a reviewer
 * can find.
 */
export async function handle(
  request: Request,
  deps: ApiDeps,
  spec: RouteSpec,
): Promise<Response> {
  const startedAt = Date.now();
  const requestId = requestIdFrom(request.headers);
  const log = (deps.log ?? logger()).child({ requestId, surface: "api" });
  const client = clientKey(request.headers);
  const at = deps.now?.() ?? new Date();

  let outcome: AuditOutcome = "internal_error";
  let errorCode: string | null = null;
  let grant: Grant | null = null;
  let argumentsRedacted: Record<string, unknown> | null = null;
  let auditResult: Record<string, unknown> | null = null;

  try {
    // ---- 1. body ------------------------------------------------------
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      throw new ApiError({
        status: 413,
        type: "invalid_request",
        code: "BODY_TOO_LARGE",
        message: `request body exceeds ${MAX_BODY_BYTES} bytes`,
        condition: `content-length <= ${MAX_BODY_BYTES}`,
        resolution:
          "Every write on this API is a single small object. A body this large is a batch, and there is no batch endpoint: send the requests one at a time, each with its own Idempotency-Key.",
      });
    }

    let body: Record<string, unknown> | null = null;
    if (!spec.readOnly) {
      body = await readJsonBody(request);
      argumentsRedacted = redactArguments(body);
    }

    // ---- 2. authentication --------------------------------------------
    let authError: ApiError | null = null;
    try {
      grant = await authenticateApiRequest(request.headers, {
        config: deps.config,
        gateway: deps.gateway,
        cache: deps.cache,
        nowMs: at.getTime(),
      });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      authError = error;
    }

    if (authError !== null) {
      // The per-address budget is spent only on FAILURE, so a well-behaved
      // integration is never throttled by a noisy neighbour behind the same
      // proxy, while a token guesser still runs out of attempts.
      const brake = deps.limiter.check(
        `api-unauth:${client}`,
        UNAUTHENTICATED_LIMIT_PER_MINUTE,
        at.getTime(),
      );
      if (!brake.allowed) {
        const throttled = rateLimitError(brake.retryAfterSeconds, brake.limitPerMinute, true);
        outcome = "refused";
        errorCode = throttled.code;
        return errorResponse(throttled, requestId);
      }
      log.warn("api.auth.refused", { code: authError.code, client });
      outcome = "refused";
      errorCode = authError.code;
      return errorResponse(authError, requestId);
    }

    if (grant === null) throw new Error("unreachable: authenticated with no grant");

    // ---- 3. rate limit -------------------------------------------------
    const budget = deps.limiter.check(
      `api-token:${grant.tokenFingerprint}`,
      grant.rateLimitPerMinute,
      at.getTime(),
    );
    if (!budget.allowed) {
      const throttled = rateLimitError(budget.retryAfterSeconds, budget.limitPerMinute, false);
      outcome = "refused";
      errorCode = throttled.code;
      return errorResponse(throttled, requestId);
    }

    if (!spec.readOnly) {
      // A read-heavy integration is fine. An integration queueing payments
      // faster than a person can read them is a denial-of-service attack on
      // the approver, and the approver is the control this design rests on.
      const writeBudget = deps.limiter.check(
        `api-write:${grant.tokenFingerprint}`,
        WRITE_LIMIT_PER_MINUTE,
        at.getTime(),
      );
      if (!writeBudget.allowed) {
        const throttled = new ApiError({
          status: 429,
          type: "rate_limit",
          code: "WRITE_RATE_LIMITED",
          message: `this token may queue at most ${WRITE_LIMIT_PER_MINUTE} payment instructions per minute`,
          condition: `queued instructions in the last minute < ${WRITE_LIMIT_PER_MINUTE}`,
          resolution: `Wait ${writeBudget.retryAfterSeconds}s and retry with the SAME Idempotency-Key. The budget is deliberately small: a queued payment costs a human's attention, and sixty a minute is an attack on the approver rather than a busy integration.`,
          headers: { "retry-after": String(writeBudget.retryAfterSeconds) },
          details: { retry_after_seconds: writeBudget.retryAfterSeconds },
        });
        outcome = "refused";
        errorCode = throttled.code;
        return errorResponse(throttled, requestId);
      }
    }

    // ---- 4. dispatch ---------------------------------------------------
    const result = await spec.run({
      grant,
      gateway: deps.gateway,
      url: new URL(request.url),
      request,
      requestId,
      log,
      now: at,
      bookToday: bookDate(at),
      body,
    });

    outcome = "ok";
    auditResult = result.audit ?? null;
    return jsonResponse(result.body, result.status, requestId, result.headers ?? {});
  } catch (error) {
    const mapped = toApiError(error, log);
    outcome = mapped.status >= 500 ? "internal_error" : "tool_error";
    errorCode = mapped.code;
    return errorResponse(mapped, requestId);
  } finally {
    const record: AuditRecord = {
      at: at.toISOString(),
      requestId,
      method: spec.name,
      tool: null,
      outcome,
      errorCode,
      actorId: grant?.actorId ?? null,
      businessId: grant?.businessId ?? null,
      grantLabel: grant?.label ?? null,
      grantFingerprint: grant?.tokenFingerprint ?? null,
      clientKey: client,
      argumentsRedacted,
      durationMs: Date.now() - startedAt,
      result: auditResult,
    };
    deps.audit.record(record);
  }
}

/**
 * Whatever was thrown, as something that can go on the wire.
 *
 * `ToolError` is the interesting case. It is what `mcp/gateway.ts` throws when
 * an upstream module refuses — the KYB gate, the payee check, the approvals
 * module — and its `code` and `message` are the upstream's own. `fromRefusal`
 * adds the status, the condition and the remedy WITHOUT rewriting the message.
 * See `errors.ts` for why rewriting it would be a second opinion about why a
 * payment was refused.
 */
function toApiError(error: unknown, log: Logger): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ToolError) {
    return fromRefusal(error.code, error.message, unwrapDetails(error.details));
  }
  // An unexpected throw is a bug here, not a caller problem. It gets its own
  // error line with the stack; the caller gets no internals.
  log.error("api.unhandled", { error });
  return new ApiError({
    status: 500,
    type: "internal",
    code: "INTERNAL_ERROR",
    message: "internal error handling the request",
    condition: "the request handler completes without throwing",
    resolution:
      "Our fault, not yours. A write is safe to retry with the SAME Idempotency-Key — a replay returns the original response and has no second effect. Send the request_id.",
  });
}

/**
 * Flatten the `{ details: … }` wrapper `mcp/gateway.ts` puts around an
 * upstream `ErrorShape.details`.
 *
 * The gateway constructs `new ToolError(code, message, { details: error.details })`,
 * so a refusal carrying field-level problems arrives here as
 * `details.details.problems` and one carrying nothing arrives as
 * `{ details: undefined }`. Neither shape is what an integrator should have to
 * read: the first buries the useful array a level deeper than every other
 * error on this surface, and the second renders as an empty object that looks
 * like a field that failed to populate. Unwrapped rather than passed through,
 * because the envelope's shape is this layer's responsibility and the CONTENT
 * is untouched either way.
 */
function unwrapDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  const keys = Object.keys(details);
  if (keys.length !== 1 || keys[0] !== "details") return details;
  const inner = details["details"];
  if (inner === undefined || inner === null) return undefined;
  if (Array.isArray(inner)) return { problems: inner };
  if (typeof inner === "object") return inner as Record<string, unknown>;
  return { detail: inner };
}

function rateLimitError(
  retryAfterSeconds: number,
  limitPerMinute: number,
  unauthenticated: boolean,
): ApiError {
  return new ApiError({
    status: 429,
    type: "rate_limit",
    code: unauthenticated ? "TOO_MANY_FAILED_AUTH" : "RATE_LIMITED",
    message: unauthenticated
      ? `too many failed authentications from this address (${limitPerMinute}/minute)`
      : `rate limit exceeded (${limitPerMinute}/minute)`,
    condition: `requests in the last minute < ${limitPerMinute}`,
    resolution: unauthenticated
      ? `Wait ${retryAfterSeconds}s. This budget is spent only by FAILED authentications, so a correct token is never throttled by it.`
      : `Wait ${retryAfterSeconds}s and retry. Retry-After carries the same number. The per-token budget is set when the token is issued.`,
    headers: { "retry-after": String(retryAfterSeconds) },
    details: { retry_after_seconds: retryAfterSeconds, limit_per_minute: limitPerMinute },
  });
}

/**
 * Read and parse a JSON body, refusing the shapes that are never a request.
 *
 * An array body, a bare string and `null` are all valid JSON and none of them
 * is a request object. Refusing them here means every route handler can assume
 * `Record<string, unknown>` without a defensive branch of its own.
 */
async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError({
      status: 415,
      type: "invalid_request",
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: `content-type "${contentType || "(absent)"}" is not application/json`,
      condition: 'content-type includes "application/json"',
      resolution:
        "Send Content-Type: application/json. There is no form-encoded variant of any endpoint on this API.",
    });
  }

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new ApiError({
      status: 413,
      type: "invalid_request",
      code: "BODY_TOO_LARGE",
      message: `request body exceeds ${MAX_BODY_BYTES} bytes`,
      condition: `body length <= ${MAX_BODY_BYTES}`,
      resolution: "Send one request object, not a batch.",
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text === "" ? "null" : text);
  } catch (error) {
    throw new ApiError({
      status: 400,
      type: "invalid_request",
      code: "MALFORMED_JSON",
      message: `body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      condition: "the request body parses as JSON",
      resolution:
        "Check for a trailing comma or an unquoted key. Note that amounts are JSON STRINGS of integer cents, never JSON numbers — see docs/API.md §Money.",
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError({
      status: 400,
      type: "invalid_request",
      code: "BODY_NOT_AN_OBJECT",
      message: "the request body must be a JSON object",
      condition: "the body is a JSON object",
      resolution:
        "Send a single object. There is no batch endpoint on this API: each payment carries its own Idempotency-Key so that a partial failure is unambiguous.",
    });
  }

  return parsed as Record<string, unknown>;
}
