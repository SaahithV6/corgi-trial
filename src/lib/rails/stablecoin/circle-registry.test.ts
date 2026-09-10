/**
 * Selection: explicit, visible, and never a silent fallback.
 */
import { describe, expect, it } from "vitest";

import { describeSelection, PROVIDER_ENV_KEY, providerLabel, selectStablecoinProvider, stablecoinProviderHealth } from "./circle-registry";
import { BaseRpc } from "./client";
import type { EnvSource } from "./circle-config";

// The EIP-155 example key. Published in the EIP; holds nothing anywhere.
const KEY = "0x4646464646464646464646464646464646464646464646464646464646464646";
const CIRCLE_ENV: EnvSource = {
  USDC_SENDER_PRIVATE_KEY: KEY,
  CIRCLE_API_KEY: "TEST_API_KEY:key:secret",
  CIRCLE_ENTITY_SECRET: "0".repeat(64),
};

const rpc = new BaseRpc({
  url: "https://node.example",
  fetchImpl: () => Promise.reject(new Error("no network in this test")),
});

describe("selectStablecoinProvider", () => {
  it("defaults to the direct rail when nothing is asked for", () => {
    const selection = selectStablecoinProvider({ rpc, env: { USDC_SENDER_PRIVATE_KEY: KEY } });
    expect(selection.provider.id).toBe("base.usdc");
    expect(selection.reason).toMatch(/unset/);
  });

  it("picks Circle when asked, and says why", () => {
    const selection = selectStablecoinProvider({ rpc, env: { ...CIRCLE_ENV, [PROVIDER_ENV_KEY]: "circle" } });
    expect(selection.provider.id).toBe("circle.w3s");
    expect(selection.requested).toBe("circle.w3s");
    expect(selection.reason).toMatch(/TEST_API_KEY credential is present/);
  });

  it("is case- and whitespace-tolerant about the value, and nothing else", () => {
    const selection = selectStablecoinProvider({ rpc, env: { ...CIRCLE_ENV, [PROVIDER_ENV_KEY]: "  CIRCLE " } });
    expect(selection.provider.id).toBe("circle.w3s");
  });

  it("DOES NOT fall back to the direct rail when Circle is asked for and absent", async () => {
    const selection = selectStablecoinProvider({
      rpc,
      env: { USDC_SENDER_PRIVATE_KEY: KEY, [PROVIDER_ENV_KEY]: "circle" },
    });
    // Still Circle. Still the caller's choice. It simply cannot pay.
    expect(selection.provider.id).toBe("circle.w3s");
    expect(selection.reason).toMatch(/not wired/);

    const health = await selection.provider.health();
    expect(health.liveness).toBe("not_configured");

    const outcome = await selection.provider.send({
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      fromAddress: "0xeaa8ce10abcbce9d7f5257126c36a078c9951e1c",
      toAddress: "0x000000000000000000000000000000000000dead",
      amountUnits: 100_000n,
      chainId: 84532n,
    });
    expect(outcome.kind === "refused" && outcome.reason).toBe("provider_not_configured");
    expect(outcome.provider).toBe("circle.w3s");
  });

  it("does not accept a typo as a provider — it falls to the default and says so", () => {
    const selection = selectStablecoinProvider({ rpc, env: { USDC_SENDER_PRIVATE_KEY: KEY, [PROVIDER_ENV_KEY]: "circl" } });
    expect(selection.provider.id).toBe("base.usdc");
    expect(selection.reason).toMatch(/is not a provider/);
  });

  it("refuses to build the direct rail with no signing key rather than pretending", () => {
    expect(() => selectStablecoinProvider({ rpc, env: {} })).toThrow(/USDC_SENDER_PRIVATE_KEY/);
  });

  it("describes itself in one line naming the rail", () => {
    const selection = selectStablecoinProvider({ rpc, env: { ...CIRCLE_ENV, [PROVIDER_ENV_KEY]: "circle" } });
    expect(describeSelection(selection)).toMatch(/^circle\.w3s — Circle Web3 Services/);
  });
});

describe("providerLabel", () => {
  it("gives every slug a human name, so no surface has to print a slug alone", () => {
    expect(providerLabel("base.usdc")).toBe("Base Sepolia, signed here");
    expect(providerLabel("circle.w3s")).toBe("Circle Web3 Services, Base Sepolia");
  });
});

describe("stablecoinProviderHealth", () => {
  it("reports BOTH rails, and one missing key cannot take the surface down", async () => {
    // No signing key, no Circle key, and an RPC that refuses to answer.
    const health = await stablecoinProviderHealth({ rpc, env: {} });
    expect(health.map((h) => h.provider)).toEqual(["base.usdc", "circle.w3s"]);
    expect(health[0]?.liveness).toBe("not_configured");
    expect(health[1]?.liveness).toBe("not_configured");
    for (const row of health) expect(row.label.length).toBeGreaterThan(0);
  });

  it("reports the direct rail as unreachable — never live — when the node will not answer", async () => {
    const health = await stablecoinProviderHealth({ rpc, env: { USDC_SENDER_PRIVATE_KEY: KEY } });
    expect(health[0]?.liveness).toBe("unreachable");
    expect(health[0]?.liveness).not.toBe("live");
  });
});
