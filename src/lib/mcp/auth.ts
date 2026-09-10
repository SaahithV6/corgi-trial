/**
 * Bearer-token authentication and tenant scoping for the MCP endpoint.
 *
 * Three properties, in the order they matter:
 *
 *   1. FAIL CLOSED. No `MCP_AGENT_TOKENS`, a malformed one, or an empty list
 *      means every call is refused. There is no development bypass, no
 *      `NODE_ENV === "development"` branch, and no default token — those are
 *      the ones that ship. An unconfigured MCP surface is an unreachable MCP
 *      surface.
 *
 *   2. THE TOKEN CARRIES THE SCOPE. A grant names exactly one `business_id`
 *      and one `actor_id`. No tool argument can widen it, because no tool
 *      accepts a business or account identifier at all (`tools.test.ts` proves
 *      this over every schema).
 *
 *   3. THE DATABASE HAS THE LAST WORD. Configuration says which actor a token
 *      speaks as; the `actor` row decides whether that is allowed. The row
 *      must be `kind = 'agent'` with `can_approve = false`. If someone edits
 *      the config to point a token at a human approver's actor id, this
 *      refuses — the same fact the ledger's maker-checker trigger relies on,
 *      checked at the door instead of at the trigger.
 *
 * WHY process.env DIRECTLY. `src/lib/env.ts` is the single place the
 * environment is read and it is owned by another worker for the duration of
 * this build; adding a key to its schema is a merge conflict in someone else's
 * file. TODO: fold `MCP_AGENT_TOKENS` into `envSchema` (optional string,
 * validated by `parseTokenConfig` below) once that file is free, and delete
 * this note.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { Gateway, Grant } from "./types";

/** Requests per minute a token gets if it does not name its own. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

/** How long a verified actor row is trusted before re-reading it. */
export const ACTOR_CACHE_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/i;

const grantConfigSchema = z
  .strictObject({
    label: z.string().min(1).max(64),
    /**
     * The token in the clear. Convenient for a sandbox; for anything shared,
     * set `tokenSha256` instead so the environment holds a digest and a leaked
     * env dump is not a leaked credential.
     */
    token: z.string().min(24).optional(),
    tokenSha256: z.string().regex(SHA256_HEX).optional(),
    actorId: z.string().regex(UUID),
    businessId: z.string().regex(UUID),
    rateLimitPerMinute: z.number().int().min(1).max(6000).optional(),
    /** Decimal string; cents. `null`/absent means no ceiling. */
    maxInstructionCents: z
      .string()
      .regex(/^[0-9]{1,16}$/)
      .nullish(),
  })
  .refine((g) => (g.token === undefined) !== (g.tokenSha256 === undefined), {
    error: "each grant needs exactly one of token or tokenSha256",
  });

const tokenConfigSchema = z.array(grantConfigSchema).max(64);

export interface ConfiguredGrant {
  readonly label: string;
  /** 32 raw bytes. Compared with `timingSafeEqual`, never with `===`. */
  readonly tokenDigest: Buffer;
  readonly actorId: string;
  readonly businessId: string;
  readonly rateLimitPerMinute: number;
  readonly maxInstructionCents: bigint | null;
}

export interface TokenConfig {
  readonly grants: readonly ConfiguredGrant[];
  /** Why the list is empty or short. Logged once at first use, never returned. */
  readonly problems: readonly string[];
}

export function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** First 8 hex chars of a token's digest: safe to log, enough to disambiguate. */
export function fingerprint(digest: Buffer): string {
  return digest.subarray(0, 4).toString("hex");
}

/**
 * Parse `MCP_AGENT_TOKENS`, a JSON array. Never throws: a broken value yields
 * zero grants and a problem string, which is refusal plus an explanation
 * rather than a crashed route.
 */
