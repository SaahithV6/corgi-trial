/**
 * The FX quote's vocabulary: corridors, scales, states and refusals.
 *
 * Pure data and pure types. No `postgres`, no `fetch`, no `process` — the
 * same discipline `src/lib/ledger/chart.ts` keeps, and for the same reason:
 * this module is imported by the screen, by the gate, by the tests and by a
 * `.mjs` script through the TypeScript loader, and any one of those picking up
 * a database handle by accident would be a bug that only shows up in
 * production.
 *
 * ── THE ONE SENTENCE THAT GOVERNS THIS WHOLE DIRECTORY ──────────────────────
 *
 * THE LEDGER IS USD, IN CENTS. A quote is a customer-facing commitment about a
 * payout; it is not a second currency in the books. The only non-USD number in
 * this feature is the delivery amount the beneficiary is promised, it lives on
 * one column of one table, and nothing ever adds it to a dollar. If a change
 * here starts wanting a currency on `journal_line`, the change is wrong.
 */

/* -------------------------------------------------------------------------- */
/* Scale                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Rates are integers scaled by 10^8. Never floats, anywhere.
 *
 * WHY EIGHT. The two constraints pull in opposite directions. Too few decimals
 * and a high-magnitude pair loses precision that matters: IDR is ~16,000 to
 * the dollar, so at 4 decimals the smallest representable step is already
 * 0.0001 of 16,000 — six significant figures, which is fine — but the inverse
 * quote (USD per IDR, 0.0000625) has only two. Too many and the products
 * inside `buyMinorUnits` grow for no gain. Eight decimals holds every pair
 * either way round with headroom, and it is the precision the FX market itself
 * quotes small-figure crosses at.
 *
 * The scale is also STORED on every row that carries a rate
 * (`fx_rate_observation.rate_scale`, `fx_quote.rate_scale`) rather than being
 * assumed to be this constant. Widening it later must not silently multiply
 * every historical quote by a hundred.
 */
export const RATE_SCALE = 100_000_000n;

/** The decimal places `RATE_SCALE` represents. Used for rendering only. */
export const RATE_SCALE_DECIMALS = 8;

/** Basis points are integers too. 10,000 bps is 100%. */
export const BPS_DENOMINATOR = 10_000n;

/* -------------------------------------------------------------------------- */
/* Corridors                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A destination currency this system will quote.
 *
 * Deliberately a short, closed list rather than "whatever the rate source
 * returns". A corridor is not a currency code — it is a promise that somebody
 * at the far end can actually pay a beneficiary in that currency, and this
 * build has no off-ramp partner for any of them (said plainly on the screen
 * and in docs/FX.md §7). Listing thirty currencies would dress that gap up as
 * coverage.
 *
 * These five are here because they are the real US outbound corridors — Mexico
 * and the Philippines are the two largest remittance destinations from the
 * United States, India the largest by value, Brazil the largest in South
 * America — and because JPY has a zero minor-unit exponent, which keeps the
 * exponent arithmetic honest instead of letting `* 100` hide everywhere.
 */
export interface Corridor {
  /** ISO 4217 alphabetic code. */
  readonly currency: string;
  /** ISO 4217 minor-unit exponent. 2 for centavos, 0 for yen. */
  readonly exponent: number;
  /** The currency's name, for a screen. */
  readonly name: string;
  /** Where the beneficiary is, for a screen. */
  readonly destination: string;
}

export const CORRIDORS: readonly Corridor[] = [
  { currency: "MXN", exponent: 2, name: "Mexican peso", destination: "Mexico" },
  { currency: "PHP", exponent: 2, name: "Philippine peso", destination: "the Philippines" },
  { currency: "INR", exponent: 2, name: "Indian rupee", destination: "India" },
  { currency: "BRL", exponent: 2, name: "Brazilian real", destination: "Brazil" },
  // Exponent 0. Kept in the list specifically so the minor-unit arithmetic has
  // to be general rather than "multiply by a hundred".
  { currency: "JPY", exponent: 0, name: "Japanese yen", destination: "Japan" },
];

