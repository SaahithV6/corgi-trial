/**
 * Authentication for the public HTTP API.
 *
 * ===========================================================================
 * THIS FILE DEFINES NOTHING. IT CHOOSES A SOURCE AND DELEGATES.
 * ===========================================================================
 *
 * The MCP surface already decided what a credential is, and it decided it
 * carefully: a grant names exactly one `business_id` and exactly one
 * `actor_id`, the token is compared as a sha256 digest with `timingSafeEqual`
 * and never with `===`, the lookup does not short-circuit on a hit, an
 * unconfigured deployment refuses every call, and the DATABASE gets the last
 * word on whether the configured actor is allowed to speak — it must be
 * `kind = 'agent'` with `can_approve = false`, re-read at most 60 seconds old.
 *
 * Every one of those properties is wanted here, unchanged. So `parseTokenConfig`,
 * `findGrant`, `authenticate`, `verifyActor` and `ActorVerificationCache` are
 * imported from `@/lib/mcp` and called. There is no second token parser, no
 * second constant-time comparison and no second definition of "which business
 * is this caller". Two surfaces with two answers to that question is the bug
 * this build has hit repeatedly.
 *
 * ===========================================================================
 * WHY AN HTTP CALLER MUST ALSO RESOLVE TO AN ACTOR OF KIND 'agent'
 * ===========================================================================
 *
 * This looks at first like a category error — an integrator is a company's
 * back-office system, not an agent — and it is deliberate.
 *
 * `actor.kind` is not a description of what is at the other end of the socket.
 * It is the answer to one question the ledger asks: MAY THIS PRINCIPAL APPROVE
 * A PAYMENT? `CHECK (NOT (kind <> 'human' AND can_approve))` makes an
 * approving non-human unrepresentable, and `assert_maker_checker()` refuses an
 * `approved` event from one. A credential that resolved to a HUMAN actor would
 * put an HTTP caller's instruction into the queue wearing a face that can
 * approve, and maker-checker would then be reasoning about the wrong
 * principal — a second approval from "the integration" would be a second
 * approval the database was willing to store.
 *
 * So the rule is the same rule, for the same reason: this surface speaks as
 * something that cannot approve, or it does not speak. An integrator can
 * PROPOSE money movement and can never CAUSE it, and that property is held by
 * a CHECK constraint rather than by this file.
 *
 * ===========================================================================
 * WHERE THE GRANTS COME FROM
 * ===========================================================================
 *
 * `API_TOKENS` first, `MCP_AGENT_TOKENS` as a documented fallback, same JSON
 * shape either way (see `.env.example`).
 *
 * The fallback is not laziness. A deployment that has already issued an agent
 * credential for one business should not need a second secret to reach the
 * same data over a second protocol, and forcing one would mean either editing
 * the deployed environment or shipping a surface nobody can call. Which source
 * was used is reported by `GET /api/v1` and logged once at first use, so
 * "which list is this token in" is never a guess.
 *
 * What the fallback does NOT do is widen anything: the grant is the same
 * grant, one business, one non-approving actor, the same per-instruction
 * ceiling. If the two surfaces should have separate credentials — and for
 * anything beyond a sandbox they should, so that revoking an integration does
 * not revoke an agent — set `API_TOKENS` and the fallback stops being
 * consulted.
 *
 * `process.env` is read directly rather than through `src/lib/env.ts` for the
 * same reason `mcp/auth.ts` does it: that file's schema is owned elsewhere for
 * the duration of this build. The TODO is the same one.
 */

import {
  ActorVerificationCache,
  authenticate,
  parseTokenConfig,
  type AuthFailure,
  type Gateway,
  type Grant,
  type TokenConfig,
} from "@/lib/mcp";

import { ApiError } from "./errors";

/** Which environment variable supplied the grants. Reported by `GET /api/v1`. */
export type TokenSource = "API_TOKENS" | "MCP_AGENT_TOKENS" | "none";

export interface ResolvedTokenConfig {
  readonly config: TokenConfig;
  readonly source: TokenSource;
}

/**
 * Parse the grant list once per process.
 *
 * Re-parsing the same JSON on every request to reach the same answer is not
 * defence in depth, it is work. The token itself is still hashed and compared
 * on every single request — only the parse is amortised.
 */
