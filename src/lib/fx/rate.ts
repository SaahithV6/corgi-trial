/**
 * Where the rate comes from, and how a decimal becomes an integer without
 * ever being a float.
 *
 * ── THE SOURCE, MEASURED ────────────────────────────────────────────────────
 *
 * Frankfurter (https://frankfurter.dev), which republishes the European
 * Central Bank's daily euro reference rates and cross-computes them. No API
 * key, no signup, no rate limit published. The exact call and its response are
 * in docs/FX.md §2; the short version, run from this repo:
 *
 *   curl -sS -w '%{http_code}' \
 *     'https://api.frankfurter.dev/v1/latest?base=USD&symbols=MXN,PHP,INR,BRL,JPY'
 *   200
 *   {"amount":1.0,"base":"USD","date":"2026-09-10",
 *    "rates":{"BRL":5.1247,"INR":95.44,"JPY":154.18,"MXN":16.9435,"PHP":62.576}}
 *
 * ── WHAT THAT NUMBER IS, AND WHAT IT IS NOT ─────────────────────────────────
 *
 * IT IS REAL. A real third party answered a real call, and the response above
 * was measured rather than imagined. Every quote priced from it carries
 * `evidence: 'live'`, the HTTP status, the source's own date, and the exact
 * characters it printed.
 *
 * IT IS NOT A DEALABLE PRICE, AND THE SCREEN SAYS SO. The ECB publishes these
 * once per working day at around 16:00 CET as a REFERENCE — the response even
 * carries `cache-control: max-age=86400`, which is the source telling you its
 * own refresh rate. Nobody will trade with you at it. A Saturday fetch returns
 * Friday's rate under Friday's date. So the honest claim this system makes is
 * exactly two things: the MID IS LIVE, and the SPREAD IS OURS. What the
 * customer is offered is the live mid less a spread we set and print. Calling
 * the result a market price would be the kind of dressing-up that the trial
 * fails people for, so it is not called one anywhere.
 *
 * ── THE FALLBACK, LABELLED ──────────────────────────────────────────────────
 *
 * When the call fails — timeout, non-200, a body that does not parse, no
 * network at all — `FIXED_RATE_TABLE` answers instead. Every quote priced from
 * it carries `evidence: 'simulated'`, a `fallbackReason` saying what went
 * wrong, and a banner on the screen in the negative colour. It is never
 * presented as a market rate and there is no configuration that makes it look
 * like one.
 *
 * ── NO FLOATS, INCLUDING INSIDE JSON.parse ──────────────────────────────────
 *
 * This is the part that is easy to get wrong and impossible to see afterwards.
 * `JSON.parse('{"MXN":16.9435}')` produces an IEEE-754 double before a single
 * line of our code runs. 16.9435 is not representable; the double is
 * 16.943500000000000227..., and `Math.round(x * 1e8)` on it happens to be
 * right for this value and is not right for all of them. There is no way to
 * recover the original decimal afterwards, because the information is gone.
 *
 * So the response body is treated as TEXT. The decimal literal is lifted out
 * with a regex, and `parseDecimalToScaled` turns those characters into a
 * `bigint` by string surgery — pad the fraction, concatenate, `BigInt(...)`.
 * The literal is carried to the database alongside the integer so the
 * conversion can be redone by hand from the row.
 */