const CORRIDOR_BY_CODE: ReadonlyMap<string, Corridor> = new Map(
  CORRIDORS.map((c) => [c.currency, c]),
);

/** Every quotable destination code, in list order. */
export const CORRIDOR_CODES: readonly string[] = CORRIDORS.map((c) => c.currency);

/** Resolve a corridor, or `undefined` for one we do not quote. */
export function findCorridor(currency: string): Corridor | undefined {
  return CORRIDOR_BY_CODE.get(currency.toUpperCase());
}

/**
 * Resolve a corridor, or throw an `FxCorridorError` carrying
 * `FX_CORRIDOR_UNSUPPORTED`. For a call site that has already decided.
 *
 * THE ERROR IS NAMED because a bare `Error` here collapsed into whatever the
 * entry point's catch-all happened to be — `INVALID_FORM` from a form action,
 * `UNQUOTABLE` from the gate — so two different facts ("we do not pay into
 * that currency" and "your form is malformed") reached the customer as one
 * sentence. The code is a member of `FX_REFUSAL_CODES`, so a caller can
 * surface it the same way it surfaces every other refusal.
 */
export function requireCorridor(currency: string): Corridor {
  const corridor = CORRIDOR_BY_CODE.get(currency.toUpperCase());
  if (corridor === undefined) {
    throw new FxCorridorError(
      `We do not pay out in '${currency}'. The currencies we quote today are ` +
        `${CORRIDOR_CODES.join(", ")} — pick one of those and quote again at /client/payouts.`,
    );
  }
  return corridor;
}

/**
 * The exponents the corridor list actually produces, which is the ONLY set
 * the arithmetic and the database have to agree on.
 *
 * THIS EXISTS BECAUSE THERE WERE THREE RANGES FOR ONE QUANTITY: `pow10`'s
 * guard admitted 0..18, its own doc comment said 0..6, and the database CHECK
 * on `fx_quote.buy_exponent` said 0..6 — while `CORRIDORS` has only ever
 * produced {0, 2}. Three spellings of one fact is how a JPY quote at exponent
 * 2 delivers a hundred times the yen it promised, so there is now one
 * spelling: this set, `pow10`'s guard (below, 0..6, the widest the database
 * will accept), and migration 0063's composite CHECK, which pins the exponent
 * to the currency rather than to a range at all.
 */
export const CORRIDOR_EXPONENTS: ReadonlySet<number> = new Set(CORRIDORS.map((c) => c.exponent));

/**
 * The widest exponent any layer will accept: the database CHECK on
 * `fx_quote.buy_exponent` (migration 0017 §3), which `pow10` now matches
 * exactly. Wider than `CORRIDOR_EXPONENTS` on purpose — the arithmetic is
 * general, the corridor list is what is actually quotable — and never wider
 * than the column, so a value the arithmetic accepts is a value the row can
 * hold.
 */
export const MAX_MINOR_EXPONENT = 6;

/** The currency the customer always sends. There is no second one. */
export const SELL_CURRENCY = "USD";

/* -------------------------------------------------------------------------- */
/* The standard terms of an offer                                             */
/* -------------------------------------------------------------------------- */

/**
 * How long an offer stands.
 *
 * Two minutes is a deliberate middle. A dealable interbank price is good for
 * seconds; a retail remittance quote is often good for fifteen minutes,
 * because the provider has hedged it. We have hedged nothing, so a long quote
 * is a free option we handed the customer — but a quote that lapses before a
 * person can read the screen is a control that trains people to click fast
 * rather than read. Two minutes is long enough to read the arithmetic and
 * short enough that the expiry is a real event you can watch happen.
 *
 * The database's ceiling is fifteen minutes (`fx_quote_expiry_is_short`).
 */
export const DEFAULT_QUOTE_TTL_SECONDS = 120;

