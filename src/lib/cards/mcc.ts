/**
 * Merchant category codes: parsing them, and the handful of groups an
 * operator actually thinks in.
 *
 * An MCC is four digits from ISO 18245 and it is a STRING. `'0742'` is a
 * veterinary surgeon; `742` is nothing at all. Every function here takes and
 * returns strings, and `parseMccList` refuses anything that is not exactly
 * four digits rather than padding it — a silently zero-padded `763` becomes
 * `0763` (agricultural co-operatives) and blocks a category nobody chose.
 *
 * The groups are a CONVENIENCE, not a schema. The database stores the codes
 * the operator ended up with, expanded, so that a later change to this file
 * cannot retroactively widen or narrow a block that a decision already cited.
 * That is the same reason `card_control_version` stores figures rather than a
 * reference to a shared limit table.
 */

/** Exactly four digits. Nothing else is an MCC. */
const MCC_RE = /^[0-9]{4}$/;

export function isMcc(value: unknown): value is string {
  return typeof value === "string" && MCC_RE.test(value);
}

/**
 * A named bundle of codes, for the screen's quick-block buttons.
 *
 * Deliberately small. A complete ISO 18245 table is ~1000 rows and shipping
 * one here would put a lookup table nobody maintains on the critical path of
 * a feature whose value is the decision, not the taxonomy. These are the
 * groups a business current account blocks in practice, and the fuel one is
 * the group the brief's own live-fire script uses.
 */
export type MccGroup = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly codes: readonly string[];
};

export const MCC_GROUPS: readonly MccGroup[] = [
  {
    id: "fuel",
    label: "Fuel and automated pumps",
    description:
      "Automated fuel dispensers and service stations. 5542 is the unattended pump — the one that authorises an estimate and clears a different number hours later.",
    codes: ["5541", "5542", "5983"],
  },
  {
    id: "cash",
    label: "Cash and quasi-cash",
    description:
      "ATM and manual cash disbursement, money orders, wire transfer purchases. Money leaving as cash is money that cannot be recalled.",
    codes: ["6010", "6011", "6012", "6051"],
  },
  {
    id: "gambling",
    label: "Gambling and betting",
    description: "Betting, lotteries, casinos and online gambling.",
    codes: ["7995", "7801", "7802"],
  },
  {
    id: "crypto",
    label: "Crypto and securities",
    description:
      "Security brokers and dealers, which is where card-funded crypto purchases land.",
    codes: ["6211", "6540"],
  },
  {
    id: "travel",
    label: "Airlines and travel agents",
    description:
      "Airlines, travel agencies and cruise lines — the classic categories for a card that should only buy software.",
    codes: ["3000", "4511", "4722", "4411"],
  },
  {
    id: "dining",
    label: "Restaurants and bars",
    description:
      "Eating places and drinking places. Tipping MCCs: authorised amount and settled amount routinely differ.",
    codes: ["5812", "5813", "5814"],
  },
];

/** A short human label for a code we happen to know, else null. */
const KNOWN_MCC_LABELS: Readonly<Record<string, string>> = {
  "3000": "United Airlines",
  "4411": "Cruise lines",
  "4511": "Airlines",
  "4722": "Travel agencies",
  "5541": "Service stations",
  "5542": "Automated fuel dispenser",
  "5812": "Eating places",
  "5813": "Drinking places",
  "5814": "Fast food",
  "5983": "Fuel dealers",
  "6010": "Manual cash disbursement",
  "6011": "ATM cash disbursement",
  "6012": "Financial institutions",
  "6051": "Quasi-cash and money orders",
  "6211": "Security brokers and dealers",
  "6540": "Stored value load",
  "7801": "Online gambling",
  "7802": "Horse and dog racing",
  "7995": "Betting and casino gaming",
};

export function labelForMcc(mcc: string): string | null {
  return KNOWN_MCC_LABELS[mcc] ?? null;
}

/** `"5542 · Automated fuel dispenser"`, or just the code. For display only. */
export function describeMcc(mcc: string): string {
  const label = labelForMcc(mcc);
  return label === null ? mcc : `${mcc} · ${label}`;
}

export type MccListParse =
  | { readonly ok: true; readonly codes: readonly string[] }
  | { readonly ok: false; readonly message: string };

/**
 * Parse what an operator typed into a sorted, deduplicated list of codes.
 *
 * Accepts commas, spaces and newlines as separators, because a list pasted out
 * of a spreadsheet arrives with all three. Refuses anything that is not four
 * digits, naming the offending token: silently dropping it would produce a
 * control set that does not block what the screen said it would.
 */
export function parseMccList(raw: string): MccListParse {
  const tokens = raw
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t !== "");

  const bad = tokens.filter((t) => !MCC_RE.test(t));
  if (bad.length > 0) {
    return {
      ok: false,
      message:
        `Not a merchant category code: ${bad.slice(0, 3).map((b) => `"${b.slice(0, 8)}"`).join(", ")}` +
        `${bad.length > 3 ? ` and ${bad.length - 3} more` : ""}. ` +
        `An MCC is exactly four digits, e.g. 5542.`,
    };
  }

  return { ok: true, codes: [...new Set(tokens)].sort() };
}

/** The union of a group's codes with a list, sorted and deduplicated. */
export function withGroup(codes: readonly string[], group: MccGroup): readonly string[] {
  return [...new Set([...codes, ...group.codes])].sort();
}