import {
  CORRIDOR_CODES,
  RATE_SCALE,
  SELL_CURRENCY,
  requireCorridor,
  type RateObservation,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Decimal text to scaled integer                                             */
/* -------------------------------------------------------------------------- */

/** A plain non-negative decimal. No sign, no exponent, no separators. */
const DECIMAL = /^(\d{1,15})(?:\.(\d{1,18}))?$/;

/**
 * `"16.9435"` at scale 10^8 becomes `1694350000n`.
 *
 * Pure string arithmetic: the fraction is padded or truncated to the scale's
 * decimal count and concatenated onto the whole part. Nothing is multiplied by
 * a power of ten as a `number` and nothing is divided at all.
 *
 * Truncating a fraction longer than the scale is the only lossy step, and it
 * truncates rather than rounds because a rate is not money — losing the ninth
 * decimal of an FX rate changes a $1,000 payout by less than a millionth of a
 * cent, and a half-up rule here would be a rounding rule nobody could name the
 * direction of.
 *
 * Returns `null` for anything that is not a plain decimal, so a caller renders
 * a refusal rather than guessing. `1.6e1` is not a plain decimal.
 */
export function parseDecimalToScaled(literal: string, scale: bigint = RATE_SCALE): bigint | null {
  const decimals = String(scale).length - 1;
  if (10n ** BigInt(decimals) !== scale) {
    throw new Error(`rate scale must be a power of ten, got ${scale}`);
  }

  const match = DECIMAL.exec(literal.trim());
  if (match === null) return null;

  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(decimals, "0").slice(0, decimals);

  const scaled = BigInt(`${whole}${fraction}`);
  return scaled > 0n ? scaled : null;
}

/* -------------------------------------------------------------------------- */
/* The live source                                                            */
/* -------------------------------------------------------------------------- */

export const FRANKFURTER_SOURCE = "frankfurter.dev";
export const FRANKFURTER_BASE_URL = "https://api.frankfurter.dev/v1";

/** The endpoint a given set of corridors is fetched from. One place, so the doc can quote it. */
export function frankfurterUrl(
  currencies: readonly string[] = CORRIDOR_CODES,
  baseUrl: string = FRANKFURTER_BASE_URL,
): string {
  return `${baseUrl}/latest?base=${SELL_CURRENCY}&symbols=${currencies.join(",")}`;
}

/** A date the source printed, `YYYY-MM-DD`, or `null`. */
function extractDate(body: string): string | null {
  const match = /"date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/.exec(body);
  return match?.[1] ?? null;
}

/**
 * The `rates` object as raw text, so a currency code appearing anywhere else
 * in the body — in `base`, in an error string — cannot be mistaken for a rate.
 */
function extractRatesBlock(body: string): string | null {
  const at = body.indexOf('"rates"');
  if (at < 0) return null;
  const open = body.indexOf("{", at);
  const close = body.indexOf("}", open);
  if (open < 0 || close < 0) return null;
  return body.slice(open, close + 1);
}

/** The literal characters printed for one currency, or `null`. */
export function extractRateLiteral(body: string, currency: string): string | null {
  const block = extractRatesBlock(body);
  if (block === null) return null;
  // Anchored on the quoted key so `"INR"` cannot match inside `"XINR"`.
  const pattern = new RegExp(`"${currency}"\\s*:\\s*(\\d{1,15}(?:\\.\\d{1,18})?)`);
  return pattern.exec(block)?.[1] ?? null;
}

export class RateSourceError extends Error {
  override readonly name = "RateSourceError";
  constructor(
    message: string,
    readonly httpStatus: number | null,
  ) {
    super(message);
  }
}

export interface FetchRateOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Injected in tests. Defaults to the global. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: Date;
}

/**
 * Fetch one mid rate, live.
 *
 * THROWS on anything short of a clean reading, and does not fall back by
 * itself. Falling back is `observeRate`'s job, one level up, because the
 * decision to substitute a fixed number for a market one is a decision that
 * has to be recorded on the observation — and a function that quietly returns
 * a fixed rate when the network is down is how a simulated integration ends up
 * presented as a live one.
 */
export async function fetchMidRate(
  currency: string,
  options: FetchRateOptions = {},
): Promise<RateObservation> {
  const corridor = requireCorridor(currency);
  const url = frankfurterUrl([corridor.currency], options.baseUrl ?? FRANKFURTER_BASE_URL);
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(url, {
      signal: AbortSignal.timeout(options.timeoutMs ?? 6_000),
      headers: { accept: "application/json" },
    });
  } catch (cause) {
    throw new RateSourceError(
      `${FRANKFURTER_SOURCE} did not answer: ${cause instanceof Error ? cause.message : String(cause)}`,
      null,
    );
  }

  if (!response.ok) {
    throw new RateSourceError(`${FRANKFURTER_SOURCE} returned ${response.status}`, response.status);
  }

  // TEXT, not json(). See the header.
  const body = await response.text();

  const literal = extractRateLiteral(body, corridor.currency);
  if (literal === null) {
    throw new RateSourceError(
      `${FRANKFURTER_SOURCE} answered ${response.status} but carried no plain decimal for ${corridor.currency}`,
      response.status,
    );
  }

  const rateScaled = parseDecimalToScaled(literal, RATE_SCALE);
  if (rateScaled === null) {
    throw new RateSourceError(
      `${FRANKFURTER_SOURCE} printed '${literal}' for ${corridor.currency}, which is not a rate`,
      response.status,
    );
  }

  const rateDate = extractDate(body);
  if (rateDate === null) {
    // The source's own date is not optional. Without it the screen cannot say
    // "this is Friday's rate, fetched on Saturday", which on a reference feed
    // is the difference between a fact and a misrepresentation.
    throw new RateSourceError(
      `${FRANKFURTER_SOURCE} answered ${response.status} without a rate date`,
      response.status,
    );
  }

  return {
    source: FRANKFURTER_SOURCE,
    evidence: "live",
    baseCurrency: SELL_CURRENCY,
    quoteCurrency: corridor.currency,
    rateScaled,
    rateScale: RATE_SCALE,
    literal,
    rateDate,
    fetchedAt: (options.now ?? new Date()).toISOString(),
    httpStatus: response.status,
    fallbackReason: null,
  };
}

