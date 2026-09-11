import { describe, expect, it } from "vitest";

import {
  CONTROL_READ_BUDGET_MS,
  DECISION_APPEND_BUDGET_MS,
  DeadlineExceededError,
  HANDLER_BUDGET_MS,
  PROVIDER_RECOMMENDED_MS,
  PROVIDER_TIMEOUT_MS,
  SECRET_FETCH_BUDGET_MS,
  stopwatch,
  withDeadline,
} from "./budget";

describe("the budget fits inside the provider's timeout", () => {
  it("adds up to less than Lithic's recommended ceiling", () => {
    // This is the assertion that fails the build if someone raises a deadline
    // without doing the arithmetic. Lithic recommend 3000 ms; being slow is
    // not "degraded", it is a declined card.
    expect(HANDLER_BUDGET_MS).toBe(
      SECRET_FETCH_BUDGET_MS + CONTROL_READ_BUDGET_MS + DECISION_APPEND_BUDGET_MS,
    );
    expect(HANDLER_BUDGET_MS).toBeLessThan(PROVIDER_RECOMMENDED_MS);
  });

  it("leaves the provider's hard timeout a wide margin", () => {
    expect(PROVIDER_TIMEOUT_MS).toBe(6_000);
    expect(HANDLER_BUDGET_MS * 2).toBeLessThan(PROVIDER_TIMEOUT_MS);
  });

  it("keeps the fail-closed deadline far above a healthy round trip", () => {
    // 600 ms is deliberately generous. The branch it arms declines the card,
    // so it must fire on an outage and never on load.
    expect(CONTROL_READ_BUDGET_MS).toBeGreaterThanOrEqual(500);
  });
});

describe("withDeadline", () => {
  it("returns the value when the work finishes in time", async () => {
    await expect(withDeadline(Promise.resolve("ok"), 50, "test")).resolves.toBe("ok");
  });

  it("rejects with a named DeadlineExceededError when it does not", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 200));
    await expect(withDeadline(slow, 10, "control read")).rejects.toBeInstanceOf(
      DeadlineExceededError,
    );
  });

  it("names the step and the budget in the message, for the decision record", async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 200));
    await expect(withDeadline(slow, 10, "control read")).rejects.toThrow(
      "control read exceeded its 10 ms budget",
    );
  });

  it("propagates a genuine rejection rather than reporting it as a timeout", async () => {
    const boom = Promise.reject(new Error("connection refused"));
    await expect(withDeadline(boom, 1_000, "control read")).rejects.toThrow("connection refused");
  });

  it("does not hold the event loop open after a fast path", async () => {
    // The timer is cleared in `finally`. In a serverless function an uncleared
    // timer can keep an instance from being frozen between invocations, which
    // is a cost paid on every single authorisation.
    const started = Date.now();
    await withDeadline(Promise.resolve(1), 5_000, "test");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("stopwatch", () => {
  it("measures in microseconds", async () => {
    const stop = stopwatch();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const us = stop();
    expect(us).toBeGreaterThan(10_000);
    expect(Number.isInteger(us)).toBe(true);
  });

  it("never returns a negative reading", () => {
    expect(stopwatch()()).toBeGreaterThanOrEqual(0);
  });
});
