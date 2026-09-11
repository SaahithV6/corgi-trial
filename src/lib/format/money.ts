/**
 * USD money formatting.
 *
 * The one rule this module exists to enforce: **money never becomes a float.**
 * Every amount in this system is an integer number of cents, and the only
 * arithmetic performed here is integer division and remainder on `bigint`.
 * There is no `/ 100`, no `toFixed`, no `Intl.NumberFormat` fed a decimal —
 * because `734.0000000000001` is a real number a float can produce and a
 * balance sheet cannot survive.
 *
 * Presentation rules, which are conventions and not arbitrary:
 *
 * - Negative amounts carry a leading minus sign, never parentheses. Ops staff
 *   read these on screen under time pressure; a bracket is a glyph that can be
 *   missed, a minus in the negative colour cannot.
 * - The sign sits outside the symbol: `-$73.40`, not `$-73.40`.
 * - Thousands are grouped, the fraction is always two digits, and callers are
 *   expected to render the result with the `.money` class from globals.css so
 *   the figures are tabular and columns align on the decimal.
 */

/** An amount of money, as integer minor units (US cents). Never dollars. */
export type CentsInput = number | bigint;

export type MoneyFormatOptions = {
  /**
   * Render an explicit `+` on amounts greater than zero. For deltas — a
   * posting's effect on a balance — where the direction is the point.
   */
  readonly signed?: boolean;
  /** Include the `$`. Defaults to true; set false for bare figures in a column. */
  readonly symbol?: boolean;
  /**
   * Group thousands with commas. Defaults to true, which is right for anything
   * a person reads and wrong for anything a machine parses back.
   *
   * A form pre-filled with `1,234.56` round-trips to a parse failure or, worse,
   * to `1.00`. That is the exact pressure that pushes a component to reach for
   * `(cents / 100).toFixed(2)` and reintroduce a float on the display path —
   * which is how three of them appeared in the disputes forms. The need is
   * real, so it belongs here next to the cents, not in each caller.
   */
  readonly group?: boolean;
};

/**
 * Narrow an input to `bigint` cents, refusing anything that is not an exact
 * integer count of cents.
 *
 * This throws rather than returning a `Result` on purpose. A float, a NaN, or
 * a number past `Number.MAX_SAFE_INTEGER` arriving at the formatter is a
 * programming error upstream — someone divided by 100 — and it should fail
 * loudly in development rather than render a plausible wrong number in front
 * of an operator.
 */
export function toCents(value: CentsInput): bigint {
  if (typeof value === "bigint") return value;

  if (!Number.isFinite(value)) {
    throw new TypeError(`money: expected finite integer cents, received ${value}`);
  }
  if (!Number.isInteger(value)) {
    throw new TypeError(
      `money: expected integer cents, received ${value} — amounts are minor units, not dollars`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(
      `money: ${value} is beyond Number.MAX_SAFE_INTEGER and cannot be an exact cent count — pass a bigint`,
    );
  }
  // `BigInt(-0)` is `0n`, which is what we want: there is no negative zero money.
  return BigInt(value);
}

/** -1, 0 or 1. Zero is neither positive nor negative, including for `-0`. */
export function signOf(value: CentsInput): -1 | 0 | 1 {
  const cents = toCents(value);
  if (cents < 0n) return -1;
  if (cents > 0n) return 1;
  return 0;
}

export function isNegative(value: CentsInput): boolean {
  return signOf(value) === -1;
}

/** Exact integer sum. Present so callers never reach for `reduce((a, b) => a + b)` on numbers. */
export function sumCents(values: Iterable<CentsInput>): bigint {
  let total = 0n;
  for (const value of values) total += toCents(value);
  return total;
}

/** Group the integer part in threes: `1234567` -> `1,234,567`. */
function groupThousands(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    // Insert a separator before every third digit counted from the right.
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits.charAt(i);
  }
  return out;
}

/**
 * Format integer cents as USD: `$1,234.56`, `-$73.40`, `$0.01`.
 */
export function formatUsd(
  value: CentsInput,
  options: MoneyFormatOptions = {},
): string {
  const cents = toCents(value);
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;

  const dollars = magnitude / 100n;
  const fraction = magnitude % 100n;

  const sign = negative ? "-" : options.signed === true && cents > 0n ? "+" : "";
  const symbol = options.symbol === false ? "" : "$";

  const whole =
    options.group === false ? dollars.toString() : groupThousands(dollars.toString());

  return `${sign}${symbol}${whole}.${fraction.toString().padStart(2, "0")}`;
}

/**
 * A spoken-language rendering for `aria-label`.
 *
 * Screen readers announce a leading hyphen inconsistently — some skip it
 * entirely, which turns an overdraft into a credit. The word is unambiguous.
 */
export function describeUsd(value: CentsInput): string {
  const cents = toCents(value);
  if (cents < 0n) return `negative ${formatUsd(-cents)}`;
  return formatUsd(cents);
}
