/**
 * The FX quote.
 *
 * Four modules and one seam, arranged so the two that can fail do not sit on
 * the path of the one that must not:
 *
 *   types.ts   pure data — corridors, scales, states, refusal codes
 *   quote.ts   pure arithmetic — the four formulas, integers only
 *   rate.ts    the network — one free source, one labelled fallback
 *   store.ts   the database — reads, and the three append-only writes
 *   gate.ts    the predicate the payout path calls
 *
 * `store.ts` and `gate.ts` are `server-only`; the other three are not, so the
 * arithmetic and the vocabulary can be tested, scripted and imported anywhere
 * without dragging a connection along.
 *
 * NOTE that this barrel deliberately does NOT re-export `store.ts` or
 * `gate.ts`. Both are `server-only`, and a barrel that mixes them with the
 * pure modules means any import of `formatRate` pulls `postgres` into the
 * graph — which is the bug `src/lib/rails/stablecoin/index.ts` has to work
 * around by exporting its ledger module separately. Import those two by path.
 */

export {
  BPS_DENOMINATOR,
  CORRIDORS,
  CORRIDOR_CODES,
  DEFAULT_FEE_BPS,
  DEFAULT_FEE_FLAT_CENTS,
  DEFAULT_QUOTE_TTL_SECONDS,
  DEFAULT_SETTLEMENT_WINDOW_SECONDS,
  DEFAULT_SPREAD_BPS,
  FX_REFUSAL_CODES,
  QUOTE_STATES,
  RATE_SCALE,
  RATE_SCALE_DECIMALS,
  SELL_CURRENCY,
  findCorridor,
  isCommitted,
  isQuoteState,
  requireCorridor,
  type Corridor,
  type FxRefusal,
  type FxRefusalCode,
  type QuoteState,
  type RateEvidence,
  type RateObservation,
} from "./types";

export {
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
  type PricedQuote,
  type QuoteTerms,
  type SettlementVariance,
} from "./quote";

export {
  FIXED_RATE_TABLE,
  FIXED_TABLE_DATE,
  FIXED_TABLE_SOURCE,
  FRANKFURTER_BASE_URL,
  FRANKFURTER_SOURCE,
  RateSourceError,
  extractRateLiteral,
  fetchMidRate,
  fixedRate,
  frankfurterUrl,
  observeRate,
  parseDecimalToScaled,
  rateAgeDays,
  type FetchRateOptions,
} from "./rate";
