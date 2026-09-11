/**
 * The quote arithmetic. Integers only, and the same integers the database uses.
 *
 * ── WHY THIS EXISTS TWICE ───────────────────────────────────────────────────
 *
 * Every function here has a counterpart in db/migrations/0017_fx_quotes.sql —
 * `fx_fee_cents`, `fx_customer_rate`, `fx_buy_minor`, `fx_cost_cents` — and
 * duplicating a formula is normally the wrong answer. It is the right one here
 * for the same reason `aba.ts` is allowed to duplicate `aba_checksum_ok()`,
 * and under the same condition, which is not negotiable:
 *
 *   THE SCREEN HAS TO PRICE A QUOTE BEFORE ANYTHING IS STORED. A customer
 *   asking "what would this cost" has not agreed to anything, and making that
 *   a database round trip means a row for every idle question.
 *
 *   THE DATABASE HAS TO GENERATE WHAT IT STORES. `fee_cents`,
 *   `customer_rate_scaled` and `buy_minor` are GENERATED columns, so a caller
 *   cannot write a commitment that does not follow from the rate it claims —
 *   not even a caller with a psql prompt.
 *
 * Both are worth having, so both exist, and `fx.integration.test.ts` runs a
 * corpus through both and asserts they agree exactly. That test is the entire
 * justification for the duplication; without it this file is a liability.
 *
 * ── THE ROUNDING RULES, ALL FOUR OF THEM, IN ONE PLACE ──────────────────────
 *
 *   FEE            rounded UP.   Ours. At most one cent, disclosed.
 *   CUSTOMER RATE  rounded DOWN. Ours. Fewer destination units per dollar.
 *   DELIVERY       rounded DOWN. Unavoidable — a fraction of a centavo cannot
 *                                be delivered by anybody. Rounding up would
 *                                commit us to money we did not buy.
 *   SETTLEMENT COST rounded UP.  Against us. Buying is the expensive
 *                                direction and a cost rounded down is a loss
 *                                hidden by a penny.
 *
 * Three of the four favour us, which is what every dealer does and is exactly
 * why they are written down here, printed on the screen's arithmetic panel,
 * and repeated in docs/FX.md §4. A rounding rule nobody states is a rounding
 * rule nobody can audit.
 *
 * ── NO FLOATS ───────────────────────────────────────────────────────────────
 *
 * There is not a `number` in any money or rate position in this file. Cents
 * are `bigint`, rates are `bigint` scaled by `RATE_SCALE`, and basis points
 * and exponents are small integers used only as multipliers. `Math.round`,
 * `parseFloat` and `toFixed` appear nowhere.
 */

import {
  BPS_DENOMINATOR,
  FxCorridorError,
  MAX_MINOR_EXPONENT,
  RATE_SCALE,
  SELL_CURRENCY,
  requireCorridor,
  type Corridor,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Integer division that says which way it goes                               */
/* -------------------------------------------------------------------------- */

/**
 * Floor division for positive divisors.
 *
 * `bigint` division in JavaScript truncates toward zero, which is floor only
 * for non-negative numerators. Every numerator here is non-negative, and the
 * assertion says so rather than leaving a reader to check — a truncating
 * divide that meets a negative number one day is a rounding bug that shows up
 * as a cent, once, on one corridor.
 */
function divFloor(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n) throw new Error(`divFloor expects a non-negative numerator, got ${numerator}`);
  if (denominator <= 0n) throw new Error(`divFloor expects a positive denominator, got ${denominator}`);
  return numerator / denominator;
}

/** Ceiling division, same constraints. */
function divCeil(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n) throw new Error(`divCeil expects a non-negative numerator, got ${numerator}`);
  if (denominator <= 0n) throw new Error(`divCeil expects a positive denominator, got ${denominator}`);
  return (numerator + denominator - 1n) / denominator;
}

