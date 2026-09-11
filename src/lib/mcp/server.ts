/**
 * The MCP server: one HTTP POST in, one JSON-RPC response out.
 *
 * The order of the gate is the design, and it is deliberately not the order
 * that reads most naturally:
 *
 *   1. size and shape        — refuse a body we will not read anyway
 *   2. origin                — a browser on another site may not drive this
 *   3. protocol version      — fail loudly rather than half-speaking
 *   4. authentication        — no token, no dispatch, ever
 *   5. rate limit            — per token, plus a stricter budget for writes
 *   6. dispatch              — and only here does anything touch the database
 *   7. audit                 — ALWAYS, including every refusal above
 *
 * Step 7 is why this is one function rather than a chain of middleware: the
 * audit record must be written on every path out of here, including the throw
 * nobody predicted, and a `finally` in one place is easier to prove than seven
 * call sites that each promise to log.
 *
 * The server has no database handle of its own. It is given a `Gateway`, which
 * makes the whole surface testable without Postgres and makes the set of
 * statements it can cause a matter of reading one interface.
 */

import { logger, requestIdFrom, type Logger } from "@/lib/log";

import { redactArguments, type AuditOutcome, type AuditRecord, type AuditSink } from "./audit";
import {
  ActorVerificationCache,
  authenticate,
  type TokenConfig,
} from "./auth";
import {
  FORBIDDEN,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  RATE_LIMITED,
  REQUEST_REFUSED,
  UNAUTHORIZED,
  decodeMessage,
  failure,
  success,
  type JsonRpcFailure,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc";
import {
  LATEST_PROTOCOL_VERSION,
  initializeResult,
  isSupportedProtocolVersion,
  negotiateProtocolVersion,
  toolCallError,
  toolCallResult,
  toolsListResult,
} from "./protocol";
import {
  RateLimiter,
  UNAUTHENTICATED_LIMIT_PER_MINUTE,
  WRITE_LIMIT_PER_MINUTE,
  clientKey,
} from "./ratelimit";
import { refusalForTool } from "./limits";
import { bookDate } from "./time";
import { TOOLS, findTool } from "./tools";
import { ToolError, type Gateway, type Grant, type ToolContext } from "./types";

/** 256 KB. A tool call is a few hundred bytes; anything larger is not one. */
const MAX_BODY_BYTES = 256 * 1024;

export interface McpServerDeps {
  readonly gateway: Gateway;
  readonly config: TokenConfig;
  readonly audit: AuditSink;
  readonly limiter?: RateLimiter;
  readonly cache?: ActorVerificationCache;
  readonly log?: Logger;
  /** Injected so tests are not a function of the wall clock. */
  readonly now?: () => Date;
}

export interface McpServer {
  handlePost(request: Request): Promise<Response>;
}

export function createMcpServer(deps: McpServerDeps): McpServer {
  const limiter = deps.limiter ?? new RateLimiter();
  const cache = deps.cache ?? new ActorVerificationCache();
  const now = deps.now ?? (() => new Date());

  return {
    async handlePost(request: Request): Promise<Response> {
      const startedAt = Date.now();
      const requestId = requestIdFrom(request.headers);
      const log = (deps.log ?? logger()).child({ requestId, surface: "mcp" });
      const client = clientKey(request.headers);
      const at = now();

      // Everything the audit record needs, filled in as we learn it, written
      // exactly once in the `finally`.
      let method = "(unparsed)";
      let tool: string | null = null;
      let outcome: AuditOutcome = "internal_error";
      let errorCode: string | null = null;
      let grant: Grant | null = null;
      let argumentsRedacted: Record<string, unknown> | null = null;
      let result: Record<string, unknown> | null = null;

      const finish = (
        response: Response,
        record: {
          outcome: AuditOutcome;
          errorCode?: string | null;
          result?: Record<string, unknown> | null;
        },
      ): Response => {
        outcome = record.outcome;
        errorCode = record.errorCode ?? null;
        result = record.result ?? null;
        return response;
      };

      try {
        // ---- 1. body ---------------------------------------------------
        const declaredLength = Number(request.headers.get("content-length") ?? "0");
        if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
          return finish(
            json(
              failure(null, INVALID_REQUEST, `request body exceeds ${MAX_BODY_BYTES} bytes`),
              413,
              requestId,
            ),
            { outcome: "protocol_error", errorCode: "BODY_TOO_LARGE" },
          );
        }

        const body = await request.text();
        if (body.length > MAX_BODY_BYTES) {
          return finish(
            json(
              failure(null, INVALID_REQUEST, `request body exceeds ${MAX_BODY_BYTES} bytes`),
              413,
              requestId,
            ),
            { outcome: "protocol_error", errorCode: "BODY_TOO_LARGE" },
          );
        }

        // ---- 2. origin -------------------------------------------------
        // Streamable HTTP is reachable from a browser, so a page on another
        // origin could otherwise drive a locally-running MCP server using the
        // user's ambient credentials. Same-origin and localhost only.
        const origin = request.headers.get("origin");
        if (origin !== null && !originAllowed(origin, request.url)) {
          return finish(
            json(
              failure(null, REQUEST_REFUSED, `origin ${origin} is not permitted`),
              403,
              requestId,
            ),
            { outcome: "refused", errorCode: "BAD_ORIGIN" },
          );
        }

        // ---- 3. protocol version --------------------------------------
        const declaredVersion = request.headers.get("mcp-protocol-version");
        if (declaredVersion !== null && !isSupportedProtocolVersion(declaredVersion)) {
          return finish(
            json(
              failure(
                null,
                INVALID_REQUEST,
                `unsupported MCP-Protocol-Version "${declaredVersion}"; this server speaks ${LATEST_PROTOCOL_VERSION}`,
              ),
              400,
              requestId,
            ),
            { outcome: "protocol_error", errorCode: "UNSUPPORTED_PROTOCOL_VERSION" },
          );
        }

        const decoded = decodeMessage(body);
        if (decoded.kind === "error") {
          method = "(unparsed)";
          return finish(json(decoded.failure, 400, requestId), {
            outcome: "protocol_error",
            errorCode: String(decoded.failure.error.code),
          });
        }

        const rpc = decoded.request;
        method = rpc.method;

        // ---- 4. authentication ----------------------------------------
        const auth = await authenticate(request.headers, {
          config: deps.config,
          gateway: deps.gateway,
          cache,
          nowMs: at.getTime(),
        });

        if (!auth.ok) {
          // Spend from the per-address budget only on FAILURE, so a well-behaved
          // client is never throttled by a noisy neighbour behind the same
          // proxy, while a token guesser still runs out of attempts.
          const brake = limiter.check(
            `unauth:${client}`,
            UNAUTHENTICATED_LIMIT_PER_MINUTE,
            at.getTime(),
          );
          if (!brake.allowed) {
            return finish(
              rateLimited(rpc, requestId, brake.retryAfterSeconds, brake.limitPerMinute),
              { outcome: "refused", errorCode: "TOO_MANY_FAILED_AUTH" },
            );
          }

          const status = auth.failure.reason === "no_token" ? 401 : forbiddenish(auth.failure.reason);
          const code = status === 401 ? UNAUTHORIZED : FORBIDDEN;
          log.warn("mcp.auth.refused", { reason: auth.failure.reason, client });
          return finish(
            json(
              failure(rpc.id ?? null, code, auth.failure.message, { reason: auth.failure.reason }),
              status,
              requestId,
              status === 401
                ? { "www-authenticate": 'Bearer realm="corgi-mcp", error="invalid_token"' }
                : undefined,
            ),
            { outcome: "refused", errorCode: auth.failure.reason.toUpperCase() },
          );
        }

        grant = auth.grant;

        // ---- 5. rate limit --------------------------------------------
        const budget = limiter.check(
          `token:${grant.tokenFingerprint}`,
          grant.rateLimitPerMinute,
          at.getTime(),
        );
        if (!budget.allowed) {
          return finish(rateLimited(rpc, requestId, budget.retryAfterSeconds, budget.limitPerMinute), {
            outcome: "refused",
            errorCode: "RATE_LIMITED",
          });
        }

        // ---- 6. dispatch ----------------------------------------------
        // A notification carries no id and gets no body. It is authenticated
        // and audited like everything else: "the client said hello" is a fact
        // worth having in the log next to the calls that followed.
        if (rpc.id === undefined) {
          return finish(new Response(null, { status: 202, headers: baseHeaders(requestId) }), {
            outcome: "ok",
          });
        }

        const dispatched = await dispatch(rpc, {
          grant,
          gateway: deps.gateway,
          log,
          now: at,
          bookToday: bookDate(at),
        }, {
          limiter,
          nowMs: at.getTime(),
          onTool: (name, args) => {
            tool = name;
            argumentsRedacted = redactArguments(args);
          },
        });

        return finish(json(dispatched.response, dispatched.status, requestId), {
          outcome: dispatched.outcome,
          errorCode: dispatched.errorCode,
          result: dispatched.resultSummary,
        });
      } catch (error) {
        // An unexpected throw is a bug in this file, not a client problem. It
        // gets its own error line with the stack, and the client gets a
        // JSON-RPC internal error with no internals in it.
        log.error("mcp.unhandled", { error, method });
        return finish(
          json(
            failure(null, INTERNAL_ERROR, "internal error handling the MCP request"),
            500,
            requestId,
          ),
          { outcome: "internal_error", errorCode: "UNHANDLED" },
        );
      } finally {
        const record: AuditRecord = {
          at: at.toISOString(),
          requestId,
          method,
          tool,
          outcome,
          errorCode,
          actorId: grant?.actorId ?? null,
          businessId: grant?.businessId ?? null,
          grantLabel: grant?.label ?? null,
          grantFingerprint: grant?.tokenFingerprint ?? null,
          clientKey: client,
          argumentsRedacted,
          durationMs: Date.now() - startedAt,
          result,
        };
        deps.audit.record(record);
      }
    },
  };
}

