import { describe, expect, it } from "vitest";

import {
  describeUsd,
  formatUsd,
  isNegative,
  signOf,
  sumCents,
  toCents,
} from "@/lib/format/money";

describe("formatUsd", () => {
  it("formats zero", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("formats one cent", () => {
    expect(formatUsd(1)).toBe("$0.01");
  });

  it("keeps the cents column two digits wide", () => {
    expect(formatUsd(5)).toBe("$0.05");
    expect(formatUsd(50)).toBe("$0.50");
    expect(formatUsd(99)).toBe("$0.99");
    expect(formatUsd(100)).toBe("$1.00");
    expect(formatUsd(105)).toBe("$1.05");
  });

  it("groups thousands", () => {
    expect(formatUsd(100_000)).toBe("$1,000.00");
    expect(formatUsd(4_821_560)).toBe("$48,215.60");
    expect(formatUsd(123_456_789)).toBe("$1,234,567.89");
  });

  it("formats large values exactly", () => {
    // $1,234,567,890,123.45 — a treasury balance, still exact.
    expect(formatUsd(123_456_789_012_345)).toBe("$1,234,567,890,123.45");
  });

  it("formats values past Number.MAX_SAFE_INTEGER when given a bigint", () => {
    // 9_007_199_254_740_993 is not representable as a `number`; as a bigint it
    // must survive formatting digit for digit. This is the test that proves
    // nothing here round-trips through a float.
    expect(formatUsd(9_007_199_254_740_993n)).toBe("$90,071,992,547,409.93");
    expect(formatUsd(340_282_366_920_938_463_463_374_607_431_768_211_455n)).toBe(
      "$3,402,823,669,209,384,634,633,746,074,317,682,114.55",
    );
  });

  it("renders negatives with a minus sign outside the symbol, never parentheses", () => {
    expect(formatUsd(-1)).toBe("-$0.01");
    expect(formatUsd(-7_340)).toBe("-$73.40");
    expect(formatUsd(-2_130)).toBe("-$21.30");
    expect(formatUsd(-123_456_789)).toBe("-$1,234,567.89");
    expect(formatUsd(-3_330)).not.toContain("(");
  });

  it("has no negative zero", () => {
    expect(formatUsd(-0)).toBe("$0.00");
    expect(formatUsd(0n)).toBe("$0.00");
    expect(formatUsd(-0n)).toBe("$0.00");
  });

  it("can render an explicit plus for deltas", () => {
    expect(formatUsd(5_000, { signed: true })).toBe("+$50.00");
    expect(formatUsd(-5_000, { signed: true })).toBe("-$50.00");
    expect(formatUsd(0, { signed: true })).toBe("$0.00");
  });

  it("can drop the symbol for bare columns", () => {
    expect(formatUsd(4_821_560, { symbol: false })).toBe("48,215.60");
    expect(formatUsd(-7_340, { symbol: false })).toBe("-73.40");
  });

  it("can drop the grouping for a value a machine parses back", () => {
    // A form pre-filled with "48,215.60" round-trips to a parse failure, or to
    // 48.00 if something is feeling helpful. This option exists so a component
    // pre-filling an amount input never has a reason to compute cents / 100.
    expect(formatUsd(4_821_560, { symbol: false, group: false })).toBe("48215.60");
    expect(formatUsd(-7_340, { symbol: false, group: false })).toBe("-73.40");
    expect(formatUsd(100, { symbol: false, group: false })).toBe("1.00");
  });

  it("round-trips an ungrouped rendering back through toCents", () => {
    // The property that matters: what we put in the input is what comes back
    // out of it. Cents in, the same cents out, with no float in between.
    for (const cents of [0, 1, 99, 100, 7_340, 4_821_560, -7_340]) {
      const rendered = formatUsd(cents, { symbol: false, group: false });
      const [whole, frac] = rendered.replace("-", "").split(".");
      const back =
        BigInt(whole ?? "0") * 100n + BigInt(frac ?? "0");
      expect(rendered.startsWith("-") ? -back : back).toBe(BigInt(cents));
    }
  });
});

describe("toCents", () => {
  it("refuses dollars-as-floats", () => {
    expect(() => toCents(73.4)).toThrow(TypeError);
    expect(() => toCents(0.01)).toThrow(/integer cents/);
  });

  it("refuses NaN and Infinity", () => {
    expect(() => toCents(Number.NaN)).toThrow(TypeError);
    expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });

  it("refuses numbers that cannot be exact cent counts", () => {
    expect(() => toCents(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });

  it("passes bigints through untouched", () => {
    expect(toCents(9_007_199_254_740_993n)).toBe(9_007_199_254_740_993n);
  });
});

describe("sign helpers", () => {
  it("classifies sign", () => {
    expect(signOf(-1)).toBe(-1);
    expect(signOf(0)).toBe(0);
    expect(signOf(-0)).toBe(0);
    expect(signOf(1)).toBe(1);
  });

  it("reports negativity", () => {
    expect(isNegative(-3_330)).toBe(true);
    expect(isNegative(0)).toBe(false);
    expect(isNegative(3_330)).toBe(false);
  });
});

describe("sumCents", () => {
  it("sums exactly, in bigint", () => {
    expect(sumCents([1_250_000, 124_000, 26_000, 50_000])).toBe(1_450_000n);
    expect(sumCents([])).toBe(0n);
    expect(sumCents([-7_340, 5_210])).toBe(-2_130n);
  });
});

describe("describeUsd", () => {
  it("says the sign out loud for screen readers", () => {
    expect(describeUsd(-2_130)).toBe("negative $21.30");
    expect(describeUsd(2_130)).toBe("$21.30");
  });
});
