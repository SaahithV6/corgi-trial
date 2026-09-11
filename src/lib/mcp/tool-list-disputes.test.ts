import { describe, expect, it } from "vitest";

import { listDisputesTool } from "./tool-list-disputes";
import { BUSINESS_A, defaultState, fakeGateway, testContext } from "./testing";
import { ToolError } from "./types";

function ctx() {
  const { gateway } = fakeGateway(defaultState());
  return testContext({ gateway });
}

async function call(args: Record<string, unknown> = {}) {
  return listDisputesTool.run(listDisputesTool.parse(args) as never, ctx());
}

function cases(outcome: { data: Record<string, unknown> }) {
  return outcome.data["cases"] as Record<string, unknown>[];
}

describe("list_disputes", () => {
  it("defaults to live cases and still counts the closed ones", async () => {
    // The failure this guards: a caller asks "do we have any disputes", gets
    // the default open-only view, sees one, and reports that as the total.
    const outcome = await call();
    expect(cases(outcome)).toHaveLength(1);
    expect(outcome.data["counts"]).toMatchObject({ open: 1, closed: 1, returned: 1 });
  });

  it("returns closed cases when asked", async () => {
    expect(cases(await call({ open_only: false }))).toHaveLength(2);
    const lost = cases(await call({ status: "closed_lost_recovered" }));
    expect(lost).toHaveLength(1);
    expect(lost[0]?.["case_ref"]).toBe("DSP-20260901-ZZ99YY");
  });

  it("reports money as cent strings, never as a float", async () => {
    const [live] = cases(await call());
    expect(live?.["amount_claimed"]).toMatchObject({ cents: "7340", display: "$73.40" });
    expect(live?.["advanced"]).toMatchObject({ cents: "7340" });
    expect(live?.["held"]).toMatchObject({ cents: "7340" });
    expect(JSON.stringify((await call()).data)).not.toMatch(/"cents":\s*\d/);
  });

  it("says the held advance is not spendable — the hold with no card behind it", async () => {
    // The whole reason this tool exists. get_balance sees a hold; only this
    // tool can say the hold is a provisional credit the bank advanced.
    const outcome = await call();
    expect(outcome.summary).toMatch(/still held and therefore NOT spendable/);
    expect(String(outcome.data["note"])).toMatch(/hold with no card behind it/);
    expect(outcome.data["totals"]).toMatchObject({ held: { cents: "7340" } });
  });

  it("warns that a clawback is not a duplicate charge", async () => {
    expect(String((await call()).data["note"])).toMatch(/not a duplicate charge/);
    expect(listDisputesTool.description).toMatch(/duplicate charge/i);
  });

  it("carries the status meaning the disputes screen shows a person", async () => {
    const [live] = cases(await call());
    expect(String(live?.["status_meaning"])).toMatch(/they cannot spend it until the case resolves/);
  });

  it("names who each case is waiting on, and that it can never be an agent", async () => {
    const [live] = cases(await call());
    const awaiting = live?.["awaiting"] as Record<string, unknown>;
    expect(awaiting["needs_authorization"]).toBe(false);
    expect(awaiting["authorizations_held"]).toBe(1);
    expect(String(awaiting["who"])).toMatch(/network's verdict/);
  });

  it("shows the authorisation as a named human in the timeline", async () => {
    const [live] = cases(await call());
    const events = live?.["events"] as Record<string, unknown>[];
    const authorised = events.find((e) => e["kind"] === "provisional_credit_authorized");
    expect(authorised?.["actor"]).toBe("Priya Raman");
    expect(authorised?.["actor_kind"]).toBe("human");
    // The raiser and the authoriser are different people. The database refuses
    // otherwise, and the timeline should make it visible rather than assert it.
    expect(events[0]?.["actor"]).toBe("Dana Whitfield");
  });

  it("does not count a closed case as waiting on an authorisation", async () => {
    // `needs_authorization` is about the CLAIM being over threshold and stays
    // true after a case closes. Found against live rows: the summary claimed
    // two cases were waiting on a human, both of which had settled weeks
    // earlier.
    const outcome = await call({ open_only: false });
    expect(outcome.data["counts"]).toMatchObject({ awaiting_authorization: 0 });
    expect(outcome.summary).toMatch(/Nothing is waiting on an authorisation/);

    const closed = cases(outcome).find((c) => c["is_closed"] === true);
    expect(String((closed?.["awaiting"] as Record<string, unknown>)["who"])).toMatch(
      /the case is closed/,
    );
  });

  it("can be asked for the cases without their timelines", async () => {
    const [live] = cases(await call({ include_events: false }));
    expect(live?.["events"]).toEqual([]);
  });

  it("carries the network deadline, which is in no journal row", async () => {
    const [live] = cases(await call());
    expect(live?.["network_outside_date"]).toBe("2026-10-28");
    expect(live?.["days_to_outside_date"]).toBe(48);
  });

  it("says plainly that it cannot raise a case or authorise a credit", async () => {
    const note = String((await call()).data["note"]);
    expect(note).toMatch(/cannot raise, withdraw or progress a case/);
    expect(note).toMatch(/never authorise or grant provisional credit/);
    expect(listDisputesTool.description).toMatch(/scoped to the single business/i);
  });

  it("returns nothing for a business with no cases, and says so honestly", async () => {
    const { gateway, state } = fakeGateway(defaultState());
    state.disputes.set(BUSINESS_A, []);
    const outcome = await listDisputesTool.run(
      listDisputesTool.parse({}) as never,
      testContext({ gateway }),
    );
    expect(outcome.data["cases"]).toEqual([]);
    expect(outcome.summary).toMatch(/No open dispute cases/);
  });

  it("refuses to take a business or dispute identifier from its caller", () => {
    expect(() => listDisputesTool.parse({ business_id: BUSINESS_A })).toThrow(ToolError);
    expect(() => listDisputesTool.parse({ dispute_id: "x" })).toThrow(ToolError);
    expect(() => listDisputesTool.parse({ status: "not_a_status" })).toThrow(ToolError);
  });
});
