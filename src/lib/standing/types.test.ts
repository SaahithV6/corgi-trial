import { describe, expect, it } from "vitest";

import {
  CATCH_UP_WINDOW_DAYS,
  DEFERRABLE_CODES,
  INSUFFICIENT_FUNDS_CODE,
  STALE_AFTER_DAYS,
  STALE_OCCURRENCE_CODE,
  daysBetweenDates,
  decideFreshness,
  decideFunding,
  type AvailabilitySnapshot,
} from "./types";

/**
 * The two decisions that are pure, tested as such.
 *
 * Nothing here touches a database. Exactly-once lives in migration 0012 and is
 * proved against the live one in `standing.integration.test.ts`; these are the
 * rules that decide WHETHER a claimed occurrence pays, and they are arithmetic
 * on `bigint` cents and calendar dates. A wrong answer here is a payment made
 * or refused for the wrong reason, which is worth its own fast test.
 */

function snapshot(
  ledger: bigint,
  holds: bigint,
  uncleared: bigint,
): AvailabilitySnapshot {
  return {
    ledgerCents: ledger,
    holdsCents: holds,
    unclearedCents: uncleared,
    availableCents: ledger - holds - uncleared,
  };
}

describe("decideFunding", () => {
  it("funds when available covers the amount exactly", () => {
    // Exactly equal must FUND, not refuse. An off-by-one here is a rent
    // payment refused on the one day the customer topped the account up to
    // precisely the right figure.
    const decision = decideFunding(400_000n, snapshot(400_000n, 0n, 0n));
    expect(decision.kind).toBe("fund");
  });

  it("refuses one cent short, and says how short", () => {
    const decision = decideFunding(400_000n, snapshot(399_999n, 0n, 0n));
    expect(decision).toMatchObject({
      kind: "refuse",
      code: INSUFFICIENT_FUNDS_CODE,
      shortfallCents: 1n,
    });
  });

  it("REFUSES WHEN THE LEDGER COVERS IT AND AVAILABLE DOES NOT", () => {
    // The whole point of the track. $18,240 on the book, $4,850 committed to
    // card authorisations, $9,500 in a credit that has not cleared. The ledger
    // covers a $4,000 rent payment four times over; the available balance is
    // $110 short, and $110 short is refused.
    const decision = decideFunding(400_000n, snapshot(1_824_000n, 485_000n, 950_000n));

    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    expect(decision.shortfallCents).toBe(11_000n);
    // The reason must name the distinction, because the customer's question is
    // "there was eighteen grand in the account".
    expect(decision.reason).toContain("ledger balance covers this payment");
    expect(decision.reason).toContain("available balance does not");
  });

  it("gives a different reason when the ledger did not cover it either", () => {
    const decision = decideFunding(400_000n, snapshot(100_000n, 0n, 0n));
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    expect(decision.reason).not.toContain("ledger balance covers this payment");
    expect(decision.shortfallCents).toBe(300_000n);
  });

  it("refuses against a negative available balance without clamping it", () => {
    // An over-captured fuel-pump authorisation can settle above the amount
    // authorised, and the honest answer is an overdraft. The shortfall is
    // measured from the real number, not from a cosmetic floor at zero.
    const decision = decideFunding(400_000n, snapshot(10_000n, 60_000n, 0n));
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") return;
    expect(decision.shortfallCents).toBe(450_000n);
  });
});

describe("decideFreshness", () => {
  it("fires on the day", () => {
    expect(decideFreshness("2026-09-10", "2026-09-10").kind).toBe("fresh");
  });

  it("still fires at the catch-up limit", () => {
    const at = decideFreshness("2026-09-05", "2026-09-10");
    expect(daysBetweenDates("2026-09-05", "2026-09-10")).toBe(STALE_AFTER_DAYS);
    expect(at.kind).toBe("fresh");
  });

  it("refuses one day past it, and says how late", () => {
    const decision = decideFreshness("2026-09-04", "2026-09-10");
    expect(decision).toMatchObject({ kind: "refuse", code: STALE_OCCURRENCE_CODE, daysLate: 6 });
  });

  it("treats a future date as fresh rather than as negative lateness", () => {
    // A tick that runs against a book date behind the schedule (a clock skew,
    // a replayed run) must not compute a negative age and then trip some other
    // comparison. Not due yet is fresh.
    expect(decideFreshness("2026-09-20", "2026-09-10").kind).toBe("fresh");
  });

  it("counts calendar days across a DST boundary", () => {
    // US DST ends on 1 November 2026. These are calendar dates, not instants,
    // so the answer is 2 — an hour of wall clock must not become a day of age.
    expect(daysBetweenDates("2026-10-31", "2026-11-02")).toBe(2);
  });

  it("refuses to guess at a malformed date", () => {
    expect(() => daysBetweenDates("31/10/2026", "2026-11-02")).toThrow(TypeError);
  });
});

describe("the windows agree with each other", () => {
  it("looks back further than it will fire", () => {
    // Everything between the two is claimed and recorded as refused rather
    // than left invisible. If the catch-up window were the shorter of the two,
    // an occurrence could age out of the queue without ever becoming a row —
    // which is exactly the failure the requirement names.
    expect(CATCH_UP_WINDOW_DAYS).toBeGreaterThan(STALE_AFTER_DAYS);
  });
});

describe("DEFERRABLE_CODES", () => {
  it("defers the two conditions that are facts about the system", () => {
    expect(DEFERRABLE_CODES.has("POLICY_MISSING")).toBe(true);
    expect(DEFERRABLE_CODES.has("UNAVAILABLE")).toBe(true);
  });

  it("does not defer a refusal that is a fact about the payment", () => {
    // A KYB gate that says no is not transient. Recording it as a refusal is
    // the honest close; deferring it would re-attempt the same refused payment
    // every night for ever.
    expect(DEFERRABLE_CODES.has("KYB_NOT_APPROVED")).toBe(false);
    expect(DEFERRABLE_CODES.has("INVALID_REQUEST")).toBe(false);
    expect(DEFERRABLE_CODES.has(INSUFFICIENT_FUNDS_CODE)).toBe(false);
  });
});
