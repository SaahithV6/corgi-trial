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

import { liveGateway } from "@/lib/mcp/gateway";
import {
  ActorVerificationCache,
  LATEST_PROTOCOL_VERSION,
  RateLimiter,
  createMcpServer,
  loggerAuditSink,
  parseTokenConfig,
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

export async function POST(request: Request): Promise<Response> {
  const at = new Date();
  const server = createMcpServer({
    gateway: liveGateway(),
    config: config(),
    audit: loggerAuditSink(logger({ requestId: requestIdFrom(request.headers) })),
    limiter,
    cache,
    now: () => at,
  });
  return server.handlePost(request);
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
