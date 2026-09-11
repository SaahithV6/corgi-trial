/**
 * POST /api/mcp — the Model Context Protocol endpoint.
 *
 * Streamable HTTP, single-response mode: one JSON-RPC message per POST, one
 * JSON body back. No SSE stream and no session id, because this server never
 * initiates a message to the client — it has no subscriptions, no progress
 * notifications and no sampling. Advertising a stream we would never write to
 * costs every client a hanging GET for nothing.
 *
 * Connecting a client, and a real captured transcript, are in docs/MCP.md.
 * The list of operations deliberately absent from this surface, with the
 * failure mode for each, is docs/AGENT-LIMITS.md.
 */

import { durableAuditSink, type AuditPersistResult } from "@/lib/audit/sink";
import { liveGateway } from "@/lib/mcp/gateway";
import {
  ActorVerificationCache,
  LATEST_PROTOCOL_VERSION,
  RateLimiter,
  createMcpServer,
  loggerAuditSink,
  parseTokenConfig,
  teeAuditSink,
  type TokenConfig,
} from "@/lib/mcp";
import { logger, newRequestId, requestIdFrom } from "@/lib/log";

/**
 * Node runtime, not edge: `@/lib/ledger/db` is a TCP Postgres driver and the
 * token comparison uses `node:crypto`'s `timingSafeEqual`.
 */
export const runtime = "nodejs";

/** A cached answer about someone's balance is a wrong answer about it. */
export const dynamic = "force-dynamic";

/**
 * Process-lifetime state, and the honest limits of each.
 *
 * The rate limiter and the actor cache are per-instance. On a platform that
 * runs several warm lambdas the effective rate limit is (instances x limit) —
 * written down in `ratelimit.ts` rather than implied away. The token config is
 * parsed once because re-parsing JSON on every request to get the same answer
 * is not defence in depth, it is just work.
 */
const limiter = new RateLimiter();
const cache = new ActorVerificationCache();

let tokenConfig: TokenConfig | null = null;

function config(): TokenConfig {
  if (tokenConfig === null) {
    // Read directly from process.env: `src/lib/env.ts` is owned by another
    // worker for the duration of this build. See the note at the top of
    // `mcp/auth.ts` for the TODO that folds this into `envSchema`.
    tokenConfig = parseTokenConfig(process.env["MCP_AGENT_TOKENS"]);
    if (tokenConfig.problems.length > 0) {
      // Once, at first use, at warn: an MCP endpoint that refuses every call
      // because of a typo in an env var is otherwise indistinguishable from
      // one that is working correctly and being probed.
      logger({ requestId: newRequestId() }).warn("mcp.config.problems", {
        problems: tokenConfig.problems,
        grants: tokenConfig.grants.length,
      });
    }
  }
  return tokenConfig;
}

/**
 * THE AUDIT TRAIL IS WRITTEN HERE, AND THE RESPONSE WAITS FOR IT.
 *
 * `src/lib/mcp/audit.ts` builds one complete record per call — the tool, the
 * business scope, the redacted arguments, the outcome, and every REFUSAL,
 * which is the half that matters after an incident. Until this line it went to
 * a single JSON line on stdout and nowhere else, while ten read tools served a
 * customer's balances, transactions, payees, pots, standing orders, card
 * controls, accruals, disputes and reconciliation breaks to an autonomous
 * agent with no durable record that any of it happened.
 *
 * TWO SINKS, IN THIS ORDER, AND THE ORDER IS THE DESIGN. `loggerAuditSink`
 * first, because it does not touch Postgres: if the database is gone the
 * record still exists, degraded from durable to a log retention window rather
 * than to nothing. `durableAuditSink` second, writing `mcp_audit` — append-only
 * by privilege and by trigger, the same four layers the money tables have.
 *
 * WHICH WAY AN AUDIT FAILURE FAILS: open for the call, closed for the claim.
 * The tool call is served; the claim that it is on the trail is withdrawn out
 * loud. The full argument is the header of `src/lib/audit/sink.ts`; the short
 * version is that `handlePost` builds the audit record in a `finally`, after
 * dispatch, so refusing here would withhold an answer the database has already
 * produced — a gate that runs after the thing it gates. It would buy a serving
 * outage and no reduction in exposure. What it must never do instead is
 * succeed silently, so:
 *
 *   - `settle()` is AWAITED. The obvious shape, `void insert().catch(log)`, is
 *     the trap: a serverless instance is frozen the moment the response is
 *     returned, and a detached insert is dropped along with its own catch
 *     handler — no row, no error line, no gap anybody can see.
 *   - a failure gets an error-level `mcp.audit.persist_failed` line, AND
 *   - `x-corgi-audit: degraded` on the response, so the caller learns that
 *     this call is not on the trail and not only the operator does.
 */
export async function POST(request: Request): Promise<Response> {
  const at = new Date();
  const log = logger({ requestId: requestIdFrom(request.headers) });
  const trail = durableAuditSink({ log });

  const server = createMcpServer({
    gateway: liveGateway(),
    config: config(),
    audit: teeAuditSink(loggerAuditSink(log), trail.sink),
    limiter,
    cache,
    now: () => at,
  });

  try {
    const response = await server.handlePost(request);
    return stamp(response, await trail.settle());
  } catch (error) {
    // Not a bare catch and not a swallow: `handlePost` has its own catch-all,
    // so arriving here means the failure was in this file. Records already
    // handed to the sink are facts, and losing them to a later bug is the
    // exact shape of gap this table exists to close — so settle, then rethrow
    // and let the platform answer 500.
    const persistence = await trail.settle();
    log.error("mcp.route.unhandled", { error, audit: persistence.state });
    throw error;
  }
}

/**
 * Say on the response whether this call is on the trail.
 *
 * A header and not a JSON-RPC error: the answer in the body is correct and the
 * client is entitled to it. What the client is not entitled to is the belief
 * that the call was recorded when it was not. `failures` stays out of the
 * response — a database error message is an internals leak, and it is already
 * in the log line the header points at.
 */
function stamp(response: Response, persistence: AuditPersistResult): Response {
  const headers = new Headers(response.headers);
  headers.set("x-corgi-audit", persistence.state);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The spec lets a server answer GET with 405 when it does not offer a stream.
 * Answering with an explanation rather than an empty 405 saves whoever is
 * wiring a client the twenty minutes of wondering whether the URL is wrong.
 */
export function GET(request: Request): Response {
  return methodNotAllowed(
    request,
    "This MCP endpoint does not open an SSE stream: it is single-response Streamable HTTP. POST one JSON-RPC message and read the JSON body of the reply.",
  );
}

/** No session id is issued, so there is no session to terminate. */
export function DELETE(request: Request): Response {
  return methodNotAllowed(
    request,
    "This server is stateless and issues no Mcp-Session-Id, so there is no session to delete.",
  );
}

function methodNotAllowed(request: Request, message: string): Response {
  const requestId = requestIdFrom(request.headers);
  return new Response(
    JSON.stringify({
      error: { code: "METHOD_NOT_ALLOWED", message },
      protocolVersion: LATEST_PROTOCOL_VERSION,
      requestId,
    }),
    {
      status: 405,
      headers: {
        "content-type": "application/json",
        allow: "POST",
        "x-request-id": requestId,
        "cache-control": "no-store",
      },
    },
  );
}