interface DispatchOptions {
  readonly limiter: RateLimiter;
  readonly nowMs: number;
  readonly onTool: (name: string, args: Record<string, unknown>) => void;
}

interface Dispatched {
  readonly response: JsonRpcResponse;
  readonly status: number;
  readonly outcome: AuditOutcome;
  readonly errorCode: string | null;
  readonly resultSummary: Record<string, unknown> | null;
}

async function dispatch(
  rpc: JsonRpcRequest,
  ctx: ToolContext,
  options: DispatchOptions,
): Promise<Dispatched> {
  const id = rpc.id as string | number;
  const params = rpc.params ?? {};

  switch (rpc.method) {
    case "initialize": {
      const version = negotiateProtocolVersion(params["protocolVersion"]);
      return okResult(success(id, initializeResult(version)), { protocolVersion: version });
    }

    case "ping":
      return okResult(success(id, {}), null);

    case "tools/list":
      return okResult(success(id, toolsListResult()), null);

    case "tools/call":
      return callTool(id, params, ctx, options);

    // Declared capabilities are tools and nothing else, so these are honest
    // method-not-found answers rather than empty lists that imply support.
    case "resources/list":
    case "resources/templates/list":
    case "prompts/list":
    case "completion/complete":
      return errorResult(
        failure(
          id,
          METHOD_NOT_FOUND,
          `this server declares only the "tools" capability; ${rpc.method} is not implemented`,
        ),
        "METHOD_NOT_FOUND",
      );

    default:
      return errorResult(
        failure(id, METHOD_NOT_FOUND, `unknown method "${rpc.method}"`),
        "METHOD_NOT_FOUND",
      );
  }
}

