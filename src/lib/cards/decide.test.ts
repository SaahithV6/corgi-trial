import { describe, expect, it } from "vitest";

import { decide, RULE_ORDER } from "./decide";
import { DECISION_RULES, type AuthRequest, type CardControls, type ControlLookup } from "./types";

/* -------------------------------------------------------------------------- */
/* Builders                                                                   */
/* -------------------------------------------------------------------------- */

function request(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    providerAuthToken: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    card: { token: "card-token", lastFour: "2081", memo: "corgi", state: "OPEN" },
    amountCents: 5_000n,
    mcc: "5542",
    merchantDescriptor: "CORGI FUEL PUMP 14",
    requestStatus: "AUTHORIZATION",
    ...overrides,
  };
}

function controls(overrides: Partial<CardControls> = {}): CardControls {
  return {
    cardId: "card-id",
    controlVersionId: "version-id",
    version: 4,
    effectiveFrom: "2026-09-10T18:00:00.000Z",
    cardState: "active",
    perTxnLimitCents: null,
    dailyLimitCents: null,
    monthlyLimitCents: null,
    blockedMccs: [],
    note: "",
    ...overrides,
  };
}

function read(
  c: CardControls | null,
  spend: { dayCents: bigint; monthCents: bigint } = { dayCents: 0n, monthCents: 0n },
): ControlLookup {
  return { status: "read", cardId: c?.cardId ?? "card-id", controls: c, spend };
}

/* -------------------------------------------------------------------------- */

describe("decide — the rule table", () => {
  it("declares every rule in the closed set, and no others", () => {
    // If someone adds a rule to the type and forgets to wire it into the
    // evaluation order, or wires one in that the type does not know about,
    // this fails before the branch is ever reached in anger.
    expect([...RULE_ORDER].sort()).toEqual([...DECISION_RULES].sort());
    expect(new Set(RULE_ORDER).size).toBe(RULE_ORDER.length);
  });
});

describe("decide — fail closed when the control store is unavailable", () => {
  const lookup: ControlLookup = { status: "unavailable", detail: "DeadlineExceededError: 600ms" };

  it("declines", () => {
    const verdict = decide(request(), lookup);
    expect(verdict.outcome).toBe("decline");
    expect(verdict.rule).toBe("control_store_unavailable");
  });

  it("uses the one decline reason the network documents as retryable", () => {
    expect(decide(request(), lookup).result).toBe("VELOCITY_EXCEEDED");
  });

  it("records the driver detail so the decline is explainable later", () => {
    const verdict = decide(request(), lookup);
    expect(verdict.inputs["detail"]).toBe("DeadlineExceededError: 600ms");
    expect(verdict.inputs["fail_mode"]).toBe("closed");
  });

  it("fails closed even for a request that every other rule would approve", () => {
    // A $1 coffee on a card with no controls at all. The point of fail-closed
    // is that we do not know that, so we do not act as if we do.
    const verdict = decide(request({ amountCents: 100n, mcc: "5812" }), lookup);
    expect(verdict.outcome).toBe("decline");
  });
});

describe("decide — an unknown card token is out of scope, not a decline", () => {
  const lookup: ControlLookup = {
    status: "read",
    cardId: null,
    controls: null,
    spend: { dayCents: 0n, monthCents: 0n },
  };

  it("approves", () => {
    const verdict = decide(request(), lookup);
    expect(verdict.outcome).toBe("approve");
    expect(verdict.rule).toBe("card_not_under_control");
    expect(verdict.result).toBe("APPROVED");
  });

  it("labels the fail mode OPEN, opposite to the unavailable branch", () => {
    // The distinction is the argument: 'the read succeeded and the answer is
    // no controls' versus 'we do not know the answer'. They get opposite
    // defaults on purpose, and the record says which one happened.
    expect(decide(request(), lookup).inputs["fail_mode"]).toBe("open");
    expect(
      decide(request(), { status: "unavailable", detail: "x" }).inputs["fail_mode"],
    ).toBe("closed");
  });
});

describe("decide — a registered card with no controls", () => {
  it("approves and says so", () => {
    const verdict = decide(request({ amountCents: 10_000_000n }), read(null));
    expect(verdict.outcome).toBe("approve");
    expect(verdict.rule).toBe("no_controls_configured");
    expect(verdict.inputs["control_version"]).toBeNull();
  });
});

