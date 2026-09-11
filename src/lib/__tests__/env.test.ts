import { describe, expect, it } from "vitest";
import { parseEnv, reportIntegrations, isUsable, EnvironmentError } from "../env.schema";

const MIN = { APP_DATABASE_URL: "postgresql://u:p@h/db" };

describe("environment contract", () => {
  it("boots on APP_DATABASE_URL alone", () => {
    expect(() => parseEnv(MIN)).not.toThrow();
  });

  it("refuses to boot without a database", () => {
    expect(() => parseEnv({})).toThrow(EnvironmentError);
  });

  it("names every offending key at once, not just the first", () => {
    try {
      parseEnv({ APP_DATABASE_URL: "not-a-uri", USDC_SENDER_ADDRESS: "nope" });
      expect.unreachable();
    } catch (e) {
      const err = e as EnvironmentError;
      expect(err.keys).toContain("APP_DATABASE_URL");
      expect(err.keys).toContain("USDC_SENDER_ADDRESS");
    }
  });

  it("REFUSES a live Stripe key — that is an automatic fail for the trial", () => {
    expect(() => parseEnv({ ...MIN, STRIPE_SECRET_KEY: "sk_live_abc123" })).toThrow(
      EnvironmentError,
    );
    expect(() => parseEnv({ ...MIN, STRIPE_SECRET_KEY: "sk_test_abc123" })).not.toThrow();
  });

  it("a missing provider key marks that slot simulated, it does not throw", () => {
    const report = reportIntegrations(parseEnv(MIN));
    const card = report.find((r) => r.slot === "card_issuing");
    expect(card?.status).toBe("simulated");
    expect(card?.missing).toEqual(["LITHIC_API_KEY"]);
  });

  it("a present key marks that slot live", () => {
    const report = reportIntegrations(parseEnv({ ...MIN, LITHIC_API_KEY: "x" }));
    expect(report.find((r) => r.slot === "card_issuing")?.status).toBe("live");
  });

  it("a slot needing several keys stays simulated until all are present", () => {
    const partial = reportIntegrations(parseEnv({ ...MIN, PLAID_CLIENT_ID: "x" }));
    const slot = partial.find((r) => r.slot === "open_banking");
    expect(slot?.status).toBe("simulated");
    expect(slot?.missing).toEqual(["PLAID_SECRET"]);
  });

  it("empty string counts as missing, not as configured", () => {
    const report = reportIntegrations(parseEnv({ ...MIN, LITHIC_API_KEY: "" }));
    expect(report.find((r) => r.slot === "card_issuing")?.status).toBe("simulated");
  });
});

describe("a rejected credential is never reported live", () => {
  it("an sk_live key is refused outright, so no slot can ever be built on one", () => {
    // This used to assert that an `sk_live` key left `business_registry`
    // simulated, because that slot declared `keys: ["STRIPE_SECRET_KEY"]`.
    // Both halves of that were false and were corrected: the registry leg runs
    // on the GLEIF LEI register, which is a public API needing no credential,
    // and the slot's provider string still read "Stripe Connect (gated) —
    // simulated" while its verdict computed `live` — /api/health contradicting
    // itself on one line.
    //
    // The PROPERTY the test existed for is real and survives in a stronger
    // form: a live Stripe key is refused by the schema itself, so it cannot
    // reach a slot at all.
    expect(isUsable("STRIPE_SECRET_KEY", "sk_live_abc123")).toBe(false);
    expect(isUsable("STRIPE_SECRET_KEY", "sk_test_abc123")).toBe(true);

    // And it is not merely unusable — parsing the environment REJECTS it,
    // because this system must never hold a live key at all.
    expect(() =>
      parseEnv({ APP_DATABASE_URL: "postgresql://u:p@h/db", STRIPE_SECRET_KEY: "sk_live_abc123" }),
    ).toThrow();
  });

  it("a slot needing no credential says so, rather than passing as measured", () => {
    // `status` is computed as "nothing is missing", so a slot with no keys
    // reads `live` unconditionally — liveness from the ABSENCE of
    // requirements. GLEIF genuinely is live, but nothing in this file
    // established that; `src/lib/integrations/probe.ts` did, by making a real
    // call, and /api/health is authoritative over both.
    //
    // The flag is what stops a reader mistaking "no credential was required"
    // for "a credential was checked". Two slots have read LIVE by accident in
    // this build already — one from a non-empty key string, one from a changed
    // 400 message falling through an `else`.
    const report = reportIntegrations({ APP_DATABASE_URL: "postgresql://u:p@h/db" });

    const registry = report.find((r) => r.slot === "business_registry");
    expect(registry?.credentialless).toBe(true);
    expect(registry?.missing).toEqual([]);

    const issuing = report.find((r) => r.slot === "card_issuing");
    expect(issuing?.credentialless).toBe(false);
    expect(issuing?.status).toBe("simulated");
    expect(issuing?.missing).toContain("LITHIC_API_KEY");
  });

  it("a malformed private key does not make the stablecoin slot live", () => {
    const report = reportIntegrations({
      APP_DATABASE_URL: "postgresql://u:p@h/db",
      USDC_SENDER_PRIVATE_KEY: "not-a-key",
      USDC_SENDER_ADDRESS: "0xd3629d7399945A1Ff2C5a1c5b0F7C9d32D3c2918",
      BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org",
      USDC_CONTRACT_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    });
    expect(report.find((r) => r.slot === "stablecoin")?.status).toBe("simulated");
  });
});