async function callTool(
  id: string | number,
  params: Record<string, unknown>,
  ctx: ToolContext,
  options: DispatchOptions,
): Promise<Dispatched> {
  const name = params["name"];
  if (typeof name !== "string") {
    return errorResult(
      failure(id, INVALID_PARAMS, "tools/call requires a string params.name"),
      "MISSING_TOOL_NAME",
    );
  }

  const rawArgs = params["arguments"];
  const args: Record<string, unknown> =
    rawArgs === undefined || rawArgs === null
      ? {}
      : typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};

  options.onTool(name, args);

  if (
    rawArgs !== undefined &&
    rawArgs !== null &&
    (typeof rawArgs !== "object" || Array.isArray(rawArgs))
  ) {
    return errorResult(
      failure(id, INVALID_PARAMS, "params.arguments must be an object"),
      "BAD_ARGUMENTS_SHAPE",
    );
  }

  const tool = findTool(name);
  if (tool === undefined) {
    // The available list is derived from the registry rather than typed out.
    // It used to be a literal of four names and it stayed a literal of four
    // names through three tools being added, so a model that guessed
    // `list_pots` was told, in writing, that `list_pots` did not exist.
    //
    // `refused` is the more interesting half. "Unknown tool" is the worst
    // answer to a guess, because it is indistinguishable from a typo and a
    // model will keep guessing synonyms. When the guess is an operation this
    // surface deliberately refuses, say so in the error and point at the tool
    // that carries the argument — `list_agent_limits` — instead of letting the
    // model conclude it spelled something wrong.
    const refusal = refusalForTool(name);
    return errorResult(
      failure(id, INVALID_PARAMS, `unknown tool "${name}"`, {
        available: TOOLS.map((t) => t.name),
        ...(refusal === undefined
          ? {}
          : {
              refused: true,
              reason: `This is not a missing tool, it is a refused operation: ${refusal.operation.toLowerCase()}. See docs/AGENT-LIMITS.md §${refusal.section}.`,
              instead: refusal.instead,
              explain_with: "list_agent_limits",
            }),
      }),
      refusal === undefined ? "UNKNOWN_TOOL" : "REFUSED_OPERATION",
    );
  }

  // The write budget. A read-heavy agent is fine; an agent queueing payments
  // faster than a person can read them is an attack on the approver, who is
  // the control this entire design rests on.
  if (!tool.readOnly) {
    const writeBudget = options.limiter.check(
      `write:${ctx.grant.tokenFingerprint}`,
      WRITE_LIMIT_PER_MINUTE,
      options.nowMs,
    );
    if (!writeBudget.allowed) {
      return {
        response: failure(
          id,
          RATE_LIMITED,
          `this token may queue at most ${WRITE_LIMIT_PER_MINUTE} payment instructions per minute; retry in ${writeBudget.retryAfterSeconds}s`,
          { retryAfterSeconds: writeBudget.retryAfterSeconds },
        ),
        status: 429,
        outcome: "refused",
        errorCode: "WRITE_RATE_LIMITED",
        resultSummary: null,
      };
    }
  }

  let parsed: unknown;
  try {
    parsed = tool.parse(args);
  } catch (error) {
    if (error instanceof ToolError) {
      // Bad arguments are a PROTOCOL error under the MCP spec, not a tool
      // result: the tool never ran. The details still travel so the model can
      // see which field it got wrong.
      return errorResult(
        failure(id, INVALID_PARAMS, error.message, error.details),
        error.code,
      );
    }
    throw error;
  }

  try {
    const outcome = await tool.run(parsed as never, ctx);
    return okResult(success(id, toolCallResult(outcome)), summarise(tool.name, outcome.data));
  } catch (error) {
    if (error instanceof ToolError) {
      // The tool ran and refused. `isError: true` inside a successful
      // JSON-RPC response, so the model reads the reason instead of aborting.
      return {
        response: success(id, toolCallError(error.code, error.message, error.details)),
        status: 200,
        outcome: "tool_error",
        errorCode: error.code,
        resultSummary: null,
      };
    }
    throw error;
  }
}