describe("decide — the freeze switch", () => {
  it("declines with CARD_PAUSED", () => {
    const verdict = decide(request(), read(controls({ cardState: "frozen" })));
    expect(verdict.outcome).toBe("decline");
    expect(verdict.rule).toBe("card_frozen");
    expect(verdict.result).toBe("CARD_PAUSED");
  });

  it("beats every other control", () => {
    // A frozen card whose amount, MCC and velocity would all have passed.
    const verdict = decide(
      request({ amountCents: 1n, mcc: "5812" }),
      read(controls({ cardState: "frozen", perTxnLimitCents: 1_000_000n })),
    );
    expect(verdict.rule).toBe("card_frozen");
  });

  it("cites the control version in the reason a cardholder would read", () => {
    const verdict = decide(request(), read(controls({ cardState: "frozen", version: 9 })));
    expect(verdict.reason).toContain("version 9");
  });
});

describe("decide — merchant category blocks", () => {
  it("declines a blocked MCC with UNAUTHORIZED_MERCHANT", () => {
    const verdict = decide(request({ mcc: "5542" }), read(controls({ blockedMccs: ["5542"] })));
    expect(verdict.outcome).toBe("decline");
    expect(verdict.rule).toBe("mcc_blocked");
    expect(verdict.result).toBe("UNAUTHORIZED_MERCHANT");
    expect(verdict.inputs["matched_mcc"]).toBe("5542");
  });

  it("approves an MCC that is not on the list", () => {
    const verdict = decide(request({ mcc: "5812" }), read(controls({ blockedMccs: ["5542"] })));
    expect(verdict.outcome).toBe("approve");
  });

  it("does NOT decline when the request carries no MCC", () => {
    // The absence of evidence is not evidence. Declining here would decline a
    // real purchase because a terminal sent a malformed field.
    const verdict = decide(request({ mcc: null }), read(controls({ blockedMccs: ["5542"] })));
    expect(verdict.outcome).toBe("approve");
    expect(verdict.inputs["mcc"]).toBeNull();
  });

  it("compares MCCs as strings so a leading zero survives", () => {
    // '0742' is a veterinary surgeon. 742 is nothing. If either side of this
    // comparison were ever a number the block would silently stop working.
    const verdict = decide(request({ mcc: "0742" }), read(controls({ blockedMccs: ["0742"] })));
    expect(verdict.rule).toBe("mcc_blocked");
  });
});

describe("decide — the per-transaction limit", () => {
  it("declines an amount over the limit", () => {
    const verdict = decide(
      request({ amountCents: 5_000n }),
      read(controls({ perTxnLimitCents: 1_000n })),
    );
    expect(verdict.outcome).toBe("decline");
    expect(verdict.rule).toBe("per_transaction_limit_exceeded");
    expect(verdict.inputs["over_by_cents"]).toBe("4000");
  });

  it("APPROVES an amount exactly equal to the limit", () => {
    // A $10 limit permits $10. The off-by-one here is the difference between a
    // limit that means what it says and one that means $9.99.
    const verdict = decide(
      request({ amountCents: 1_000n }),
      read(controls({ perTxnLimitCents: 1_000n })),
    );
    expect(verdict.outcome).toBe("approve");
  });

  it("treats a zero limit as 'this card may spend nothing', not as 'no limit'", () => {
    const verdict = decide(request({ amountCents: 1n }), read(controls({ perTxnLimitCents: 0n })));
    expect(verdict.rule).toBe("per_transaction_limit_exceeded");
  });

  it("treats a null limit as no limit", () => {
    const verdict = decide(
      request({ amountCents: 9_999_999_999n }),
      read(controls({ perTxnLimitCents: null })),
    );
    expect(verdict.outcome).toBe("approve");
  });
});

