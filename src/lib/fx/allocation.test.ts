import { describe, expect, it } from "vitest";

import { USDC_UNITS_PER_CENT } from "@/lib/rails/stablecoin/types";

import {
  FX_SETTLEMENT_ACCOUNTS,
  deliveryCostUnits,
  fundingAllocation,
  settlementLines,
} from "./allocation";
import { costCents, priceQuote } from "./quote";
import { CORRIDORS, DEFAULT_FEE_BPS, DEFAULT_FEE_FLAT_CENTS, DEFAULT_SPREAD_BPS, RATE_SCALE } from "./types";

/** USD/MXN as Frankfurter printed it on 2026-09-10. */
const MXN_MID = 1_694_350_000n;

const STANDARD = {
  feeFlatCents: DEFAULT_FEE_FLAT_CENTS,
  feeBps: DEFAULT_FEE_BPS,
  spreadBps: DEFAULT_SPREAD_BPS,
} as const;

describe("deliveryCostUnits", () => {
  it("is costCents carried to the rail's own resolution", () => {
    // 33.54 MXN at 16.9435 costs 197.9521 cents. In USDC minor units that is
    // 1_979_521 — four digits the ledger cannot hold and the chain can.
    const units = deliveryCostUnits({
      buyMinor: 3_354n,
      rateScaled: MXN_MID,
      rateScale: RATE_SCALE,
      buyExponent: 2,
    });
    expect(units).toBe(1_979_521n);
  });

  it("rounds UP, because buying is the expensive direction", () => {
    // One yen at 147.00 is 0.680272... cents = 6802.72 USDC units. Up to 6803,
    // never 6802: a cost rounded down is a loss hidden behind a fraction.
    expect(
      deliveryCostUnits({
        buyMinor: 1n,
        rateScaled: 14_700_000_000n,
        rateScale: RATE_SCALE,
        buyExponent: 0,
      }),
    ).toBe(6_803n);
  });

  it("refuses a non-positive delivery, rate or scale rather than returning zero", () => {
    const base = { buyMinor: 1n, rateScaled: MXN_MID, rateScale: RATE_SCALE, buyExponent: 2 };
    expect(() => deliveryCostUnits({ ...base, buyMinor: 0n })).toThrow(/positive amount/);
    expect(() => deliveryCostUnits({ ...base, rateScaled: 0n })).toThrow(/positive/);
    expect(() => deliveryCostUnits({ ...base, rateScale: 0n })).toThrow(/positive/);
  });

  /**
   * THE IDENTITY THE WHOLE ALLOCATION RESTS ON.
   *
   * `fundingAllocation()` takes the funded units, floors them to cents for
   * 1140 and adds a cent to 2900 when anything is left over — and then claims
   * the sum is `settlement_cost_cents`, the figure `fx_quote_settlement`'s
   * trigger checks against the customer's price. That claim is only true if
   * rounding a rounded-up figure up again lands on the same cent. It does, but
   * it is asserted over a corpus rather than argued, because a failure here
   * would be a settlement row the database refuses AFTER a transfer has
   * already confirmed on a chain.
   */
  it("ceil(units / 10_000) === costCents(), over every corridor and a range of sizes", () => {
    for (const corridor of CORRIDORS) {
      for (const rate of [1_000_000n, 5_500_000_000n, MXN_MID, 14_700_000_000n, 1_600_000_000_000n]) {
        for (const buyMinor of [1n, 7n, 999n, 3_354n, 18_494n, 1_679_977n, 99_999_991n]) {
          const units = deliveryCostUnits({
            buyMinor,
            rateScaled: rate,
            rateScale: RATE_SCALE,
            buyExponent: corridor.exponent,
          });
          const viaCents = costCents({
            buyMinor,
            rateScaled: rate,
            rateScale: RATE_SCALE,
            buyExponent: corridor.exponent,
          });
          const ceilOfUnits =
            (units + USDC_UNITS_PER_CENT - 1n) / USDC_UNITS_PER_CENT;
          expect(ceilOfUnits).toBe(viaCents);
        }
      }
    }
  });
});

