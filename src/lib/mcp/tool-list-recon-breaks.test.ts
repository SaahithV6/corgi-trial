import { describe, expect, it } from "vitest";

import { listReconBreaksTool } from "./tool-list-recon-breaks";
import { BUSINESS_A, breakRow, defaultState, fakeGateway, testContext } from "./testing";
import { ToolError } from "./types";

function withBreaks(rows: ReturnType<typeof breakRow>[], unattributable = 0) {
  const state = defaultState();
  state.breaks.set(BUSINESS_A, rows);
  state.unattributableBreaks = unattributable;
  const { gateway } = fakeGateway(state);
  return testContext({ gateway });
}

async function call(args: Record<string, unknown>, ctx = withBreaks([breakRow()])) {
  return listReconBreaksTool.run(listReconBreaksTool.parse(args) as never, ctx);
}

describe("list_recon_breaks", () => {
  it("returns each break with its category and age", async () => {
    const outcome = await call({});
    const [row] = (outcome.data as { open_breaks: Record<string, unknown>[] }).open_breaks;
    expect(row?.["category"]).toBe("in_ledger_not_file");
    expect(row?.["age_days"]).toBe(9);
    expect(row?.["age_bucket"]).toBe("8-30");
    expect(row?.["severity"]).toBe("aged");
    expect(row?.["ledger_amount"]).toMatchObject({ cents: "12500", display: "$125.00" });
    expect(row?.["file_amount"]).toBeNull();
  });

  it("orders oldest first, because age is the escalation signal", async () => {
    const ctx = withBreaks([
      breakRow({ breakKey: "young", ageDays: 1 }),
      breakRow({ breakKey: "old", ageDays: 30 }),
    ]);
    const outcome = await call({}, ctx);
    const rows = (outcome.data as { open_breaks: Record<string, unknown>[] }).open_breaks;
    expect(rows[0]?.["break_key"]).toBe("old");
    expect((outcome.data as Record<string, unknown>)["oldest_age_days"]).toBe(30);
  });

  it("filters by minimum age so ordinary settlement timing can be skipped", async () => {
    const ctx = withBreaks([
      breakRow({ breakKey: "young", ageDays: 1 }),
      breakRow({ breakKey: "old", ageDays: 30 }),
    ]);
    const outcome = await call({ min_age_days: 3 }, ctx);
    expect((outcome.data as { open_breaks: unknown[] }).open_breaks).toHaveLength(1);
  });

  it("reports a mismatch with both amounts and the delta", async () => {
    const ctx = withBreaks([
      breakRow({
        category: "amount_mismatch",
        reasonCode: "amount_differs",
        ledgerAmountCents: 12_500n,
        fileAmountCents: 12_750n,
        breakAmountCents: 250n,
      }),
    ]);
    const outcome = await call({}, ctx);
    const [row] = (outcome.data as { open_breaks: Record<string, unknown>[] }).open_breaks;
    expect(row?.["break_amount"]).toMatchObject({ cents: "250", display: "$2.50" });
    expect(row?.["reason"]).toBe("Both sides have it; the money differs");
    expect(row?.["file_amount"]).toMatchObject({ cents: "12750" });
    expect(row?.["ledger_amount"]).toMatchObject({ cents: "12500" });
  });

  it("counts unattributable breaks instead of hiding them or leaking them", async () => {
    // A file row with no ledger line has no account and therefore no owner.
    // Listing it to a tenant could hand one customer another's settlement.
    const ctx = withBreaks([], 4);
    const outcome = await call({}, ctx);
    expect((outcome.data as { open_breaks: unknown[] }).open_breaks).toHaveLength(0);
    expect((outcome.data as Record<string, unknown>)["unattributable_open_breaks"]).toBe(4);
    expect(outcome.summary).toContain("cannot be attributed");
  });

  it("does not claim the books tie out when nothing is attributable", async () => {
    const outcome = await call({}, withBreaks([], 4));
    // The empty-list summary must never read as "everything reconciles".
    expect(outcome.summary).toContain("No open reconciliation breaks attributable");
    expect(outcome.summary).toContain("4 unmatched settlement-file row");
  });

  it("says in the payload that it cannot adjudicate", async () => {
    const outcome = await call({});
    expect(String((outcome.data as Record<string, unknown>)["note"])).toContain(
      "cannot adjudicate, resolve or adjust",
    );
  });

  it("refuses an unknown category and an out-of-range limit", () => {
    expect(() => listReconBreaksTool.parse({ category: "vibes" })).toThrow(ToolError);
    expect(() => listReconBreaksTool.parse({ limit: 5000 })).toThrow(ToolError);
    expect(() => listReconBreaksTool.parse({ min_age_days: -1 })).toThrow(ToolError);
  });

  it("dates the answer in book time", async () => {
    const outcome = await call({});
    expect((outcome.data as Record<string, unknown>)["as_of_book_date"]).toBe("2026-09-10");
  });
});
