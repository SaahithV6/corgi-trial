import { describe, expect, it } from "vitest";

import {
  decideMove,
  identityOf,
  isMoveDirection,
  isPotNegativeRefusal,
  moveDescription,
  moveIdempotencyKey,
  POT_NEGATIVE_CODE,
  transferLegs,
  type Availability,
} from "./model";

/**
 * The pots decision rules, without a database.
 *
 * These are the rules the screen draws itself from and the rules the
 * transaction re-runs behind `lock_business_deposits()`. Same function, both
 * times — so a test of it is a test of both.
 */

const flush: Availability = {
  ledgerCents: 100_000n,
  holdsCents: 0n,
  unclearedCents: 0n,
  pendingOutboundCents: 0n,
  availableCents: 100_000n,
};

/** Ledger covers it; available does not. The case the edge state shows. */
const committed: Availability = {
  ledgerCents: 100_000n,
  holdsCents: 30_000n,
  unclearedCents: 25_000n,
  pendingOutboundCents: 0n,
  availableCents: 45_000n,
};

describe("decideMove — into a pot", () => {
  it("allows a move covered by AVAILABLE", () => {
    const d = decideMove(
      { direction: "in", amountCents: 45_000n },
      { availability: committed, potBalanceCents: 0n, potName: "Payroll" },
    );
    expect(d).toEqual({ kind: "allow", amountCents: 45_000n });
  });

  it("refuses a move the LEDGER covers but AVAILABLE does not", () => {
    const d = decideMove(
      { direction: "in", amountCents: 60_000n },
      { availability: committed, potBalanceCents: 0n, potName: "Payroll" },
    );

    expect(d.kind).toBe("refuse");
    if (d.kind !== "refuse") return;
    expect(d.code).toBe("INSUFFICIENT_AVAILABLE");
    expect(d.requestedCents).toBe(60_000n);
    expect(d.coverCents).toBe(45_000n);
    expect(d.shortfallCents).toBe(15_000n);
    // The refusal has to carry the arithmetic, not just the verdict: a customer
    // looking at $1,000.00 of ledger balance being told they have $450.00 needs
    // the two subtractions in front of them.
    expect(d.reason).toContain("$1,000.00");
    expect(d.reason).toContain("$300.00");
    expect(d.reason).toContain("$250.00");
    expect(d.reason).toContain("$450.00");
    expect(d.reason).toContain("LEDGER balance covers it");
  });

  it("says so when the ledger does not cover it either", () => {
    const d = decideMove(
      { direction: "in", amountCents: 200_000n },
      { availability: committed, potBalanceCents: 0n, potName: "Payroll" },
    );
    expect(d.kind).toBe("refuse");
    if (d.kind !== "refuse") return;
    expect(d.reason).toContain("does not cover it either");
  });

  it("allows exactly the available balance, and refuses one cent past it", () => {
    expect(
      decideMove(
        { direction: "in", amountCents: 45_000n },
        { availability: committed, potBalanceCents: 0n, potName: "P" },
      ).kind,
    ).toBe("allow");
    expect(
      decideMove(
        { direction: "in", amountCents: 45_001n },
        { availability: committed, potBalanceCents: 0n, potName: "P" },
      ).kind,
    ).toBe("refuse");
  });

  it("refuses zero and negative amounts rather than inverting the direction", () => {
    for (const amount of [0n, -1n, -45_000n]) {
      const d = decideMove(
        { direction: "in", amountCents: amount },
        { availability: flush, potBalanceCents: 0n, potName: "P" },
      );
      expect(d.kind).toBe("refuse");
      if (d.kind !== "refuse") return;
      expect(d.code).toBe("AMOUNT_NOT_POSITIVE");
    }
  });
});