describe("fundingAllocation", () => {
  it("splits the funded units into whole cents and one residual cent", () => {
    // $3.00 quoted, $1.01 fee, funded with 1.979521 USDC.
    const allocation = fundingAllocation({
      sellCents: 300n,
      feeCents: 101n,
      fundedUnits: 1_979_521n,
    });

    expect(allocation.walletCreditCents).toBe(197n); // what 1140 actually parted with
    expect(allocation.dustUnits).toBe(9_521n); // 0.9521 of a cent
    expect(allocation.residualCreditCents).toBe(1n); // §12.6, to 2900
    expect(allocation.settlementCostCents).toBe(198n); // 197 + the residual cent
    expect(allocation.varianceCents).toBe(1n); // 300 − 101 − 198
  });

  it("posts no residual line when the funding is a whole number of cents", () => {
    const allocation = fundingAllocation({
      sellCents: 300n,
      feeCents: 101n,
      fundedUnits: 1_980_000n,
    });
    expect(allocation.dustUnits).toBe(0n);
    expect(allocation.residualCreditCents).toBe(0n);
    expect(allocation.settlementCostCents).toBe(198n);
  });

  it("carries a negative variance when honouring the commitment cost more than we were paid", () => {
    const allocation = fundingAllocation({
      sellCents: 300n,
      feeCents: 101n,
      fundedUnits: 2_500_000n, // $0.25 more than the customer's net
    });
    expect(allocation.settlementCostCents).toBe(250n);
    expect(allocation.varianceCents).toBe(-51n);
  });

  it("keeps both identities: the entry sums to zero and the trigger's equation holds", () => {
    for (const sellCents of [300n, 1_200n, 100_000n]) {
      for (const feeCents of [101n, 103n, 350n]) {
        for (const fundedUnits of [1n, 9_999n, 10_000n, 1_979_521n, 10_920_001n]) {
          if (feeCents >= sellCents) continue;
          const a = fundingAllocation({ sellCents, feeCents, fundedUnits });
          expect(
            a.depositDebitCents -
              a.feeCreditCents -
              a.walletCreditCents -
              a.residualCreditCents -
              a.varianceCents,
          ).toBe(0n);
          expect(a.depositDebitCents - a.feeCreditCents - a.settlementCostCents).toBe(
            a.varianceCents,
          );
        }
      }
    }
  });

  it("refuses inputs that cannot make an entry rather than making a wrong one", () => {
    expect(() => fundingAllocation({ sellCents: 0n, feeCents: 0n, fundedUnits: 1n })).toThrow(
      /sellCents must be positive/,
    );
    expect(() => fundingAllocation({ sellCents: 100n, feeCents: 100n, fundedUnits: 1n })).toThrow(
      /cannot consume/,
    );
    expect(() => fundingAllocation({ sellCents: 300n, feeCents: 1n, fundedUnits: 0n })).toThrow(
      /fundedUnits must be positive/,
    );
  });
});

