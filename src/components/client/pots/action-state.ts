/**
 * What the customer's pot forms get back, as one shape for all three writes.
 *
 * A `"use server"` module may export only async functions, so the result type
 * and its idle value cannot live beside the actions that produce them. That is
 * the same split `@/components/client/card-controls-state` makes for the card
 * controls form, and this file is its neighbour for the same reason.
 *
 * ===========================================================================
 * EVERY FIGURE ON THIS BOUNDARY IS ALREADY A STRING
 * ===========================================================================
 *
 * These values cross into a client component, and `bigint` does not survive
 * that serialisation. Rather than convert cents to a number on the way — which
 * is the defect this codebase has already shipped once — the server formats
 * every amount through `formatUsd` while it still holds the `bigint`, and what
 * crosses is text. There is no arithmetic on the browser side of this line and
 * no `Number(...)` anywhere near a figure.
 *
 * ===========================================================================
 * A REFUSAL IS A RESULT, NOT AN EXCEPTION
 * ===========================================================================
 *
 * `status: "refused"` carries the `code` the library returned — one of
 * `AMOUNT_NOT_POSITIVE`, `INSUFFICIENT_AVAILABLE`, `INSUFFICIENT_POT`,
 * `NO_SUCH_POT`, `POT_WOULD_GO_NEGATIVE` or `MOVE_FAILED`, plus this surface's
 * own `POT_NOT_ON_THIS_BUSINESS` and `AMOUNT_UNREADABLE` — and the sentence
 * the library wrote to explain it. Nothing here is caught and dropped: a write
 * that did not happen says which rule stopped it and what would make it
 * succeed.
 */

/** One `label: value` line on a receipt or a refusal. Money is preformatted. */
export type PotFact = {
  readonly label: string;
  readonly value: string;
  /** Monospace: an id, a key, a sequence number — never a sentence. */
  readonly mono?: boolean;
};

export type PotActionResult = {
  readonly status: "idle" | "posted" | "refused";
  /** The named code a refusal carries. `null` when nothing was refused. */
  readonly code: string | null;
  /** One paragraph, rendered verbatim. The library writes the refusals. */
  readonly message: string;
  readonly facts: readonly PotFact[];
  /** ISO instant, so a second submit is visibly a second answer. */
  readonly at: string | null;
};

export const POT_ACTION_IDLE: PotActionResult = {
  status: "idle",
  code: null,
  message: "",
  facts: [],
  at: null,
};
