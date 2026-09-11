/**
 * An approval that judged nothing must not be counted as one that was judged.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE FINDING THIS SUITE EXISTS FOR
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Re-measured against the live book rather than inherited from an earlier
 * audit, whole history of `card_auth_decision` (145 rows):
 *
 *     63 provider-lane approvals
 *       44  no_controls_configured   approved by a rule that compared nothing
 *       11  card_not_under_control   approved by a rule that compared nothing
 *        8  within_controls          approved by a rule that compared something
 *
 *     936 cards, 44 with any control version at all.
 *
 * 87% of the approvals this system points at as evidence that card controls
 * work were produced by a branch that never read a control. Both branches are
 * correct — `decide()` argues both at length and neither is changed — but until
 * this field existed, all 63 rows said `outcome: 'approve'` and nothing else.
 * A card with no controls was indistinguishable, in the approval log, from a
 * card whose controls said yes.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THIS SUITE IS WORTH ITS OWN FILE, AND WHAT IT WAS SEEN TO CATCH
 * ════════════════════════════════════════════════════════════════════════════
 *
 * "An invariant never seen to fail is not trusted here." These assertions were
 * run against the code as it stood BEFORE the fix. Verbatim, the first two:
 *
 *     AssertionError: expected undefined to be false
 *       ❯ src/lib/cards/judged.test.ts
 *         expect(verdict.judged).toBe(false);
 *
 *     AssertionError: expected undefined to be false
 *       ❯ src/lib/cards/judged.test.ts
 *         expect(verdict.inputs["judged"]).toBe(false);
 *
 * `undefined` is the whole finding in one word: the old verdict had no opinion
 * about whether anything had been compared, so every reader that wanted one had
 * to invent it, and the readers that did not want one counted 63.
 *
 * NOTE THE SHAPE OF THE LAST TEST IN SECTION 2 PARTICULARLY. It counts the way
 * a scoreboard counts — `filter(d => d.outcome === "approve").length` — over a
 * list holding one judged approval and one unjudged one, and asserts that the
 * honest figure is 1 and not 2. That is the exact arithmetic the "51 approvals"
 * claim was made with, run against a population where the answer is known.
 */
import { describe, expect, it } from "vitest";