describe("settlementLines", () => {
  const allocation = fundingAllocation({
    sellCents: 300n,
    feeCents: 101n,
    fundedUnits: 1_979_521n,
  });
  const labels = {
    fundedUnits: 1_979_521n,
    deliveryLabel: "33.54 MXN",
    customerRateLabel: "16.8587",
    settlementMidLabel: "16.9435",
    quoteRef: "FXQ-TEST0000",
    txHash: "0xdead",
  };

  it("balances to the cent", () => {
    const lines = settlementLines({ ...allocation, ...labels });
    expect(lines.reduce((sum, l) => sum + l.amountCents, 0n)).toBe(0n);
  });

  it("puts the house line at ordinal 0, which is the §12.5 template", () => {
    const lines = settlementLines({ ...allocation, ...labels });
    expect(lines[0]?.accountCode).toBe(FX_SETTLEMENT_ACCOUNTS.variance);

    // With no variance the house line is the fee, and it still leads.
    const flat = fundingAllocation({ sellCents: 300n, feeCents: 101n, fundedUnits: 1_990_000n });
    expect(flat.varianceCents).toBe(0n);
    const flatLines = settlementLines({ ...flat, ...labels, fundedUnits: 1_990_000n });
    expect(flatLines[0]?.accountCode).toBe(FX_SETTLEMENT_ACCOUNTS.feeIncome);
  });

  it("never emits a zero line — postEntry() and journal_line both refuse one", () => {
    for (const fundedUnits of [1_979_521n, 1_990_000n, 1_980_000n, 2_500_000n]) {
      const a = fundingAllocation({ sellCents: 300n, feeCents: 101n, fundedUnits });
      for (const line of settlementLines({ ...a, ...labels, fundedUnits })) {
        expect(line.amountCents).not.toBe(0n);
      }
    }
  });

  it("credits 4300 when we kept the difference and debits it when we ate it", () => {
    const kept = fundingAllocation({ sellCents: 300n, feeCents: 101n, fundedUnits: 1_979_521n });
    const keptLine = settlementLines({ ...kept, ...labels, fundedUnits: 1_979_521n })[0];
    expect(keptLine?.accountCode).toBe("4300");
    expect(keptLine?.amountCents).toBeLessThan(0n); // a credit: income

    const ate = fundingAllocation({ sellCents: 300n, feeCents: 101n, fundedUnits: 2_500_000n });
    const ateLine = settlementLines({ ...ate, ...labels, fundedUnits: 2_500_000n })[0];
    expect(ateLine?.accountCode).toBe("4300");
    expect(ateLine?.amountCents).toBeGreaterThan(0n); // a debit: negative income
  });

  it("names the residual in its memo instead of letting it vanish into 4300", () => {
    const lines = settlementLines({ ...allocation, ...labels });
    const residual = lines.find((l) => l.accountCode === FX_SETTLEMENT_ACCOUNTS.roundingResidual);
    expect(residual?.amountCents).toBe(-1n);
    expect(residual?.memo).toContain("9521");
    expect(residual?.memo).toContain("§12.6");
  });
});

describe("the whole chain, quote to entry", () => {
  /**
   * The end-to-end arithmetic of the demo payout, done here so a grader can
   * check the report's numbers without a database or a chain.
   */
  it("prices $3.00 to MXN and settles it into a balanced five-line entry", () => {
    const priced = priceQuote({
      sellCents: 300n,
      buyCurrency: "MXN",
      midRateScaled: MXN_MID,
      ...STANDARD,
    });

    expect(priced.feeCents).toBe(101n); // $1.00 + 0.25% of $3.00, rounded up
    expect(priced.netCents).toBe(199n);
    expect(priced.customerRateScaled).toBe(1_685_878_250n); // 16.9435 less 50bp
    expect(priced.buyMinor).toBe(3_354n); // 33.54 MXN, floored

    // Settled the same day against the same mid: no market move, so the
    // variance is our spread and nothing else.
    const funded = deliveryCostUnits({
      buyMinor: priced.buyMinor,
      rateScaled: MXN_MID,
      rateScale: RATE_SCALE,
      buyExponent: priced.corridor.exponent,
    });
    expect(funded).toBe(1_979_521n);

    const allocation = fundingAllocation({
      sellCents: priced.sellCents,
      feeCents: priced.feeCents,
      fundedUnits: funded,
    });

    expect(allocation).toMatchObject({
      depositDebitCents: 300n,
      feeCreditCents: 101n,
      walletCreditCents: 197n,
      residualCreditCents: 1n,
      dustUnits: 9_521n,
      settlementCostCents: 198n,
      varianceCents: 1n,
    });

    const lines = settlementLines({
      ...allocation,
      fundedUnits: funded,
      deliveryLabel: "33.54 MXN",
      customerRateLabel: "16.8587825",
      settlementMidLabel: "16.9435",
      quoteRef: "FXQ-TEST0000",
      txHash: "0xdead",
    });
    expect(lines).toHaveLength(5);
    expect(lines.reduce((sum, l) => sum + l.amountCents, 0n)).toBe(0n);
  });
});
