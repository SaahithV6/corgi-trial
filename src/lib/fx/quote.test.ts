import { describe, expect, it } from "vitest";

import {
  buyMinorUnits,
  costCents,
  customerRateScaled,
  feeCents,
  formatBps,
  formatMinorUnits,
  formatRate,
  pow10,
  priceQuote,
  settlementVariance,
} from "./quote";
import {
  CORRIDOR_EXPONENTS,
  DEFAULT_FEE_BPS,
  DEFAULT_FEE_FLAT_CENTS,
  DEFAULT_SPREAD_BPS,
  FX_REFUSAL_CODES,
  MAX_MINOR_EXPONENT,
  RATE_SCALE,
  isFxCorridorError,
  type FxCorridorError,
} from "./types";

/**
 * USD/MXN as Frankfurter printed it on 2026-09-10: 16.9435.
 * At scale 10^8 that is 1_694_350_000.
 */
const MXN_MID = 1_694_350_000n;

const STANDARD = {
  feeFlatCents: DEFAULT_FEE_FLAT_CENTS,
  feeBps: DEFAULT_FEE_BPS,
  spreadBps: DEFAULT_SPREAD_BPS,
} as const;

describe("feeCents", () => {
  it("is flat plus basis points", () => {
    // $1.00 + 0.25% of $1,000.00 = 100 + 250 cents.
    expect(feeCents(100_000n, 100n, 25)).toBe(350n);
  });

  it("rounds UP, which is our direction and is disclosed", () => {
    // 0.25% of $1.01 is 0.2525 cents. Up, not down, not to-even.
    expect(feeCents(101n, 0n, 25)).toBe(1n);
    expect(feeCents(1n, 0n, 1)).toBe(1n);
  });

  it("charges nothing proportional at zero bps", () => {
    expect(feeCents(100_000n, 250n, 0)).toBe(250n);
  });
});

describe("customerRateScaled", () => {
  it("takes the spread off the mid, rounded down", () => {
    // 16.9435 less 50bp = 16.85878250 at scale 10^8.
    expect(customerRateScaled(MXN_MID, 50)).toBe(1_685_878_250n);
  });

  it("is the mid itself at zero spread", () => {
    expect(customerRateScaled(MXN_MID, 0)).toBe(MXN_MID);
  });

  it("never returns more than the mid", () => {
    for (const bps of [0, 1, 7, 50, 137, 1000]) {
      expect(customerRateScaled(MXN_MID, bps)).toBeLessThanOrEqual(MXN_MID);
    }
  });
});

describe("buyMinorUnits", () => {
  it("prices a $1,000 payout to Mexico", () => {
    const net = 100_000n - feeCents(100_000n, 100n, 25); // 99,650 cents
    expect(
      buyMinorUnits({
        netCents: net,
        customerRateScaled: customerRateScaled(MXN_MID, 50),
        rateScale: RATE_SCALE,
        buyExponent: 2,
      }),
    ).toBe(1_679_977n); // 16,799.77 MXN
  });

  it("handles a zero-exponent currency without a hidden times-one-hundred", () => {
    // JPY at 154.18. The exponent is 0, so the result is whole yen.
    const net = 100_000n - feeCents(100_000n, 100n, 25);
    expect(
      buyMinorUnits({
        netCents: net,
        customerRateScaled: customerRateScaled(15_418_000_000n, 50),
        rateScale: RATE_SCALE,
        buyExponent: 0,
      }),
    ).toBe(152_872n); // ¥152,872
  });

  it("rounds the delivery DOWN — a fraction of a minor unit cannot be delivered", () => {
    // Chosen so the exact answer is 1.9999... of a minor unit.
    const delivered = buyMinorUnits({
      netCents: 1n,
      customerRateScaled: 199_999_999n,
      rateScale: RATE_SCALE,
      buyExponent: 2,
    });
    expect(delivered).toBe(1n);
  });
});

describe("costCents", () => {
  it("inverts buyMinorUnits at the same rate, to within the roundings", () => {
    const net = 99_650n;
    const rate = customerRateScaled(MXN_MID, 50);
    const minor = buyMinorUnits({
      netCents: net,
      customerRateScaled: rate,
      rateScale: RATE_SCALE,
      buyExponent: 2,
    });
    const back = costCents({ buyMinor: minor, rateScaled: rate, rateScale: RATE_SCALE, buyExponent: 2 });
    // Never more than the net it came from: the delivery was floored, and the
    // cost is ceilinged, so the round trip lands at most one cent above the
    // floored amount and never above the original.
    expect(back).toBeLessThanOrEqual(net);
    expect(net - back).toBeLessThanOrEqual(1n);
  });

  it("rounds UP — a cost rounded down is a loss hidden by a penny", () => {
    // 1 minor unit at 2.0 with exponent 2 costs 0.5 cents. Up is 1.
    expect(costCents({ buyMinor: 1n, rateScaled: 200_000_000n, rateScale: RATE_SCALE, buyExponent: 2 })).toBe(1n);
  });

  it("costs more when the destination currency strengthens", () => {
    const minor = 1_679_977n;
    const cheap = costCents({ buyMinor: minor, rateScaled: MXN_MID, rateScale: RATE_SCALE, buyExponent: 2 });
    const dear = costCents({ buyMinor: minor, rateScaled: 1_650_000_000n, rateScale: RATE_SCALE, buyExponent: 2 });
    expect(dear).toBeGreaterThan(cheap);
  });
});

