import { describeUsd, formatUsd, signOf } from "@/lib/format/money";
import type { CentsInput } from "@/lib/format/money";

export type MoneyTone =
  /** Negative in the negative colour, everything else in the text colour. */
  | "auto"
  /** Never coloured. For neutral figures like an authorised amount. */
  | "neutral"
  /** Negative red, positive green. For deltas, where direction is the meaning. */
  | "direction";

export type MoneyProps = {
  readonly cents: CentsInput;
  readonly tone?: MoneyTone;
  /** Show a `+` on positive amounts. For deltas. */
  readonly signed?: boolean;
  readonly symbol?: boolean;
  /** Extra classes — sizing and weight only; colour comes from `tone`. */
  readonly className?: string;
};

function toneClass(cents: CentsInput, tone: MoneyTone): string {
  const sign = signOf(cents);
  if (tone === "neutral") return "";
  if (sign < 0) return "money-negative";
  if (tone === "direction" && sign > 0) return "money-positive";
  return "";
}

/**
 * An amount of money.
 *
 * Always monospaced and tabular (the `.money` class in globals.css), so a
 * column of figures lines up on the decimal and a digit never changes width
 * when it changes value. Colour is a token, never a literal.
 *
 * Negative amounts get a spoken-language duplicate for screen readers: a
 * leading hyphen is announced inconsistently, and an overdraft read aloud as a
 * credit is the worst failure this component could have.
 */
export function Money({
  cents,
  tone = "auto",
  signed = false,
  symbol = true,
  className = "",
}: MoneyProps) {
  const text = formatUsd(cents, { signed, symbol });
  const negative = signOf(cents) < 0;
  const classes = ["money", toneClass(cents, tone), className]
    .filter((part) => part !== "")
    .join(" ");

  if (!negative) return <span className={classes}>{text}</span>;

  return (
    <span className={classes}>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{describeUsd(cents)}</span>
    </span>
  );
}
