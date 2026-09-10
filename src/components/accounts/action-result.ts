/**
 * What a console action hands back to the form that fired it.
 *
 * Two constraints shape this type and neither is cosmetic.
 *
 * 1. IT CROSSES THE SERIALISATION BOUNDARY. A server action's return value is
 *    serialised to the client, so it holds strings and nothing else — no rows,
 *    no `Date`, no database ids the screen does not render. Money crosses as a
 *    DECIMAL STRING OF INTEGER CENTS (`"-2340"`), never as a number and never
 *    as dollars, and is turned back into `bigint` by `centsFrom()` at the point
 *    of render. A `number` in this type would be a float waiting to happen.
 *
 * 2. IT HAS TO BE ABLE TO SAY "I DO NOT KNOW YET". Simulating an authorisation
 *    fires a real webhook from Lithic into the deployed system; the round trip
 *    is fast but it is not synchronous and it is not guaranteed. So `pending`
 *    is a first-class status alongside `ok` and `failed`, and it carries what
 *    was actually observed — the transaction token, the inbox row, its state —
 *    rather than a spinner that eventually claims success.
 *
 * This module is imported by client components, so it must stay free of
 * `server-only` and free of anything that reaches a database.
 */

export type ConsoleIntent = "issue_card" | "authorize" | "clearing" | "drain";

export type ConsoleStatus = "idle" | "ok" | "pending" | "failed";

/** A fact worth copying out of the screen: a provider token, a card's last four. */
export type ActionFact = {
  readonly label: string;
  readonly value: string;
  /** Render monospaced. True for tokens and ids. */
  readonly mono?: boolean;
};

/** The four figures, as decimal strings of integer cents. */
export type BalanceFacts = {
  readonly ledgerCents: string;
  readonly holdsCents: string;
  readonly unclearedCents: string;
  readonly availableCents: string;
};

export type BalanceMove = {
  readonly before: BalanceFacts;
  readonly after: BalanceFacts;
};

export type ConsoleActionResult = {
  readonly status: ConsoleStatus;
  readonly intent: ConsoleIntent | null;
  /** Machine-readable outcome or refusal code. */
  readonly code: string | null;
  readonly message: string;
  readonly facts: readonly ActionFact[];
  /** Present when the action measured the balances either side of itself. */
  readonly balances: BalanceMove | null;
  /** The hold this action opened or moved, for a link into the drill-down. */
  readonly holdId: string | null;
  /** Monotonic per submission so a repeated identical result still re-renders. */
  readonly at: string;
};

export const IDLE_RESULT: ConsoleActionResult = {
  status: "idle",
  intent: null,
  code: null,
  message: "",
  facts: [],
  balances: null,
  holdId: null,
  at: "",
};

/** Decimal string of integer cents → `bigint`. Throws on anything else. */
export function centsFrom(value: string): bigint {
  if (!/^-?\d+$/.test(value)) {
    throw new TypeError(`expected a decimal string of integer cents, received "${value}"`);
  }
  return BigInt(value);
}

export function balanceDelta(move: BalanceMove, field: keyof BalanceFacts): bigint {
  return centsFrom(move.after[field]) - centsFrom(move.before[field]);
}
