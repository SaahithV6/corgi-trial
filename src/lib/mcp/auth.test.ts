import { describe, expect, it } from "vitest";

import {
  ActorVerificationCache,
  authenticate,
  bearerToken,
  findGrant,
  parseTokenConfig,
  sha256,
  verifyActor,
  type ConfiguredGrant,
} from "./auth";
import { AGENT_ACTOR, BUSINESS_A, BUSINESS_B, HUMAN_APPROVER, SYSTEM_ACTOR, fakeGateway } from "./testing";

const TOKEN = "corgi_mcp_test_0123456789abcdef0123";

function configJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      label: "ridgeline-agent",
      token: TOKEN,
      actorId: AGENT_ACTOR,
      businessId: BUSINESS_A,
      ...overrides,
    },
  ]);
}

describe("parseTokenConfig", () => {
  it("fails closed when the variable is absent", () => {
    const config = parseTokenConfig(undefined);
    expect(config.grants).toHaveLength(0);
    expect(config.problems[0]).toContain("MCP_AGENT_TOKENS is not set");
  });

  it("fails closed on invalid JSON rather than throwing", () => {
    const config = parseTokenConfig("{oops");
    expect(config.grants).toHaveLength(0);
    expect(config.problems).toHaveLength(1);
  });

  it("fails closed on a grant that names neither token nor tokenSha256", () => {
    const config = parseTokenConfig(
      JSON.stringify([{ label: "x", actorId: AGENT_ACTOR, businessId: BUSINESS_A }]),
    );
    expect(config.grants).toHaveLength(0);
  });

  it("refuses a grant with both token and tokenSha256", () => {
    const config = parseTokenConfig(
      configJson({ tokenSha256: sha256(TOKEN).toString("hex") }),
    );
    expect(config.grants).toHaveLength(0);
  });

  it("accepts a hashed token so the environment need not hold the secret", () => {
    const config = parseTokenConfig(
      JSON.stringify([
        {
          label: "hashed",
          tokenSha256: sha256(TOKEN).toString("hex"),
          actorId: AGENT_ACTOR,
          businessId: BUSINESS_A,
        },
      ]),
    );
    expect(config.grants).toHaveLength(1);
    expect(findGrant(config, TOKEN)?.label).toBe("hashed");
  });

  it("drops BOTH grants when two share a secret", () => {
    // Otherwise which business a call is scoped to would depend on array order.
    const config = parseTokenConfig(
      JSON.stringify([
        { label: "a", token: TOKEN, actorId: AGENT_ACTOR, businessId: BUSINESS_A },
        { label: "b", token: TOKEN, actorId: AGENT_ACTOR, businessId: BUSINESS_B },
      ]),
    );
    expect(config.grants).toHaveLength(0);
    expect(config.problems[0]).toContain("duplicate token");
  });

  it("carries the per-token ceiling as a bigint", () => {
    const config = parseTokenConfig(configJson({ maxInstructionCents: "500000" }));
    expect(config.grants[0]?.maxInstructionCents).toBe(500000n);
  });

  it("defaults the rate limit and the absent ceiling", () => {
    const config = parseTokenConfig(configJson());
    expect(config.grants[0]?.rateLimitPerMinute).toBe(60);
    expect(config.grants[0]?.maxInstructionCents).toBeNull();
  });
});

describe("bearerToken", () => {
  it("reads a bearer token case-insensitively", () => {
    expect(bearerToken(new Headers({ authorization: `bearer ${TOKEN}` }))).toBe(TOKEN);
    expect(bearerToken(new Headers({ authorization: `Bearer   ${TOKEN}` }))).toBe(TOKEN);
  });

  it("returns null for anything else", () => {
    expect(bearerToken(new Headers())).toBeNull();
    expect(bearerToken(new Headers({ authorization: "Basic abc" }))).toBeNull();
    expect(bearerToken(new Headers({ authorization: "Bearer " }))).toBeNull();
  });
});

describe("findGrant", () => {
  it("matches the right grant and rejects a near miss", () => {
    const config = parseTokenConfig(configJson());
    expect(findGrant(config, TOKEN)?.label).toBe("ridgeline-agent");
    expect(findGrant(config, `${TOKEN}x`)).toBeNull();
    expect(findGrant(config, TOKEN.slice(0, -1))).toBeNull();
  });
});

