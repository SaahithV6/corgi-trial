/**
 * The interest rounding rule, proved rather than described.
 *
 * Pure: no database, no network, no clock. Everything here is integer
 * arithmetic on `bigint`, which is the claim as much as it is the method — if
 * a float had crept in anywhere, the exhaustive sweeps below would find it as
 * a one-cent disagreement long before a customer did.
 *
 * THE FOUR CLAIMS:
 *
 *   1. It is HALF TO EVEN and not half-up, and the two differ on exactly the
 *      ties and nowhere else. Asserted by sweeping every remainder against a
 *      half-up reference and checking that the disagreement set IS the tie set.
 *
 *   2. It is SYMMETRIC IN THE SIGN. A credit balance and an overdraft of the
 *      same magnitude at the same rate round to the same number of cents, so
 *      no side of the book is systematically favoured by the rounding.
 *
 *   3. THE TIE IS REACHABLE, and both of its branches are exercised — one that
 *      stays on an even cent and one that moves up to the next one. A rounding
 *      rule whose tiebreak is never taken is a rounding rule nobody has tested.
 *
 *   4. IT IS §12.2 AND NOT §12.3. There is no total to allocate: the sum of a
 *      month of daily interest is whatever the balances made it, and asserting
 *      it equals some target would be asserting a rule that does not apply.
 *      What IS asserted is that each day is independently reproducible from
 *      its own three inputs, which is the property §12.2 actually promises.
 */
import { describe, expect, it } from "vitest";

import {
  BPS_SCALE,
  DEFAULT_DAY_COUNT,
  InterestInputError,
  bpsToPercent,
  centsToPlainUsd,
  computeDailyInterest,
  explainInterest,
  roundHalfEven,
  roundingOf,
  sideOf,
} from "./interest-types";

/** Half-up, as a reference implementation, used ONLY to contrast with the rule. */
function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const q = numerator / denominator;
  const r = numerator % denominator;
  return 2n * r >= denominator ? q + 1n : q;
}

const D = BPS_SCALE * BigInt(DEFAULT_DAY_COUNT); // 3_650_000

describe("roundHalfEven — DESIGN §12.2", () => {
  it("rounds down below the half and up above it", () => {
    // q = 7, r just under and just over half of D
    const base = 7n * D;
    expect(roundHalfEven(base + D / 2n - 1n, D)).toBe(7n);
    expect(roundHalfEven(base + D / 2n + 1n, D)).toBe(8n);
  });

  it("breaks the exact half to the EVEN cent, in both directions", () => {
    // q even -> stays. 4 is even, so 4.5 -> 4.
    expect(roundHalfEven(4n * D + D / 2n, D)).toBe(4n);
    // q odd -> goes up. 5 is odd, so 5.5 -> 6.
    expect(roundHalfEven(5n * D + D / 2n, D)).toBe(6n);
    // and 0.5 -> 0, which is the case a naive implementation gets wrong.
    expect(roundHalfEven(D / 2n, D)).toBe(0n);
  });

  it("differs from half-up on the ties and NOWHERE else", () => {
    // A small odd denominator, so `2r = D` is unreachable and the tie set is
    // empty — the two rules must agree everywhere.
    const odd = 7n;
    for (let n = 0n; n < 200n; n++) {
      expect(roundHalfEven(n, odd)).toBe(roundHalfUp(n, odd));
    }

    // An even denominator, where ties exist. Sweep a full period and collect
    // the disagreements; they must be exactly the numerators whose remainder
    // is half the denominator AND whose quotient is even.
    const even = 8n;
    const disagreed: bigint[] = [];
    for (let n = 0n; n < 400n; n++) {
      if (roundHalfEven(n, even) !== roundHalfUp(n, even)) disagreed.push(n);
    }
    expect(disagreed.length).toBeGreaterThan(0);
    for (const n of disagreed) {
      expect(roundingOf(n, even)).toBe("tie_to_even");
      // half-up went up; half-even stayed, so the quotient was even.
      expect((n / even) % 2n).toBe(0n);
      expect(roundHalfEven(n, even)).toBe(n / even);
    }
  });

  it("is unbiased over a full period of remainders, and half-up is not", () => {
    // Sum the signed rounding error (rounded*D - n) over one full period.
    // Half-even cancels; half-up is short by exactly one tie's worth.
    const den = 8n;
    let evenErr = 0n;
    let upErr = 0n;
    for (let n = 0n; n < 2n * den; n++) {
      evenErr += roundHalfEven(n, den) * den - n;
      upErr += roundHalfUp(n, den) * den - n;
    }
    expect(evenErr).toBe(0n);
    expect(upErr).toBe(den); // one whole tie, always in the same direction
  });

  it("refuses a signed numerator rather than rounding it asymmetrically", () => {
    expect(() => roundHalfEven(-1n, D)).toThrow(InterestInputError);
  });

  it("refuses a non-positive denominator", () => {
    expect(() => roundHalfEven(1n, 0n)).toThrow(InterestInputError);
  });
});

