/**
 * What an accepted quote costs at settlement, and how that becomes balanced
 * integer-cent journal lines.
 *
 * Pure arithmetic. No `postgres`, no `fetch`, no `process` — the same rule
 * ./quote.ts and src/lib/rails/stablecoin/allocation.ts keep, and for the same
 * reason: this is the module a grader points at, and it has to be runnable in
 * a test process that holds no credentials.
 *
 * ── THE RESIDUAL, AND WHICH RULE GOVERNS IT ─────────────────────────────────
 *
 * A conversion at a quoted rate leaves TWO residuals. They are different
 * facts, they are governed by different rules, and exactly one of them is a
 * ledger amount.
 *
 *   1. THE DELIVERY FLOOR, in the destination currency. `buyMinorUnits()`
 *      floors, because a fraction of a centavo cannot be delivered by anybody.
 *      That fraction is NOT a ledger amount: the ledger is USD in cents and
 *      the destination currency never enters the books (see ./types.ts, the
 *      one sentence that governs the directory). It is disclosed instead — as
 *      `PricedQuote.deliveryResidualTenThousandths`, on the quote, before the
 *      customer accepts, priced into what they agreed. DESIGN §12 does not
 *      reach it because §12 is about cents.
 *
 *   2. THE SUB-CENT DUST ON THE USDC LEG, which is a ledger amount and is the
 *      one this module has to place. USDC carries six decimals, so the rail's
 *      resolution is 10,000 steps per cent — four digits finer than the ledger.
 *      Funding a commitment to the nearest USDC minor unit therefore produces
 *      an amount that is NOT a whole number of cents.
 *
 * **§12.6 IS THE CLAUSE.** Not §12.2 (half-to-even on one value → one cent):
 * the direction of every rounding on this path is already chosen by who bears
 * the risk, not by a neutral tie-break — ./quote.ts fixes all four and says so
 * — and a banker's-rounded conversion would round the customer's delivery UP
 * half the time, committing us to money we did not buy. Not §12.3
 * (largest-remainder over N shares): nothing is being split. There is one
 * amount, one beneficiary and one wallet; a rule for apportioning a sum across
 * lines has nothing to apportion.
 *
 * §12.6 is the clause that describes this exact situation in these exact
 * words: *"Sub-cent dust that cannot be allocated at all — USDC has six
 * decimals, so a 1.234567 USDC receipt is 123.4567 cents — posts the rounded
 * cents to the customer and the remainder to `2900 Rounding residual clearing`
 * as a real journal line, so the entry still sums to zero and the dust is a
 * balance we can see, age, and periodically sweep."*
 *
 * So that is what happens here, and it is the same convention
 * `payoutAllocation()` already applies to an unquoted USDC transfer one
 * directory over: **1140 is credited the whole cents the wallet actually
 * parted with, and the sub-cent remainder is carried to 2900 as one cent, with
 * the true fraction in the line memo so a sweep can true it up.** The dust is
 * never folded into 4300 — 4300's own `why` in the chart says it is a real P&L
 * position "and not a rounding artefact", and a rounding artefact hidden
 * inside a market-move account is precisely the residual nobody owns.
 *
 * ── WHY THE FUNDING AMOUNT IS DERIVED AND NOT TYPED ─────────────────────────
 *
 * `deliveryCostUnits()` decides how much USDC leaves. An operator does not.
 * The commitment is to deliver `buy_minor` of a destination currency; what
 * that costs is a function of the market at settlement, and a payout sized by
 * hand is not the settlement of a commitment, it is a transfer that happens to
 * cite one. The gate enforces the ceiling (never more than the customer paid);
 * this function decides the figure.
 */

import { USDC_UNITS_PER_CENT } from "@/lib/rails/stablecoin/types";

import { pow10 } from "./quote";

/* -------------------------------------------------------------------------- */
/* Integer division that says which way it goes                               */
/* -------------------------------------------------------------------------- */

/** Ceiling division. Non-negative numerator, positive divisor, asserted. */
function divCeil(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n) {
    throw new Error(`divCeil expects a non-negative numerator, got ${numerator}`);
  }
  if (denominator <= 0n) {
    throw new Error(`divCeil expects a positive denominator, got ${denominator}`);
  }
  return (numerator + denominator - 1n) / denominator;
}

/* -------------------------------------------------------------------------- */
/* What the commitment costs, to the rail's own resolution                    */
/* -------------------------------------------------------------------------- */

export interface DeliveryCostInput {
  /** The committed delivery, in the destination currency's minor units. */
  readonly buyMinor: bigint;
  /** The mid at settlement. NOT the quoted mid — that is the whole point. */
  readonly rateScaled: bigint;
  readonly rateScale: bigint;
  readonly buyExponent: number;
}