/* -------------------------------------------------------------------------- */
/* The labelled fallback                                                      */
/* -------------------------------------------------------------------------- */

export const FIXED_TABLE_SOURCE = "fixed-table";

/**
 * The date these figures were read off the live source. NOT today's date, ever.
 *
 * A simulated rate that reports the current date is a simulated rate wearing a
 * live one's clothes. This is the day the numbers below were true, and the
 * screen prints it next to the word SIMULATED and an age in days.
 */
export const FIXED_TABLE_DATE = "2026-09-10";

/**
 * The fallback table.
 *
 * Every literal here was read from the live Frankfurter response on
 * FIXED_TABLE_DATE, so a demo without a network shows plausible arithmetic
 * rather than round numbers that teach a viewer the wrong magnitude. They are
 * stale by construction and they are labelled as stale everywhere they appear.
 */
export const FIXED_RATE_TABLE: ReadonlyMap<string, string> = new Map([
  ["MXN", "16.9435"],
  ["PHP", "62.576"],
  ["INR", "95.44"],
  ["BRL", "5.1247"],
  ["JPY", "154.18"],
]);

/** A reading from the fixed table. Always `simulated`, always carries the reason. */
export function fixedRate(
  currency: string,
  reason: string,
  options: { readonly httpStatus?: number | null; readonly now?: Date } = {},
): RateObservation {
  const corridor = requireCorridor(currency);
  const literal = FIXED_RATE_TABLE.get(corridor.currency);
  if (literal === undefined) {
    throw new Error(`no fixed rate for ${corridor.currency}`);
  }
  const rateScaled = parseDecimalToScaled(literal, RATE_SCALE);
  if (rateScaled === null) {
    throw new Error(`the fixed rate table holds '${literal}' for ${corridor.currency}, which is not a rate`);
  }

  return {
    source: FIXED_TABLE_SOURCE,
    evidence: "simulated",
    baseCurrency: SELL_CURRENCY,
    quoteCurrency: corridor.currency,
    rateScaled,
    rateScale: RATE_SCALE,
    literal,
    rateDate: FIXED_TABLE_DATE,
    fetchedAt: (options.now ?? new Date()).toISOString(),
    httpStatus: options.httpStatus ?? null,
    fallbackReason: reason,
  };
}

/* -------------------------------------------------------------------------- */
/* The one function callers use                                               */
/* -------------------------------------------------------------------------- */

/**
 * Get a mid rate, live if the source answers and labelled if it does not.
 *
 * Never throws for a source problem. The degradation is the product: a payout
 * screen that 500s because a free rate feed is having an afternoon is worse
 * than one that quotes a stale number and says, in the negative colour, that
 * it is a stale number.
 */
export async function observeRate(
  currency: string,
  options: FetchRateOptions = {},
): Promise<RateObservation> {
  try {
    return await fetchMidRate(currency, options);
  } catch (cause) {
    const reason =
      cause instanceof RateSourceError
        ? cause.message
        : `the rate source failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    const status = cause instanceof RateSourceError ? cause.httpStatus : null;
    return fixedRate(currency, reason, {
      httpStatus: status,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
}

/**
 * How stale a reading is, in whole days, against an explicit `now`.
 *
 * Not `Date.now()` inside the function: the caller passes the instant the page
 * was read as-of, so a rendered figure is a pure function of its inputs. Same
 * rule `src/lib/format/datetime.ts` states.
 */
export function rateAgeDays(rateDate: string, now: string): number | null {
  const then = Date.parse(`${rateDate}T00:00:00Z`);
  const at = Date.parse(now);
  if (Number.isNaN(then) || Number.isNaN(at)) return null;
  const days = Math.floor((at - then) / 86_400_000);
  return days < 0 ? 0 : days;
}