export function resolveTokenConfig(env: NodeJS.ProcessEnv = process.env): ResolvedTokenConfig {
  const own = env["API_TOKENS"];
  if (own !== undefined && own.trim() !== "") {
    return { config: parseTokenConfig(own), source: "API_TOKENS" };
  }
  const shared = env["MCP_AGENT_TOKENS"];
  if (shared !== undefined && shared.trim() !== "") {
    return { config: parseTokenConfig(shared), source: "MCP_AGENT_TOKENS" };
  }
  return {
    config: {
      grants: [],
      problems: [
        "neither API_TOKENS nor MCP_AGENT_TOKENS is set; /api/v1 will refuse every call. See docs/API.md.",
      ],
    },
    source: "none",
  };
}

export { ActorVerificationCache };

export interface AuthenticateApiDeps {
  readonly config: TokenConfig;
  readonly gateway: Pick<Gateway, "resolveActor">;
  readonly cache: ActorVerificationCache;
  readonly nowMs: number;
}

/**
 * Authenticate, or throw the refusal that should go on the wire.
 *
 * The messages are deliberately identical whether a token is unknown, revoked
 * or mistyped — `mcp/auth.ts` makes that choice and the reason is that a
 * caller able to tell them apart has an oracle for probing. What this adds is
 * the HTTP shape: 401 with `WWW-Authenticate` for "you did not identify
 * yourself", 403 for "you did, and the answer is still no".
 */
export async function authenticateApiRequest(
  headers: Headers,
  deps: AuthenticateApiDeps,
): Promise<Grant> {
  const result = await authenticate(headers, {
    config: deps.config,
    gateway: deps.gateway,
    cache: deps.cache,
    nowMs: deps.nowMs,
  });

  if (result.ok) return result.grant;
  throw authFailureToApiError(result.failure);
}

/** The one place an `AuthFailure` becomes a status code. */
export function authFailureToApiError(failure: AuthFailure): ApiError {
  switch (failure.reason) {
    case "no_token":
      return new ApiError({
        status: 401,
        type: "authentication",
        code: "MISSING_BEARER_TOKEN",
        // THE ONE PLACE THIS LAYER REPLACES AN UPSTREAM MESSAGE, and it is
        // worth naming as an exception because the rule everywhere else is
        // that rewriting one is a second opinion about why a caller was
        // refused. `mcp/auth.ts`'s wording ends "See docs/MCP.md", which is
        // the wrong document for an HTTP integrator and would send them to a
        // page about connecting a model client. Nothing about the DECISION is
        // restated — only the pointer, which is a fact about this surface and
        // not about the refusal.
        message:
          "this endpoint requires a bearer token: send Authorization: Bearer <token>. See docs/API.md.",
        condition: "Authorization: Bearer <token> is present on the request",
        resolution:
          "Send the API token issued for your business as a bearer token. Every endpoint under /api/v1 requires one; there is no anonymous read.",
        headers: { "www-authenticate": 'Bearer realm="corgi-api", error="invalid_token"' },
      });
    case "unknown_token":
      return new ApiError({
        status: 401,
        type: "authentication",
        code: "UNKNOWN_TOKEN",
        message: failure.message,
        condition: "the presented token matches a configured grant",
        resolution:
          "The wording here is identical for a mistyped token, a revoked token and one that never existed — telling them apart would hand a caller a way to probe for valid credentials. Check the token you were issued.",
        headers: { "www-authenticate": 'Bearer realm="corgi-api", error="invalid_token"' },
      });
    case "not_configured":
      return new ApiError({
        status: 401,
        type: "authentication",
        code: "NO_TOKENS_CONFIGURED",
        message: failure.message,
        condition: "this deployment has at least one grant in API_TOKENS or MCP_AGENT_TOKENS",
        resolution:
          "An unconfigured API is an unreachable API — there is no development bypass and no default token, because those are the ones that ship. The operator sets API_TOKENS.",
        headers: { "www-authenticate": 'Bearer realm="corgi-api"' },
      });
    case "actor_missing":
      return new ApiError({
        status: 403,
        type: "authentication",
        code: "GRANT_DOES_NOT_RESOLVE",
        message: failure.message,
        condition: "the grant's actor_id and business_id both exist in the database",
        resolution:
          "Configuration says which actor a token speaks as; the actor row decides whether that is allowed, and there is no row. This is an operator problem: send the request_id.",
      });
    case "actor_not_agent":
      return new ApiError({
        status: 403,
        type: "authentication",
        code: "ACTOR_MAY_APPROVE",
        message: failure.message,
        condition: "the grant resolves to an actor of kind 'agent' with can_approve = false",
        resolution:
          "A credential for this surface must resolve to a principal that cannot approve a payment, because everything it can write lands in the maker-checker queue and a principal that could approve would be able to satisfy its own instruction. Re-issue the token against a non-approving actor.",
      });
  }
}
