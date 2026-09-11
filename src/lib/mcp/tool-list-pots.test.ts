import { describe, expect, it } from "vitest";

import { listPotsTool } from "./tool-list-pots";
import { BUSINESS_A, defaultState, fakeGateway, testContext } from "./testing";
import { ToolError, type PotsSnapshot } from "./types";

function withPots(snapshot?: PotsSnapshot) {
  const state = defaultState();
  if (snapshot !== undefined) state.pots.set(BUSINESS_A, snapshot);
  const { gateway } = fakeGateway(state);
  return testContext({ gateway });
}

async function call(args: Record<string, unknown> = {}, ctx = withPots()) {
  return listPotsTool.run(listPotsTool.parse(args) as never, ctx);
}

function data(outcome: { data: Record<string, unknown> }) {
  return outcome.data as {
    main_account: Record<string, { cents: string; display: string } | string>;
    pots: Record<string, unknown>[];
    totals: Record<string, unknown>;
    truncated: boolean;
  };
}

describe("list_pots", () => {
  it("separates the main balance from the money earmarked in pots", async () => {
    const d = data(await call());
    // The whole reason this tool exists: get_balance answers with the first
    // figure, and a customer with pots has more money than that.
    expect(d.main_account["ledger_balance"]).toMatchObject({ cents: "1000000" });
    expect(d.totals["pots_total"]).toMatchObject({ cents: "1500000" });
    expect(d.totals["main_plus_pots"]).toMatchObject({ cents: "2500000" });
  });

  it("reports the identity rather than asserting it", async () => {
    const d = data(await call());
    expect(d.totals["identity_holds"]).toBe(true);
    expect(d.totals["identity_difference"]).toMatchObject({ cents: "0" });
  });

  it("says so loudly when the two routes to the total disagree", async () => {
    // A drift here would mean the pot table and a recursive walk of the chart
    // no longer describe the same money. The tool must not quote one of them.
    const outcome = await call(
      {},
      withPots({
        pots: [
          {
            potId: "9a1f5f2e-0000-4000-8000-000000000001",
            name: "Payroll",
            purpose: null,
            accountCode: "2100.9a1f5f2e-0000-4000-8000-000000000001",
            openedAt: "2026-09-01T14:00:00.000Z",
            balanceCents: 1_000_00n,
          },
        ],
        mainCents: 10_000_00n,
        potsCents: 1_000_00n,
        totalCents: 11_000_00n,
        subtreeCents: 10_900_00n,
      }),
    );
    const d = data(outcome);
    expect(d.totals["identity_holds"]).toBe(false);
    expect(d.totals["identity_difference"]).toMatchObject({ cents: "10000" });
    expect(outcome.summary).toMatch(/WARNING/);
  });

  it("computes the share with integer arithmetic, never a float", async () => {
    const d = data(await call());
    for (const pot of d.pots) {
      expect(Number.isInteger(pot["share_percent"])).toBe(true);
    }
    // 12,000.00 of 25,000.00 is 48%, floored from exact integer division.
    expect(d.pots[0]?.["share_percent"]).toBe(48);
  });

  it("renders every money field as a string of cents", async () => {
    const d = data(await call());
    for (const pot of d.pots) {
      expect(typeof (pot["balance"] as { cents: unknown }).cents).toBe("string");
    }
  });

  it("can hide empty pots, and shows them by default", async () => {
    const snapshot: PotsSnapshot = {
      pots: [
        {
          potId: "9a1f5f2e-0000-4000-8000-000000000009",
          name: "Opened, never funded",
          purpose: null,
          accountCode: "2100.9a1f5f2e-0000-4000-8000-000000000009",
          openedAt: "2026-09-09T09:00:00.000Z",
          balanceCents: 0n,
        },
      ],
      mainCents: 10_000_00n,
      potsCents: 0n,
      totalCents: 10_000_00n,
      subtreeCents: 10_000_00n,
    };
    expect(data(await call({}, withPots(snapshot))).pots).toHaveLength(1);
    expect(data(await call({ include_empty: false }, withPots(snapshot))).pots).toHaveLength(0);
  });

  it("answers cleanly for a business that has never opened a pot", async () => {
    const outcome = await call(
      {},
      withPots({ pots: [], mainCents: 0n, potsCents: 0n, totalCents: 0n, subtreeCents: 0n }),
    );
    expect(data(outcome).pots).toHaveLength(0);
    expect(data(outcome).totals["identity_holds"]).toBe(true);
    expect(outcome.summary).toContain("no pots");
  });

  it("refuses to take a business or account from its caller", () => {
    expect(() => listPotsTool.parse({ business_id: BUSINESS_A })).toThrow(ToolError);
    expect(() => listPotsTool.parse({ account_id: "2100" })).toThrow(ToolError);
  });

  it("tells the caller in its own note that it cannot move money", async () => {
    const outcome = await call();
    expect(outcome.data["note"]).toMatch(/cannot fund, empty, open or close a pot|not available to this surface/i);
  });
});
