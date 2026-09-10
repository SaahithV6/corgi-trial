import { describe, expect, it } from "vitest";

import { getBalanceTool } from "./tool-get-balance";
import {
  BUSINESS_A,
  BUSINESS_B,
  defaultState,
  fakeGateway,
  snapshotOf,
  testContext,
} from "./testing";
import { ToolError } from "./types";

async function call(args: Record<string, unknown>, ctx = testContext()) {
  return getBalanceTool.run(getBalanceTool.parse(args) as never, ctx);
}

describe("get_balance", () => {
  it("returns ledger and available, with the difference itemised", async () => {
    const { gateway } = fakeGateway();
    const outcome = await call({}, testContext({ gateway }));

    const data = outcome.data as Record<string, Record<string, unknown>>;
    expect(data["ledger_balance"]?.["cents"]).toBe("1000000");
    expect(data["available_balance"]?.["cents"]).toBe("958740");

    // -$362.60 of card holds and -$50.00 of uncleared credits.
    const difference = data["difference"] as { total: { cents: string }; items: unknown[] };
    expect(difference.total.cents).toBe("-41260");
    expect(difference.items).toHaveLength(2);
    expect(difference.items[0]).toMatchObject({
      kind: "card_auth_holds",
      count: 2,
      amount: { cents: "-36260" },
    });
    expect(difference.items[1]).toMatchObject({
      kind: "uncleared_credits",
      count: 1,
      amount: { cents: "-5000" },
    });
  });

  it("states the formula rather than leaving it implied", async () => {
    const outcome = await call({});
    expect(String((outcome.data as Record<string, unknown>)["formula"])).toContain(
      "available = ledger",
    );
    expect(String((outcome.data as Record<string, unknown>)["formula"])).toContain(
      "no balance is stored",
    );
  });

  it("names both figures in the summary a model will read aloud", async () => {
    const outcome = await call({});
    expect(outcome.summary).toContain("ledger balance $10,000.00");
    expect(outcome.summary).toContain("available $9,587.40");
  });

  it("reports available equal to ledger, and says so, when nothing is held", async () => {
    const state = defaultState();
    state.balances.set(`${BUSINESS_A}:a0c41a37-2be1-5c30-bfe9-03455f048fac`, snapshotOf(4_200n));
    const { gateway } = fakeGateway(state);
    const outcome = await call({}, testContext({ gateway }));
    expect(outcome.summary).toContain("Nothing is encumbered");
  });

  it("lets available go negative rather than clamping an overdraft to zero", async () => {
    const state = defaultState();
    state.balances.set(
      `${BUSINESS_A}:a0c41a37-2be1-5c30-bfe9-03455f048fac`,
      snapshotOf(1_000n, 7_340n, 0n, 1, 0),
    );
    const { gateway } = fakeGateway(state);
    const outcome = await call({}, testContext({ gateway }));
    const data = outcome.data as Record<string, Record<string, unknown>>;
    expect(data["available_balance"]?.["cents"]).toBe("-6340");
    expect(data["available_balance"]?.["display"]).toBe("-$63.40");
  });

  it("uses the bitemporal path and reports the watermark when asked as-believed", async () => {
    const outcome = await call({
      as_of_value_date: "2026-09-08",
      as_of_booking_time: "2026-09-09T12:00:00Z",
    });
    const asOf = (outcome.data as Record<string, Record<string, unknown>>)["as_of"];
    expect(asOf?.["basis"]).toBe("as_believed");
    expect(asOf?.["value_date"]).toBe("2026-09-08");
    expect(asOf?.["booking_watermark"]).toBe("5");
    expect(outcome.summary).toContain("as believed at");
  });

  it("distinguishes a valid-time cut from a transaction-time one", async () => {
    const valueOnly = await call({ as_of_value_date: "2026-09-08" });
    expect(
      (valueOnly.data as Record<string, Record<string, unknown>>)["as_of"]?.["basis"],
    ).toBe("as_of_value_date");
    expect(
      (valueOnly.data as Record<string, Record<string, unknown>>)["as_of"]?.["booking_watermark"],
    ).toBeNull();

    const current = await call({});
    expect((current.data as Record<string, Record<string, unknown>>)["as_of"]?.["basis"]).toBe(
      "current",
    );
  });

  it("derives the book date from the booking instant when no value date is given", async () => {
    // 01:30 UTC on the 11th is the evening of the 10th in New York.
    const outcome = await call({ as_of_booking_time: "2026-09-11T01:30:00Z" });
    expect(
      (outcome.data as Record<string, Record<string, unknown>>)["as_of"]?.["value_date"],
    ).toBe("2026-09-10");
  });

  it("refuses an account code this business does not have", async () => {
    // 1110 is the house FBO cash account: every customer's money, pooled. It
    // is not addressable from a tenant token at all.
    await expect(call({ account_code: "1110" })).rejects.toThrow(ToolError);
    await expect(call({ account_code: "1110" })).rejects.toThrow(/no open account with code 1110/);
  });

  it("cannot be pointed at another business by any argument", async () => {
    // There is no parameter to try. The only handle on an account is a chart
    // code, resolved inside the grant's business.
    const { gateway, state } = fakeGateway();
    const ctx = testContext({ gateway });
    const outcome = await call({}, ctx);
    const data = outcome.data as Record<string, Record<string, unknown>>;

    expect(data["business"]?.["id"]).toBe(BUSINESS_A);
    // Business B's balance is a different number and is never reachable.
    expect(state.balances.get(`${BUSINESS_B}:bbbbbbbb-0000-4000-8000-000000000001`)?.ledgerCents).toBe(
      750_000n,
    );
    expect(data["ledger_balance"]?.["cents"]).toBe("1000000");
  });

  it("refuses a nonsense date instead of silently reporting today", async () => {
    expect(() => getBalanceTool.parse({ as_of_value_date: "2026-02-30" })).toThrow(ToolError);
    expect(() => getBalanceTool.parse({ as_of_booking_time: "yesterday" })).toThrow(ToolError);
  });
});
