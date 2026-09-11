/**
 * What a team action hands back to the form that fired it, and its idle value.
 *
 * IN ITS OWN PLAIN MODULE, AND THAT IS THE REPAIR. `TEAM_IDLE` used to be
 * exported from `src/app/(app)/team/actions.ts`, which is a `"use server"`
 * module. Everything exported from such a module becomes a SERVER REFERENCE, so
 * the client's `import { TEAM_IDLE }` received a callable stub rather than the
 * object — `useActionState` seeded every form with it, `result.status` was not
 * `"idle"`, and `Receipt` reached `result.facts.length` on `undefined`. The
 * page still answered 200 because the throw happened inside the streamed
 * Suspense body: `/team` rendered its skeleton and nothing else, and all four
 * actions — add a member, set terms, end a membership, issue a card — were
 * unreachable.
 *
 * Same arrangement as `src/components/accounts/action-result.ts` and
 * `src/components/chaos/action-result.ts`: the types and the constants live in
 * a plain module that BOTH the action module and the client component import.
 *
 * This module is imported by client components, so it must stay free of
 * `server-only` and free of anything that reaches a database.
 */

export type TeamActionStatus = "idle" | "ok" | "failed";

/** A fact worth copying out of the screen: a card token, a terms version. */
export type TeamActionFact = {
  readonly label: string;
  readonly value: string;
  /** Render monospaced. True for tokens and ids. */
  readonly mono?: boolean;
};

export type TeamActionResult = {
  readonly status: TeamActionStatus;
  readonly code: string | null;
  readonly message: string;
  readonly facts: readonly TeamActionFact[];
  readonly at: string | null;
};

export const TEAM_IDLE: TeamActionResult = {
  status: "idle",
  code: null,
  message: "",
  facts: [],
  at: null,
};
