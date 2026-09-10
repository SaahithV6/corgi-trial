import { describe, expect, it } from "vitest";

import { listTransactionsTool } from "./tool-list-transactions";
import { BUSINESS_A, defaultState, fakeGateway, testContext, txRow } from "./testing";
import { ToolError } from "./types";

function withRows(rows: ReturnType<typeof txRow>[]) {
  const state = defaultState();
  state.transactions.set(BUSINESS_A, rows);
  const { gateway } = fakeGateway(state);
  return testContext({ gateway });
}

async function call(args: Record<string, unknown>, ctx = withRows([txRow()])) {
  return listTransactionsTool.run(listTransactionsTool.parse(args) as never, ctx);
}

describe("list_transactions", () => {
  it("returns value_date and booking_date as separate fields", async () => {
    const outcome = await call({});
    const [row] = (outcome.data as { transactions: Record<string, unknown>[] }).transactions;
    expect(row?.["value_date"]).toBe("2026-09-08");
    expect(row?.["booking_date"]).toBe("2026-09-08");
    expect(row?.["backdated_by_days"]).toBe(0);
  });

  it("computes the gap on a correction booked days after it happened", async () => {
    // The published live-fire case: Thursday reverses Tuesday's settlement.
    const ctx = withRows([
      txRow({
        entryId: "e0000000-0000-4000-8000-00000000000a",
        entryType: "reversal",
        valueDate: "2026-09-08",
        bookingDate: "2026-09-10",
        bookingSeq: 9n,
        description: "Reversal of Tuesday's settlement",
        reversesEntryId: "e0000000-0000-4000-8000-000000000001",
        correctionGroupId: "cg-1",
        amountCents: 7_340n,
      }),
    ]);
    const outcome = await call({}, ctx);
    const [row] = (outcome.data as { transactions: Record<string, unknown>[] }).transactions;
    expect(row?.["backdated_by_days"]).toBe(2);
    expect(row?.["entry_type"]).toBe("reversal");
    expect(row?.["correction_group_id"]).toBe("cg-1");
    expect(outcome.summary).toContain("booked after their value date");
  });

  it("signs amounts from the account's point of view", async () => {
    const outcome = await call({});
    const [row] = (outcome.data as { transactions: Record<string, unknown>[] }).transactions;
    // A card clearing takes money out of a customer's account: negative.
    expect((row?.["amount"] as Record<string, unknown>)["display"]).toBe("-$73.40");
  });

  it("filters the two date axes independently", async () => {
    const ctx = withRows([
      txRow({ entryId: "a", valueDate: "2026-08-01", bookingDate: "2026-09-01", bookingSeq: 1n }),
      txRow({ entryId: "b", valueDate: "2026-09-01", bookingDate: "2026-09-01", bookingSeq: 2n }),
    ]);

    const byValue = await call({ value_date_from: "2026-08-25" }, ctx);
    expect((byValue.data as { transactions: unknown[] }).transactions).toHaveLength(1);

    const byBooking = await call({ booking_date_from: "2026-08-25" }, ctx);
    expect((byBooking.data as { transactions: unknown[] }).transactions).toHaveLength(2);
  });

  it("refuses an inverted date range rather than returning nothing", async () => {
    // Silently returning zero rows would read to a model as "no activity",
    // which is a different and much worse answer than "your filter is wrong".
    await expect(
      call({ value_date_from: "2026-09-10", value_date_to: "2026-09-01" }),
    ).rejects.toThrow(ToolError);
    await expect(
      call({ booking_date_from: "2026-09-10", booking_date_to: "2026-09-01" }),
    ).rejects.toThrow(ToolError);
  });

  it("pages with an opaque cursor", async () => {
    const ctx = withRows([
      txRow({ entryId: "a", bookingSeq: 3n }),
      txRow({ entryId: "b", bookingSeq: 2n }),
      txRow({ entryId: "c", bookingSeq: 1n }),
    ]);
    const first = await call({ limit: 2 }, ctx);
    const page = first.data as { transactions: Record<string, unknown>[]; next_cursor: string | null };
    expect(page.transactions).toHaveLength(2);
    expect(page.next_cursor).toBe("2");

    const second = await call({ limit: 2, cursor: page.next_cursor as string }, ctx);
    expect((second.data as { transactions: unknown[] }).transactions).toHaveLength(1);
  });

  it("refuses an account code this business does not own", async () => {
    await expect(call({ account_code: "1110" })).rejects.toThrow(ToolError);
  });

  it("caps the page size", () => {
    expect(() => listTransactionsTool.parse({ limit: 1000 })).toThrow(ToolError);
    expect(() => listTransactionsTool.parse({ limit: 0 })).toThrow(ToolError);
  });

  it("echoes the filters it applied so a model can see what it actually asked", async () => {
    const outcome = await call({ rail: "card", book: "financial" });
    const filters = (outcome.data as Record<string, Record<string, unknown>>)["filters_applied"];
    expect(filters?.["rail"]).toBe("card");
    expect(filters?.["book"]).toBe("financial");
    expect(filters?.["limit"]).toBe(50);
  });

  it("explains the two date columns in the payload itself", async () => {
    const outcome = await call({});
    expect(String((outcome.data as Record<string, unknown>)["note"])).toContain(
      "when this system learned of it",
    );
  });
});
