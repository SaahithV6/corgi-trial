/**
 * Configuration: the absence is an answer, and a live key is a refusal.
 */
import { describe, expect, it } from "vitest";

import { CIRCLE_BASE_URL, describeCircleConfig, readCircleConfig } from "./circle-config";

const SECRET = "a".repeat(64);
const KEY = "TEST_API_KEY:abc:def";

describe("readCircleConfig", () => {
  it("reports what is missing rather than throwing", () => {
    const result = readCircleConfig({});
    expect(result.configured).toBe(false);
    if (result.configured) throw new Error("unreachable");
    expect(result.missing).toEqual(["CIRCLE_API_KEY", "CIRCLE_ENTITY_SECRET"]);
  });

  it("says out loud that the direct rail is not a substitute", () => {
    const result = readCircleConfig({});
    if (result.configured) throw new Error("unreachable");
    expect(result.detail).toMatch(/direct-to-chain rail is NOT a substitute/);
  });

  it("treats a blank value as absent — the DECISIONS 011 blank-value rule", () => {
    const result = readCircleConfig({ CIRCLE_API_KEY: "   ", CIRCLE_ENTITY_SECRET: SECRET });
    expect(result.configured).toBe(false);
    if (result.configured) throw new Error("unreachable");
    expect(result.missing).toEqual(["CIRCLE_API_KEY"]);
  });

  it("REFUSES a live-mode key, which is an automatic fail on this trial", () => {
    const result = readCircleConfig({ CIRCLE_API_KEY: "LIVE_API_KEY:abc:def", CIRCLE_ENTITY_SECRET: SECRET });
    expect(result.configured).toBe(false);
    if (result.configured) throw new Error("unreachable");
    expect(result.detail).toMatch(/live-mode key/);
    // Nothing to "just set" — this is a refusal, not a gap.
    expect(result.missing).toEqual([]);
  });

  it("refuses a key with no recognisable prefix at all", () => {
    const result = readCircleConfig({ CIRCLE_API_KEY: "sk_test_whatever", CIRCLE_ENTITY_SECRET: SECRET });
    expect(result.configured).toBe(false);
  });

  it("refuses an entity secret that is not 32 bytes of hex", () => {
    for (const bad of ["deadbeef", "z".repeat(64), `${SECRET}00`]) {
      const result = readCircleConfig({ CIRCLE_API_KEY: KEY, CIRCLE_ENTITY_SECRET: bad });
      expect(result.configured).toBe(false);
      if (result.configured) throw new Error("unreachable");
      expect(result.detail).toMatch(/64 hex characters/);
    }
  });

  it("accepts a sandbox key and defaults the optional pins to null", () => {
    const result = readCircleConfig({ CIRCLE_API_KEY: KEY, CIRCLE_ENTITY_SECRET: SECRET });
    expect(result.configured).toBe(true);
    if (!result.configured) throw new Error("unreachable");
    expect(result.config.baseUrl).toBe(CIRCLE_BASE_URL);
    expect(result.config.walletSetId).toBeNull();
    expect(result.config.walletId).toBeNull();
    expect(result.config.tokenId).toBeNull();
  });

  it("carries the pins when they are set", () => {
    const result = readCircleConfig({
      CIRCLE_API_KEY: KEY,
      CIRCLE_ENTITY_SECRET: SECRET,
      CIRCLE_WALLET_SET_ID: "9882bf06-4831-5bad-a1d4-606b80f944e0",
      CIRCLE_WALLET_ID: "9a3524c0-728c-554f-8d26-a19c6ee66a4a",
      CIRCLE_TOKEN_ID: "5797fbd6-3795-519d-84ca-ec4c5f80c3b1",
    });
    if (!result.configured) throw new Error("unreachable");
    expect(result.config.walletId).toBe("9a3524c0-728c-554f-8d26-a19c6ee66a4a");
  });
});

describe("describeCircleConfig", () => {
  it("never prints the credential", () => {
    const result = readCircleConfig({ CIRCLE_API_KEY: KEY, CIRCLE_ENTITY_SECRET: SECRET });
    const described = describeCircleConfig(result);
    expect(described).not.toContain("abc");
    expect(described).not.toContain(SECRET);
    expect(described).toContain("TEST_API_KEY (testnet)");
  });

  it("describes the absence with the reason for it", () => {
    expect(describeCircleConfig(readCircleConfig({}))).toMatch(/not wired/);
  });
});
