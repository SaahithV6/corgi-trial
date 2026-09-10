import { describe, expect, it } from "vitest";

import { RateLimiter, clientKey } from "./ratelimit";

describe("RateLimiter", () => {
  it("allows exactly the capacity in a burst, then refuses", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.check("k", 5, 0).allowed).toBe(true);
    }
    const refused = limiter.check("k", 5, 0);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("refills continuously rather than in a fixed window", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 60; i += 1) limiter.check("k", 60, 0);
    expect(limiter.check("k", 60, 0).allowed).toBe(false);

    // One token per second at 60/minute.
    expect(limiter.check("k", 60, 1_000).allowed).toBe(true);
    expect(limiter.check("k", 60, 1_000).allowed).toBe(false);
    expect(limiter.check("k", 60, 3_000).allowed).toBe(true);
  });

  it("never refills past the capacity, so an idle hour is not a 3600-call burst", () => {
    const limiter = new RateLimiter();
    limiter.check("k", 10, 0);
    for (let i = 0; i < 10; i += 1) {
      expect(limiter.check("k", 10, 3_600_000).allowed).toBe(true);
    }
    expect(limiter.check("k", 10, 3_600_000).allowed).toBe(false);
  });

  it("keeps separate buckets per key", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 3; i += 1) limiter.check("a", 3, 0);
    expect(limiter.check("a", 3, 0).allowed).toBe(false);
    expect(limiter.check("b", 3, 0).allowed).toBe(true);
  });

  it("never returns Retry-After 0 on a refusal", () => {
    const limiter = new RateLimiter();
    limiter.check("k", 1, 0);
    const refused = limiter.check("k", 1, 0);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("evicts idle buckets so the map cannot grow without bound", () => {
    const limiter = new RateLimiter();
    limiter.check("old", 5, 0);
    expect(limiter.size()).toBe(1);
    limiter.check("new", 5, 60 * 60_000);
    expect(limiter.size()).toBe(1);
  });
});

describe("clientKey", () => {
  it("prefers the header the edge writes over the one a client can forge", () => {
    expect(
      clientKey(new Headers({ "x-real-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" })),
    ).toBe("1.2.3.4");
  });

  it("falls back to the first forwarded hop, then to a constant", () => {
    expect(clientKey(new Headers({ "x-forwarded-for": "5.6.7.8, 9.9.9.9" }))).toBe("5.6.7.8");
    expect(clientKey(new Headers())).toBe("unknown");
  });
});
