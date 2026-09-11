/**
 * The rounding rule, proved on integers with no database in sight.
 *
 * The claim under test is DESIGN §12.3's, and it is absolute rather than
 * approximate: **the daily shares of a month sum to the monthly price exactly,
 * for every price and every month length.** Not within a penny. Exactly.
 *
 * So the central test is not an example, it is a sweep: every month length a
 * calendar produces (28, 29, 30, 31) crossed with every price from 1¢ to $50
 * plus a set of awkward ones, asserting the sum. 4 × ~5,000 assertions is a
 * couple of milliseconds and it is the difference between "we think the
 * allocation is exact" and "the allocation is exact".
 */

import { describe, expect, it } from "vitest";

import {
  AccrualInputError,
  allocateDay,
  allocateForDate,
  dayOfMonth,
  daysInMonth,
  explainAllocation,
  monthOf,
} from "./types";

const MONTH_LENGTHS = [28, 29, 30, 31] as const;

function monthTotal(monthlyCents: bigint, n: number): bigint {
  let total = 0n;
  for (let d = 1; d <= n; d += 1) {
    total += allocateDay({ monthlyCents, daysInMonth: n, dayOfMonth: d }).amountCents;
  }
  return total;
}

describe("the month always sums to the price, exactly", () => {
  it("for every price from 1¢ to $50.00 in every month length", () => {
    for (const n of MONTH_LENGTHS) {
      for (let cents = 1; cents <= 5000; cents += 1) {
        const price = BigInt(cents);
        // The whole rule, in one assertion, five thousand times per month
        // length. A rounding rule that is right on the examples in the README
        // and wrong on 4,997¢ is not a rounding rule.
        expect(monthTotal(price, n)).toBe(price);
      }
    }
  });

  it("for awkward prices well past the sweep", () => {
    const awkward = [9_999n, 12_345n, 100_000n, 999_999n, 1_000_000_007n];
    for (const n of MONTH_LENGTHS) {
      for (const price of awkward) {
        expect(monthTotal(price, n)).toBe(price);
      }
    }
  });
});

describe("the residual penny lands where DESIGN §12.4 says", () => {
  it("on the first r days and no others", () => {
    for (const n of MONTH_LENGTHS) {
      for (const price of [2500n, 4999n, 999n, 1n, 3333n]) {
        const r = Number(price % BigInt(n));
        for (let d = 1; d <= n; d += 1) {
          const a = allocateDay({ monthlyCents: price, daysInMonth: n, dayOfMonth: d });
          expect(a.residualPennies).toBe(r);
          // Ordinal ascending: day d carries a penny iff d ≤ r. Nothing else
          // decides it, because a uniform split makes every remainder equal.
          expect(a.residualApplied).toBe(d <= r);
          expect(a.amountCents).toBe(a.baseShareCents + (d <= r ? 1n : 0n));
        }
      }
    }
  });

  it("places exactly r of them", () => {
    for (const n of MONTH_LENGTHS) {
      for (const price of [2500n, 4999n, 999n, 7n]) {
        let placed = 0;
        for (let d = 1; d <= n; d += 1) {
          if (allocateDay({ monthlyCents: price, daysInMonth: n, dayOfMonth: d }).residualApplied) {
            placed += 1;
          }
        }
        expect(placed).toBe(Number(price % BigInt(n)));
      }
    }
  });

  it("places none when the price divides the month evenly", () => {
    // $30.00 over 30 days is a dollar a day and there is nothing to place.
    for (let d = 1; d <= 30; d += 1) {
      const a = allocateDay({ monthlyCents: 3000n, daysInMonth: 30, dayOfMonth: d });
      expect(a.residualPennies).toBe(0);
      expect(a.residualApplied).toBe(false);
      expect(a.amountCents).toBe(100n);
    }
  });
});

describe("the cumulative is the running total and closes on the price", () => {
  it("cum(d) equals the sum of shares 1..d, and cum(N) equals F", () => {
    for (const n of MONTH_LENGTHS) {
      for (const price of [2500n, 4999n, 999n, 31n, 1n]) {
        let running = 0n;
        for (let d = 1; d <= n; d += 1) {
          const a = allocateDay({ monthlyCents: price, daysInMonth: n, dayOfMonth: d });
          running += a.amountCents;
          expect(a.cumulativeCents).toBe(running);
          expect(a.remainingCents).toBe(price - running);
        }
        expect(running).toBe(price);
      }
    }
  });
});