/**
 * 10^n as a bigint. `n` is a minor-unit exponent, so 0..`MAX_MINOR_EXPONENT`.
 *
 * ONE RANGE, NOT THREE. This guard used to admit 0..18 while its own doc
 * comment said 0..6, the database CHECK on `fx_quote.buy_exponent` said 0..6,
 * and `CORRIDORS` produced only {0, 2}. Three ranges for one quantity, and the
 * widest of them was the one that actually ran — so the function that turns an
 * exponent into a multiplier would happily have produced 10^18 for a column
 * that cannot store the row.
 *
 * The bound is now `MAX_MINOR_EXPONENT` = 6, the database's own number, stated
 * once in ./types.ts. It is deliberately WIDER than the {0, 2} the corridor
 * list produces: this is general arithmetic and narrowing it to today's two
 * corridors would be the "multiply by a hundred" shortcut the JPY corridor
 * exists to prevent. What pins an exponent to a currency is migration 0063's
 * composite CHECK, not a range.
 */
export function pow10(exponent: number): bigint {
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > MAX_MINOR_EXPONENT) {
    throw new FxCorridorError(
      `pow10 expects an integer minor-unit exponent in 0..${MAX_MINOR_EXPONENT}, got ${exponent}`,
    );
  }
  return 10n ** BigInt(exponent);
}

/* -------------------------------------------------------------------------- */
/* The four formulas                                                          */
/* -------------------------------------------------------------------------- */

/** SQL twin: `fx_fee_cents(bigint, bigint, integer)`. Rounded UP. */
export function feeCents(sellCents: bigint, flatCents: bigint, bps: number): bigint {
  return flatCents + divCeil(sellCents * BigInt(bps), BPS_DENOMINATOR);
}

/** SQL twin: `fx_customer_rate(bigint, integer)`. Rounded DOWN. */
export function customerRateScaled(midRateScaled: bigint, spreadBps: number): bigint {
  return divFloor(midRateScaled * (BPS_DENOMINATOR - BigInt(spreadBps)), BPS_DENOMINATOR);
}

/**
 * SQL twin: `fx_buy_minor(...)`. Rounded DOWN.
 *
 * The chain of units, so the 100 and the 10^exponent are not magic:
 *
 *   netCents                        US cents
 *   / 100                           US dollars
 *   * customerRate / RATE_SCALE     destination major units
 *   * 10^exponent                   destination minor units
 *
 * Done as one product over one divisor rather than four steps, because
 * dividing between the steps would round four times instead of once and the
 * error would compound in our favour without anyone choosing that.
 */
export function buyMinorUnits(input: {
  readonly netCents: bigint;
  readonly customerRateScaled: bigint;
  readonly rateScale: bigint;
  readonly buyExponent: number;
}): bigint {
  return divFloor(
    input.netCents * input.customerRateScaled * pow10(input.buyExponent),
    100n * input.rateScale,
  );
}

/**
 * SQL twin: `fx_cost_cents(...)`. Rounded UP.
 *
 * The inverse: what it costs, in US cents, to buy a committed delivery amount
 * at a given rate. This is the settlement-side question — "we promised
 * 16,799.77 MXN; the market is now here; what does that cost us today" — and
 * the difference between this and what the customer paid is the variance.
 */
export function costCents(input: {
  readonly buyMinor: bigint;
  readonly rateScaled: bigint;
  readonly rateScale: bigint;
  readonly buyExponent: number;
}): bigint {
  return divCeil(
    input.buyMinor * 100n * input.rateScale,
    input.rateScaled * pow10(input.buyExponent),
  );
}

/* -------------------------------------------------------------------------- */
/* A priced quote                                                             */
/* -------------------------------------------------------------------------- */

/** The terms of an offer: everything the price is a function of. */
export interface QuoteTerms {
  readonly sellCents: bigint;
  readonly buyCurrency: string;
  readonly midRateScaled: bigint;
  readonly rateScale?: bigint;
  readonly feeFlatCents: bigint;
  readonly feeBps: number;
  readonly spreadBps: number;
}

/**
 * Every number on the quote, with nothing left to compute downstream.
 *
 * The screen renders these and does no arithmetic of its own — the browser
 * never multiplies money. That is not fastidiousness: a figure computed in two
 * places is a figure that can disagree with itself, and the one on the screen
 * is the one the customer is agreeing to.
 */