import { decide } from "./decide";
import { RULE_ORDER } from "./decide";
import {
  DECISION_RULES,
  UNJUDGED_RULES,
  isJudgedRule,
  type AuthRequest,
  type CardControls,
  type ControlLookup,
  type DecisionRecord,
  type MemberDecisionTerms,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Builders — the same shapes decide.test.ts uses, so the two agree            */
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

function member(overrides: Partial<MemberDecisionTerms> = {}): MemberDecisionTerms {
  return {
    memberId: "member-id",
    memberVersionId: "member-version-id",
    version: 1,
    displayName: "Noor Haddad",
    state: "active",
    role: "initiator",
    perTxnLimitCents: null,
    dailyLimitCents: null,
    monthlyLimitCents: null,
    ...overrides,
  };
}

const NO_SPEND = { dayCents: 0n, monthCents: 0n };

/** A card this book knows, with whatever controls and holder are passed. */
function read(
  c: CardControls | null,
  m: MemberDecisionTerms | null = null,
): ControlLookup {
  return {
    status: "read",
    cardId: c?.cardId ?? "card-id",
    controls: c,
    spend: NO_SPEND,
    member: m,
    memberSpend: NO_SPEND,
  };
}

/** One decision-log row, as a screen or a scoreboard reads it. */
function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "decision-id",
    decidedAt: "2026-09-11T14:07:00.000Z",
    provider: "lithic",
    providerAuthToken: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    providerCardToken: "card-token",
    cardId: "card-id",
    lastFour: "2081",
    nickname: "Contractor card",
    controlVersion: null,
    amountCents: 5_000n,
    mcc: "5542",
    merchantDescriptor: "CORGI FUEL PUMP 14",
    requestStatus: "AUTHORIZATION",
    outcome: "approve",
    resultCode: "APPROVED",
    rule: "no_controls_configured",
    judged: false,
    reason: "No controls have been set on this card.",
    inputs: {},
    decisionLatencyUs: 4_118,
    source: "provider",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* 1. THE RED ONE — an auth on a card with no controls                        */
/* -------------------------------------------------------------------------- */

describe("an authorisation on a card with no controls", () => {
  // THE EXACT SCENARIO BEHIND 44 OF THE 63 PROVIDER-LANE APPROVALS: a card this
  // book has registered, that nobody ever configured, that belongs to nobody.
  const lookup = read(null, null);

  it("is still approved — the fail-open is deliberate and is NOT changed here", () => {
    // Stated first so that no reader of this file can mistake it for a
    // behaviour change. A card with no controls goes on approving exactly as
    // it did; `decide()`'s header argues why, and 756 live cards depend on it.
    const verdict = decide(request({ amountCents: 10_000_000n }), lookup);
    expect(verdict.outcome).toBe("approve");
    expect(verdict.result).toBe("APPROVED");
    expect(verdict.rule).toBe("no_controls_configured");
  });

  it("is NOT a judged approval", () => {
    // ON THE OLD CODE: AssertionError: expected undefined to be false.
    const verdict = decide(request(), lookup);
    expect(verdict.judged).toBe(false);
  });

  it("says so in the row it writes, in the decision's own words", () => {
    // ON THE OLD CODE: AssertionError: expected undefined to be false.
    // `inputs` is the jsonb column, so this is what a dispute reads in
    // September. Not a classification a screen applied afterwards.
    const verdict = decide(request(), lookup);
    expect(verdict.inputs["judged"]).toBe(false);
  });

  it("is not counted as a judged approval by a reader counting approvals", () => {
    // THE ARITHMETIC THE "51 APPROVALS" CLAIM WAS MADE WITH, run over a
    // population where the right answer is known: two approvals, one of which
    // nothing judged. The honest number is 1.
    //
    // THE TWO ROWS ARE BUILT FROM REAL VERDICTS and not hand-written, which is
    // the difference between testing the arithmetic and testing the pipeline.
    // An earlier draft of this test typed `judged: false` into the fixture and
    // PASSED against the pre-fix code — it was asserting that `filter` works.
    // Driving `decide()` is what makes it fail there, for the right reason.
    const unjudged = decide(request(), read(null, null));
    const judged = decide(request({ amountCents: 1n }), read(controls()));
    expect(unjudged.rule).toBe("no_controls_configured");
    expect(judged.rule).toBe("within_controls");

    const log: readonly DecisionRecord[] = [
      record({ id: "unjudged", rule: unjudged.rule, judged: unjudged.judged }),
      record({
        id: "judged",
        rule: judged.rule,
        judged: judged.judged,
        controlVersion: 4,
      }),
    ];

    const approvals = log.filter((d) => d.outcome === "approve");
    const judgedApprovals = approvals.filter((d) => d.judged);

    expect(approvals).toHaveLength(2);
    expect(judgedApprovals).toHaveLength(1);
    expect(judgedApprovals[0]?.id).toBe("judged");
  });
});

describe("an authorisation on a token this book does not know", () => {
  // The other unjudged approval, 11 rows on the live book. Same treatment, and
  // it matters that it is the same: the scope fail-open and the no-controls
  // fail-open are different arguments that produce the same amount of evidence,
  // which is none.
  const lookup: ControlLookup = {
    status: "read",
    cardId: null,
    controls: null,
    spend: NO_SPEND,
  };

  it("approves, and records that nothing judged it", () => {
    const verdict = decide(request(), lookup);
    expect(verdict.outcome).toBe("approve");
    expect(verdict.rule).toBe("card_not_under_control");
    expect(verdict.judged).toBe(false);
    expect(verdict.inputs["judged"]).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The other side of the line — approvals that WERE judged                  */
/* -------------------------------------------------------------------------- */

describe("an approval a control actually cleared", () => {
  it("is judged when the card carries a control version", () => {
    const verdict = decide(request({ amountCents: 100n }), read(controls()));
    expect(verdict.outcome).toBe("approve");
    expect(verdict.rule).toBe("within_controls");
    expect(verdict.judged).toBe(true);
    expect(verdict.inputs["judged"]).toBe(true);
  });

  it("is judged when the card has NO controls but a holder whose limits ran", () => {
    // The subtle one, and the reason `judged` is not simply
    // `control_version_id IS NOT NULL`. 15 rows on the live book are
    // `within_controls` with a NULL control version: no card control, but a
    // member whose daily limit was compared. Judging those as unjudged would
    // under-report in the direction that manufactures a finding.
    const verdict = decide(
      request({ amountCents: 100n }),
      read(null, member({ dailyLimitCents: 400_00n })),
    );
    expect(verdict.rule).toBe("within_controls");
    expect(verdict.judged).toBe(true);
  });

  it("is judged when the holder has no limits at all — their STATE is a control", () => {
    // A member with every limit null is still a member: rules 5 and 6 compared
    // their state and would have declined had it been `removed`. Something
    // could have refused this, so something judged it.
    const verdict = decide(request({ amountCents: 100n }), read(null, member()));
    expect(verdict.rule).toBe("within_controls");
    expect(verdict.judged).toBe(true);
  });

  it("is judged on a decline, because judged is not a synonym for approved", () => {
    const verdict = decide(
      request({ amountCents: 100_00n }),
      read(controls({ perTxnLimitCents: 10_00n })),
    );
    expect(verdict.outcome).toBe("decline");
    expect(verdict.rule).toBe("per_transaction_limit_exceeded");
    expect(verdict.judged).toBe(true);
  });
});

describe("a decline nothing judged either", () => {
  it("marks the fail-closed decline unjudged — nothing was compared", () => {
    // `judged` is orthogonal to `outcome` on purpose. This row declines BECAUSE
    // nothing could be compared, and a census that assumed every decline was
    // judged would over-report the control system in the other direction.
    const verdict = decide(request(), { status: "unavailable", detail: "600ms" });
    expect(verdict.outcome).toBe("decline");
    expect(verdict.judged).toBe(false);
  });
});

describe("the two not-a-purchase rules", () => {
  // THE CASE THAT DECIDES WHETHER THE DEFINITION IS "a control was compared" OR
  // "a rule fired". A balance inquiry is approved at position 3 of RULE_ORDER,
  // BEFORE `card_frozen` at position 7 — so it is approved on a FROZEN card,
  // and no control could have refused it. It is unjudged, and the test proves
  // the ordering claim rather than asserting the classification alone.
  it("approves a balance inquiry on a FROZEN card, so nothing could have refused it", () => {
    const verdict = decide(
      request({ requestStatus: "BALANCE_INQUIRY", amountCents: 0n }),
      read(controls({ cardState: "frozen" })),
    );
    expect(verdict.outcome).toBe("approve");
    expect(verdict.rule).toBe("balance_inquiry_not_a_purchase");
    expect(verdict.judged).toBe(false);
  });

  it("approves a credit on a frozen card too, and records it as unjudged", () => {
    const verdict = decide(
      request({ requestStatus: "CREDIT_AUTHORIZATION" }),
      read(controls({ cardState: "frozen" })),
    );
    expect(verdict.outcome).toBe("approve");
    expect(verdict.rule).toBe("credit_not_a_purchase");
    expect(verdict.judged).toBe(false);
  });

  it("puts both of them before the freeze switch in the evaluation order", () => {
    // The claim the two tests above rest on, asserted directly so that
    // reordering `RULE_ORDER` cannot silently make the classification wrong.
    const at = (rule: string): number => RULE_ORDER.indexOf(rule as never);
    expect(at("balance_inquiry_not_a_purchase")).toBeLessThan(at("card_frozen"));
    expect(at("credit_not_a_purchase")).toBeLessThan(at("card_frozen"));
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The classification is total, and the two statements of it agree         */
/* -------------------------------------------------------------------------- */

describe("the judged classification", () => {
  it("covers every rule in the closed set", () => {
    for (const rule of DECISION_RULES) {
      expect(typeof isJudgedRule(rule)).toBe("boolean");
    }
    // And no rule on the unjudged list has fallen out of the closed set.
    for (const rule of UNJUDGED_RULES) {
      expect(DECISION_RULES).toContain(rule);
    }
  });

  it("reports a rule this build has never heard of as JUDGED", () => {
    // The safe direction: over-reporting the unjudged count would manufacture a
    // finding out of a newer deploy's vocabulary. Under-reporting it merely
    // fails to claim something, which is the error this whole change prefers.
    expect(isJudgedRule("a_rule_from_a_later_build")).toBe(true);
  });

  it("agrees with every verdict decide() can produce", () => {
    // EVERY RULE, DRIVEN THROUGH THE REAL FUNCTION, cross-checked against the
    // table. `decide()` states `judged` at each return site rather than
    // deriving it — see its header — so this is the join that stops the two
    // drifting, and it is why a rule added next year cannot quietly default to
    // "judged" because `true` is the easy value to type.
    const verdicts = [
      decide(request(), { status: "unavailable", detail: "x" }),
      decide(request(), { status: "read", cardId: null, controls: null, spend: NO_SPEND }),
      decide(request({ requestStatus: "BALANCE_INQUIRY", amountCents: 0n }), read(controls())),
      decide(request({ requestStatus: "CREDIT_AUTHORIZATION" }), read(controls())),
      decide(request(), read(null, member({ state: "removed" }))),
      decide(request(), read(null, member({ state: "suspended" }))),
      decide(request(), read(controls({ cardState: "frozen" }))),
      decide(request(), read(controls({ blockedMccs: ["5542"] }))),
      decide(request(), read(controls({ perTxnLimitCents: 10n }))),
      decide(request(), read(controls({ dailyLimitCents: 10n }))),
      decide(request(), read(controls({ monthlyLimitCents: 10n }))),
      decide(request(), read(controls(), member({ perTxnLimitCents: 10n }))),
      decide(request(), read(controls(), member({ dailyLimitCents: 10n }))),
      decide(request(), read(controls(), member({ monthlyLimitCents: 10n }))),
      decide(request(), read(null, null)),
      decide(request({ amountCents: 1n }), read(controls())),
    ];

    // Every rule reached, so this is a statement about all sixteen and not
    // about the nine somebody remembered.
    expect(new Set(verdicts.map((v) => v.rule)).size).toBe(DECISION_RULES.length);

    for (const verdict of verdicts) {
      expect({ rule: verdict.rule, judged: verdict.judged }).toEqual({
        rule: verdict.rule,
        judged: isJudgedRule(verdict.rule),
      });
      // And the column the database will carry says the same thing.
      expect(verdict.inputs["judged"]).toBe(verdict.judged);
    }
  });
});