/**
 * How long the commitment stands once accepted.
 *
 * An acceptance is not an indefinite obligation. Twenty-four hours is the
 * window: long enough to cover an approval queue, a business day boundary and
 * a slow chain, short enough that our unhedged exposure to one customer's
 * commitment is a day's move and not a quarter's.
 */
export const DEFAULT_SETTLEMENT_WINDOW_SECONDS = 86_400;

/**
 * The disclosed fee: $1.00 plus 25 basis points.
 *
 * Both halves exist because both halves are real. The flat part is what it
 * costs us to originate anything at all — gas, an off-ramp instruction, a
 * reconciliation line — and it does not get cheaper on a small payout. The
 * proportional part is the risk, which does scale.
 */
export const DEFAULT_FEE_FLAT_CENTS = 100n;
export const DEFAULT_FEE_BPS = 25;

/**
 * The spread: 50 basis points off the mid rate.
 *
 * THIS IS THE CHARGE THAT NORMALLY HIDES. A remittance provider quoting "zero
 * fees" is taking its margin here, inside the rate, where the customer cannot
 * see it without knowing the mid. It is a separate field from the fee, it is
 * printed as its own line on the quote, and the mid it was taken from is
 * printed beside it. That is the whole reason `spread_bps` and `fee_bps` are
 * two columns rather than one blended number.
 *
 * Fifty basis points is also roughly the honest price of the risk it covers:
 * we are committing to a rate for up to a day with no hedge, and one day's
 * move on USD/MXN is larger than that more often than anybody would like —
 * which is exactly why `fx_quote_settlement.variance_cents` exists.
 */
export const DEFAULT_SPREAD_BPS = 50;

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The five states of a quote, derived and never stored — the same rule
 * available balance follows. `v_fx_quote.state` is the authority; this union
 * exists so TypeScript can exhaust it.
 *
 * `expired` and `lapsed` are different words for different facts and the
 * distinction is load-bearing:
 *
 *   expired — nobody accepted the offer in time. We committed to nothing, the
 *             customer lost nothing, and the remedy is one click: re-quote.
 *   lapsed  — the offer WAS accepted, so we did commit, and we honoured that
 *             commitment for the whole settlement window the offer named. The
 *             customer did not send in time. The remedy is still a re-quote,
 *             but the fact is not the same fact and a screen that says
 *             "expired" for both cannot explain what happened.
 */
export const QUOTE_STATES = ["open", "expired", "accepted", "lapsed", "settled"] as const;

export type QuoteState = (typeof QUOTE_STATES)[number];

export function isQuoteState(value: string): value is QuoteState {
  return QUOTE_STATES.some((s) => s === value);
}

/** Which states are a commitment we are on the hook for. */
export function isCommitted(state: QuoteState): boolean {
  return state === "accepted" || state === "settled";
}

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Why a payout was refused by the quote gate.
 *
 * Nine codes rather than one, for the reason `payee_directory_result` has four
 * values rather than two: these are nine different facts with nine different
 * remedies, and an operator holding a single `FX_QUOTE_INVALID` cannot tell
 * "you never quoted this" from "you quoted it and waited too long".
 *
 * `FX_QUOTE_NOT_ACCEPTED` is the headline one — it is the answer to "a payout
 * without an accepted, unexpired quote must be refused".
 */
