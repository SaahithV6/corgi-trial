import { describe, expect, it } from "vitest";

import { listCardControlsTool } from "./tool-list-card-controls";
import { BUSINESS_A, defaultState, fakeGateway, testContext } from "./testing";
import { ToolError } from "./types";

function ctx() {
  const { gateway } = fakeGateway(defaultState());
  return testContext({ gateway });
}

async function call(args: Record<string, unknown> = {}) {
  return listCardControlsTool.run(listCardControlsTool.parse(args) as never, ctx());
}

function cards(outcome: { data: Record<string, unknown> }) {
  return outcome.data["cards"] as Record<string, unknown>[];
}

function decisions(outcome: { data: Record<string, unknown> }) {
  return outcome.data["recent_decisions"] as Record<string, unknown>[];
}

describe("list_card_controls", () => {
  it("returns each card's controls with the money as cent strings", async () => {
    const [card] = cards(await call());
    const controls = card?.["controls"] as Record<string, unknown>;
    expect(controls["card_state"]).toBe("active");
    expect(controls["per_transaction_limit"]).toMatchObject({ cents: "50000" });
    expect(controls["daily_limit"]).toMatchObject({ cents: "100000" });
    expect(controls["monthly_limit"]).toBeNull();
    expect(controls["version"]).toBe(3);
  });

  it("labels a blocked merchant category instead of printing a bare number", async () => {
    const [card] = cards(await call());
    const blocked = (card?.["controls"] as Record<string, unknown>)["blocked_mccs"] as Record<
      string,
      unknown
    >[];
    expect(blocked[0]?.["mcc"]).toBe("5542");
    expect(String(blocked[0]?.["label"]).toLowerCase()).toContain("fuel");
  });

  it("distinguishes a card with no controls from a card with no limits", async () => {
    const [, unconfigured] = cards(await call());
    expect(unconfigured?.["controls"]).toBeNull();
    expect(unconfigured?.["headroom_today"]).toBeNull();
    expect((await call()).data["counts"]).toMatchObject({ without_controls: 1 });
  });

  it("computes headroom against the approved spend, not the ledger", async () => {
    const [card] = cards(await call());
    // $1,000.00 daily limit less $73.40 already approved today.
    expect(card?.["headroom_today"]).toMatchObject({ cents: "92660" });
    expect(card?.["spend_today"]).toMatchObject({ cents: "7340" });
  });

  it("explains a decline with the rule that fired and the network result", async () => {
    const declined = decisions(await call({ declines_only: true }));
    expect(declined).toHaveLength(1);
    expect(declined[0]?.["rule"]).toBe("mcc_blocked");
    expect(declined[0]?.["result_code"]).toBe("UNAUTHORIZED_MERCHANT");
    expect(declined[0]?.["merchant_category"]).toBeTruthy();
    expect(declined[0]?.["control_version"]).toBe(3);
  });

  it("puts the decline into the summary, because that is the question", async () => {
    const outcome = await call();
    expect(outcome.summary).toMatch(/most recent decline/);
    expect(outcome.summary).toMatch(/mcc_blocked/);
  });

  it("reports latency in milliseconds, as an integer", async () => {
    const [first] = decisions(await call());
    expect(first?.["decision_latency_ms"]).toBe(41);
    expect(Number.isInteger(first?.["decision_latency_ms"])).toBe(true);
  });

  it("never returns a provider card or authorisation token", async () => {
    const rendered = JSON.stringify((await call()).data);
    expect(rendered).not.toMatch(/provider_card_token/);
    expect(rendered).not.toMatch(/provider_auth_token/);
    expect(rendered).not.toMatch(/card_[A-Za-z0-9]{10,}/);
  });

  it("can be asked for the controls alone", async () => {
    expect(decisions(await call({ decision_limit: 0 }))).toHaveLength(0);
    expect(cards(await call({ decision_limit: 0 }))).toHaveLength(2);
  });

  it("says a control change is an authorisation decision and not on this surface", async () => {
    expect((await call()).data["note"]).toMatch(/real-time authorisation decision made in advance/);
    expect(listCardControlsTool.description).toMatch(/cannot change a limit/i);
  });

  it("refuses to take a business or card identifier from its caller", () => {
    expect(() => listCardControlsTool.parse({ business_id: BUSINESS_A })).toThrow(ToolError);
    expect(() => listCardControlsTool.parse({ card_id: "x" })).toThrow(ToolError);
  });
});
