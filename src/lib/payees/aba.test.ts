import { describe, expect, it } from "vitest";

import {
  ABA_WEIGHTS,
  abaChecksumOk,
  abaNearMisses,
  abaPrefixAssigned,
  checkRoutingNumber,
  describeAbaPrefix,
  normaliseRoutingNumber,
  transpositionIsDetectable,
} from "./aba";

/**
 * The ABA check digit, proved rather than asserted.
 *
 * The interesting tests here are not "does it accept 021000021". They are the
 * two exhaustive sweeps at the bottom, which enumerate the ENTIRE error space
 * of a corpus of valid routing numbers and count what the checksum catches.
 * That is where the honest limit of the feature comes from, and the numbers
 * in `aba.ts`'s header and in docs/PAYEES.md are these numbers.
 */

/**
 * Real, published US routing numbers.
 *
 * Not invented: these are the numbers this system already carries. The first
 * two are what Plaid's sandbox returns from `/auth/get` for the seeded Item
 * (`numbers.ach[].routing` and `.wire_routing`) and appear in
 * `src/lib/rails/plaid/types.ts` and throughout `src/lib/mcp`'s tests; the
 * third is the only routing number Increase's sandbox directory knows, and
 * `directory.test.ts` looks it up for real.
 */
const REAL_ROUTING_NUMBERS: readonly { readonly rn: string; readonly who: string }[] = [
  { rn: "011401533", who: "ACH routing on the seeded Plaid item" },
  { rn: "021000021", who: "wire routing on the seeded Plaid item (JPMorgan Chase)" },
  { rn: "101050001", who: "First Bank of the United States — Increase's sandbox directory" },
  { rn: "026009593", who: "Bank of America, New York" },
  { rn: "121000248", who: "Wells Fargo" },
  { rn: "031101279", who: "The Bancorp Bank" },
  { rn: "084009519", who: "Evolve Bank & Trust" },
];

describe("the published routing numbers this system actually uses", () => {
  for (const { rn, who } of REAL_ROUTING_NUMBERS) {
    it(`${rn} passes — ${who}`, () => {
      expect(abaChecksumOk(rn)).toBe(true);
      const verdict = checkRoutingNumber(rn);
      expect(verdict.valid).toBe(true);
      if (verdict.valid) {
        expect(verdict.weightedSum % 10).toBe(0);
        expect(verdict.routingNumber).toBe(rn);
      }
    });
  }

  it("the weights are 3,7,1 repeating and nothing else", () => {
    expect([...ABA_WEIGHTS]).toEqual([3, 7, 1, 3, 7, 1, 3, 7, 1]);
  });

  it("shows the arithmetic by hand for 011401533", () => {
    // 3*(0+4+5) + 7*(1+0+3) + 1*(1+1+3) = 27 + 28 + 5 = 60
    const verdict = checkRoutingNumber("011401533");
    expect(verdict.valid).toBe(true);
    if (verdict.valid) expect(verdict.weightedSum).toBe(60);
  });
});

describe("format", () => {
  it("accepts the separators a human types", () => {
    expect(normaliseRoutingNumber(" 011-401-533 ")).toBe("011401533");
    expect(abaChecksumOk("011 401 533")).toBe(true);
  });

  it("says which problem it is, not just 'invalid'", () => {
    expect(checkRoutingNumber("")).toMatchObject({ valid: false, problem: "EMPTY" });
    expect(checkRoutingNumber("01140153")).toMatchObject({
      valid: false,
      problem: "NOT_NINE_DIGITS",
    });
    expect(checkRoutingNumber("01140153X")).toMatchObject({
      valid: false,
      problem: "NON_NUMERIC",
    });
    expect(checkRoutingNumber("011401534")).toMatchObject({
      valid: false,
      problem: "CHECKSUM_FAILED",
    });
  });

  it("never throws on hostile input", () => {
    for (const input of ["", "        ", "abcdefghi", "٠١٢٣٤٥٦٧٨", "-".repeat(9), "9".repeat(400)]) {
      expect(() => checkRoutingNumber(input)).not.toThrow();
      expect(abaChecksumOk(input)).toBe(false);
    }
  });

  it("puts the arithmetic in the refusal, so a person can check it", () => {
    const verdict = checkRoutingNumber("011401534");
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) {
      expect(verdict.weightedSum).toBe(61);
      expect(verdict.message).toContain("61");
      expect(verdict.message).toContain("No bank has this routing number");
    }
  });
});