export function parseTokenConfig(raw: string | undefined): TokenConfig {
  if (raw === undefined || raw.trim() === "") {
    return {
      grants: [],
      problems: [
        "MCP_AGENT_TOKENS is not set; the MCP endpoint will refuse every call. See docs/MCP.md.",
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      grants: [],
      problems: [
        `MCP_AGENT_TOKENS is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }

  const result = tokenConfigSchema.safeParse(parsed);
  if (!result.success) {
    return {
      grants: [],
      problems: result.error.issues.map(
        (i) => `MCP_AGENT_TOKENS[${i.path.join(".")}]: ${i.message}`,
      ),
    };
  }

  const problems: string[] = [];
  const grants: ConfiguredGrant[] = [];
  const seen = new Set<string>();

  for (const g of result.data) {
    const digest =
      g.token !== undefined ? sha256(g.token) : Buffer.from(g.tokenSha256 as string, "hex");
    const hex = digest.toString("hex");
    if (seen.has(hex)) {
      // Two grants sharing a secret means the scope of a call depends on list
      // order. Drop both rather than pick one.
      problems.push(`duplicate token for grant "${g.label}"; both grants dropped`);
      const index = grants.findIndex((existing) => existing.tokenDigest.toString("hex") === hex);
      if (index >= 0) grants.splice(index, 1);
      continue;
    }
    seen.add(hex);
    grants.push({
      label: g.label,
      tokenDigest: digest,
      actorId: g.actorId.toLowerCase(),
      businessId: g.businessId.toLowerCase(),
      rateLimitPerMinute: g.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
      maxInstructionCents:
        g.maxInstructionCents === undefined || g.maxInstructionCents === null
          ? null
          : BigInt(g.maxInstructionCents),
    });
  }

  return { grants, problems };
}

/** `Authorization: Bearer <token>`, and nothing else. */
export function bearerToken(headers: Headers): string | null {
  const raw = headers.get("authorization");
  if (raw === null) return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(raw.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token === "" ? null : token;
}

/**
 * Constant-time lookup.
 *
 * The loop does not break on a hit. An early exit leaks, through response
 * time, roughly where in the list a token sits — small, but the fix is one
 * boolean and there is no reason to keep the leak.
 */
export function findGrant(
  config: TokenConfig,
  presented: string,
): ConfiguredGrant | null {
  const digest = sha256(presented);
  let found: ConfiguredGrant | null = null;
  for (const grant of config.grants) {
    // Both operands are sha256 output, so lengths always match and
    // timingSafeEqual cannot throw on a length mismatch.
    if (timingSafeEqual(digest, grant.tokenDigest)) found = grant;
  }
  return found;
}

export type AuthFailure =
  | { readonly reason: "no_token"; readonly message: string }
  | { readonly reason: "unknown_token"; readonly message: string }
  | { readonly reason: "not_configured"; readonly message: string }
  | { readonly reason: "actor_missing"; readonly message: string }
  | { readonly reason: "actor_not_agent"; readonly message: string };

export type AuthResult =
  | { readonly ok: true; readonly grant: Grant }
  | { readonly ok: false; readonly failure: AuthFailure };

interface CacheEntry {
  readonly at: number;
  readonly result: AuthResult;
}

/**
 * Caches the `actor`/`business` verification, not the token comparison. The
 * token is hashed and compared on every single request; only the round trip to
 * Postgres is amortised, and only for a minute, so revoking an agent by
 * flipping its actor row takes effect inside 60 seconds without a deploy.
 */
export class ActorVerificationCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number = ACTOR_CACHE_MS) {}

  get(key: string, nowMs: number): AuthResult | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    if (nowMs - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.result;
  }

  set(key: string, nowMs: number, result: AuthResult): void {
    this.entries.set(key, { at: nowMs, result });
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface AuthenticateDeps {
  readonly config: TokenConfig;
  readonly gateway: Pick<Gateway, "resolveActor">;
  readonly cache: ActorVerificationCache;
  readonly nowMs: number;
}

export async function authenticate(
  headers: Headers,
  deps: AuthenticateDeps,
): Promise<AuthResult> {
  const token = bearerToken(headers);
  if (token === null) {
    return {
      ok: false,
      failure: {
        reason: "no_token",
        message:
          "this endpoint requires a bearer token: send Authorization: Bearer <token>. See docs/MCP.md.",
      },
    };
  }

  if (deps.config.grants.length === 0) {
    return {
      ok: false,
      failure: {
        reason: "not_configured",
        message:
          "no agent tokens are configured on this deployment, so every call is refused",
      },
    };
  }

  const configured = findGrant(deps.config, token);
  if (configured === null) {
    return {
      ok: false,
      // Deliberately identical wording whether the token is unknown, revoked
      // or merely mistyped. A caller learning WHICH is a probing oracle.
      failure: { reason: "unknown_token", message: "token is not recognised" },
    };
  }

  const cacheKey = configured.tokenDigest.toString("hex");
  const cached = deps.cache.get(cacheKey, deps.nowMs);
  if (cached !== undefined) return cached;

  const actor = await deps.gateway.resolveActor(configured.actorId, configured.businessId);

  const result = verifyActor(configured, actor);
  deps.cache.set(cacheKey, deps.nowMs, result);
  return result;
}

/** The database's verdict on a configured grant. Pure, so it is directly testable. */
export function verifyActor(
  configured: ConfiguredGrant,
  actor: Awaited<ReturnType<Gateway["resolveActor"]>>,
): AuthResult {
  if (actor === null) {
    return {
      ok: false,
      failure: {
        reason: "actor_missing",
        message: `grant "${configured.label}" names an actor or business that does not exist`,
      },
    };
  }

  if (actor.kind !== "agent") {
    // The MCP surface speaks as an agent or it does not speak. Letting a token
    // borrow a human's actor id would put an agent's write into the queue
    // wearing a face that CAN approve, and maker-checker would then be
    // deciding about the wrong principal.
    return {
      ok: false,
      failure: {
        reason: "actor_not_agent",
        message: `grant "${configured.label}" resolves to an actor of kind "${actor.kind}"; the MCP surface may only act as an agent`,
      },
    };
  }

  if (actor.canApprove) {
    // Unreachable while `actor_only_humans_approve` holds — an agent with
    // can_approve is not a representable row. Checked anyway: a constraint
    // dropped by a future migration should turn this surface off, not open it.
    return {
      ok: false,
      failure: {
        reason: "actor_not_agent",
        message: `grant "${configured.label}" resolves to an actor marked can_approve; refusing`,
      },
    };
  }

  if (actor.actorBusinessId !== null && actor.actorBusinessId !== configured.businessId) {
    return {
      ok: false,
      failure: {
        reason: "actor_not_agent",
        message: `grant "${configured.label}" is scoped to a business its actor is not attached to`,
      },
    };
  }

  return {
    ok: true,
    grant: {
      label: configured.label,
      tokenFingerprint: fingerprint(configured.tokenDigest),
      actorId: configured.actorId,
      businessId: configured.businessId,
      businessLegalName: actor.businessLegalName,
      rateLimitPerMinute: configured.rateLimitPerMinute,
      maxInstructionCents: configured.maxInstructionCents,
    },
  };
}
