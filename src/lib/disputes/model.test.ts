import { describe, expect, it } from "vitest";

import {
  canTransition,
  caseRef,
  clawbackLines,
  DISPUTE_EVENT_KINDS,
  DISPUTE_STATUSES,
  DISPUTE_STATUS_MEANING,
  disputeHoldRef,
  disputeKeys,
  finalCreditLines,
  holdLines,
  isClosed,
  isDisputeReason,
  networkOutsideDate,
  provisionalCreditLines,
  writeOffLines,
  type DisputeAccounts,
  type DisputeFold,
  type DisputeStatus,
} from "./model";

const ACCOUNTS: DisputeAccounts = {
  customerAccountId: "cust",
  memoAccountId: "memo",
  receivableAccountId: "recv",
  lossAccountId: "loss",
  memoContraAccountId: "contra",
};

const sum = (lines: readonly { amountCents: bigint }[]) =>
  lines.reduce((acc, l) => acc + l.amountCents, 0n);

const on = (lines: readonly { accountId: string; amountCents: bigint }[], id: string) =>
  lines.filter((l) => l.accountId === id).reduce((acc, l) => acc + l.amountCents, 0n);

describe("the postings balance and point the right way", () => {
  it("every posting sums to zero — the thing ledger_append refuses otherwise", () => {
    for (const lines of [
      provisionalCreditLines(ACCOUNTS, 7340n),
      clawbackLines(ACCOUNTS, 7340n),
      writeOffLines(ACCOUNTS, 7340n),
      finalCreditLines(ACCOUNTS, 7340n),
      holdLines(ACCOUNTS, 7340n),
      holdLines(ACCOUNTS, -7340n),
    ]) {
      expect(sum(lines)).toBe(0n);
    }
  });

  it("a provisional credit CREDITS the customer and DEBITS the receivable", () => {
    const lines = provisionalCreditLines(ACCOUNTS, 7340n);
    // 2100 is credit-normal: a NEGATIVE amount_cents is money the customer gains.
    expect(on(lines, "cust")).toBe(-7340n);
    expect(on(lines, "recv")).toBe(7340n);
  });

  it("nothing in the dispute path ever touches cash at the sponsor bank", () => {
    // 1110 is debited only when funds actually land. Winning a dispute is a
    // promise, not an arrival, so no posting here may name a cash account.
    const every = [
      ...provisionalCreditLines(ACCOUNTS, 100n),
      ...clawbackLines(ACCOUNTS, 100n),
      ...writeOffLines(ACCOUNTS, 100n),
      ...finalCreditLines(ACCOUNTS, 100n),
    ];
    expect(every.map((l) => l.accountId)).not.toContain("cash");
  });

  it("a clawback is the grant negated, line for line", () => {
    const grant = provisionalCreditLines(ACCOUNTS, 7340n);
    const claw = clawbackLines(ACCOUNTS, 7340n);
    expect(on(claw, "cust")).toBe(-on(grant, "cust"));
    expect(on(claw, "recv")).toBe(-on(grant, "recv"));
  });

  it("a write-off leaves the customer alone and puts the cost on 5200", () => {
    const lines = writeOffLines(ACCOUNTS, 7340n);
    expect(on(lines, "cust")).toBe(0n);
    expect(on(lines, "loss")).toBe(7340n);
    expect(on(lines, "recv")).toBe(-7340n);
  });

  it("opening a hold CREDITS the credit-normal 9200 leaf — the classic inversion", () => {
    expect(on(holdLines(ACCOUNTS, 7340n), "memo")).toBe(-7340n);
    expect(on(holdLines(ACCOUNTS, -7340n), "memo")).toBe(7340n);
  });

  it("refuses a zero or negative amount rather than posting a zero line", () => {
    expect(() => provisionalCreditLines(ACCOUNTS, 0n)).toThrow(RangeError);
    expect(() => clawbackLines(ACCOUNTS, -1n)).toThrow(RangeError);
    expect(() => holdLines(ACCOUNTS, 0n)).toThrow(RangeError);
  });
});

