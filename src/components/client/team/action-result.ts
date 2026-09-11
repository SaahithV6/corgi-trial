/**
 * What a `/client/team` action hands back to the form that fired it, and its
 * idle value.
 *
 * IN A PLAIN MODULE, AND THAT IS NOT A STYLE CHOICE. A `"use server"` module
 * may export async functions AND NOTHING ELSE: every other export becomes a
 * SERVER REFERENCE, so a client component's `import { CLIENT_TEAM_IDLE }`
 * receives a callable stub rather than the object, `useActionState` seeds every
 * form with it, and the first render throws inside the streamed Suspense body —
 * a page that answers 200 with nothing but its skeleton and four dead forms.
 *
 * That exact bug took `/team` down for hours on 2026-09-11. The repair was this
 * arrangement, in `src/components/team/action-result.ts`, and this file is the
 * same arrangement for the customer's half. It is imported by client
 * components, so it stays free of `server-only` and of anything that reaches a
 * database.
 */

export type ClientTeamStatus = "idle" | "ok" | "failed";

/** A fact worth copying off the screen: a card's last four, a terms version. */
export type ClientTeamFact = {
  readonly label: string;
  readonly value: string;
  /** Render monospaced. True for tokens, ids and figures. */
  readonly mono?: boolean;
};

export type ClientTeamResult = {
  readonly status: ClientTeamStatus;
  readonly code: string | null;
  readonly message: string;
  readonly facts: readonly ClientTeamFact[];
  readonly at: string | null;
};

export const CLIENT_TEAM_IDLE: ClientTeamResult = {
  status: "idle",
  code: null,
  message: "",
  facts: [],
  at: null,
};
