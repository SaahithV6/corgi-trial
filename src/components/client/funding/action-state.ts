/**
 * What the customer's funding forms get back, and their idle value.
 *
 * IN A PLAIN MODULE, AND THAT IS THE WHOLE POINT OF THE FILE. A `"use server"`
 * module may export ONLY async functions: every other export becomes a server
 * reference, so a client component's `import { FUNDING_IDLE }` receives a
 * callable stub instead of the object, `useActionState` seeds the form with
 * it, and the first render throws on `result.facts.length` while `tsc` stays
 * perfectly happy. `src/components/team/action-result.ts` records that exact
 * outage and this file is its neighbour, for the identical reason —
 * `@/components/client/pots/action-state` and
 * `@/components/client/card-controls-state` are the other two.
 *
 * EVERY FIGURE THAT CROSSES THIS BOUNDARY IS ALREADY TEXT. `bigint` does not
 * survive serialisation into a client component, and the repair is not to turn
 * cents into a `number` on the way out — it is to format while the server still
 * holds the `bigint`, and to send the string. There is no arithmetic on the
 * browser side of this line.
 */

/** One `label: value` line on a receipt or a refusal. Money is preformatted. */
export type FundingFact = {
  readonly label: string;
  readonly value: string;
  /** Monospace: an id, an external ref, a routing number — never a sentence. */
  readonly mono?: boolean;
};

export type FundingActionResult = {
  readonly status: "idle" | "posted" | "refused";
  /**
   * The named code, carried verbatim from wherever the decision was made —
   * `canTransact()`'s KYB vocabulary, `FundingRefused`'s codes, the item-state
   * vocabulary (`needs_reauth` / `revoked` / `orphaned`), or this surface's own
   * `BANK_NOT_ON_THIS_BUSINESS` and `AMOUNT_UNREADABLE`. `null` on success.
   */
  readonly code: string | null;
  /** One paragraph, rendered verbatim. */
  readonly message: string;
  readonly facts: readonly FundingFact[];
  /** ISO instant, so a second submit is visibly a second answer. */
  readonly at: string | null;
};

export const FUNDING_IDLE: FundingActionResult = {
  status: "idle",
  code: null,
  message: "",
  facts: [],
  at: null,
};

/**
 * The sentence this screen is not allowed to stop saying.
 *
 * 137 journal entries on this book already carry `ORIGINATED, NOT TRANSMITTED
 * (no ACH entry was sent to any network)` in their own `description`, because
 * a ledger line that reads "in transit" while nothing was transmitted is a
 * false statement unless the row itself carries the qualification. The screen
 * repeats the row's own claim rather than softening it.
 */
export const NOT_TRANSMITTED =
  "No ACH entry was sent to any network. The deposit is booked at origination — the moment the pull is instructed — which is what account 1130 exists for and what every one of these entries says on its own row.";