describe("roundingOf — which of the four cases, recorded not inferred", () => {
  it("labels all four", () => {
    expect(roundingOf(3n * D, D)).toBe("exact");
    expect(roundingOf(3n * D + 1n, D)).toBe("down");
    expect(roundingOf(3n * D + D - 1n, D)).toBe("up");
    expect(roundingOf(3n * D + D / 2n, D)).toBe("tie_to_even");
  });
});

describe("sideOf — the sign, and nothing else", () => {
  it("maps the three cases", () => {
    expect(sideOf(1n)).toBe("credit");
    expect(sideOf(-1n)).toBe("overdraft");
    expect(sideOf(0n)).toBe("flat");
  });
});

describe("computeDailyInterest", () => {
  it("reproduces the live book's edge pair by hand", () => {
    // Kettle & Crumb Bakery LLC held exactly $2,003.00 across the rate change.
    // 2026-09-08 was priced by the 150 bps card, 2026-09-09 by the 125 bps one,
    // and the ONLY thing that moved between the two days was the rate.
    const before = computeDailyInterest({ balanceCents: 200_300n, rateBps: 150, dayCount: 365 });
    expect(before.numerator).toBe(30_045_000n);
    expect(before.denominator).toBe(3_650_000n);
    expect(before.wholeCents).toBe(8n);
    expect(before.remainderUnits).toBe(845_000n);
    expect(before.rounding).toBe("down"); // 2 × 845000 = 1690000 < 3650000
    expect(before.amountCents).toBe(8n);

    const after = computeDailyInterest({ balanceCents: 200_300n, rateBps: 125, dayCount: 365 });
    expect(after.numerator).toBe(25_037_500n);
    expect(after.wholeCents).toBe(6n);
    expect(after.remainderUnits).toBe(3_137_500n);
    expect(after.rounding).toBe("up"); // 2 × 3137500 = 6275000 > 3650000
    expect(after.amountCents).toBe(7n);

    // One cent apart, and the two rows round in opposite directions.
    expect(before.amountCents - after.amountCents).toBe(1n);
  });

  it("is symmetric between a credit balance and an overdraft of the same size", () => {
    for (const cents of [1n, 999n, 200_300n, 12_994_940n, 50_000_000n]) {
      const credit = computeDailyInterest({ balanceCents: cents, rateBps: 1800, dayCount: 365 });
      const overdraft = computeDailyInterest({
        balanceCents: -cents,
        rateBps: 1800,
        dayCount: 365,
      });
      expect(credit.amountCents).toBe(overdraft.amountCents);
      expect(credit.numerator).toBe(overdraft.numerator);
      expect(credit.rounding).toBe(overdraft.rounding);
      // What differs is who owes whom, and only that.
      expect(credit.side).toBe("credit");
      expect(overdraft.side).toBe("overdraft");
      expect(credit.customerEffectCents).toBe(credit.amountCents);
      expect(overdraft.customerEffectCents).toBe(-overdraft.amountCents);
    }
  });

  it("prices a zero balance at nothing, on neither side", () => {
    const flat = computeDailyInterest({ balanceCents: 0n, rateBps: 1800, dayCount: 365 });
    expect(flat.side).toBe("flat");
    expect(flat.rateBps).toBe(0); // not the card rate: there is no side to price
    expect(flat.amountCents).toBe(0n);
    expect(flat.customerEffectCents).toBe(0n);
    expect(explainInterest(flat)).toContain("nothing to price");
  });

  it("rounds a sub-half-cent day to nothing rather than to a penny", () => {
    // $100.00 at 150 bps for one day is 1500000/3650000 = 0.41 of a cent.
    const tiny = computeDailyInterest({ balanceCents: 10_000n, rateBps: 150, dayCount: 365 });
    expect(tiny.wholeCents).toBe(0n);
    expect(tiny.rounding).toBe("down");
    expect(tiny.amountCents).toBe(0n);

    // The smallest balance that earns a cent a day at 150 bps: the fraction has
    // to reach a half, i.e. balance × 150 ≥ 1825000, i.e. balance ≥ 12166.67.
    expect(computeDailyInterest({ balanceCents: 12_166n, rateBps: 150, dayCount: 365 }).amountCents)
      .toBe(0n);
    expect(computeDailyInterest({ balanceCents: 12_167n, rateBps: 150, dayCount: 365 }).amountCents)
      .toBe(1n);
  });

  it("exercises the tie in both directions on a real-shaped input", () => {
    // A tie needs |balance| × rate ≡ D/2 (mod D) with D = 3,650,000, i.e. the
    // numerator must be an ODD multiple of 1,825,000 = 73 × 25,000. So the
    // balance and the rate between them must supply 2^3 · 5^5 · 73 exactly once
    // in the 2-part. These two do, and they land on either side of the tiebreak.
    //
    // 1,825,000 × 3 = 5,475,000 -> q = 1 (odd)  -> up to 2
    const odd = computeDailyInterest({ balanceCents: 36_500n, rateBps: 150, dayCount: 365 });
    expect(odd.numerator).toBe(5_475_000n);
    expect(odd.remainderUnits * 2n).toBe(odd.denominator);
    expect(odd.rounding).toBe("tie_to_even");
    expect(odd.wholeCents).toBe(1n);
    expect(odd.amountCents).toBe(2n);
    expect(explainInterest(odd)).toContain("odd, so it goes up");

    // 1,825,000 × 5 = 9,125,000 -> q = 2 (even) -> stays at 2
    const even = computeDailyInterest({ balanceCents: 36_500n, rateBps: 250, dayCount: 365 });
    expect(even.numerator).toBe(9_125_000n);
    expect(even.remainderUnits * 2n).toBe(even.denominator);
    expect(even.rounding).toBe("tie_to_even");
    expect(even.wholeCents).toBe(2n);
    expect(even.amountCents).toBe(2n);
    expect(explainInterest(even)).toContain("even, so it stays");

    // Half-up would have said 2 and 3. That one-cent difference, on every tie,
    // forever, in the same direction, is the whole argument for §12.2.
    expect(roundHalfUp(odd.numerator, odd.denominator)).toBe(2n);
    expect(roundHalfUp(even.numerator, even.denominator)).toBe(3n);
  });

  it("says what ACT/360 would have cost, so the convention is a choice and not a habit", () => {
    const balance = 50_000_000n; // $500,000.00
    const act365 = computeDailyInterest({ balanceCents: balance, rateBps: 150, dayCount: 365 });
    const act360 = computeDailyInterest({ balanceCents: balance, rateBps: 150, dayCount: 360 });
    expect(act365.amountCents).toBe(2055n);
    expect(act360.amountCents).toBe(2083n);
    // 365/360 is 1.389% more per day, every day, for the same quoted rate.
    expect(act360.amountCents).toBeGreaterThan(act365.amountCents);
  });

  it("is exact for every balance in a sweep, with no float anywhere", () => {
    // The property §12.2 actually promises: the posted cents are within half a
    // cent of the exact fraction, on both sides, for every input. Checked by
    // cross-multiplication so the comparison itself never leaves the integers.
    for (let cents = 0n; cents <= 2_000_000n; cents += 9_973n) {
      for (const rate of [0, 1, 125, 150, 1800, 10_000]) {
        for (const sign of [1n, -1n]) {
          const a = computeDailyInterest({
            balanceCents: sign * cents,
            rateBps: rate,
            dayCount: 365,
          });
          // |amount × D − N| × 2 ≤ D
          const err = a.amountCents * a.denominator - a.numerator;
          const magnitude = err < 0n ? -err : err;
          expect(magnitude * 2n <= a.denominator).toBe(true);
          // and the working reconstructs the answer exactly
          expect(a.wholeCents * a.denominator + a.remainderUnits).toBe(a.numerator);
        }
      }
    }
  });

  it("holds past Number.MAX_SAFE_INTEGER, where a float would already be wrong", () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1 cents
    const a = computeDailyInterest({ balanceCents: huge, rateBps: 150, dayCount: 365 });
    expect(a.numerator).toBe(huge * 150n);
    expect(a.wholeCents * a.denominator + a.remainderUnits).toBe(a.numerator);
    expect(Number(a.amountCents)).toBeGreaterThan(Number.MAX_SAFE_INTEGER / 1e6);
  });

  it("refuses a rate or a day count it does not have a rule for", () => {
    expect(() => computeDailyInterest({ balanceCents: 1n, rateBps: -1, dayCount: 365 })).toThrow(
      InterestInputError,
    );
    expect(() =>
      computeDailyInterest({ balanceCents: 1n, rateBps: 10_001, dayCount: 365 }),
    ).toThrow(InterestInputError);
    expect(() => computeDailyInterest({ balanceCents: 1n, rateBps: 150, dayCount: 366 })).toThrow(
      InterestInputError,
    );
    expect(() => computeDailyInterest({ balanceCents: 1n, rateBps: 1.5, dayCount: 365 })).toThrow(
      InterestInputError,
    );
  });
});

