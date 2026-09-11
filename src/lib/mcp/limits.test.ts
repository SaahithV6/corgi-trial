/**
 * THE POLICY AND THE SURFACE, HELD EQUAL.
 *
 * `docs/AGENT-LIMITS.md` is prose and `limits.ts` is the same content as data,
 * and the value of the second over the first is entirely that a program can
 * check it. This file is that check.
 *
 * The property being asserted is not "the list is nicely formatted". It is
 * that **every tool the policy claims is absent really is absent**, in the
 * registry a client actually calls. A refusal document that has drifted from
 * the tool list is worse than no document: it is a written promise that the
 * surface no longer keeps, and it would be quoted at a panel.
 */

import { describe, expect, it } from "vitest";

import {
  DEBATABLE,
  PRINCIPLE,
  REFUSALS,
  findRefusals,
  refusalForTool,
  refusedToolNames,
} from "./limits";
import { listAgentLimitsTool } from "./tool-list-agent-limits";
import { testContext } from "./testing";
import { TOOLS, WRITE_TOOLS } from "./tools";
import { ToolError } from "./types";

async function call(args: Record<string, unknown> = {}) {
  return listAgentLimitsTool.run(listAgentLimitsTool.parse(args) as never, testContext());
}

describe("the catalogue and the registry cannot drift apart", () => {
  it("names no tool that actually exists", () => {
    // THE TEST THIS FILE EXISTS FOR. If someone adds `set_card_controls` to
    // the registry, §13 stops being true, and it fails here rather than in a
    // debrief.
    const registered = new Set(TOOLS.map((t) => t.name));
    for (const name of refusedToolNames()) {
      expect(
        registered.has(name),
        `docs/AGENT-LIMITS.md claims "${name}" is absent, but it is in the tool registry`,
      ).toBe(false);
    }
  });

  it("covers every operation the import guard forbids", () => {
    // `no-write-imports.test.ts` names each forbidden import with the section
    // that argues it. Those section numbers have to exist.
    const sections = new Set(REFUSALS.map((r) => r.section));
    for (const section of [1, 2, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) {
      expect(sections.has(section), `AGENT-LIMITS §${section} is referenced but missing`).toBe(true);
    }
  });

  it("gives every refusal a mechanism, not just a sentence", () => {
    for (const refusal of REFUSALS) {
      expect(refusal.enforcedBy.length, `§${refusal.section} names no enforcement`).toBeGreaterThan(
        0,
      );
      expect(refusal.absentTools.length).toBeGreaterThan(0);
      expect(refusal.instead.length, `§${refusal.section} has no forward path`).toBeGreaterThan(20);
      expect(refusal.keywords.length).toBeGreaterThan(0);
    }
  });

  it("numbers its sections uniquely and contiguously", () => {
    const sections = REFUSALS.map((r) => r.section);
    expect(new Set(sections).size).toBe(sections.length);
    expect(sections).toEqual([...sections].sort((a, b) => a - b));
    expect(sections[0]).toBe(1);
    expect(sections[sections.length - 1]).toBe(REFUSALS.length);
  });

  it("distinguishes what the database refuses from what we merely do not offer", () => {
    // Flattening these two into "the agent cannot" would be the single most
    // dishonest sentence on this surface, so both kinds must be present.
    const kinds = new Set(REFUSALS.map((r) => r.guarantee));
    expect(kinds.has("unrepresentable")).toBe(true);
    expect(kinds.has("capability-absent")).toBe(true);

    // Approval and the KYB review are the schema-level ones, proved live by
    // mcp.integration.test.ts and dbcheck.mjs respectively.
    expect(refusalForTool("approve_payment")?.guarantee).toBe("unrepresentable");
    expect(refusalForTool("approve_kyb")?.guarantee).toBe("unrepresentable");
    expect(refusalForTool("grant_provisional_credit")?.guarantee).toBe("unrepresentable");
  });
});

describe("matching a caller's question", () => {
  it("answers an exact tool-name guess with that section first", () => {
    expect(findRefusals("approve_payment")[0]?.section).toBe(2);
    expect(findRefusals("set_card_controls")[0]?.section).toBe(13);
    expect(findRefusals("raise_dispute")[0]?.section).toBe(17);
  });

  it("answers the question as a person would phrase it", () => {
    const asked = findRefusals("can I unblock the fuel category on the ops card");
    expect(asked.map((r) => r.section)).toContain(13);

    const pot = findRefusals("move money out of the payroll pot");
    expect(pot.map((r) => r.section)).toContain(15);

    const fee = findRefusals("change their monthly plan price");
    expect(fee.map((r) => r.section)).toContain(19);
  });

  it("returns everything when asked nothing", () => {
    expect(findRefusals("")).toHaveLength(REFUSALS.length);
  });
});

describe("list_agent_limits", () => {
  it("returns the whole list with the principle attached", async () => {
    const outcome = await call();
    expect(outcome.data["total_refusals"]).toBe(REFUSALS.length);
    expect((outcome.data["refusals"] as unknown[]).length).toBe(REFUSALS.length);
    expect(outcome.data["principle"]).toEqual([...PRINCIPLE]);
    expect((outcome.data["debatable"] as unknown[]).length).toBe(DEBATABLE.length);
  });

  it("narrows to the operation asked about and says where it lives instead", async () => {
    const outcome = await call({ operation: "set_card_controls" });
    const first = (outcome.data["refusals"] as Record<string, unknown>[])[0];
    expect(first?.["section"]).toBe(13);
    expect(String(first?.["instead"])).toMatch(/list_card_controls/);
    expect(String(first?.["why"])).toMatch(/real-time authorisation decision/);
  });

  it("says which refusals the database enforces and which we merely do not offer", async () => {
    const outcome = await call({ operation: "approve_payment" });
    const first = (outcome.data["refusals"] as Record<string, unknown>[])[0];
    expect(first?.["guarantee"]).toBe("unrepresentable");
    expect((first?.["enforced_by"] as string[]).join(" ")).toMatch(/actor_only_humans_approve/);
    expect(outcome.summary).toMatch(/enforced by the schema/);
  });

  it("never implies permission when nothing matches", async () => {
    // The dangerous failure: a model asks about something absurd, gets an
    // empty list, and concludes it is allowed.
    const outcome = await call({ operation: "zqx nonexistent operation" });
    expect(outcome.data["matched"]).toBe(0);
    expect(outcome.summary).toMatch(/That is not permission/);
    expect(outcome.summary).toMatch(/does not exist here/);
  });

  it("reports the one write tool honestly", async () => {
    const outcome = await call();
    const can = outcome.data["what_you_can_do"] as Record<string, unknown>;
    expect(can["write_tools"]).toEqual(WRITE_TOOLS.map((t) => t.name));
    expect(can["write_tools"]).toHaveLength(1);
    expect(String(can["write_tools_note"])).toMatch(/NOTHING HAS BEEN PAID/);
  });

  it("can be asked to leave out the arguable ones", async () => {
    expect(await call({ include_debatable: false })).toMatchObject({
      data: { debatable: [] },
    });
  });

  it("reads no customer data, so it needs no gateway", async () => {
    // Called with a context whose gateway would throw if touched. The claim in
    // the tool's description — that it reads nothing about the business — is
    // asserted rather than written.
    const ctx = testContext({
      gateway: new Proxy({} as never, {
        get() {
          throw new Error("list_agent_limits must not touch the gateway");
        },
      }),
    });
    await expect(
      listAgentLimitsTool.run(listAgentLimitsTool.parse({}) as never, ctx),
    ).resolves.toBeDefined();
  });

  it("refuses to take a business identifier from its caller", () => {
    expect(() => listAgentLimitsTool.parse({ business_id: "x" })).toThrow(ToolError);
  });
});