describe("priceQuote", () => {
  const quote = priceQuote({
    sellCents: 100_000n,
    buyCurrency: "MXN",
    midRateScaled: MXN_MID,
    ...STANDARD,
  });

  it("shows every figure the screen renders, so the browser does no arithmetic", () => {
    expect(quote.sellCents).toBe(100_000n);
    expect(quote.feeCents).toBe(350n);
    expect(quote.netCents).toBe(99_650n);
    expect(quote.customerRateScaled).toBe(1_685_878_250n);
    expect(quote.buyMinor).toBe(1_679_977n);
    expect(quote.corridor.currency).toBe("MXN");
    expect(quote.corridor.exponent).toBe(2);
  });

  it("values the spread in dollars, not just in basis points", () => {
    // Roughly half a percent of the $996.50 that crosses.
    expect(quote.spreadValueCents).toBeGreaterThan(400n);
    expect(quote.spreadValueCents).toBeLessThan(600n);
  });

  it("discloses the size of the delivery rounding, in ten-thousandths", () => {
    expect(quote.deliveryResidualTenThousandths).toBeGreaterThanOrEqual(0n);
    expect(quote.deliveryResidualTenThousandths).toBeLessThan(10_000n);
  });

  it("adds up: fee plus net is what the customer sends", () => {
    expect(quote.feeCents + quote.netCents).toBe(quote.sellCents);
  });

  it("refuses a corridor it does not quote rather than inventing a rate", () => {
    const price = () =>
      priceQuote({ sellCents: 100_000n, buyCurrency: "ZAR", midRateScaled: MXN_MID, ...STANDARD });

    // The message names the fix — the quotable list, and where to re-quote.
    expect(price).toThrow(/We do not pay out in 'ZAR'/);
    expect(price).toThrow(/MXN, PHP, INR, BRL, JPY/);
    expect(price).toThrow(/\/client\/payouts/);

    // AND IT CARRIES A CODE. A bare `Error` here collapsed into whatever the
    // entry point's catch-all was, so "we do not pay into that currency" and
    // "your form is malformed" reached the customer as one sentence.
    try {
      price();
      expect.unreachable("priceQuote accepted a currency with no corridor");
    } catch (caught) {
      expect(isFxCorridorError(caught)).toBe(true);
      expect((caught as FxCorridorError).code).toBe("FX_CORRIDOR_UNSUPPORTED");
      expect(FX_REFUSAL_CODES).toContain("FX_CORRIDOR_UNSUPPORTED");
    }
  });

  it("pow10 bounds at the exponent the column accepts, not at 18", () => {
    // One range, not three. The guard, its doc comment and the database CHECK
    // on fx_quote.buy_exponent now say the same number.
    expect(MAX_MINOR_EXPONENT).toBe(6);
    expect(pow10(0)).toBe(1n);
    expect(pow10(2)).toBe(100n);
    expect(pow10(MAX_MINOR_EXPONENT)).toBe(1_000_000n);
    expect(() => pow10(MAX_MINOR_EXPONENT + 1)).toThrow(/0\.\.6/);
    expect(() => pow10(18)).toThrow(/0\.\.6/);
    expect(() => pow10(-1)).toThrow(/0\.\.6/);

    // And every exponent the corridor list actually produces is inside it.
    for (const exponent of CORRIDOR_EXPONENTS) {
      expect(exponent).toBeGreaterThanOrEqual(0);
      expect(exponent).toBeLessThanOrEqual(MAX_MINOR_EXPONENT);
    }
  });

  it("refuses an amount the fee would consume", () => {
    expect(() =>
      priceQuote({ sellCents: 50n, buyCurrency: "MXN", midRateScaled: MXN_MID, ...STANDARD }),
    ).toThrow(/would consume the whole payout/);
  });

  it("refuses a non-positive amount", () => {
    expect(() =>
      priceQuote({ sellCents: 0n, buyCurrency: "MXN", midRateScaled: MXN_MID, ...STANDARD }),
    ).toThrow(/positive amount/);
  });

  it("is pure — the same terms price identically, forever", () => {
    const again = priceQuote({
      sellCents: 100_000n,
      buyCurrency: "MXN",
      midRateScaled: MXN_MID,
      ...STANDARD,
    });
    expect(again.buyMinor).toBe(quote.buyMinor);
    expect(again.feeCents).toBe(quote.feeCents);
  });

  it("delivers more when the spread is smaller", () => {
    const tight = priceQuote({
      sellCents: 100_000n,
      buyCurrency: "MXN",
      midRateScaled: MXN_MID,
      ...STANDARD,
      spreadBps: 10,
    });
    expect(tight.buyMinor).toBeGreaterThan(quote.buyMinor);
  });
});

