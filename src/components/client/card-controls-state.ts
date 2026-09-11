/**
 * The shape a card-control write comes back as, and its idle value.
 *
 * It lives here rather than beside the action because a `"use server"` module
 * may export nothing but async functions. `src/app/(app)/team/actions.ts`
 * exported a plain `TEAM_IDLE` object from one, and the whole `/team` screen
 * dies on it at render time — `result.facts` is `undefined` because the import
 * resolved to a server reference rather than to the literal. That failure is
 * measured and on the matrix; this file is how it is avoided here, and it is
 * the same shape `@/lib/cards/view-state` and `@/components/chaos/action-result`
 * already use.
 *
 * Pure. No `server-only`, no database: it is imported by a server action and by
 * a client component, and both need the same answer.
 */

/** One line of the receipt. `mono` for anything a person reads out loud. */
export type ControlFact = {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
};

export type ClientControlResult = {
  readonly status: "idle" | "ok" | "failed";
  /** A named code on every failure. Nothing here fails silently. */
  readonly code: string | null;
  readonly message: string;
  readonly facts: readonly ControlFact[];
  /** Which card the result belongs to, so a receipt cannot land on a sibling. */
  readonly cardId: string | null;
  readonly at: string | null;
};

export const CLIENT_CONTROL_IDLE: ClientControlResult = {
  status: "idle",
  code: null,
  message: "",
  facts: [],
  cardId: null,
  at: null,
};