export const FX_REFUSAL_CODES = [
  /** No quote was referenced at all. The payout named no commitment. */
  "FX_QUOTE_REQUIRED",
  /** A reference was given and it matches nothing on file. */
  "FX_QUOTE_NOT_FOUND",
  /** The quote exists and nobody accepted it — including because it expired unaccepted. */
  "FX_QUOTE_NOT_ACCEPTED",
  /** Accepted, but the settlement window named in the offer has closed. */
  "FX_QUOTE_COMMITMENT_LAPSED",
  /** Already consumed by a payout. One accepted rate funds one transfer. */
  "FX_QUOTE_ALREADY_SETTLED",
  /** The payout does not match the quote it claims: wrong amount, wrong destination. */
  "FX_QUOTE_MISMATCH",
  /**
   * The acceptance was refused because the customer does not have the money.
   *
   * Raised at ACCEPTANCE, not at the payout — which is the point of it. Every
   * code above is a payout-time refusal; this one fires two steps earlier,
   * because an accepted quote now reserves the price it commits (migration
   * 0053) and a commitment nobody can fund is a commitment we should never
   * have made. Nothing is written when it fires: no acceptance, no hold, no
   * rate locked.
   */
  "FX_COMMITMENT_EXCEEDS_AVAILABLE",
  /**
   * The customer has no 2100 deposit leaf, or the chart has no 9300 memo leaf,
   * so the commitment cannot be withheld. FAILS CLOSED: an acceptance whose
   * hold cannot be placed is an acceptance that does not happen.
   */
  "FX_COMMITMENT_NO_ACCOUNT",
  /**
   * The currency or the minor-unit exponent is not one this system quotes.
   *
   * ADDED BECAUSE THE EIGHT CODES ABOVE ALL ASSUME A CORRIDOR. Every one of
   * them describes something that happened to a quote we were willing to
   * price; none of them can say "we do not pay into that currency at all", so
   * `requireCorridor` threw a bare `Error` and the fact collapsed into
   * `INVALID_FORM` or `UNQUOTABLE` depending on which entry point caught it.
   * Those two sentences send a customer to two different places and only one
   * of them is true.
   *
   * The message names its own fix — the quotable list and where to re-quote —
   * which is the house form `FX_COMMITMENT_EXCEEDS_AVAILABLE` set.
   */
  "FX_CORRIDOR_UNSUPPORTED",
] as const;

export type FxRefusalCode = (typeof FX_REFUSAL_CODES)[number];

export interface FxRefusal {
  readonly code: FxRefusalCode;
  readonly message: string;
}

/**
 * What `requireCorridor` and `pow10` throw: a refusal with a code on it.
 *
 * A thrown error rather than a `Result` because both call sites are the
 * "already decided" kind — by the time `fetchMidRate` asks for a corridor the
 * currency came off a closed list — so the throw is the assertion that the
 * decision was made upstream. The CODE is what is new: a catch block can now
 * answer with `FX_CORRIDOR_UNSUPPORTED` and this message instead of guessing.
 */
export class FxCorridorError extends Error {
  override readonly name = "FxCorridorError";
  readonly code: FxRefusalCode = "FX_CORRIDOR_UNSUPPORTED";
  constructor(message: string) {
    super(message);
  }
}

/** Is this a corridor refusal, with its code already attached? */
export function isFxCorridorError(value: unknown): value is FxCorridorError {
  return value instanceof FxCorridorError;
}

/* -------------------------------------------------------------------------- */
/* Rate provenance                                                            */
/* -------------------------------------------------------------------------- */

/** `live` only when a third party answered a real call. Same word 0005/0016 use. */
export type RateEvidence = "live" | "simulated";

/**
 * One reading of one pair, exactly as it will be stored.
 *
 * `literal` is the undigested text the source printed. It is carried all the
 * way to the database because the integer beside it has to be re-derivable by
 * hand — see `parseDecimalToScaled` in ./rate.ts for why the literal never
 * passes through `JSON.parse` on its way here.
 */
export interface RateObservation {
  readonly source: string;
  readonly evidence: RateEvidence;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly rateScaled: bigint;
  readonly rateScale: bigint;
  /** The characters the source returned, e.g. `"16.9435"`. Never a number. */
  readonly literal: string;
  /** The source's own date for the rate, `YYYY-MM-DD`. Not when we asked. */
  readonly rateDate: string;
  readonly fetchedAt: string;
  /** The status code of the call. `null` when nobody was called. */
  readonly httpStatus: number | null;
  /** Why this reading is simulated, when it is. `null` for a live one. */
  readonly fallbackReason: string | null;
}