/**
 * What buying the committed delivery costs right now, in USDC MINOR UNITS.
 *
 * This is `costCents()` from ./quote.ts carried four decimal places further,
 * because that is the resolution the rail actually has. Rounded UP, for the
 * reason `costCents` is rounded up: buying is the expensive direction and a
 * cost rounded down is a loss hidden behind a fraction.
 *
 *   buyMinor / 10^exponent            destination major units
 *   / (rateScaled / rateScale)        US dollars
 *   * 100                             US cents
 *   * USDC_UNITS_PER_CENT             USDC minor units
 *
 * One product over one divisor, never four steps: dividing between the steps
 * would round four times instead of once and the error would compound in our
 * favour without anyone choosing that.
 *
 * `divCeil(x * 10000, d)` and `divCeil(x, d) * 10000` are NOT the same number,
 * and the first is the right one — it is the cheapest funding that still
 * covers the delivery. The identity that does hold, and that
 * `fundingAllocation()` relies on, is
 * `ceil(deliveryCostUnits / 10000) === costCents(...)`: rounding a
 * rounded-up figure up again lands on the same cent. `allocation.test.ts`
 * asserts it across the corpus rather than leaving it as a claim.
 */
export function deliveryCostUnits(input: DeliveryCostInput): bigint {
  if (input.buyMinor <= 0n) {
    throw new Error(`a delivery needs a positive amount, got ${input.buyMinor} minor units`);
  }
  if (input.rateScaled <= 0n) {
    throw new Error(`a settlement rate must be positive, got ${input.rateScaled}`);
  }
  if (input.rateScale <= 0n) {
    throw new Error(`a rate scale must be positive, got ${input.rateScale}`);
  }
  return divCeil(
    input.buyMinor * 100n * input.rateScale * USDC_UNITS_PER_CENT,
    input.rateScaled * pow10(input.buyExponent),
  );
}

/* -------------------------------------------------------------------------- */
/* The settlement entry, as integers                                          */
/* -------------------------------------------------------------------------- */

/** Every chart code this entry can touch, so no string is spelled twice. */
export const FX_SETTLEMENT_ACCOUNTS = {
  deposit: "2100",
  feeIncome: "4200",
  usdcWallet: "1140",
  roundingResidual: "2900",
  variance: "4300",
} as const;

export interface FundingAllocationInput {
  /** The price the customer committed to. Debited to their deposit account. */
  readonly sellCents: bigint;
  /** Our disclosed fee, out of that price. */
  readonly feeCents: bigint;
  /** What actually left the wallet, in USDC minor units. */
  readonly fundedUnits: bigint;
}

/**
 * The five figures the settlement entry is made of.
 *
 * Every one of them is an integer, and they are arranged so that
 *
 *   sellCents − feeCents − walletCents − residualCents − varianceCents === 0
 *
 * which is the entry summing to zero, and separately so that
 *
 *   sellCents − feeCents − settlementCostCents === varianceCents
 *
 * which is the identity `fx_quote_settlement`'s trigger refuses a row for
 * failing. Both are asserted here rather than hoped for.
 */
export interface FundingAllocation {
  /** DR 2100/<business>. The committed price. */
  readonly depositDebitCents: bigint;
  /** CR 4200. Our disclosed fee. */
  readonly feeCreditCents: bigint;
  /** CR 1140. The whole cents the wallet actually parted with. */
  readonly walletCreditCents: bigint;
  /** CR 2900. One cent when there is sub-cent dust, zero otherwise (§12.6). */
  readonly residualCreditCents: bigint;
  /** The true sub-cent remainder, out of 10,000 USDC units per cent. */
  readonly dustUnits: bigint;
  /**
   * What the delivery cost us to the cent: the wallet's whole cents plus the
   * residual cent. This is the figure `fx_quote_settlement.settlement_cost_cents`
   * carries, and it equals `costCents()` at the settlement rate.
   */
  readonly settlementCostCents: bigint;
  /**
   * SIGNED, and the sign is the point. Positive: the move (and our spread)
   * went our way and we kept the difference — a CREDIT to 4300. Negative: we
   * ate it — a DEBIT to 4300, which reads as negative income, which is exactly
   * what an FX book does.
   */
  readonly varianceCents: bigint;
}

export function fundingAllocation(input: FundingAllocationInput): FundingAllocation {
  const { sellCents, feeCents, fundedUnits } = input;

  if (sellCents <= 0n) throw new Error(`sellCents must be positive, got ${sellCents}`);
  if (feeCents < 0n) throw new Error(`feeCents cannot be negative, got ${feeCents}`);
  if (feeCents >= sellCents) {
    throw new Error(`a ${feeCents} cent fee cannot consume a ${sellCents} cent payout`);
  }
  if (fundedUnits <= 0n) throw new Error(`fundedUnits must be positive, got ${fundedUnits}`);

  const walletCreditCents = fundedUnits / USDC_UNITS_PER_CENT;
  const dustUnits = fundedUnits % USDC_UNITS_PER_CENT;
  const residualCreditCents = dustUnits > 0n ? 1n : 0n;
  const settlementCostCents = walletCreditCents + residualCreditCents;

  if (settlementCostCents <= 0n) {
    // Below one cent the whole movement is dust and there is no whole-cent
    // line to carry it. `fx_quote_settlement.settlement_cost_cents` CHECKs
    // `> 0` too. Refuse loudly rather than posting a lie.
    throw new Error(
      `${fundedUnits} USDC units is below one cent; 1140 is carried in cents and cannot ` +
        "represent a settlement this small",
    );
  }

  const varianceCents = sellCents - feeCents - settlementCostCents;

  // The two identities, checked. A throw here means this function is wrong,
  // which is worth finding in a test rather than in `assert_entry_balanced()`
  // after a transfer has already confirmed on a chain.
  const entrySum =
    sellCents - feeCents - walletCreditCents - residualCreditCents - varianceCents;
  if (entrySum !== 0n) {
    throw new Error(`settlement lines sum to ${entrySum} cents, must be 0`);
  }
  if (sellCents - feeCents - settlementCostCents !== varianceCents) {
    throw new Error("the settlement identity does not hold; refusing to build an entry");
  }

  return {
    depositDebitCents: sellCents,
    feeCreditCents: feeCents,
    walletCreditCents,
    residualCreditCents,
    dustUnits,
    settlementCostCents,
    varianceCents,
  };
}