/** Ids and counts worth having in the audit line. Never the payload itself. */
function summarise(tool: string, data: Record<string, unknown>): Record<string, unknown> | null {
  switch (tool) {
    case "initiate_payment":
      return {
        instruction_id: data["instruction_id"],
        replayed: data["replayed"],
        content_hash: data["content_hash"],
        money_moved: data["money_moved"],
      };
    case "list_transactions":
      return { rows: Array.isArray(data["transactions"]) ? data["transactions"].length : 0 };
    case "list_recon_breaks":
      return { rows: Array.isArray(data["open_breaks"]) ? data["open_breaks"].length : 0 };
    case "get_balance":
      return { basis: (data["as_of"] as Record<string, unknown> | undefined)?.["basis"] ?? null };
    case "list_disputes":
      return {
        cases: Array.isArray(data["cases"]) ? data["cases"].length : 0,
        // Worth having in the audit line on its own: this is customer money
        // the bank advanced and is holding, and "who asked about it, when" is
        // a question that gets asked after the fact rather than before.
        held_cents:
          (data["totals"] as Record<string, Record<string, unknown>> | undefined)?.["held"]?.[
            "cents"
          ] ?? null,
      };
    case "list_accruals":
      return { days: Array.isArray(data["days"]) ? data["days"].length : 0 };
    case "list_agent_limits":
      // The query, never the answer. A model repeatedly asking whether it may
      // approve payments is a signal worth being able to grep for.
      return { query: data["query"], matched: data["matched"] };
    default:
      return null;
  }
}

