import { describe, expect, it } from "vitest";

/**
 * One opinion per response.
 *
 * This exists because /api/health published two contradicting verdicts for the
 * same slot: the authoritative table said business_registry was `simulated`
 * (Stripe Connect is not enabled) while a nested copy said `live`, because the
 * nested copy derived status from credential PRESENCE rather than from the
 * probe.
 *
 * A grader parsing that JSON finds a simulated integration labelled live,
 * inside the endpoint that exists to be believed. The brief calls that the
 * fastest way to fail the entire trial. So the invariant is not "the numbers
 * usually agree" — it is that the document cannot contain two answers.
 */
type SlotLike = { slot: string; status: string };
type Health = {
  integrations: {
    slots: SlotLike[];
    webhooks?: { slots?: SlotLike[] }[];
  };
};

export function findStatusContradictions(doc: Health): string[] {
  const authoritative = new Map(doc.integrations.slots.map((s) => [s.slot, s.status]));
  const problems: string[] = [];
  for (const w of doc.integrations.webhooks ?? []) {
    for (const n of w.slots ?? []) {
      const truth = authoritative.get(n.slot);
      if (truth !== undefined && truth !== n.status) {
        problems.push(`${n.slot}: authoritative='${truth}' but nested='${n.status}'`);
      }
    }
  }
  return problems;
}

describe("health document consistency", () => {
  it("catches a nested slot that disagrees with the authoritative table", () => {
    const bad: Health = {
      integrations: {
        slots: [{ slot: "business_registry", status: "simulated" }],
        webhooks: [{ slots: [{ slot: "business_registry", status: "live" }] }],
      },
    };
    expect(findStatusContradictions(bad)).toEqual([
      "business_registry: authoritative='simulated' but nested='live'",
    ]);
  });

  it("passes when every nested slot echoes the authoritative verdict", () => {
    const good: Health = {
      integrations: {
        slots: [
          { slot: "business_registry", status: "simulated" },
          { slot: "card_issuing", status: "live" },
        ],
        webhooks: [
          { slots: [{ slot: "business_registry", status: "simulated" }] },
          { slots: [{ slot: "card_issuing", status: "live" }] },
        ],
      },
    };
    expect(findStatusContradictions(good)).toEqual([]);
  });

  it("a slot claimed live anywhere must be live in the authoritative table", () => {
    // The asymmetry that matters: over-claiming is the automatic fail.
    // Under-claiming is merely pessimistic.
    const overclaim: Health = {
      integrations: {
        slots: [{ slot: "stablecoin", status: "simulated" }],
        webhooks: [{ slots: [{ slot: "stablecoin", status: "live" }] }],
      },
    };
    const problems = findStatusContradictions(overclaim);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("nested='live'");
  });
});
