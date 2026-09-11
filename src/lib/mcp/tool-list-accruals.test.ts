import { describe, expect, it } from "vitest";

import { listAccrualsTool } from "./tool-list-accruals";
import { BUSINESS_A, defaultState, fakeGateway, testContext } from "./testing";
import { ToolError } from "./types";

function ctx() {
  const { gateway } = fakeGateway(defaultState());
  return testContext({ gateway });
}

async function call(args: Record<string, unknown> = {}) {
  return listAccrualsTool.run(listAccrualsTool.parse(args) as never, ctx());
}

function days(outcome: { data: Record<string, unknown> }) {
  return outcome.data["days"] as Record<string, unknown>[];
}

describe("list_accruals", () => {
  it("returns the schedule with its monthly price in cents", async () => {
    const [schedule] = (await call()).data["schedules"] as Record<string, unknown>[];
    expect(schedule?.["plan_name"]).toBe("Business Standard");
    expect(schedule?.["monthly_price"]).toMatchObject({ cents: "2500", display: "$25.00" });
    expect(schedule?.["active"]).toBe(true);
  });

  it("explains the penny — the whole reason this tool exists", async () => {
    // Day 10 carries a residual penny and day 11 does not. An agent without
    // this reports a rounding bug; with it, it can quote the arithmetic.
    const [eleventh, tenth] = days(await call());

    expect(tenth?.["accrual_date"]).toBe("2026-09-10");
    const tenthMaths = tenth?.["arithmetic"] as Record<string, unknown>;
    expect(tenthMaths["residual_applied"]).toBe(true);
    expect(tenthMaths["amount"]).toMatchObject({ cents: "84" });

    expect(eleventh?.["accrual_date"]).toBe("2026-09-11");
    const eleventhMaths = eleventh?.["arithmetic"] as Record<string, unknown>;
    expect(eleventhMaths["residual_applied"]).toBe(false);
    expect(eleventhMaths["amount"]).toMatchObject({ cents: "83" });
  });

  it("shows the working as integers AND as a sentence built from them", async () => {
    const [, tenth] = days(await call());
    const maths = tenth?.["arithmetic"] as Record<string, unknown>;
    expect(maths["monthly_price"]).toMatchObject({ cents: "2500" });
    expect(maths["days_in_month"]).toBe(30);
    expect(maths["day_of_month"]).toBe(10);
    expect(maths["base_share"]).toMatchObject({ cents: "83" });
    expect(maths["residual_pennies"]).toBe(10);
    expect(maths["month_to_date"]).toMatchObject({ cents: "840" });
    expect(maths["remaining_this_month"]).toMatchObject({ cents: "1660" });
    // Built by explainAllocation from the same integers, so it cannot disagree
    // with the figures beside it.
    expect(String(maths["explanation"])).toContain("$25.00 ÷ 30 days = 83¢ per day");
    expect(String(maths["explanation"])).toContain("84¢");
  });

  it("remaining_this_month is price minus month-to-date, by definition", async () => {
    for (const day of days(await call())) {
      const m = day["arithmetic"] as Record<string, unknown>;
      const price = BigInt((m["monthly_price"] as Record<string, string>)["cents"] ?? "0");
      const mtd = BigInt((m["month_to_date"] as Record<string, string>)["cents"] ?? "0");
      const left = BigInt((m["remaining_this_month"] as Record<string, string>)["cents"] ?? "0");
      expect(price - mtd).toBe(left);
    }
  });

  it("says an incomplete month is month-to-date and not the bill", async () => {
    const [month] = (await call()).data["months"] as Record<string, unknown>[];
    expect(month?.["month_complete"]).toBe(false);
    expect(month?.["accrued"]).toMatchObject({ cents: "923" });
    expect(month?.["monthly_price"]).toMatchObject({ cents: "2500" });
    expect((await call()).summary).toMatch(/month-to-date, so this is not the month's bill yet/);
    expect(String((await call()).data["note"])).toMatch(/quoting it as the bill understates/);
  });

  it("does not call an incomplete month a drift", async () => {
    // sums_to_price is only meaningful once every day is decided; a mid-month
    // `false` would read as a fault when it is simply Tuesday.
    const [month] = (await call()).data["months"] as Record<string, unknown>[];
    expect(month?.["sums_to_price"]).toBe(true);
  });

  it("returns the invariants, including the gap that means the job stopped", async () => {
    const outcome = await call();
    expect(outcome.data["invariants"]).toMatchObject({
      month_drift: 0,
      ledger_drift: 0,
      gap_days: 0,
      healthy: true,
    });
    expect(outcome.summary).toMatch(/Month and ledger drift are both zero/);
  });

  it("raises the alarm in the summary when the books disagree with themselves", async () => {
    const { gateway, state } = fakeGateway(defaultState());
    const page = state.accruals.get(BUSINESS_A);
    state.accruals.set(BUSINESS_A, {
      ...(page ?? { schedules: [], months: [], days: [], accruedToDateCents: 0n }),
      invariants: { monthDrift: 1, ledgerDrift: 0, unresolved: 0, gapDays: 9 },
    } as never);
    const outcome = await listAccrualsTool.run(
      listAccrualsTool.parse({}) as never,
      testContext({ gateway }),
    );
    expect(outcome.summary).toMatch(/9 day\(s\) are owed and unclaimed/);
    expect(outcome.summary).toMatch(/WARNING: month drift 1/);
    expect((outcome.data["invariants"] as Record<string, unknown>)["healthy"]).toBe(false);
  });

  it("can be asked for the roll-ups without the individual days", async () => {
    expect(days(await call({ days: 0 }))).toHaveLength(0);
  });

  it("labels what it does not cover rather than returning zero for it", async () => {
    // The interest leg exists in the schema and had posted nothing when this
    // reader was written. Saying so beats implying coverage.
    expect(String((await call()).data["note"])).toMatch(/platform FEE leg/);
    expect(String((await call()).data["note"])).toMatch(/not on this surface rather than reporting zero/);
  });

  it("says plainly that it cannot enrol, re-price, run or skip", async () => {
    const note = String((await call()).data["note"]);
    expect(note).toMatch(/cannot enrol, re-price or end a schedule/);
    expect(note).toMatch(/cannot skip a day/);
    expect(listAccrualsTool.description).toMatch(/scoped to the single business/i);
  });

  it("says the account is simply not enrolled rather than inventing a fee", async () => {
    const { gateway, state } = fakeGateway(defaultState());
    state.accruals.delete(BUSINESS_A);
    const outcome = await listAccrualsTool.run(
      listAccrualsTool.parse({}) as never,
      testContext({ gateway }),
    );
    expect(outcome.summary).toMatch(/not enrolled in any platform-fee accrual schedule/);
  });

  it("refuses to take a business or schedule identifier from its caller", () => {
    expect(() => listAccrualsTool.parse({ business_id: BUSINESS_A })).toThrow(ToolError);
    expect(() => listAccrualsTool.parse({ schedule_id: "x" })).toThrow(ToolError);
    expect(() => listAccrualsTool.parse({ days: 500 })).toThrow(ToolError);
  });
});
