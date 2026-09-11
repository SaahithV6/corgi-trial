/**
 * The check digit, as arithmetic a person can follow — not as a verdict.
 *
 * ─── WHY THIS IS A SEPARATE MODULE FROM `aba.ts` ───────────────────────────
 *
 * `checkRoutingNumber()` answers a question: is this number possible. It
 * returns `weightedSum` alongside the answer, which is enough for a sentence
 * and not enough for a screen. What an operator typing a routing number off a
 * supplier's letterhead needs is the WORKING: which digit carried which
 * weight, what each of the three groups came to, and how the total landed
 * where it did. That is the difference between a control somebody believes and
 * a control somebody suspects of being fussy.
 *
 * The distinction is the same one the whole feature is built on. A refusal
 * that says "invalid routing number" is an assertion of authority. A refusal
 * that shows
 *
 *     3(0+4+0) + 7(1+1+3) + 1(1+5+3)  =  12 + 35 + 9  =  56
 *     56 mod 10 = 6 — six away from a multiple of ten
 *
 * is a claim the reader can check on the back of an envelope, and then the
 * BLOCK is obviously arithmetic rather than policy. That is what earns this
 * feature the right to have exactly one wall in it.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * IT NAMES NO SINGLE-DIGIT REPAIR. Every weight here (1, 3, 7) is invertible
 * mod 10, so for every position there is exactly one digit that would repair
 * the checksum: **every invalid routing number has exactly nine single-digit
 * repairs, always.** "Did you mean one of these nine?" is the sentence "it is
 * wrong" retyped in nine parts, and it invites a clerk to pick one. Only the
 * TRANSPOSITION repair is surfaced, because that is a specific, checkable
 * claim about what the hand did rather than a restatement of the failure.
 * `abaNearMisses()` computes both; this module filters, exactly as
 * `verify.ts` and `gate.ts` do.
 *
 * IT SHOWS THE BLIND SPOT ON A NUMBER THAT PASSES. `101500001` is `101050001`
 * with two adjacent digits swapped and it passes the check digit, because the
 * swapped digits differ by exactly five and the adjacent weight differences
 * all have gcd 2 with ten. A limitation the operator can see is a limitation;
 * one only the author knows about is a trap, so `invisibleSwaps` lists the
 * adjacent pairs of THIS number whose transposition this arithmetic could not
 * have caught.
 *
 * PURE, AND CLIENT-SAFE. No `server-only`, no I/O, no clock. The add-payee
 * form recomputes this on every keystroke in the browser, and the server
 * recomputes it again from the submitted string; they agree because there is
 * one function and it is a fold over nine digits.
 */

import {
  ABA_LENGTH,
  abaNearMisses,
  abaWeight,
  checkRoutingNumber,
  normaliseRoutingNumber,
  transpositionIsDetectable,
} from "./aba";

/** One digit's contribution to the weighted sum. */
export type AbaTerm = {
  /** 1-based, the way the formula in every reference is written. */
  readonly position: number;
  readonly digit: number;
  readonly weight: number;
  /** `digit * weight`. Spelled out so the row is checkable on its own. */
  readonly product: number;
};

/**
 * One of the three weight groups.
 *
 * The formula is conventionally written grouped by weight —
 * `3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9)` — rather than digit by digit, so
 * the screen groups it the same way. A reader comparing this against a
 * reference should not have to rearrange it first.
 */
export type AbaGroup = {
  readonly weight: number;
  readonly positions: readonly number[];
  readonly digits: readonly number[];
  /** The digits added, before the weight is applied. */
  readonly digitSum: number;
  /** `weight * digitSum`. */
  readonly product: number;
};

/** An adjacent swap of this number that the checksum cannot see. */
export type InvisibleSwap = {
  readonly positions: readonly [number, number];
  readonly digits: readonly [number, number];
  /** The number this one is indistinguishable from. */
  readonly candidate: string;
};

/** A swap of two adjacent digits that WOULD repair an invalid number. */
export type TranspositionRepair = {
  readonly positions: readonly [number, number];
  readonly candidate: string;
};

export type AbaExplanation =
  /** Nothing typed yet. Not an error; the form has not been filled in. */
  | { readonly state: "empty" }
  /** Something that is not a digit. The evidence is left in place, not stripped. */
  | { readonly state: "not_numeric"; readonly typed: string; readonly message: string }
  /** Fewer or more than nine digits: there is no sum to compute yet. */
  | {
      readonly state: "wrong_length";
      readonly typed: string;
      readonly digitCount: number;
      readonly message: string;
    }
  /** Nine digits, and here is what they came to. */
  | {
      readonly state: "computed";
      readonly routingNumber: string;
      readonly terms: readonly AbaTerm[];
      readonly groups: readonly AbaGroup[];
      /** The weighted sum. */
      readonly total: number;
      /** `total mod 10`. Zero exactly when the number is possible. */
      readonly remainder: number;
      readonly holds: boolean;
      /** `3(0+4+5) + 7(1+0+3) + 1(1+1+3)` — the formula with this number's digits in it. */
      readonly substituted: string;
      /** `27 + 28 + 5` — the group products, before they are added. */
      readonly products: string;
      /**
       * Adjacent swaps that would REPAIR an invalid number. Empty on a valid
       * one, and usually empty on an invalid one too. Never a single-digit
       * repair — see the header.
       */
      readonly transpositions: readonly TranspositionRepair[];
      /**
       * Adjacent swaps of a VALID number that this arithmetic cannot see.
       * The honest limit, on the screen, on the number it applies to.
       */
      readonly invisibleSwaps: readonly InvisibleSwap[];
      readonly prefixAssigned: boolean;
      readonly prefixDescription: string;
    };

