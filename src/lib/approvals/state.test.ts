import { describe, expect, it } from "vitest";

import {
  STATE_DESCRIPTION,
  STATE_LABEL,
  TERMINAL_STATES,
  canTransition,
  foldState,
  isPending,
  isTerminal,
  nextKinds,
  normaliseKind,
} from "./state";
import { PAYMENT_EVENT_KINDS, PAYMENT_STATES, type PaymentEventKind } from "./types";

const ev = (...kinds: PaymentEventKind[]) => kinds.map((kind) => ({ kind }));

describe("the state machine", () => {
  it("walks requested -> approved -> released -> settled", () => {
    expect(foldState(ev("requested"))).toBe("requested");
    expect(foldState(ev("requested", "approved"))).toBe("approved");
    expect(foldState(ev("requested", "approved", "released"))).toBe("released");
    expect(foldState(ev("requested", "approved", "released", "settled"))).toBe("settled");
  });

  it("walks requested -> rejected, and rejected is terminal", () => {
    expect(foldState(ev("requested", "rejected"))).toBe("rejected");
    expect(isTerminal("rejected")).toBe(true);
    expect(nextKinds("rejected")).toHaveLength(0);
  });

  it("reaches returned and failed only through released", () => {
    expect(foldState(ev("requested", "approved", "released", "returned"))).toBe("returned");
    expect(foldState(ev("requested", "approved", "released", "failed"))).toBe("failed");
    expect(canTransition("approved", "settled")).toBe(false);
    expect(canTransition("released", "settled")).toBe(true);
  });

  it("reads 0001's `submitted` as 0007's `released` — the same fact, two names", () => {
    expect(normaliseKind("submitted")).toBe("released");
    expect(foldState(ev("requested", "approved", "submitted"))).toBe("released");
  });

  /**
   * The fold reads a SET, not a sequence. An out-of-order delivery or two rows
   * written in the same millisecond must not produce a different answer than
   * the same facts arriving tidily — ordering is enforced at INSERT by
   * assert_payment_lifecycle(), not re-litigated on every read.
   */
  it("is order-insensitive", () => {
    const forwards = ev("requested", "approved", "released", "settled");
    const backwards = [...forwards].reverse();
    const shuffled = [forwards[2], forwards[0], forwards[3], forwards[1]].filter(
      (e): e is { kind: PaymentEventKind } => e !== undefined,
    );
    expect(foldState(backwards)).toBe("settled");
    expect(foldState(shuffled)).toBe("settled");
  });

  it("keeps a withdrawn instruction out of the pending queue even after approval", () => {
    expect(foldState(ev("requested", "approved", "cancelled"))).toBe("cancelled");
    expect(isPending("cancelled")).toBe(false);
    expect(isPending("approved")).toBe(true);
    expect(isPending("requested")).toBe(true);
    expect(isPending("released")).toBe(false);
  });

  it("calls an empty set `requested` rather than throwing on a screen", () => {
    expect(foldState([])).toBe("requested");
  });

  it("refuses to approve or release anything that has already been released", () => {
    expect(canTransition("released", "approved")).toBe(false);
    expect(canTransition("released", "released")).toBe(false);
    expect(canTransition("settled", "released")).toBe(false);
  });

  it("allows a second approval while pending — a two-approver rail needs one", () => {
    expect(canTransition("approved", "approved")).toBe(true);
  });

  it("names every state and every event kind", () => {
    for (const state of PAYMENT_STATES) {
      expect(STATE_LABEL[state].length).toBeGreaterThan(0);
      expect(STATE_DESCRIPTION[state].length).toBeGreaterThan(0);
      expect(nextKinds(state)).toBeDefined();
    }
    for (const kind of PAYMENT_EVENT_KINDS) {
      expect(normaliseKind(kind)).toBeTruthy();
    }
  });

  it("has exactly four terminal states", () => {
    expect([...TERMINAL_STATES].sort()).toEqual(["cancelled", "failed", "rejected", "returned"]);
  });
});