describe("verifyActor", () => {
  const configured: ConfiguredGrant = {
    label: "g",
    tokenDigest: sha256(TOKEN),
    actorId: AGENT_ACTOR,
    businessId: BUSINESS_A,
    rateLimitPerMinute: 60,
    maxInstructionCents: null,
  };

  it("accepts an agent actor with no business pin", () => {
    const result = verifyActor(configured, {
      actorId: AGENT_ACTOR,
      kind: "agent",
      displayName: "Corgi payments agent",
      canApprove: false,
      actorBusinessId: null,
      businessLegalName: "Ridgeline Robotics, Inc.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.grant.businessId).toBe(BUSINESS_A);
    expect(result.grant.businessLegalName).toBe("Ridgeline Robotics, Inc.");
  });

  it("refuses a HUMAN actor — the surface may only speak as an agent", () => {
    const result = verifyActor(configured, {
      actorId: HUMAN_APPROVER,
      kind: "human",
      displayName: "Alex Whitfield",
      canApprove: true,
      actorBusinessId: BUSINESS_A,
      businessLegalName: "Ridgeline Robotics, Inc.",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("actor_not_agent");
  });

  it("refuses a SYSTEM actor", () => {
    const result = verifyActor(configured, {
      actorId: SYSTEM_ACTOR,
      kind: "system",
      displayName: "ledger-poster",
      canApprove: false,
      actorBusinessId: null,
      businessLegalName: "Ridgeline Robotics, Inc.",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses an agent flagged can_approve, even though the schema forbids the row", () => {
    // Unreachable while actor_only_humans_approve holds. Checked so that a
    // constraint dropped by a future migration turns this surface OFF.
    const result = verifyActor(configured, {
      actorId: AGENT_ACTOR,
      kind: "agent",
      displayName: "Corgi payments agent",
      canApprove: true,
      actorBusinessId: null,
      businessLegalName: "Ridgeline Robotics, Inc.",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toContain("can_approve");
  });

  it("refuses an actor pinned to a different business than the grant", () => {
    const result = verifyActor(configured, {
      actorId: AGENT_ACTOR,
      kind: "agent",
      displayName: "Corgi payments agent",
      canApprove: false,
      actorBusinessId: BUSINESS_B,
      businessLegalName: "Ridgeline Robotics, Inc.",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses when the actor or business row does not exist", () => {
    const result = verifyActor(configured, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("actor_missing");
  });
});

describe("authenticate", () => {
  const { gateway } = fakeGateway();

  it("refuses with no_token when the header is absent", async () => {
    const result = await authenticate(new Headers(), {
      config: parseTokenConfig(configJson()),
      gateway,
      cache: new ActorVerificationCache(),
      nowMs: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("no_token");
  });

  it("refuses every token when nothing is configured", async () => {
    const result = await authenticate(new Headers({ authorization: `Bearer ${TOKEN}` }), {
      config: parseTokenConfig(undefined),
      gateway,
      cache: new ActorVerificationCache(),
      nowMs: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("not_configured");
  });

  it("gives the same message for unknown and revoked tokens", async () => {
    const result = await authenticate(new Headers({ authorization: "Bearer wrong-token-value-x" }), {
      config: parseTokenConfig(configJson()),
      gateway,
      cache: new ActorVerificationCache(),
      nowMs: 0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toBe("token is not recognised");
  });

  it("resolves a grant and caches the actor verification", async () => {
    let calls = 0;
    const counting = {
      async resolveActor(actorId: string, businessId: string) {
        calls += 1;
        return gateway.resolveActor(actorId, businessId);
      },
    };
    const cache = new ActorVerificationCache(60_000);
    const headers = new Headers({ authorization: `Bearer ${TOKEN}` });
    const deps = { config: parseTokenConfig(configJson()), gateway: counting, cache, nowMs: 0 };

    const first = await authenticate(headers, deps);
    const second = await authenticate(headers, { ...deps, nowMs: 30_000 });
    expect(first.ok && second.ok).toBe(true);
    expect(calls).toBe(1);

    // Past the TTL the database gets the last word again, so revoking an
    // agent by editing its actor row takes effect without a deploy.
    await authenticate(headers, { ...deps, nowMs: 61_000 });
    expect(calls).toBe(2);
  });
});