describe("decide — velocity", () => {
  it("declines when this authorisation would take the card past the daily limit", () => {
    const verdict = decide(
      request({ amountCents: 600n }),
      read(controls({ dailyLimitCents: 1_000n }), { dayCents: 500n, monthCents: 500n }),
    );
    expect(verdict.rule).toBe("daily_limit_exceeded");
    expect(verdict.inputs["would_total_cents"]).toBe("1100");
    expect(verdict.inputs["over_by_cents"]).toBe("100");
  });

  it("approves when the total lands exactly on the limit", () => {
    const verdict = decide(
      request({ amountCents: 500n }),
      read(controls({ dailyLimitCents: 1_000n }), { dayCents: 500n, monthCents: 500n }),
    );
    expect(verdict.outcome).toBe("approve");
  });

  it("checks the day before the month", () => {
    const verdict = decide(
      request({ amountCents: 100n }),
      read(controls({ dailyLimitCents: 1n, monthlyLimitCents: 1n }), {
        dayCents: 0n,
        monthCents: 0n,
      }),
    );
    expect(verdict.rule).toBe("daily_limit_exceeded");
  });

  it("declines on the monthly limit when the day is fine", () => {
    const verdict = decide(
      request({ amountCents: 100n }),
      read(controls({ dailyLimitCents: 100_000n, monthlyLimitCents: 1_000n }), {
        dayCents: 0n,
        monthCents: 950n,
      }),
    );
    expect(verdict.rule).toBe("monthly_limit_exceeded");
  });

  it("names the book clock the window was measured on", () => {
    const verdict = decide(
      request({ amountCents: 100n }),
      read(controls({ dailyLimitCents: 1n })),
    );
    expect(verdict.inputs["window_basis"]).toBe("book_date (America/New_York)");
  });

  it("holds exact arithmetic past Number.MAX_SAFE_INTEGER", () => {
    // $90 trillion is reachable in a fuzz test and a silent precision loss in
    // a spending limit is the worst class of bug there is.
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const verdict = decide(
      request({ amountCents: 1n }),
      read(controls({ dailyLimitCents: huge }), { dayCents: huge, monthCents: 0n }),
    );
    expect(verdict.rule).toBe("daily_limit_exceeded");
    expect(verdict.inputs["would_total_cents"]).toBe("9007199254740994");
  });
});

describe("decide — what is not a purchase", () => {
  it("approves a balance inquiry regardless of the limits", () => {
    const verdict = decide(
      request({ requestStatus: "BALANCE_INQUIRY", amountCents: 0n }),
      read(controls({ perTxnLimitCents: 0n, dailyLimitCents: 0n })),
    );
    expect(verdict.outcome).toBe("approve");
    expect(verdict.rule).toBe("balance_inquiry_not_a_purchase");
  });

  it("approves a credit authorisation on a card that has spent its limit", () => {
    // A refund must not be declined because the card already spent its daily
    // limit — the customer would be unable to receive their own money back.
    const verdict = decide(
      request({ requestStatus: "CREDIT_AUTHORIZATION", amountCents: 4_000n }),
      read(controls({ dailyLimitCents: 1_000n }), { dayCents: 1_000n, monthCents: 1_000n }),
    );
    expect(verdict.outcome).toBe("approve");
    expect(verdict.rule).toBe("credit_not_a_purchase");
  });

  it("still declines a frozen card's balance inquiry? no — freeze is about spend", () => {
    // Documented by assertion rather than left ambiguous: a balance inquiry on
    // a frozen card is approved, because it moves no money. Freezing a card
    // stops it spending; it does not stop the cardholder finding out what is
    // on it.
    const verdict = decide(
      request({ requestStatus: "BALANCE_INQUIRY", amountCents: 0n }),
      read(controls({ cardState: "frozen" })),
    );
    expect(verdict.outcome).toBe("approve");
    expect(verdict.rule).toBe("balance_inquiry_not_a_purchase");
  });
});

describe("decide — the record it leaves", () => {
  it("never puts a JSON number where money belongs", () => {
    // Every money value in `inputs` must be a decimal string. JSON.parse turns
    // 9007199254740993 into ...992, and a control that silently rounds is a
    // control that silently fails open.
    const verdict = decide(
      request({ amountCents: 5_000n }),
      read(controls({ perTxnLimitCents: 1_000n })),
    );
    for (const [key, value] of Object.entries(verdict.inputs)) {
      if (key.endsWith("_cents")) expect(typeof value).toBe("string");
    }
  });

  it("gives an approval the figures it approved against", () => {
    const verdict = decide(
      request({ amountCents: 100n, mcc: "5812" }),
      read(controls({ dailyLimitCents: 5_000n, monthlyLimitCents: 20_000n }), {
        dayCents: 300n,
        monthCents: 900n,
      }),
    );
    expect(verdict.rule).toBe("within_controls");
    expect(verdict.inputs["daily_spend_cents"]).toBe("300");
    expect(verdict.inputs["monthly_spend_cents"]).toBe("900");
    expect(verdict.inputs["daily_limit_cents"]).toBe("5000");
  });

  it("is deterministic — the same inputs give the same verdict", () => {
    const a = decide(request(), read(controls({ blockedMccs: ["5542"] })));
    const b = decide(request(), read(controls({ blockedMccs: ["5542"] })));
    expect(a).toEqual(b);
  });
});