describe("deliberate transpositions of real routing numbers", () => {
  /**
   * The classic mistype, on numbers that exist. Every adjacent swap of two
   * DIFFERENT digits, listed with what the checksum said about it.
   */
  const cases: readonly {
    readonly from: string;
    readonly to: string;
    readonly caught: boolean;
    readonly why: string;
  }[] = [
    // 011401533 -> swap positions 4,5 ('4','0'): digits differ by 4, caught.
    { from: "011401533", to: "011041533", caught: true, why: "4↔0 differ by 4" },
    // 011401533 -> swap positions 8,9 ('3','3'): identical digits, not an error.
    // 021000021 -> swap positions 2,3 ('2','1'): differ by 1, caught.
    { from: "021000021", to: "012000021", caught: true, why: "2↔1 differ by 1" },
    // 021000021 -> swap positions 8,9 ('2','1'): differ by 1, caught.
    { from: "021000021", to: "021000012", caught: true, why: "2↔1 differ by 1" },
    // 101050001 -> swap positions 3,4 ('1','0'): differ by 1, caught.
    { from: "101050001", to: "100150001", caught: true, why: "1↔0 differ by 1" },
    // THE BLIND SPOT. 101050001 -> swap positions 4,5 ('0','5'): differ by 5.
    { from: "101050001", to: "101500001", caught: false, why: "0↔5 differ by exactly 5" },
    // 026009593 -> swap positions 1,2 ('0','2'): differ by 2, caught.
    { from: "026009593", to: "206009593", caught: true, why: "0↔2 differ by 2" },
  ];

  for (const c of cases) {
    it(`${c.from} → ${c.to} is ${c.caught ? "CAUGHT" : "MISSED"} (${c.why})`, () => {
      expect(abaChecksumOk(c.from)).toBe(true);
      expect(abaChecksumOk(c.to)).toBe(!c.caught);
    });
  }

  it("the miss is a real routing number, which is why it is a real risk", () => {
    // 101500001 is not merely "checksum-valid nonsense": a transposed digit
    // that survives the checksum produces a number the form will accept, the
    // rail will submit, and only the receiving bank can reject — days later,
    // as an R03/R04 return. That is precisely the case docs/PAYEES.md says
    // needs a prenotification rather than arithmetic.
    expect(abaChecksumOk("101500001")).toBe(true);
    expect(abaChecksumOk("101050001")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The exhaustive proofs                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every nine-digit string whose check digit holds, for a deterministic sample
 * of prefixes. Built rather than listed: the ninth digit is whatever makes the
 * sum land on zero, so a valid corpus is generated by construction and no
 * hand-typed list can be quietly wrong.
 */
function validCorpus(count: number): readonly string[] {
  const out: string[] = [];
  // A fixed LCG, so the corpus is identical on every machine and every run.
  // `Math.random()` in a proof is a proof that changes its mind.
  //
  // The HIGH bits are used, not the low ones. `seed % 10` off a power-of-two
  // LCG reads the least significant bits, which have a period of a handful of
  // values — the first version of this generated a corpus whose adjacent
  // digits were almost always equal, and equal digits are not transpositions,
  // so the sweep below reported a 0.2% miss rate for an 11.1% property. A
  // biased corpus in a proof is worse than no proof.
  let seed = 20260910;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed >>> 16) % 10;
  };
  while (out.length < count) {
    const first8 = Array.from({ length: 8 }, () => next());
    const partial =
      3 * ((first8[0] ?? 0) + (first8[3] ?? 0) + (first8[6] ?? 0)) +
      7 * ((first8[1] ?? 0) + (first8[4] ?? 0) + (first8[7] ?? 0)) +
      1 * ((first8[2] ?? 0) + (first8[5] ?? 0));
    const check = (10 - (partial % 10)) % 10;
    out.push([...first8, check].join(""));
  }
  return out;
}

describe("EXHAUSTIVE: what the check digit catches", () => {
  const corpus = validCorpus(500);

  it("every routing number in the generated corpus is valid", () => {
    for (const rn of corpus) expect(abaChecksumOk(rn)).toBe(true);
  });

  it("catches 100% of single wrong digits — all 81 per number, all 500 numbers", () => {
    let total = 0;
    let missed = 0;
    for (const rn of corpus) {
      for (let i = 0; i < 9; i += 1) {
        for (let v = 0; v <= 9; v += 1) {
          const digit = String(v);
          if (rn[i] === digit) continue;
          total += 1;
          const typo = rn.slice(0, i) + digit + rn.slice(i + 1);
          if (abaChecksumOk(typo)) missed += 1;
        }
      }
    }
    expect(total).toBe(500 * 9 * 9);
    // The strongest claim this module makes. All three weights are coprime
    // to 10, so w·δ ≡ 0 (mod 10) forces δ ≡ 0: a changed digit ALWAYS moves
    // the sum. There is no exception and this is why.
    expect(missed).toBe(0);
  });

  it("catches 88.9% of adjacent transpositions, and misses exactly the ±5 pairs", () => {
    let total = 0;
    let missed = 0;
    const missedDeltas = new Set<number>();

    for (const rn of corpus) {
      for (let i = 0; i < 8; i += 1) {
        const a = rn[i];
        const b = rn[i + 1];
        if (a === undefined || b === undefined || a === b) continue;
        total += 1;
        const swapped = rn.slice(0, i) + b + a + rn.slice(i + 2);
        if (abaChecksumOk(swapped)) {
          missed += 1;
          missedDeltas.add(Math.abs(Number(a) - Number(b)));
        }
      }
    }

    // Every miss is a pair of digits five apart: {0,5} {1,6} {2,7} {3,8} {4,9}.
    // Ten of the ninety ordered pairs of distinct digits, which is 11.1%.
    expect([...missedDeltas]).toEqual([5]);
    const missRate = missed / total;
    expect(missRate).toBeGreaterThan(0.1);
    expect(missRate).toBeLessThan(0.125);
    expect(1 - missRate).toBeGreaterThan(0.875);
  });

  it("cannot catch ANY transposition three or six positions apart", () => {
    // The weight vector repeats every three digits, so positions 1&4, 2&5,
    // 3&6, 4&7, 5&8, 6&9 (and 1&7, 2&8, 3&9) carry EQUAL weights and swapping
    // them cannot change the sum at all. This is a property of every mod-10
    // checksum over a repeating weight vector; it is not a defect in this
    // implementation and no correct implementation of the ABA rule does
    // better. It is in docs/PAYEES.md as a stated limit.
    let total = 0;
    let missed = 0;
    for (const rn of corpus) {
      for (const distance of [3, 6]) {
        for (let i = 0; i + distance < 9; i += 1) {
          const a = rn[i];
          const b = rn[i + distance];
          if (a === undefined || b === undefined || a === b) continue;
          total += 1;
          const chars = rn.split("");
          chars[i] = b;
          chars[i + distance] = a;
          if (abaChecksumOk(chars.join(""))) missed += 1;
        }
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(missed).toBe(total);
  });

  it("cannot catch a twin shift across a 3+7 weight pair", () => {
    // Positions (1,2), (4,5) and (7,8) carry weights 3 and 7, which sum to
    // 10. Mistyping both by the SAME amount — 'ba' typed as 'dc' one row over
    // on the keypad — shifts the sum by 10δ, which is invisible for every δ.
    let checked = 0;
    for (const rn of corpus.slice(0, 50)) {
      for (const i of [0, 3, 6]) {
        const a = Number(rn[i]);
        const b = Number(rn[i + 1]);
        for (let delta = -9; delta <= 9; delta += 1) {
          if (delta === 0) continue;
          if (a + delta < 0 || a + delta > 9 || b + delta < 0 || b + delta > 9) continue;
          const chars = rn.split("");
          chars[i] = String(a + delta);
          chars[i + 1] = String(b + delta);
          checked += 1;
          expect(abaChecksumOk(chars.join(""))).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("transpositionIsDetectable predicts every one of those outcomes", () => {
    // The analytic predicate and the brute-force answer must agree, or one of
    // them is a story. This is the test that keeps the header comment honest.
    for (const rn of corpus.slice(0, 100)) {
      for (let i = 1; i <= 9; i += 1) {
        for (let j = i + 1; j <= 9; j += 1) {
          const a = rn[i - 1];
          const b = rn[j - 1];
          if (a === undefined || b === undefined || a === b) continue;
          const chars = rn.split("");
          chars[i - 1] = b;
          chars[j - 1] = a;
          const bruteForce = !abaChecksumOk(chars.join(""));
          expect(transpositionIsDetectable(rn, i, j)).toBe(bruteForce);
        }
      }
    }
  });
});

describe("Federal Reserve prefixes", () => {
  it("accepts the allocated ranges", () => {
    expect(abaPrefixAssigned("011401533")).toBe(true); // 01, Boston
    expect(abaPrefixAssigned("101050001")).toBe(true); // 10, Kansas City
    expect(abaPrefixAssigned("312000000")).toBe(true); // 31, thrift (district 11)
    expect(abaPrefixAssigned("610000000")).toBe(true); // 61, electronic (district 1)
    expect(abaPrefixAssigned("800000000")).toBe(true); // 80, traveler's cheques
  });

  it("rejects the ranges that were never allocated", () => {
    for (const prefix of ["13", "20", "33", "45", "60", "75", "81", "99"]) {
      expect(abaPrefixAssigned(`${prefix}0000000`)).toBe(false);
    }
  });

  it("describes the district for a screen", () => {
    expect(describeAbaPrefix("011401533")).toContain("district 1 (Boston)");
    expect(describeAbaPrefix("121000248")).toContain("district 12 (San Francisco)");
    expect(describeAbaPrefix("450000000")).toContain("not an allocated range");
  });

  it("an unallocated prefix with a valid check digit warns and does not block", () => {
    // 450000000: 3*(4+0+0) + 7*(5+0+0) + 1*(0+0+0) = 12 + 35 = 47. Not valid.
    // Construct one that IS valid to make the point that the two checks are
    // independent: prefix 45, check digit chosen to satisfy the sum.
    const withUnallocatedPrefix = "450000003"; // 12 + 35 + 3 = 50
    expect(abaChecksumOk(withUnallocatedPrefix)).toBe(true);
    expect(abaPrefixAssigned(withUnallocatedPrefix)).toBe(false);
    const verdict = checkRoutingNumber(withUnallocatedPrefix);
    expect(verdict.valid).toBe(true);
    if (verdict.valid) expect(verdict.prefixAssigned).toBe(false);
  });
});

describe("near misses", () => {
  it("finds the single edit that would fix a mistyped number", () => {
    // 011401534 is 011401533 with the last digit wrong.
    const misses = abaNearMisses("011401534");
    expect(misses.some((m) => m.candidate === "011401533")).toBe(true);
    expect(misses.every((m) => abaChecksumOk(m.candidate))).toBe(true);
  });

  it("every invalid number has EXACTLY nine single-digit repairs — always", () => {
    // The reason `verify.ts` shows none of them. All three weights are
    // coprime to 10, so for each position exactly one replacement digit
    // satisfies w·(v − d) ≡ −S (mod 10), and that digit is never the one
    // already there because S ≢ 0. "Did you mean one of these nine?" is a
    // restatement of "it is wrong", not a hint.
    for (const rn of validCorpus(60)) {
      for (let i = 0; i < 9; i += 1) {
        for (let v = 0; v <= 9; v += 1) {
          const digit = String(v);
          if (rn[i] === digit) continue;
          const invalid = rn.slice(0, i) + digit + rn.slice(i + 1);
          const substitutions = abaNearMisses(invalid).filter((m) => m.kind === "substitution");
          expect(substitutions).toHaveLength(9);
        }
      }
    }
  });

  it("finds a transposition when one explains the failure", () => {
    // 011401533 with positions 1,2 swapped: 101401533. 3*(1+4+5)=30,
    // 7*(0+0+3)=21, 1*(1+1+3)=5 → 56, invalid. Swapping back fixes it.
    expect(abaChecksumOk("101401533")).toBe(false);
    const misses = abaNearMisses("101401533");
    expect(
      misses.some((m) => m.kind === "transposition" && m.candidate === "011401533"),
    ).toBe(true);
  });

  it("returns nothing for a valid number", () => {
    expect(abaNearMisses("011401533")).toEqual([]);
  });

  it("returns nothing for input that is not nine digits", () => {
    expect(abaNearMisses("0114015")).toEqual([]);
    expect(abaNearMisses("nonsense")).toEqual([]);
  });
});