/** The three weight groups, in the order the formula is written. */
const GROUP_WEIGHTS: readonly number[] = [3, 7, 1];

function digitAt(rn: string, position1Based: number): number {
  const ch = rn[position1Based - 1];
  // Unreachable for a nine-digit numeric string; `noUncheckedIndexedAccess`
  // wants the branch and a wrong answer here would be a silent one.
  if (ch === undefined) return 0;
  return ch.charCodeAt(0) - 48;
}

/**
 * The working, for whatever has been typed so far.
 *
 * Never throws and never returns "invalid" as a bare word: every state carries
 * the reason it is in, because a form that says "invalid" while the person is
 * still typing the fourth digit has taught them to ignore it by the ninth.
 */
export function explainRoutingNumber(input: string): AbaExplanation {
  const rn = normaliseRoutingNumber(input);

  if (rn.length === 0) return { state: "empty" };

  if (!/^[0-9]+$/.test(rn)) {
    return {
      state: "not_numeric",
      typed: rn,
      message:
        "A routing number is nine digits and nothing else. Spaces and hyphens are removed " +
        "because cheques print them; anything else is left where you typed it rather than " +
        "quietly deleted, so you can see what came out of the paste.",
    };
  }

  if (rn.length !== ABA_LENGTH) {
    return {
      state: "wrong_length",
      typed: rn,
      digitCount: rn.length,
      message:
        `A routing number is nine digits. This has ${rn.length}, so there is no weighted sum ` +
        "to compute yet — nothing below is a judgement about the number, only about its length.",
    };
  }

  const terms: AbaTerm[] = [];
  for (let position = 1; position <= ABA_LENGTH; position += 1) {
    const digit = digitAt(rn, position);
    const weight = abaWeight(position);
    terms.push({ position, digit, weight, product: digit * weight });
  }

  const groups: AbaGroup[] = GROUP_WEIGHTS.map((weight) => {
    const inGroup = terms.filter((t) => t.weight === weight);
    const digitSum = inGroup.reduce((acc, t) => acc + t.digit, 0);
    return {
      weight,
      positions: inGroup.map((t) => t.position),
      digits: inGroup.map((t) => t.digit),
      digitSum,
      product: weight * digitSum,
    };
  });

  const total = groups.reduce((acc, g) => acc + g.product, 0);
  const remainder = total % 10;

  // THE SAME ARITHMETIC, ASKED OF THE FUNCTION THAT OWNS IT. `total` is
  // computed here for the display and the verdict is NOT re-derived from it:
  // `checkRoutingNumber()` is the definition and this module is a view of it.
  // Two copies of one rule are exactly what DECISIONS forbids, and the way out
  // is to have one of them ask the other rather than agree with it by
  // coincidence.
  const verdict = checkRoutingNumber(rn);
  const holds = verdict.valid;

  const substituted = groups
    .map((g, index) =>
      `${index === GROUP_WEIGHTS.length - 1 ? "" : `${g.weight}`}(${g.digits.join("+")})`,
    )
    .join(" + ");

  const products = groups.map((g) => String(g.product)).join(" + ");

  const transpositions: TranspositionRepair[] = holds
    ? []
    : abaNearMisses(rn).flatMap((miss) =>
        miss.kind === "transposition"
          ? [{ positions: miss.positions, candidate: miss.candidate }]
          : [],
      );

  const invisibleSwaps: InvisibleSwap[] = [];
  if (holds) {
    for (let position = 1; position < ABA_LENGTH; position += 1) {
      const a = digitAt(rn, position);
      const b = digitAt(rn, position + 1);
      if (a === b) continue;
      if (transpositionIsDetectable(rn, position, position + 1)) continue;
      const swapped = rn.split("");
      swapped[position - 1] = String(b);
      swapped[position] = String(a);
      invisibleSwaps.push({
        positions: [position, position + 1],
        digits: [a, b],
        candidate: swapped.join(""),
      });
    }
  }

  return {
    state: "computed",
    routingNumber: rn,
    terms,
    groups,
    total,
    remainder,
    holds,
    substituted,
    products,
    transpositions,
    invisibleSwaps,
    prefixAssigned: verdict.valid ? verdict.prefixAssigned : false,
    prefixDescription: verdict.valid ? verdict.prefixDescription : "",
  };
}

/**
 * The one-line version, for a place that has room for a sentence and not a
 * table. Still the arithmetic, never a bare verdict.
 */
export function summariseExplanation(explanation: AbaExplanation): string {
  switch (explanation.state) {
    case "empty":
      return "Nothing typed yet.";
    case "not_numeric":
      return explanation.message;
    case "wrong_length":
      return explanation.message;
    case "computed":
      return explanation.holds
        ? `${explanation.substituted} = ${explanation.products} = ${explanation.total}, a multiple of ten. This routing number is arithmetically possible.`
        : `${explanation.substituted} = ${explanation.products} = ${explanation.total}, which is ${explanation.remainder} away from a multiple of ten. No bank has this routing number.`;
  }
}