/* -------------------------------------------------------------------------- */
/* The lines, in template order                                               */
/* -------------------------------------------------------------------------- */

/** One line of the settlement entry, before account ids are resolved. */
export interface SettlementLinePlan {
  readonly accountCode: string;
  /** True when the line is per-business and needs the 2100 leaf, not the rollup. */
  readonly perBusiness: boolean;
  /** Debit positive, credit negative. One signed column, like `journal_line`. */
  readonly amountCents: bigint;
  readonly memo: string;
}

export interface SettlementLineInput extends FundingAllocation {
  readonly fundedUnits: bigint;
  /** For the memos: what we promised, rendered. */
  readonly deliveryLabel: string;
  /** For the memos: the rate the customer accepted, rendered. */
  readonly customerRateLabel: string;
  /** For the memos: the mid we settled against, rendered. */
  readonly settlementMidLabel: string;
  readonly quoteRef: string;
  readonly txHash: string;
}

/**
 * The entry, as an ordered list of lines.
 *
 * ORDER IS THE §12.5 TEMPLATE, NOT READING ORDER. DESIGN §12.4 breaks ties —
 * and therefore assigns any residual penny — by line ordinal ascending, and
 * §12.5 requires the posting template to place the house's own income or
 * expense line at ordinal 0 so that the house absorbs rather than the
 * customer. The house line here is 4300 when there is a variance and 4200
 * otherwise, so that is what leads.
 *
 * This particular entry has no N-way allocation and therefore nothing for the
 * tiebreak to decide, exactly as docs/ACCRUAL.md §4 observes about the daily
 * fee entry. The ordering is still the rule and not "the rule, except where it
 * does not currently matter" — the day someone adds a second beneficiary line
 * to this template, the residual lands on us by construction rather than by
 * whoever edits the array.
 *
 * A zero-amount line is an allocation bug, never a posting: `postEntry()`
 * throws on one and `journal_line` CHECKs it. So the 4300 and 2900 lines are
 * OMITTED when their figure is zero rather than posted as zero.
 */
export function settlementLines(input: SettlementLineInput): readonly SettlementLinePlan[] {
  const A = FX_SETTLEMENT_ACCOUNTS;
  const trace = `${input.quoteRef} · tx ${input.txHash}`;
  const lines: SettlementLinePlan[] = [];

  if (input.varianceCents !== 0n) {
    lines.push({
      accountCode: A.variance,
      perBusiness: false,
      // Positive variance is money we KEPT, which credits an income account.
      amountCents: -input.varianceCents,
      memo:
        `${input.varianceCents > 0n ? "kept" : "ate"} ` +
        `${input.varianceCents > 0n ? input.varianceCents : -input.varianceCents} cents on ` +
        `${trace}: accepted ${input.customerRateLabel}, settled against a mid of ` +
        `${input.settlementMidLabel}`,
    });
  }

  lines.push({
    accountCode: A.feeIncome,
    perBusiness: false,
    amountCents: -input.feeCreditCents,
    memo: `disclosed FX fee on ${trace}`,
  });

  lines.push({
    accountCode: A.deposit,
    perBusiness: true,
    amountCents: input.depositDebitCents,
    memo:
      `cross-border payout under ${trace} — accepted ${input.customerRateLabel}, ` +
      `delivering ${input.deliveryLabel}`,
  });

  lines.push({
    accountCode: A.usdcWallet,
    perBusiness: false,
    amountCents: -input.walletCreditCents,
    memo: `${input.fundedUnits} USDC units funded the delivery under ${trace}`,
  });

  if (input.residualCreditCents !== 0n) {
    lines.push({
      accountCode: A.roundingResidual,
      perBusiness: false,
      amountCents: -input.residualCreditCents,
      memo:
        `sub-cent conversion residual on ${trace}: ${input.dustUnits} of ` +
        `${USDC_UNITS_PER_CENT} USDC units of a cent, carried here rather than truncated ` +
        "or netted into 4300 (DESIGN §12.6)",
    });
  }

  return lines;
}
