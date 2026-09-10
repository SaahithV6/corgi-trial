/**
 * Turning what an operator typed into `bigint` cents, without ever making a
 * float.
 *
 * `Number("73.40") * 100` is `7340.000000000001`. Every rounding helper built
 * on top of that inherits the problem, so this module never divides, never
 * multiplies a decimal and never calls `parseFloat`. It splits the string on
 * the point, pads the fraction to two digits, and does integer arithmetic on
 * `bigint` from there. The only multiplication is by `100n`.
 *
 * Shared by the client forms and the server actions deliberately: the form
 * shows the operator what it read, and the action re-reads the raw string
 * itself rather than trusting a cents field from the browser. Same function,
 * both sides, so the preview cannot disagree with what gets sent.
 */

export type AmountParse =
  | { readonly ok: true; readonly cents: bigint }
  | { readonly ok: false; readonly message: string };

/** `$1,234.56`, `1234.56`, `1234`, `.5`. Not `1.234`, not `1e3`, not `-5`. */
const AMOUNT_RE = /^\$?\s*(\d{0,12})(?:[.,](\d{1,2}))?$/;

/**
 * Parse a USD amount into integer cents.
 *
 * Refuses negatives outright: the direction of a card authorisation lives in
 * the endpoint you call, never in the sign of the amount, and a negative here
 * would be a mapping bug being typed in by hand.
 */
export function parseUsdAmount(raw: string): AmountParse {
  const trimmed = raw.trim().replaceAll(",", "");
  if (trimmed === "") {
    return { ok: false, message: "Enter an amount in dollars, e.g. 50.00." };
  }

  const match = AMOUNT_RE.exec(trimmed);
  if (match === null) {
    return {
      ok: false,
      message: `"${raw.slice(0, 24)}" is not a USD amount. Use dollars and up to two decimal places, e.g. 50.00.`,
    };
  }

  const dollars = match[1] ?? "";
  const fraction = (match[2] ?? "").padEnd(2, "0");
  if (dollars === "" && match[2] === undefined) {
    return { ok: false, message: "Enter an amount in dollars, e.g. 50.00." };
  }

  const cents = BigInt(dollars === "" ? "0" : dollars) * 100n + BigInt(fraction);
  if (cents <= 0n) {
    return { ok: false, message: "The amount must be greater than zero." };
  }
  return { ok: true, cents };
}

/**
 * `bigint` cents at the provider boundary, where the SDK's type is `number`.
 *
 * Lithic's API speaks integer cents as JSON numbers, so the conversion has to
 * happen somewhere. It happens here, once, with the range check that makes it
 * safe — and it throws rather than truncating, because an amount that cannot
 * be represented exactly must never be sent to a card network as a close
 * approximation.
 */
export function centsToProviderAmount(cents: bigint, field: string): number {
  if (cents < 0n) throw new RangeError(`${field}: cents must be >= 0, got ${cents}`);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${field}: ${cents} cents exceeds Number.MAX_SAFE_INTEGER`);
  }
  return Number(cents);
}