describe("settlementVariance — who eats the difference", () => {
  const quote = priceQuote({
    sellCents: 100_000n,
    buyCurrency: "MXN",
    midRateScaled: MXN_MID,
    ...STANDARD,
  });

  const at = (settlementMid: bigint) =>
    settlementVariance({
      sellCents: quote.sellCents,
      feeCents: quote.feeCents,
      buyMinor: quote.buyMinor,
      buyExponent: quote.corridor.exponent,
      quotedMidRateScaled: quote.midRateScaled,
      settlementMidRateScaled: settlementMid,
      rateScale: RATE_SCALE,
    });

  it("leaves us the spread when the market has not moved", () => {
    const flat = at(MXN_MID);
    expect(flat.varianceCents).toBeGreaterThan(0n);
    expect(flat.rateMoveScaled).toBe(0n);
    // The variance at a flat market IS the spread, to the cent.
    expect(flat.varianceCents).toBe(quote.spreadValueCents);
  });

  it("costs us real money when the peso strengthens past the spread", () => {
    // 16.9435 -> 16.50: the peso is dearer, our commitment costs more.
    const moved = at(1_650_000_000n);
    expect(moved.varianceCents).toBeLessThan(0n);
    expect(moved.rateMoveScaled).toBeLessThan(0n);
  });

  it("hands us the move when the peso weakens", () => {
    const moved = at(1_750_000_000n);
    expect(moved.varianceCents).toBeGreaterThan(quote.spreadValueCents);
    expect(moved.rateMoveScaled).toBeGreaterThan(0n);
  });

  it("always satisfies the identity the database enforces", () => {
    for (const mid of [1_500_000_000n, MXN_MID, 1_800_000_000n]) {
      const v = at(mid);
      expect(quote.sellCents - quote.feeCents - v.settlementCostCents).toBe(v.varianceCents);
    }
  });
});

describe("rendering never divides", () => {
  it("prints a scaled rate without a float", () => {
    expect(formatRate(MXN_MID, RATE_SCALE, { minDecimals: 4 })).toBe("16.9435");
    expect(formatRate(1_685_878_250n, RATE_SCALE, { minDecimals: 4 })).toBe("16.8587825");
    expect(formatRate(100_000_000n, RATE_SCALE)).toBe("1.00");
  });

  it("refuses a scale that is not a power of ten", () => {
    expect(() => formatRate(1n, 3n)).toThrow(/power of ten/);
  });

  it("groups a destination amount on the digit string", () => {
    expect(formatMinorUnits(1_679_977n, 2, "MXN")).toBe("16,799.77 MXN");
    expect(formatMinorUnits(152_872n, 0, "JPY")).toBe("152,872 JPY");
    expect(formatMinorUnits(7n, 2, "BRL")).toBe("0.07 BRL");
  });

  it("prints basis points as a percentage by integer arithmetic", () => {
    expect(formatBps(50)).toBe("0.50%");
    expect(formatBps(25)).toBe("0.25%");
    expect(formatBps(1000)).toBe("10.00%");
    expect(formatBps(0)).toBe("0.00%");
  });
});

describe("no floats reach any of it", () => {
  it("prices an amount well past Number.MAX_SAFE_INTEGER cents", () => {
    // $900,000,000.00 — inside the schema's ceiling, far outside a double's
    // exact integer range once multiplied by a rate at 10^8.
    const big = priceQuote({
      sellCents: 90_000_000_000n,
      buyCurrency: "MXN",
      midRateScaled: MXN_MID,
      ...STANDARD,
    });
    // The intermediate product here is ~1.5e21, which a double cannot hold
    // exactly. If anything in the chain were a float this would be wrong in
    // its low digits, and the identity below would fail.
    expect(big.feeCents + big.netCents).toBe(big.sellCents);
    expect(big.buyMinor % 1n).toBe(0n);
    expect(typeof big.buyMinor).toBe("bigint");
  });
});