export interface PricedQuote {
  readonly sellCurrency: string;
  readonly sellCents: bigint;
  readonly feeCents: bigint;
  readonly netCents: bigint;
  readonly midRateScaled: bigint;
  readonly customerRateScaled: bigint;
  readonly rateScale: bigint;
  readonly spreadBps: number;
  readonly feeBps: number;
  readonly feeFlatCents: bigint;
  readonly corridor: Corridor;
  readonly buyMinor: bigint;
  /**
   * What our spread is worth on this quote, in US cents, at the quoted mid.
   *
   * netCents minus what the delivery would cost at the MID rate. It is the
   * margin, made visible in dollars rather than left as a basis-point number
   * the customer has to apply themselves — and it is the figure the settlement
   * variance is measured against.
   */
  readonly spreadValueCents: bigint;
  /**
   * The fraction of a minor unit lost to the delivery floor, expressed in
   * ten-thousandths of a minor unit. Always 0..9999.
   *
   * Shown because it is the one rounding that is against the customer and is
   * unavoidable, and because stating "we rounded down" without the size of the
   * rounding is not a disclosure.
   */
  readonly deliveryResidualTenThousandths: bigint;
}

/**
 * Price an offer. Pure: same inputs, same output, forever.
 *
 * Throws on a corridor we do not quote and on a non-positive amount, rather
 * than returning a quote for a thing that cannot happen. Callers that take
 * user input validate before they get here (see the zod schema in
 * `src/app/(app)/payouts/actions.ts`); this throw is the backstop, and it
 * names the bad value.
 */
export function priceQuote(terms: QuoteTerms): PricedQuote {
  if (terms.sellCents <= 0n) {
    throw new Error(`a quote needs a positive amount, got ${terms.sellCents} cents`);
  }
  if (terms.midRateScaled <= 0n) {
    throw new Error(`a quote needs a positive rate, got ${terms.midRateScaled}`);
  }
  if (!Number.isInteger(terms.feeBps) || terms.feeBps < 0 || terms.feeBps > 1000) {
    throw new Error(`feeBps must be an integer in 0..1000, got ${terms.feeBps}`);
  }
  if (!Number.isInteger(terms.spreadBps) || terms.spreadBps < 0 || terms.spreadBps > 1000) {
    throw new Error(`spreadBps must be an integer in 0..1000, got ${terms.spreadBps}`);
  }

  const corridor = requireCorridor(terms.buyCurrency);
  const rateScale = terms.rateScale ?? RATE_SCALE;

  const fee = feeCents(terms.sellCents, terms.feeFlatCents, terms.feeBps);
  if (fee >= terms.sellCents) {
    throw new Error(
      `the fee (${fee} cents) would consume the whole payout (${terms.sellCents} cents); ` +
        "nothing would reach the beneficiary",
    );
  }
  const net = terms.sellCents - fee;
  const customerRate = customerRateScaled(terms.midRateScaled, terms.spreadBps);

  const buyMinor = buyMinorUnits({
    netCents: net,
    customerRateScaled: customerRate,
    rateScale,
    buyExponent: corridor.exponent,
  });
  if (buyMinor <= 0n) {
    throw new Error(
      `${terms.sellCents} cents less a ${fee} cent fee does not reach one ` +
        `${corridor.currency} minor unit at this rate; quote a larger amount`,
    );
  }

  // What the same delivery would cost at the MID. The difference is our
  // margin on the rate, in dollars, which is the number a customer can
  // actually reason about.
  const midCost = costCents({
    buyMinor,
    rateScaled: terms.midRateScaled,
    rateScale,
    buyExponent: corridor.exponent,
  });

  // The exact numerator and denominator of the delivery division, so the
  // residual is the true remainder rather than a re-derivation.
  const denominator = 100n * rateScale;
  const numerator = net * customerRate * pow10(corridor.exponent);
  const remainder = numerator % denominator;

  return {
    sellCurrency: SELL_CURRENCY,
    sellCents: terms.sellCents,
    feeCents: fee,
    netCents: net,
    midRateScaled: terms.midRateScaled,
    customerRateScaled: customerRate,
    rateScale,
    spreadBps: terms.spreadBps,
    feeBps: terms.feeBps,
    feeFlatCents: terms.feeFlatCents,
    corridor,
    buyMinor,
    spreadValueCents: net - midCost,
    deliveryResidualTenThousandths: divFloor(remainder * 10_000n, denominator),
  };
}