describe("idempotency keys are derived from the dispute, never generated", () => {
  it("the same dispute always produces the same key", () => {
    const a = "0cb8f0a2-0000-4000-8000-000000000001";
    expect(disputeKeys.provisionalCredit(a)).toBe(disputeKeys.provisionalCredit(a));
    expect(disputeKeys.clawback(a)).toBe(`dispute:clawback:${a}`);
    expect(disputeHoldRef(a)).toBe(`dispute:${a}`);
  });

  it("every step has a DIFFERENT key, so one step cannot swallow another", () => {
    const a = "0cb8f0a2-0000-4000-8000-000000000001";
    const keys = Object.values(disputeKeys).map((fn) => fn(a));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("the transition rules mirror the trigger", () => {
  const base: DisputeFold = {
    status: "raised",
    granted: false,
    declined: false,
    decided: false,
    needsAuthorization: false,
    authorizations: 0,
    requiredApprovals: 1,
  };

  it("grants freely below the threshold", () => {
    expect(canTransition(base, "provisional_credit_granted").allowed).toBe(true);
  });

  it("refuses a grant at or above the threshold with no second human", () => {
    const verdict = canTransition({ ...base, needsAuthorization: true }, "provisional_credit_granted");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe("NEEDS_AUTHORIZATION");
  });

  it("allows the grant once the second human has signed", () => {
    expect(
      canTransition(
        { ...base, needsAuthorization: true, authorizations: 1 },
        "provisional_credit_granted",
      ).allowed,
    ).toBe(true);
  });

  it("will not settle provisional credit twice", () => {
    for (const fold of [
      { ...base, granted: true, status: "provisional_credit_granted" as DisputeStatus },
      { ...base, declined: true, status: "provisional_credit_declined" as DisputeStatus },
    ]) {
      const verdict = canTransition(fold, "provisional_credit_granted");
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.code).toBe("CREDIT_ALREADY_SETTLED");
    }
  });

  it("refuses a withdrawal once money has been advanced — that is a loss, not a withdrawal", () => {
    const verdict = canTransition(
      { ...base, granted: true, status: "provisional_credit_granted" },
      "withdrawn",
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe("CREDIT_OUTSTANDING");
  });

  it("allows a withdrawal while nothing has been advanced", () => {
    expect(canTransition(base, "withdrawn").allowed).toBe(true);
  });

  it("only lets a credit be made final on a case that was won", () => {
    expect(
      canTransition({ ...base, status: "won_pending_finalization", decided: true }, "credit_finalized")
        .allowed,
    ).toBe(true);
    expect(
      canTransition({ ...base, status: "lost_pending_recovery", decided: true }, "credit_finalized")
        .allowed,
    ).toBe(false);
  });

  it("only claws back a case that was lost AND advanced", () => {
    const lostWithCredit: DisputeFold = {
      ...base,
      status: "lost_pending_recovery",
      decided: true,
      granted: true,
    };
    expect(canTransition(lostWithCredit, "credit_clawed_back").allowed).toBe(true);
    expect(canTransition(lostWithCredit, "credit_written_off").allowed).toBe(true);

    const lostWithout: DisputeFold = { ...lostWithCredit, granted: false };
    const verdict = canTransition(lostWithout, "credit_clawed_back");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.code).toBe("NOTHING_ADVANCED");
  });

  it("nothing at all follows a resolution", () => {
    for (const status of [
      "closed_won",
      "closed_lost_recovered",
      "closed_lost_written_off",
      "withdrawn",
    ] as const) {
      expect(isClosed(status)).toBe(true);
      for (const kind of DISPUTE_EVENT_KINDS) {
        if (kind === "raised") continue;
        const verdict = canTransition({ ...base, status }, kind);
        expect(verdict.allowed).toBe(false);
      }
    }
  });
});

describe("dates and references", () => {
  it("the outside date is 120 days out and crosses a month end correctly", () => {
    expect(networkOutsideDate("2026-09-10")).toBe("2027-01-08");
    expect(networkOutsideDate("2026-09-10", 1)).toBe("2026-09-11");
  });

  it("a case reference is sayable and is not a uuid", () => {
    const ref = caseRef("2026-09-10", "k3x9pq");
    expect(ref).toBe("DSP-20260910-K3X9PQ");
    expect(ref).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("refuses a value date it cannot parse rather than inventing one", () => {
    expect(() => networkOutsideDate("not-a-date")).toThrow(RangeError);
  });
});

describe("vocabulary", () => {
  it("every status has a sentence an operator can read", () => {
    for (const status of DISPUTE_STATUSES) {
      expect(DISPUTE_STATUS_MEANING[status].length).toBeGreaterThan(20);
    }
  });

  it("recognises our reasons and nothing else", () => {
    expect(isDisputeReason("fraud")).toBe(true);
    expect(isDisputeReason("chargeback")).toBe(false);
    expect(isDisputeReason(undefined)).toBe(false);
  });
});
