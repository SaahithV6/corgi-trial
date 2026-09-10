import { describe, expect, it, vi, afterEach } from "vitest";

import { readProviderHealth } from "./provider-health";

/**
 * The banner's job is to render the health endpoint's verdict, never to invent
 * one. These tests pin the distinction that matters: "we have no freshness
 * data" and "the feeds are healthy" are different answers, and collapsing them
 * is how an outage hides behind a green banner.
 */
function mockHealth(body: unknown, ok = true) {
  vi.stubGlobal("fetch", async () => ({
    ok,
    status: ok ? 200 : 503,
    json: async () => body,
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe("provider health banner state", () => {
  it("reports UNKNOWN when the endpoint publishes no freshness field", async () => {
    // Not "healthy". Inventing health from an absence is the same mistake as
    // marking a slot live because a key exists.
    mockHealth({ integrations: { slots: [{ slot: "card_issuing", status: "live" }] } });
    const s = await readProviderHealth("http://x");
    expect(s.kind).toBe("unknown");
  });

  it("reports HEALTHY only when freshness exists and nothing is stale", async () => {
    mockHealth({
      integrations: { webhookHealth: [{ provider: "lithic", feedStale: false }] },
    });
    expect((await readProviderHealth("http://x")).kind).toBe("healthy");
  });

  it("reports DEGRADED and names the provider when a feed is stale", async () => {
    mockHealth({
      integrations: {
        webhookHealth: [
          { provider: "lithic", feedStale: true, secondsSinceLastDelivery: 420 },
          { provider: "plaid", feedStale: false },
        ],
      },
    });
    const s = await readProviderHealth("http://x");
    expect(s.kind).toBe("degraded");
    if (s.kind !== "degraded") return;
    expect(s.providers).toHaveLength(1);
    expect(s.providers[0]?.provider).toBe("lithic");
    expect(s.providers[0]?.detail).toContain("7 minutes");
  });

  it("treats a verdict string as authoritative too", async () => {
    mockHealth({ webhookHealth: { lithic: { verdict: "stale" } } });
    expect((await readProviderHealth("http://x")).kind).toBe("degraded");
  });

  it("reports UNREACHABLE, not healthy, when the endpoint is down", async () => {
    mockHealth({}, false);
    expect((await readProviderHealth("http://x")).kind).toBe("unreachable");
  });

  it("never reports healthy on a thrown fetch", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    const s = await readProviderHealth("http://x");
    expect(s.kind).toBe("unreachable");
  });
});

describe("the real endpoint shape", () => {
  it("reads the providers array out of the wrapper, not the wrapper's own keys", async () => {
    // The deployed shape. Treating the wrapper as a provider map yields
    // providers called "source" and "measuredAt" — neither ever stale — so
    // the banner reported healthy for a reason unrelated to any provider.
    mockHealth({
      integrations: {
        webhookHealth: {
          source: "webhook_inbox.received_at",
          measuredAt: "2026-09-10T19:00:00Z",
          measured: true,
          providers: [
            { provider: "lithic", verdict: "stale", secondsSinceLastDelivery: 300 },
            { provider: "increase", verdict: "never" },
          ],
        },
      },
    });
    const s = await readProviderHealth("http://x");
    expect(s.kind).toBe("degraded");
    if (s.kind !== "degraded") return;
    expect(s.providers.map((p) => p.provider)).toEqual(["lithic"]);
  });

  it("a 'never' verdict is not an outage — it has simply never delivered", async () => {
    mockHealth({
      integrations: {
        webhookHealth: { providers: [{ provider: "stripe", verdict: "never" }] },
      },
    });
    expect((await readProviderHealth("http://x")).kind).toBe("healthy");
  });

  it("'quiet' is not an outage either — that is the deliberate middle band", async () => {
    mockHealth({
      integrations: {
        webhookHealth: {
          providers: [{ provider: "lithic", verdict: "quiet", secondsSinceLastDelivery: 1732 }],
        },
      },
    });
    expect((await readProviderHealth("http://x")).kind).toBe("healthy");
  });
});
