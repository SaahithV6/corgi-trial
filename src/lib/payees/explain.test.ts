/**
 * THE WORKING, AND WHAT IT REFUSES TO SHOW.
 *
 * `explain.ts` is what turns the one BLOCK this feature has from an assertion
 * of authority into a claim a person can check on the back of an envelope. So
 * the assertions here are about two things and only two:
 *
 *   1. THE ARITHMETIC IS THE ARITHMETIC. The groups, the products and the
 *      total have to be the same numbers `checkRoutingNumber()` computes, and
 *      `verdict.valid` — not this module's own sum — has to be what decides.
 *      Two copies of one rule is what DECISIONS forbids; the way out is that
 *      one of them ASKS the other.
 *
 *   2. THE NINE SINGLE-DIGIT REPAIRS ARE NEVER OFFERED. Every invalid routing
 *      number has exactly nine of them, always, so listing them restates "it
 *      is wrong" in nine parts and invites a clerk to pick one. Only the
 *      transposition repair is named. That is a product decision and it is
 *      one edit away from being lost, so it is pinned here.
 */

import { describe, expect, it } from "vitest";

import { abaNearMisses, checkRoutingNumber } from "./aba";
import { composeAcknowledgement, REASON_MIN_LENGTH } from "./acknowledge-text";
import { explainRoutingNumber, summariseExplanation } from "./explain";

describe("explainRoutingNumber — the working, not the verdict", () => {
  it("computes the worked example from docs/PAYEES.md §1 digit for digit", () => {
    const explanation = explainRoutingNumber("011401533");
    expect(explanation.state).toBe("computed");
    if (explanation.state !== "computed") return;

    // 3(0+4+5) = 27, 7(1+0+3) = 28, 1(1+1+3) = 5, total 60.
    expect(explanation.groups.map((g) => g.product)).toEqual([27, 28, 5]);
    expect(explanation.groups.map((g) => g.digitSum)).toEqual([9, 4, 5]);
    expect(explanation.total).toBe(60);
    expect(explanation.remainder).toBe(0);
    expect(explanation.holds).toBe(true);
    expect(explanation.substituted).toBe("3(0+4+5) + 7(1+0+3) + (1+1+3)");
    expect(explanation.products).toBe("27 + 28 + 5");
  });

  it("shows the sum that MISSED, and by how much", () => {
    // The single-digit slip fired live against the deployed system: 61, one
    // away from a multiple of ten.
    const explanation = explainRoutingNumber("011401534");
    expect(explanation.state).toBe("computed");
    if (explanation.state !== "computed") return;
    expect(explanation.total).toBe(61);
    expect(explanation.remainder).toBe(1);
    expect(explanation.holds).toBe(false);
    expect(summariseExplanation(explanation)).toContain("61");
    expect(summariseExplanation(explanation)).toContain("1 away from a multiple of ten");
  });

  it("NAMES THE TRANSPOSITION and never the nine single-digit repairs", () => {
    // 011041533 is 011401533 with positions 4 and 5 swapped.
    const explanation = explainRoutingNumber("011041533");
    expect(explanation.state).toBe("computed");
    if (explanation.state !== "computed") return;

    expect(explanation.total).toBe(76);
    expect(explanation.transpositions.map((t) => t.candidate)).toEqual(["011401533"]);

    // The nine exist and are computable — they are just not offered. If this
    // count ever stops being nine the claim in the header is wrong.
    const substitutions = abaNearMisses("011041533").filter((m) => m.kind === "substitution");
    expect(substitutions).toHaveLength(9);
    const offered = explanation.transpositions.map((t) => t.candidate);
    for (const substitution of substitutions) {
      if (substitution.candidate === "011401533") continue;
      expect(offered).not.toContain(substitution.candidate);
    }
  });

  it("offers no repair at all when no adjacent pair explains the failure", () => {
    const explanation = explainRoutingNumber("011401534");
    if (explanation.state !== "computed") throw new Error("expected a computed explanation");
    expect(explanation.transpositions).toEqual([]);
  });

  it("takes its verdict from checkRoutingNumber rather than from its own sum", () => {
    // The corpus that matters is the one where the two could disagree: every
    // number whose total is a multiple of ten must be `holds`, and no other.
    for (const rn of [
      "011401533",
      "021000021",
      "026009593",
      "121000248",
      "101050001",
      "101500001",
      "011401534",
      "011041533",
      "000000000",
      "101050002",
    ]) {
      const explanation = explainRoutingNumber(rn);
      if (explanation.state !== "computed") throw new Error(`${rn} did not compute`);
      expect(explanation.holds, rn).toBe(checkRoutingNumber(rn).valid);
      expect(explanation.holds, rn).toBe(explanation.total % 10 === 0);
    }
  });

  it("SAYS OUT LOUD what it could not have caught — the 0↔5 blind spot", () => {
    // 101500001 passes the check digit and is 101050001 with two adjacent
    // digits swapped. The honest limit, on the number it applies to.
    const explanation = explainRoutingNumber("101500001");
    if (explanation.state !== "computed") throw new Error("expected a computed explanation");
    expect(explanation.holds).toBe(true);
    expect(explanation.invisibleSwaps.map((s) => s.candidate)).toContain("101050001");
    for (const swap of explanation.invisibleSwaps) {
      expect(Math.abs(swap.digits[0] - swap.digits[1])).toBe(5);
    }
  });

  it("says nothing about a number nobody has finished typing", () => {
    expect(explainRoutingNumber("").state).toBe("empty");
    expect(explainRoutingNumber("0114").state).toBe("wrong_length");
    expect(explainRoutingNumber("01140153X").state).toBe("not_numeric");
    // AND IT KEEPS THE EVIDENCE. A non-numeric entry is not silently stripped
    // down to a length complaint — that would delete the character that
    // explains the paste.
    const bad = explainRoutingNumber("01140153X");
    if (bad.state !== "not_numeric") throw new Error("expected not_numeric");
    expect(bad.typed).toBe("01140153X");
  });

  it("normalises the separators a cheque prints and nothing else", () => {
    const spaced = explainRoutingNumber("011 401-533");
    if (spaced.state !== "computed") throw new Error("expected a computed explanation");
    expect(spaced.routingNumber).toBe("011401533");
    expect(spaced.total).toBe(60);
  });
});