describe("the sentence a customer can check with a calculator", () => {
  it("carries the two integers of the fraction, not just the answer", () => {
    const a = computeDailyInterest({ balanceCents: 200_300n, rateBps: 125, dayCount: 365 });
    const text = explainInterest(a);
    expect(text).toContain("$2,003.00");
    expect(text).toContain("125 bps");
    expect(text).toContain("365 days");
    expect(text).toContain("25037500");
    expect(text).toContain("3650000");
    expect(text).toContain("7¢");
  });

  it("names who pays whom on each side", () => {
    expect(explainInterest(computeDailyInterest({ balanceCents: 1_000_000n, rateBps: 150, dayCount: 365 })))
      .toContain("we pay");
    expect(explainInterest(computeDailyInterest({ balanceCents: -1_000_000n, rateBps: 1800, dayCount: 365 })))
      .toContain("we charge");
  });
});

describe("formatting helpers, which are also integer-only", () => {
  it("renders cents as dollars without dividing by 100", () => {
    expect(centsToPlainUsd(0n)).toBe("$0.00");
    expect(centsToPlainUsd(7n)).toBe("$0.07");
    expect(centsToPlainUsd(200_300n)).toBe("$2,003.00");
    expect(centsToPlainUsd(-180_000n)).toBe("-$1,800.00");
    expect(centsToPlainUsd(1_234_567_890n)).toBe("$12,345,678.90");
  });

  it("renders basis points as a percentage", () => {
    expect(bpsToPercent(0)).toBe("0.00%");
    expect(bpsToPercent(125)).toBe("1.25%");
    expect(bpsToPercent(150)).toBe("1.50%");
    expect(bpsToPercent(1800)).toBe("18.00%");
    expect(bpsToPercent(10_000)).toBe("100.00%");
  });
});