/* -------------------------------------------------------------------------- */
/* Settlement variance                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What an accepted quote cost us once the market moved.
 *
 * THIS IS THE QUESTION THE WHOLE FEATURE IS FOR. The customer accepted a rate;
 * the rate they get is the rate they saw; somebody eats the difference between
 * that and the market at settlement, and it is us. This computes how much.
 *
 *   variance = what the customer paid − our fee − what the delivery cost us
 *
 * SIGNED, and the sign is the point. Positive means the move went our way and
 * we kept the difference on top of the spread. Negative means we ate it — and
 * on a 24-hour window, a 50bp spread and an unhedged position, negative is not
 * rare. See docs/FX.md §6 for where this posts, and for the chart account that
 * does not exist yet.
 */
export interface SettlementVariance {
  readonly settlementCostCents: bigint;
  /** Signed. Positive we kept it, negative we ate it. */
  readonly varianceCents: bigint;
  /** The rate move itself, scaled, signed. Positive means the destination got cheaper for us. */
  readonly rateMoveScaled: bigint;
}

export function settlementVariance(input: {
  readonly sellCents: bigint;
  readonly feeCents: bigint;
  readonly buyMinor: bigint;
  readonly buyExponent: number;
  readonly quotedMidRateScaled: bigint;
  readonly settlementMidRateScaled: bigint;
  readonly rateScale: bigint;
}): SettlementVariance {
  const cost = costCents({
    buyMinor: input.buyMinor,
    rateScaled: input.settlementMidRateScaled,
    rateScale: input.rateScale,
    buyExponent: input.buyExponent,
  });

  return {
    settlementCostCents: cost,
    varianceCents: input.sellCents - input.feeCents - cost,
    // More destination units per dollar at settlement than at quote time means
    // the delivery got cheaper for us.
    rateMoveScaled: input.settlementMidRateScaled - input.quotedMidRateScaled,
  };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A scaled integer rate as a decimal string. Presentation only — never fed
 * back into arithmetic.
 *
 * Built by string surgery on the integer, not by dividing: `Number(1694350000)
 * / 1e8` is a float, and a float is how a rate ends up displaying as
 * 16.943499999999998 on the one screen where a customer is deciding whether to
 * agree to it.
 *
 * Trailing zeros are trimmed to `minDecimals` so 16.94350000 reads as 16.9435,
 * which is what the source actually said.
 */
export function formatRate(
  rateScaled: bigint,
  rateScale: bigint,
  options: { readonly minDecimals?: number } = {},
): string {
  const minDecimals = options.minDecimals ?? 2;
  const decimals = String(rateScale).length - 1;
  if (10n ** BigInt(decimals) !== rateScale) {
    throw new Error(`rate scale must be a power of ten, got ${rateScale}`);
  }

  const negative = rateScaled < 0n;
  const abs = negative ? -rateScaled : rateScaled;
  const whole = abs / rateScale;
  let fraction = (abs % rateScale).toString().padStart(decimals, "0");
  while (fraction.length > minDecimals && fraction.endsWith("0")) {
    fraction = fraction.slice(0, -1);
  }

  const body = fraction.length === 0 ? `${whole}` : `${whole}.${fraction}`;
  return negative ? `-${body}` : body;
}

/**
 * An amount in a destination currency's minor units, as a grouped decimal
 * string with its code. `1679977` MXN at exponent 2 becomes `16,799.77 MXN`.
 *
 * Presentation only, and never `Intl.NumberFormat` on a divided float: the
 * grouping is done on the digit string. A delivery amount is the number the
 * customer is committing to and it must not pass through a double on its way
 * to their eyes.
 */
export function formatMinorUnits(minor: bigint, exponent: number, currency: string): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const scale = pow10(exponent);
  const whole = (abs / scale).toString();
  const fraction = exponent === 0 ? "" : (abs % scale).toString().padStart(exponent, "0");

  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = fraction === "" ? grouped : `${grouped}.${fraction}`;
  return `${negative ? "-" : ""}${body} ${currency}`;
}

/** Basis points as a percentage string, by integer arithmetic. `50` is `0.50%`. */
export function formatBps(bps: number): string {
  if (!Number.isInteger(bps) || bps < 0) throw new Error(`bps must be a non-negative integer, got ${bps}`);
  const whole = Math.trunc(bps / 100);
  const fraction = String(bps % 100).padStart(2, "0");
  return `${whole}.${fraction}%`;
}