describe("composeAcknowledgement — a signature names what it signed for", () => {
  it("keeps the operator's words first and then names the findings", () => {
    const text = composeAcknowledgement("Confirmed on the contract's finance line.", [
      {
        code: "TWIN_WITH_DIFFERENT_DETAILS",
        title: "You already pay someone by this name at a different account",
      },
    ]);
    expect(text).toBe(
      'Confirmed on the contract\'s finance line. — signed for 1 finding on this check: ' +
        'TWIN_WITH_DIFFERENT_DETAILS ("You already pay someone by this name at a different account").',
    );
  });

  it("names every finding when a check raised more than one", () => {
    const text = composeAcknowledgement("Both differences are explained by the acquisition.", [
      { code: "NAME_NO_MATCH", title: "The name does not match the account" },
      { code: "TWIN_WITH_DIFFERENT_DETAILS", title: "Different account, same name" },
    ]);
    expect(text).toContain("signed for 2 findings");
    expect(text).toContain("NAME_NO_MATCH");
    expect(text).toContain("TWIN_WITH_DIFFERENT_DETAILS");
  });

  it("asks for a sentence rather than a word", () => {
    // Not a serious barrier and not meant to be one — it stops "ok" and "."
    // without pretending a length threshold can tell a considered reason from
    // a padded one.
    expect(REASON_MIN_LENGTH).toBeGreaterThan(2);
    expect("ok".length).toBeLessThan(REASON_MIN_LENGTH);
  });
});