describe("decideMove — out of a pot", () => {
  it("is capped by the pot's own balance, not by the main account", () => {
    // Nothing available on the main leaf at all, and it does not matter: money
    // coming OUT of a pot lands there rather than leaving it.
    const broke: Availability = {
      ledgerCents: 0n,
      holdsCents: 0n,
      unclearedCents: 0n,
      pendingOutboundCents: 0n,
      availableCents: 0n,
    };
    expect(
      decideMove(
        { direction: "out", amountCents: 20_000n },
        { availability: broke, potBalanceCents: 20_000n, potName: "Payroll" },
      ),
    ).toEqual({ kind: "allow", amountCents: 20_000n });
  });

  it("refuses to overdraw a pot", () => {
    const d = decideMove(
      { direction: "out", amountCents: 20_001n },
      { availability: flush, potBalanceCents: 20_000n, potName: "Payroll" },
    );
    expect(d.kind).toBe("refuse");
    if (d.kind !== "refuse") return;
    expect(d.code).toBe("INSUFFICIENT_POT");
    expect(d.shortfallCents).toBe(1n);
  });

  it("a move out is fully reversible: out then in restores the figures", () => {
    // Not a claim about the database — a claim about the RULES. Moving $500
    // out of a pot and back in is two allowed moves, with no special case for
    // "undo" in either direction, because an undo is an ordinary transfer.
    const out = decideMove(
      { direction: "out", amountCents: 50_000n },
      { availability: flush, potBalanceCents: 50_000n, potName: "Payroll" },
    );
    expect(out.kind).toBe("allow");

    const backIn = decideMove(
      { direction: "in", amountCents: 50_000n },
      {
        availability: {
          ledgerCents: 150_000n,
          holdsCents: 0n,
          unclearedCents: 0n,
          pendingOutboundCents: 0n,
          availableCents: 150_000n,
        },
        potBalanceCents: 0n,
        potName: "Payroll",
      },
    );
    expect(backIn.kind).toBe("allow");
  });
});

describe("transferLegs", () => {
  it("posts two lines that sum to zero, main debited when money goes in", () => {
    const legs = transferLegs({
      mainAccountId: "main",
      potAccountId: "pot",
      potName: "Payroll",
      direction: "in",
      amountCents: 50_000n,
    });

    expect(legs).toHaveLength(2);
    expect(legs[0].accountId).toBe("main");
    expect(legs[0].amountCents).toBe(50_000n); // DEBIT: we owe less on this leaf
    expect(legs[1].accountId).toBe("pot");
    expect(legs[1].amountCents).toBe(-50_000n); // CREDIT: we owe more on that one
    expect(legs[0].amountCents + legs[1].amountCents).toBe(0n);
  });

  it("reverses the two sides for a move out, and still sums to zero", () => {
    const legs = transferLegs({
      mainAccountId: "main",
      potAccountId: "pot",
      potName: "Payroll",
      direction: "out",
      amountCents: 50_000n,
    });

    expect(legs[0].accountId).toBe("pot");
    expect(legs[0].amountCents).toBe(50_000n);
    expect(legs[1].accountId).toBe("main");
    expect(legs[1].amountCents).toBe(-50_000n);
    expect(legs[0].amountCents + legs[1].amountCents).toBe(0n);
  });

  it("never emits a zero line", () => {
    // A zero line is always a bug in an allocation; postEntry() throws on one
    // and the schema CHECKs it. Nothing here can produce one for a positive
    // amount, and decideMove refuses the amounts that could.
    const legs = transferLegs({
      mainAccountId: "main",
      potAccountId: "pot",
      potName: "P",
      direction: "in",
      amountCents: 1n,
    });
    for (const leg of legs) expect(leg.amountCents).not.toBe(0n);
  });
});

describe("moveIdempotencyKey", () => {
  it("is derived from the pot, the direction and the operator's reference", () => {
    expect(moveIdempotencyKey("pot-1", "in", "payroll-2026-09")).toBe(
      "pot:pot-1:in:payroll-2026-09",
    );
  });

  it("is stable across calls — nothing generated goes into it", () => {
    const a = moveIdempotencyKey("pot-1", "in", "payroll-2026-09");
    const b = moveIdempotencyKey("pot-1", "in", "payroll-2026-09");
    expect(a).toBe(b);
  });

  it("does NOT include the amount, so a resubmit is a replay and not a second transfer", () => {
    // The reference names the movement. If the amount were in the key, sending
    // "payroll-2026-09" again for a different figure would quietly post a
    // SECOND entry — which is the exact failure idempotency exists to prevent.
    const first = moveIdempotencyKey("pot-1", "in", "payroll-2026-09");
    const retypedAmount = moveIdempotencyKey("pot-1", "in", "payroll-2026-09");
    expect(retypedAmount).toBe(first);
  });

  it("separates the two directions, so an undo is its own fact", () => {
    expect(moveIdempotencyKey("pot-1", "in", "r")).not.toBe(
      moveIdempotencyKey("pot-1", "out", "r"),
    );
  });

  it("is prefixed 'pot:' — which is what v_internal_transfer_impure selects on", () => {
    expect(moveIdempotencyKey("pot-1", "in", "r").startsWith("pot:")).toBe(true);
  });
});

