/**
 * Process-lifetime wiring for `/api/v1/**`, and the honest limits of each part.
 *
 * The rate limiter and the actor cache live in this process. On a platform
 * that runs several warm lambdas the effective rate limit is (instances x
 * limit) — the same gap `mcp/ratelimit.ts` writes down rather than implying
 * away, and it is a gap for the same reason: the limiter's job is to stop a
 * well-meaning integration in a retry loop from consuming an approver's
 * afternoon, not to stop an attacker. The controls that stop an attacker are
 * the token, the tenant scope and the approval queue.
 *
 * The limiter is deliberately NOT shared with the MCP surface. Two protocols
 * holding one bucket would mean an agent's reads throttling an integration's
 * writes, and the budgets exist for different reasons.
 */

import "server-only";

import { liveGateway } from "@/lib/mcp/gateway";
import {
  ActorVerificationCache,
  RateLimiter,
  loggerAuditSink,
  type Gateway,
} from "@/lib/mcp";
import { logger, newRequestId } from "@/lib/log";

import { resolveTokenConfig, type TokenSource } from "./auth";
import type { ApiDeps } from "./handle";

const limiter = new RateLimiter();
const cache = new ActorVerificationCache();

let resolved: { readonly config: ReturnType<typeof resolveTokenConfig>["config"]; readonly source: TokenSource } | null =
  null;

function tokens(): { readonly config: ReturnType<typeof resolveTokenConfig>["config"]; readonly source: TokenSource } {
  if (resolved === null) {
    resolved = resolveTokenConfig();
    if (resolved.config.problems.length > 0) {
      // Once, at first use, at warn. An API that refuses every call because of
      // a typo in an env var is otherwise indistinguishable from one that is
      // working correctly and being probed.
      logger({ requestId: newRequestId() }).warn("api.config.problems", {
        problems: resolved.config.problems,
        grants: resolved.config.grants.length,
        source: resolved.source,
      });
    }
  }
  return resolved;
}

/** Which env var supplied the grants. Reported by `GET /api/v1`. */
export function tokenSource(): TokenSource {
  return tokens().source;
}

export function apiDeps(overrides: Partial<ApiDeps> = {}): ApiDeps {
  const { config } = tokens();
  const gateway: Gateway = overrides.gateway ?? liveGateway();
  return {
    gateway,
    config: overrides.config ?? config,
    // `surface: "api"` on every audit line. The record itself has no surface
    // field — it is the MCP surface's `AuditRecord`, reused deliberately so
    // that "what did the integration try" and "what did the agent try" are one
    // query rather than two log formats — so the distinction rides on the
    // logger's child fields and on `method`, which is the verb and path.
    audit: overrides.audit ?? loggerAuditSink(logger().child({ surface: "api" })),
    limiter: overrides.limiter ?? limiter,
    cache: overrides.cache ?? cache,
    ...(overrides.log === undefined ? {} : { log: overrides.log }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  };
}
