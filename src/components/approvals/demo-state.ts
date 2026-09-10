/**
 * URL-driven demo states for the approvals screen.
 *
 * Same contract as the account screen: every state is reachable by editing the
 * query string, each has a URL that reproduces it, and switching between them
 * writes nothing.
 *
 * ONE DIFFERENCE, AND IT IS DELIBERATE. `default` is not a fixture — it is the
 * LIVE QUEUE, read from Neon through `createLiveApprovalsSource()`. The account
 * screen could not do that when it was built because the ledger's read side did
 * not exist; this one can, and a maker-checker screen backed by a fixture would
 * be demonstrating nothing. The other four states stay fixtures, because
 * `error` and `edge` must be showable on demand and neither should require
 * breaking a database or raising a payment as somebody else.
 */

export const DEMO_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type DemoState = (typeof DEMO_STATES)[number];

export type ApprovalsView = {
  readonly state: DemoState;
};

export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  default: "Default · live",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · your own payment",
};

export const DEMO_STATE_HINTS: Record<DemoState, string> = {
  default: "The real pending queue, read from the live database.",
  loading: "Skeleton, held open long enough to see.",
  empty: "Nothing is awaiting a decision.",
  error: "The queue read failed. Nothing moved; retry is live.",
  edge: "A payment you raised yourself. Approve is disabled, with the reason stated.",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isDemoState(value: string | undefined): value is DemoState {
  return DEMO_STATES.some((state) => state === value);
}

/** Anything unrecognised falls back to the live queue, never to an error page. */
export function parseApprovalsView(
  searchParams: Record<string, string | string[] | undefined>,
): ApprovalsView {
  const raw = first(searchParams["state"]);
  return { state: isDemoState(raw) ? raw : "default" };
}

/** `?state=edge`, or `""` for the live default. */
export function demoQuery(state: DemoState): string {
  return state === "default" ? "" : `?state=${state}`;
}