describe("the worked example on the screen", () => {
  it("$25.00 over 30 days: 83¢ with 10¢ left over", () => {
    const tenth = allocateDay({ monthlyCents: 2500n, daysInMonth: 30, dayOfMonth: 10 });
    expect(tenth.baseShareCents).toBe(83n);
    expect(tenth.residualPennies).toBe(10);
    expect(tenth.residualApplied).toBe(true);
    expect(tenth.amountCents).toBe(84n);
    expect(tenth.cumulativeCents).toBe(840n);
    expect(tenth.remainingCents).toBe(1660n);

    const eleventh = allocateDay({ monthlyCents: 2500n, daysInMonth: 30, dayOfMonth: 11 });
    expect(eleventh.residualApplied).toBe(false);
    expect(eleventh.amountCents).toBe(83n);
    expect(eleventh.cumulativeCents).toBe(923n);

    // 10 × 84 + 20 × 83 = 2500. The sentence the migration header makes.
    expect(10n * 84n + 20n * 83n).toBe(2500n);
  });

  it("explains itself in a sentence a customer can check", () => {
    const a = allocateDay({ monthlyCents: 2500n, daysInMonth: 30, dayOfMonth: 10 });
    const text = explainAllocation(a);
    expect(text).toContain("$25.00 ÷ 30 days = 83¢ per day");
    expect(text).toContain("10¢ left over");
    expect(text).toContain("carries one of those pennies");
    expect(text).toContain("84¢");
  });

  it("says so plainly on a day that carries no penny", () => {
    const text = explainAllocation(allocateDay({ monthlyCents: 2500n, daysInMonth: 30, dayOfMonth: 11 }));
    expect(text).toContain("past the first 10");
    expect(text).toContain("carries none: 83¢");
  });
});

describe("a price below a cent a day", () => {
  it("gives zero-cent days and still sums to the price", () => {
    // 20¢ a month over 31 days: q = 0, r = 20. Days 1–20 accrue 1¢ each and
    // days 21–31 accrue nothing at all. postEntry() refuses a zero line, so
    // those eleven days are recorded as `skipped` — and the month is still
    // exactly 20¢.
    const zeros: number[] = [];
    let total = 0n;
    for (let d = 1; d <= 31; d += 1) {
      const a = allocateDay({ monthlyCents: 20n, daysInMonth: 31, dayOfMonth: d });
      total += a.amountCents;
      if (a.amountCents === 0n) zeros.push(d);
    }
    expect(total).toBe(20n);
    expect(zeros).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
  });
});

describe("calendar arithmetic is UTC and refuses nonsense", () => {
  it("knows how long every month is, including leap Februaries", () => {
    expect(daysInMonth("2026-09-10")).toBe(30);
    expect(daysInMonth("2026-02-10")).toBe(28);
    expect(daysInMonth("2028-02-10")).toBe(29);
    expect(daysInMonth("2026-01-31")).toBe(31);
    // 2000 is a leap year and 1900 is not — the rule most implementations get
    // wrong, and the one a bank hits every hundred years.
    expect(daysInMonth("2000-02-01")).toBe(29);
    expect(daysInMonth("1900-02-01")).toBe(28);
  });

  it("reads the ordinal and the month key", () => {
    expect(dayOfMonth("2026-09-10")).toBe(10);
    expect(monthOf("2026-09-10")).toBe("2026-09");
  });

  it("refuses a date that does not exist rather than rolling it over", () => {
    // `new Date("2026-02-30")` would silently become 2 March. A value date
    // that quietly moves is how an entry lands in the wrong month.
    expect(() => daysInMonth("2026-02-30")).toThrow(AccrualInputError);
    expect(() => daysInMonth("2026-13-01")).toThrow(AccrualInputError);
    expect(() => daysInMonth("10 Sep 2026")).toThrow(AccrualInputError);
  });

  it("refuses a price or a day that could not produce a valid allocation", () => {
    expect(() => allocateDay({ monthlyCents: 0n, daysInMonth: 30, dayOfMonth: 1 })).toThrow(
      AccrualInputError,
    );
    expect(() => allocateDay({ monthlyCents: -100n, daysInMonth: 30, dayOfMonth: 1 })).toThrow(
      AccrualInputError,
    );
    expect(() => allocateDay({ monthlyCents: 2500n, daysInMonth: 30, dayOfMonth: 31 })).toThrow(
      AccrualInputError,
    );
    expect(() => allocateDay({ monthlyCents: 2500n, daysInMonth: 32, dayOfMonth: 1 })).toThrow(
      AccrualInputError,
    );
  });

  it("derives the month length from the date, not from the caller", () => {
    expect(allocateForDate(2500n, "2026-02-10").daysInMonth).toBe(28);
    expect(allocateForDate(2500n, "2028-02-10").daysInMonth).toBe(29);
    // February is the case that proves it: $25.00 over 28 days is 89¢ with
    // 8¢ left over, and the 10th is past the first 8.
    const feb = allocateForDate(2500n, "2026-02-10");
    expect(feb.baseShareCents).toBe(89n);
    expect(feb.residualPennies).toBe(8);
    expect(feb.residualApplied).toBe(false);
    expect(feb.amountCents).toBe(89n);
  });
});

describe("no float ever appears in a result", () => {
  it("every money field is a bigint", () => {
    const a = allocateForDate(4999n, "2026-09-10");
    for (const value of [
      a.monthlyCents,
      a.baseShareCents,
      a.amountCents,
      a.cumulativeCents,
      a.remainingCents,
    ]) {
      expect(typeof value).toBe("bigint");
    }
    // And the counts are integers, not cents wearing a disguise.
    expect(Number.isInteger(a.daysInMonth)).toBe(true);
    expect(Number.isInteger(a.dayOfMonth)).toBe(true);
    expect(Number.isInteger(a.residualPennies)).toBe(true);
  });

  it("survives a price larger than Number.MAX_SAFE_INTEGER", () => {
    // $90 trillion is reachable in a fuzz test and a float would have lost the
    // cent long before here.
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    expect(monthTotal(huge, 31)).toBe(huge);
  });
});
