import { describe, expect, it } from "vitest";

import { decisionGate, releaseGate, type GateActor } from "./gate";

const DANA: GateActor = {
  id: "76f9266f-23c9-52de-b8ff-0ec0b23ef386",
  displayName: "Dana Okonkwo",
  kind: "human",
  canApprove: true,
};

const PRIYA: GateActor = {
  id: "b3c4f786-5d1b-5194-9aae-6342ba0ef606",
  displayName: "Priya Raman",
  kind: "human",
  canApprove: false,
};

const AGENT: GateActor = {
  id: "3743dc53-4e1c-577e-9a0f-e4469ffc1761",
  displayName: "Corgi payments agent",
  kind: "agent",
  canApprove: false,
};

const raisedByPriya = {
  state: "requested" as const,
  initiatorActorId: PRIYA.id,
  initiatorName: PRIYA.displayName,
};

/**
 * These cases mirror `approvals.integration.test.ts`, which walks the same
 * situations against the live database. This file asserts what the SCREEN says;
 * that file asserts what Postgres DOES. They must agree, and when they do not,
 * Postgres is right.
 */
describe("decisionGate", () => {
  it("lets an approver decide somebody else's payment", () => {
    const gate = decisionGate({ ...raisedByPriya, actor: DANA });
    expect(gate.allowed).toBe(true);
    expect(gate.code).toBe("ok");
  });

  it("refuses the initiator — even when the initiator is an approver", () => {
    const gate = decisionGate({
      state: "requested",
      initiatorActorId: DANA.id,
      initiatorName: DANA.displayName,
      actor: DANA,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.code).toBe("self_initiated");
    // The reason must name the mechanism, not just say no: an operator who is
    // refused needs to know this is a control, not a glitch.
    expect(gate.reason).toMatch(/cannot approve it/);
    expect(gate.reason).toMatch(/42501/);
  });

  it("says 'you raised this one' before 'you cannot approve anything'", () => {
    // Priya can approve nothing AND raised this one. The specific fact wins.
    const gate = decisionGate({ ...raisedByPriya, actor: PRIYA });
    expect(gate.code).toBe("self_initiated");
  });

  it("refuses a human who holds no approval rights", () => {
    const gate = decisionGate({
      state: "requested",
      initiatorActorId: DANA.id,
      initiatorName: DANA.displayName,
      actor: PRIYA,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.code).toBe("not_an_approver");
    expect(gate.reason).toMatch(/can_approve/);
  });

  it("refuses an agent, and says why it could never be otherwise", () => {
    const gate = decisionGate({ ...raisedByPriya, actor: AGENT });
    expect(gate.allowed).toBe(false);
    expect(gate.code).toBe("not_an_approver");
    expect(gate.reason).toMatch(/actor_only_humans_approve/);
    expect(gate.reason).toMatch(/unrepresentable/);
  });

  it("refuses when nobody is signed in", () => {
    expect(decisionGate({ ...raisedByPriya, actor: null }).code).toBe("no_actor");
  });

  it("refuses a decision on anything already released or closed", () => {
    for (const state of ["released", "settled", "rejected", "cancelled"] as const) {
      const gate = decisionGate({ ...raisedByPriya, state, actor: DANA });
      expect(gate.allowed).toBe(false);
      expect(gate.code).toBe("not_pending");
    }
  });
});

describe("releaseGate", () => {
  const base = { ...raisedByPriya, actor: DANA, approvalsHeld: 0, approvalsRequired: 1 };

  it("refuses a release that does not hold the approvals its version demands", () => {
    const gate = releaseGate(base);
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/Needs 1 approval\(s\)/);
    expect(gate.reason).toMatch(/Priya Raman/);
  });

  it("allows it once the approvals are held", () => {
    expect(releaseGate({ ...base, approvalsHeld: 1 }).allowed).toBe(true);
  });

  /**
   * Below threshold the required count is zero and the SAME path runs. DESIGN
   * §16: "one mechanism, not two."
   */
  it("allows a below-threshold release with no approval at all", () => {
    const gate = releaseGate({ ...base, approvalsRequired: 0 });
    expect(gate.allowed).toBe(true);
  });

  /**
   * Releasing is not approving. The initiator may release their own payment
   * once somebody else has approved it — maker-checker is about the DECISION,
   * not about who presses the button afterwards.
   */
  it("lets the initiator release a payment somebody else approved", () => {
    const gate = releaseGate({
      state: "approved",
      initiatorActorId: PRIYA.id,
      initiatorName: PRIYA.displayName,
      actor: PRIYA,
      approvalsHeld: 1,
      approvalsRequired: 1,
    });
    expect(gate.allowed).toBe(true);
  });

  it("says a second release would post nothing", () => {
    const gate = releaseGate({ ...base, state: "released", approvalsHeld: 1 });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/keyed on the instruction id/);
  });
});
