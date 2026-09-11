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

/**
 * What this screen may claim about where its rows came from.
 *
 * ONE VALUE, TWO SURFACES. The badge in the board's header and the badge and
 * note on the demo-state bar are both derived from `sourceClaim()`, so they
 * cannot disagree about what was read. Whichever surface is carrying the claim
 * is the only one that draws a badge.
 */
export type SourceClaim = "LIVE" | "FIXTURE" | "NO DATABASE";

/**
 * Which claim a state is entitled to make.
 *
 * `default` is the live queue, so it claims LIVE — unless there is no database
 * to read, in which case it claims neither LIVE nor FIXTURE. NO DATABASE is not
 * a sixth demo state: it is not a demonstration of anything, it is what this
 * deployment is, and the URL cannot ask for it.
 *
 * The other four are fixtures whether or not a database is configured. They
 * read nothing and never did, so "no database" does not make a drawing any more
 * or less drawn — and until the import defect was fixed they were unreachable
 * anyway, because they lived behind a page module that could not load.
 */
export function sourceClaim(state: DemoState, noDatabase: boolean): SourceClaim {
  if (state !== "default") return "FIXTURE";
  return noDatabase ? "NO DATABASE" : "LIVE";
}

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
