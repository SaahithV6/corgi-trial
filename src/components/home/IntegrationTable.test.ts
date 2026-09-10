/**
 * The honest-labelling requirement, asserted where it would be broken.
 *
 * Presenting a simulated integration as live fails the entire trial. These
 * tests pin the asymmetry down: only the exact string `live` may ever produce
 * the label LIVE, and no verdict is rendered without the evidence that earned
 * it.
 */
import { describe, expect, it } from "vitest";

import type { HealthView, IntegrationSlotView, SlotStatus } from "@/lib/home/summary";

import {
  describeEvidence,
  summariseHealth,
  unmetRequirements,
  verdictLabel,
  verdictTone,
} from "./IntegrationTable";

function slot(over: Partial<IntegrationSlotView> = {}): IntegrationSlotView {
  return {
    slot: "card_issuing",
    provider: "Lithic sandbox",
    status: "live",
    liveness: "live",
    evidence: "GET /v1/cards -> 200",
    mustBeLive: true,
    latencyMs: 237,
    ...over,
  };
}

function health(slots: readonly IntegrationSlotView[]): HealthView {
  return {
    status: "ok",
    checkedAt: "2026-09-10T17:41:30.023Z",
    commitShortSha: "3b1d138",
    databaseReachable: true,
    databaseLatencyMs: 182,
    slots,
    liveCount: slots.filter((s) => s.status === "live").length,
    total: slots.length,
  };
}

describe("verdictLabel", () => {
  it("prints LIVE only for a live slot", () => {
    expect(verdictLabel("live")).toBe("LIVE");
    expect(verdictLabel("simulated")).toBe("SIMULATED");
  });

  it("never prints LIVE for a status this build does not recognise", () => {
    // `unknown` is what the parser produces for anything that was not exactly
    // "live" or "simulated". It must not quietly become either one.
    expect(verdictLabel("unknown")).toBe("UNKNOWN");

    const statuses: readonly SlotStatus[] = ["live", "simulated", "unknown"];
    for (const status of statuses) {
      if (status !== "live") expect(verdictLabel(status)).not.toBe("LIVE");
    }
  });

  it("tones an unknown verdict as a problem, not as a pass", () => {
    expect(verdictTone("live")).toBe("positive");
    expect(verdictTone("simulated")).toBe("neutral");
    expect(verdictTone("unknown")).toBe("negative");
  });
});

describe("describeEvidence", () => {
  it("shows the round trip that earned the verdict", () => {
    expect(describeEvidence(slot())).toBe("GET /v1/cards -> 200");
    expect(
      describeEvidence(
        slot({
          slot: "stablecoin",
          status: "simulated",
          evidence: "holds 20.00 USDC but only 0 wei gas; a transfer needs ~390000000000",
        }),
      ),
    ).toContain("0 wei gas");
  });

  it("admits when there is no evidence rather than showing a bare verdict", () => {
    const text = describeEvidence(slot({ evidence: null }));
    expect(text).toContain("no evidence");
    expect(text).not.toBe("");
  });
});

describe("summariseHealth", () => {
  it("counts live slots from the rows the table renders", () => {
    const view = health([
      slot(),
      slot({ slot: "business_registry", status: "simulated", mustBeLive: false }),
      slot({ slot: "stablecoin", status: "simulated", mustBeLive: false }),
    ]);
    expect(summariseHealth(view)).toBe(
      "1 of 3 integration slots are live against a real provider sandbox; 2 are simulated and labelled so.",
    );
  });

  it("does not claim a live slot when every verdict is unknown", () => {
    const view = health([slot({ status: "unknown" }), slot({ slot: "b", status: "unknown" })]);
    expect(summariseHealth(view)).toContain("0 of 2");
  });
});

describe("unmetRequirements", () => {
  it("surfaces a must-be-live slot that is not live", () => {
    const view = health([
      slot(),
      slot({ slot: "director_kyc", status: "simulated", mustBeLive: true }),
      slot({ slot: "stablecoin", status: "simulated", mustBeLive: false }),
    ]);
    expect(unmetRequirements(view).map((s) => s.slot)).toEqual(["director_kyc"]);
  });

  it("is empty when every required slot is live", () => {
    expect(unmetRequirements(health([slot()]))).toHaveLength(0);
  });
});