function okResult(
  response: JsonRpcResponse,
  resultSummary: Record<string, unknown> | null,
): Dispatched {
  return { response, status: 200, outcome: "ok", errorCode: null, resultSummary };
}

function errorResult(response: JsonRpcFailure, errorCode: string): Dispatched {
  // 200 with a JSON-RPC error body: the HTTP layer delivered the message
  // successfully, and the failure is at the RPC layer. Only the transport-level
  // refusals above (auth, throttling, oversized bodies) change the status code.
  return { response, status: 200, outcome: "protocol_error", errorCode, resultSummary: null };
}

function rateLimited(
  rpc: JsonRpcRequest,
  requestId: string,
  retryAfterSeconds: number,
  limit: number,
): Response {
  return json(
    failure(
      rpc.id ?? null,
      RATE_LIMITED,
      `rate limit exceeded (${limit}/minute); retry in ${retryAfterSeconds}s`,
      { retryAfterSeconds },
    ),
    429,
    requestId,
    { "retry-after": String(retryAfterSeconds) },
  );
}

function forbiddenish(reason: string): number {
  return reason === "unknown_token" || reason === "not_configured" ? 401 : 403;
}

function baseHeaders(requestId: string): Record<string, string> {
  return {
    "x-request-id": requestId,
    "cache-control": "no-store",
    // Echoed so a client can confirm which revision it is talking to without
    // a second round trip.
    "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
  };
}

function json(
  body: unknown,
  status: number,
  requestId: string,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...baseHeaders(requestId),
      ...(extra ?? {}),
    },
  });
}

/**
 * Same origin, or a loopback address. Nothing else.
 *
 * A missing Origin header is allowed: that is every non-browser client, which
 * is all of them today. The header only appears when a browser is involved,
 * and that is exactly the case worth restricting.
 */
export function originAllowed(origin: string, requestUrl: string): boolean {
  let parsed: URL;
  let self: URL;
  try {
    parsed = new URL(origin);
    self = new URL(requestUrl);
  } catch {
    return false;
  }
  if (parsed.origin === self.origin) return true;
  return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
}