describe("identityOf", () => {
  it("computes main + Σ pots and agrees with the recursive subtree walk", () => {
    const id = identityOf(
      1_000_000n,
      [
        { potId: "a", name: "Payroll", balanceCents: 250_000n },
        { potId: "b", name: "Tax", balanceCents: 125_000n },
      ],
      1_375_000n,
    );
    expect(id.potsCents).toBe(375_000n);
    expect(id.totalCents).toBe(1_375_000n);
    expect(id.subtreeCents).toBe(1_375_000n);
    expect(id.holds).toBe(true);
  });

  it("reports disagreement rather than papering over it", () => {
    const id = identityOf(
      1_000_000n,
      [{ potId: "a", name: "Payroll", balanceCents: 250_000n }],
      1_300_000n,
    );
    expect(id.holds).toBe(false);
    expect(id.totalCents - id.subtreeCents).toBe(-50_000n);
  });

  it("holds with no pots at all — the identity degenerates to main = subtree", () => {
    const id = identityOf(1_000_000n, [], 1_000_000n);
    expect(id.potsCents).toBe(0n);
    expect(id.holds).toBe(true);
  });

  it("handles an overdrawn main account without clamping", () => {
    // A deposit account is allowed to be negative (an over-captured fuel-pump
    // authorisation). A POT is not, which is v_pot_negative's job — but the
    // identity still has to add up when the main leaf is below zero.
    const id = identityOf(-5_000n, [{ potId: "a", name: "P", balanceCents: 10_000n }], 5_000n);
    expect(id.totalCents).toBe(5_000n);
    expect(id.holds).toBe(true);
  });
});

describe("moveDescription and isMoveDirection", () => {
  it("names the pot and the reference in the journal entry's own description", () => {
    expect(moveDescription("Payroll", "in", "payroll-2026-09")).toContain("Payroll");
    expect(moveDescription("Payroll", "in", "payroll-2026-09")).toContain(
      "payroll-2026-09",
    );
    expect(moveDescription("Payroll", "out", "r")).toContain("release");
  });

  it("accepts only the two directions", () => {
    expect(isMoveDirection("in")).toBe(true);
    expect(isMoveDirection("out")).toBe(true);
    expect(isMoveDirection("sideways")).toBe(false);
    expect(isMoveDirection(undefined)).toBe(false);
  });
});

describe("isPotNegativeRefusal — migration 0057's floor, recognised by name", () => {
  /**
   * A database refusal becomes a NAMED refusal by naming itself. This is the
   * `pot_name_unique` test in `openPot` one layer up, and it matches on the
   * CODE TOKEN rather than the prose around it, so rewording the sentence a
   * human reads cannot quietly turn `POT_WOULD_GO_NEGATIVE` back into
   * `MOVE_FAILED`.
   */
  const real =
    'POT_WOULD_GO_NEGATIVE: pot "Payroll — October" ' +
    "(a94a4e92-19af-4004-8fc9-d3b77f23df0c) would hold -98800000 cents, " +
    "which is less than nothing";

  it("recognises the message the trigger actually raised", () => {
    expect(isPotNegativeRefusal(real)).toBe(true);
    expect(real).toContain(POT_NEGATIVE_CODE);
  });

  it("recognises it wrapped in whatever the driver prepends", () => {
    expect(isPotNegativeRefusal(`PostgresError: ${real}`)).toBe(true);
  });

  it("does not claim every other database error", () => {
    // The three that matter: a different structural refusal, the replay
    // constraint, and the refusal `decideMove()` raises itself. None of them
    // is this one, and treating them as it would report the wrong fix.
    expect(
      isPotNegativeRefusal(
        "journal entry 3ab2aa97 has lines in the wrong book/entity/currency, or posts to a rollup account",
      ),
    ).toBe(false);
    expect(
      isPotNegativeRefusal(
        'duplicate key value violates unique constraint "pot_name_unique"',
      ),
    ).toBe(false);
    expect(isPotNegativeRefusal("INSUFFICIENT_POT")).toBe(false);
    expect(isPotNegativeRefusal("")).toBe(false);
  });

  it("is not fooled by the prose alone — the token is the contract", () => {
    // The sentence without its code is NOT this refusal. If the trigger ever
    // stops emitting the token, this must go red rather than keep passing on
    // a phrase that happens to survive.
    expect(
      isPotNegativeRefusal(
        'pot "Payroll — October" would hold -98800000 cents, which is less than nothing',
      ),
    ).toBe(false);
  });
});
