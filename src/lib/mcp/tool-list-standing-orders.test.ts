import { describe, expect, it } from "vitest";

import { listStandingOrdersTool } from "./tool-list-standing-orders";
import { BUSINESS_A, defaultState, defaultStanding, fakeGateway, testContext } from "./testing";
import { ToolError, type StandingOrderPage } from "./types";

function ctx(page?: StandingOrderPage) {
  const state = defaultState();
  if (page !== undefined) state.standing.set(BUSINESS_A, page);
  const { gateway } = fakeGateway(state);
  return testContext({ gateway });
}

async function call(args: Record<string, unknown> = {}, context = ctx()) {
  return listStandingOrdersTool.run(listStandingOrdersTool.parse(args) as never, context);
}

function mandates(outcome: { data: Record<string, unknown> }) {
  return outcome.data["mandates"] as Record<string, unknown>[];
}

describe("list_standing_orders", () => {
  it("returns the mandate with its schedule and its next due date", async () => {
    const [rent] = mandates(await call());
    expect(rent?.["reference"]).toBe("Rent — Unit 4, Ridgeline Works");
    expect(rent?.["amount"]).toMatchObject({ cents: "400000", display: "$4,000.00" });
    expect(rent?.["schedule"]).toMatch(/monthly on the 1st/);
    expect(rent?.["next_due_date"]).toBe("2026-10-01");
    expect(rent?.["days_until_next"]).toBe(21);
  });

  it("counts an overdue unclaimed date as negative rather than as today", async () => {
    // Clamping this to zero would tell an agent that an occurrence nobody has
    // claimed is due today, which is the one answer that sounds fine.
    const page = defaultStanding();
    const [rent, ...rest] = page.orders;
    if (rent === undefined) throw new Error("fixture");
    const context = ctx({
      orders: [{ ...rent, nextDueDate: "2026-09-08" }, ...rest],
      occurrences: page.occurrences,
    });
    const outcome = await call({}, context);
    expect(mandates(outcome)[0]?.["days_until_next"]).toBe(-2);
    expect(outcome.summary).toMatch(/not yet claimed/);
  });

  it("carries a refusal with its code and the four figures it was judged on", async () => {
    const [rent] = mandates(await call());
    const occurrences = rent?.["recent_occurrences"] as Record<string, unknown>[];
    const refused = occurrences.find((o) => o["disposition"] === "refused");
    expect(refused?.["refusal_code"]).toBe("INSUFFICIENT_AVAILABLE_FUNDS");
    expect(refused?.["shortfall"]).toMatchObject({ cents: "16260" });
    expect(refused?.["observed"]).toMatchObject({
      ledger_balance: { cents: "450000" },
      available_balance: { cents: "383740" },
    });
    // The interesting refusal: the ledger covered it and available did not.
    expect(String(refused?.["refusal_reason"])).toMatch(/available balance does not/);
  });

  it("carries the derived idempotency key that makes a retry safe", async () => {
    const [rent] = mandates(await call());
    const occurrences = rent?.["recent_occurrences"] as Record<string, unknown>[];
    expect(String(occurrences[0]?.["idempotency_key"])).toMatch(/^standing:[0-9a-f-]+:\d{4}-\d{2}-\d{2}$/);
  });

  it("hides cancelled mandates by default and can show them", async () => {
    expect(mandates(await call())).toHaveLength(1);
    const withCancelled = mandates(await call({ include_cancelled: true }));
    expect(withCancelled).toHaveLength(2);
    expect(withCancelled[1]?.["cancellation_reason"]).toMatch(/short-month rule/);
  });

  it("answers the why-didn't-it-go-out question directly", async () => {
    const outcome = await call({ refused_only: true });
    const [rent] = mandates(outcome);
    const occurrences = rent?.["recent_occurrences"] as Record<string, unknown>[];
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.["disposition"]).toBe("refused");
    expect((outcome.data["counts"] as Record<string, number>)["refused_shown"]).toBe(1);
  });

  it("counts every occurrence even when it shows few", async () => {
    const [rent] = mandates(await call({ occurrences_per_order: 0 }));
    expect(rent?.["recent_occurrences"]).toHaveLength(0);
    expect(rent?.["occurrence_counts"]).toMatchObject({ raised: 1, refused: 1, undecided: 0 });
  });

  it("describes the destination without a full account number", async () => {
    const [rent] = mandates(await call());
    expect(rent?.["destination_summary"]).toBe(
      "Ridgeline Works Property LLC · ACH 021000021 ••8812 (checking)",
    );
  });

  it("returns the destination in the shape initiate_payment accepts", async () => {
    // An agent that reads a mandate and drafts a one-off replacement should be
    // able to copy this object across. The stored column is camelCase; a tool
    // that echoed it would hand the model a payload the write tool refuses.
    const [rent] = mandates(await call());
    expect(rent?.["destination"]).toEqual({
      type: "ach",
      holder_name: "Ridgeline Works Property LLC",
      routing_number: "021000021",
      account_number_last4: "8812",
      account_type: "checking",
    });
  });

  it("publishes the insufficient-funds policy as the module states it", async () => {
    const policy = (await call()).data["policy"] as Record<string, unknown>;
    expect(policy["insufficient_funds_code"]).toBe("INSUFFICIENT_AVAILABLE_FUNDS");
    expect(policy["stale_after_days"]).toBe(5);
    expect(policy["catch_up_window_days"]).toBe(45);
    expect(String(policy["on_insufficient_funds"])).toMatch(/No partial payment, no carry-forward/);
  });

  it("says it cannot create, amend, cancel or fire a mandate", async () => {
    expect((await call()).data["note"]).toMatch(/cannot create, amend, cancel or fire one/);
  });

  it("refuses to take a business or account from its caller", () => {
    expect(() => listStandingOrdersTool.parse({ business_id: BUSINESS_A })).toThrow(ToolError);
    expect(() => listStandingOrdersTool.parse({ account_id: "x" })).toThrow(ToolError);
  });
});
