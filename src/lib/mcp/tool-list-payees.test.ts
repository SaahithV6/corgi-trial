import { describe, expect, it } from "vitest";

import { listPayeesTool } from "./tool-list-payees";
import { BUSINESS_A, defaultState, fakeGateway, testContext } from "./testing";
import { ToolError } from "./types";

function ctx() {
  const { gateway } = fakeGateway(defaultState());
  return testContext({ gateway });
}

async function call(args: Record<string, unknown> = {}) {
  return listPayeesTool.run(listPayeesTool.parse(args) as never, ctx());
}

function payees(outcome: { data: Record<string, unknown> }) {
  return outcome.data["payees"] as Record<string, unknown>[];
}

describe("list_payees", () => {
  it("returns the book with the verification state on each row", async () => {
    const rows = payees(await call());
    const first = rows[0] as Record<string, Record<string, unknown>>;
    expect(first["holder_name"]).toBe("Northwind Components LLC");
    expect(first["verification"]?.["outcome"]).toBe("verified");
    expect(first["verification"]?.["freshness"]).toBe("fresh");
    expect(first["verification"]?.["name_source"]).toBe("linked_account_holder");
  });

  it("excludes archived payees by default and can include them", async () => {
    expect(payees(await call())).toHaveLength(2);
    expect(payees(await call({ include_archived: true }))).toHaveLength(3);
  });

  it("derives payable without claiming to be the gate", async () => {
    const rows = payees(await call());
    // Verified and fresh: would pass.
    expect(rows[0]?.["payable"]).toBe(true);
    // Warned and unacknowledged: would not, and the warning is the reason.
    expect(rows[1]?.["payable"]).toBe(false);
    expect(String(outcomeNote(rows))).toBe("");
  });

  it("filters by outcome, freshness and rail", async () => {
    expect(payees(await call({ outcome: "warned" }))).toHaveLength(1);
    expect(payees(await call({ freshness: "fresh" }))).toHaveLength(1);
    expect(payees(await call({ rail: "wire" }))).toHaveLength(0);
    expect(payees(await call({ rail: "wire", include_archived: true }))).toHaveLength(1);
  });

  it("finds a counterparty by name, which is the pre-payment question", async () => {
    const rows = payees(await call({ holder_name_contains: "pierce" }));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["holder_name"]).toBe("Pierce Fluids Co");
  });

  it("carries the findings that explain a warning", async () => {
    const rows = payees(await call({ outcome: "warned" }));
    const findings = (rows[0]?.["verification"] as Record<string, unknown>)[
      "findings"
    ] as Record<string, unknown>[];
    expect(findings[0]?.["code"]).toBe("NAME_CLOSE_MATCH");
    expect(findings[0]?.["severity"]).toBe("warn");
  });

  it("flags a conflicting twin, which is what changed bank details look like", async () => {
    const rows = payees(await call({ outcome: "warned" }));
    expect(rows[0]?.["has_conflicting_twin"]).toBe(true);
  });

  it("never returns anything longer than the last four digits", async () => {
    const rendered = JSON.stringify(payees(await call({ include_archived: true })));
    for (const row of payees(await call({ include_archived: true }))) {
      const last4 = row["account_number_last4"];
      if (last4 !== null) expect(String(last4)).toMatch(/^\d{4}$/);
    }
    // No field anywhere in the payload is a full account number. A routing
    // number IS nine digits and IS returned, on purpose: it is public
    // information a payer needs, and it is the half of the destination the
    // checksum can actually verify.
    expect(rendered).not.toMatch(/"account_number"/);
    for (const row of payees(await call({ include_archived: true }))) {
      const routing = row["routing_number"];
      if (routing !== null) expect(String(routing)).toMatch(/^\d{9}$/);
    }
  });

  it("says in its own note that it cannot acknowledge a warning", async () => {
    const outcome = await call();
    expect(outcome.data["note"]).toMatch(/cannot acknowledge a warning/i);
    expect(listPayeesTool.description).toMatch(/cannot add, edit, archive or re-check a payee/i);
  });

  it("refuses to take a business or actor from its caller", () => {
    expect(() => listPayeesTool.parse({ business_id: BUSINESS_A })).toThrow(ToolError);
    expect(() => listPayeesTool.parse({ actor_id: "x" })).toThrow(ToolError);
  });
});

/** No payable row may carry an unacknowledged warning. Returns "" when clean. */
function outcomeNote(rows: Record<string, unknown>[]): string {
  for (const row of rows) {
    const verification = row["verification"] as Record<string, unknown>;
    const ack = row["acknowledgement"] as Record<string, unknown>;
    if (row["payable"] === true && verification["outcome"] === "warned" && ack["acknowledged"] !== true) {
      return `${String(row["holder_name"])} is payable with an unacknowledged warning`;
    }
  }
  return "";
}
