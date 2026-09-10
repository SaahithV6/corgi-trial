/**
 * URL-driven demo states.
 *
 * Every state the account screen can be in is reachable by editing the query
 * string — `?state=error`, `?state=edge` — and nothing else. No feature flag,
 * no seeded row, no mutation. That matters for two reasons: the states can be
 * shown live, in order, in front of a panel without touching the database; and
 * a screenshot of any of them carries the URL that reproduces it.
 *
 * The parameter selects which *fixture* answers the data contract. When the
 * real ledger is wired in, `state=default` becomes the live query and the
 * other four keep working, because they are the same interface.
 */

export const DEMO_STATES = [
  "default",
  "loading",
  "empty",
  "error",
  "edge",
] as const;

export type DemoState = (typeof DEMO_STATES)[number];

export type DemoView = {
  readonly state: DemoState;
  /**
   * Whether the $50.00 fuel-pump authorisation has landed.
   *
   * The toggle exists so the contrast can be demonstrated rather than
   * described: flip it and the available balance drops by exactly $50.00
   * while the ledger balance does not move a cent. Only meaningful in the
   * `default` state.
   */
  readonly authPending: boolean;
};

export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  default: "Default",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · negative available",
};

export const DEMO_STATE_HINTS: Record<DemoState, string> = {
  default: "Funded account with live holds and uncleared credits.",
  loading: "Skeleton, held for a few seconds so it can be seen.",
  empty: "Account opened, no postings yet.",
  error: "The balance query failed. Retry is live.",
  edge: "Over-capture at a fuel pump has driven available negative.",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isDemoState(value: string | undefined): value is DemoState {
  return DEMO_STATES.some((state) => state === value);
}

/**
 * Read the demo view out of `searchParams`. Anything unrecognised falls back
 * to `default` — a malformed URL shows the real screen, never an error page.
 */
export function parseDemoView(
  searchParams: Record<string, string | string[] | undefined>,
): DemoView {
  const raw = first(searchParams["state"]);
  const state: DemoState = isDemoState(raw) ? raw : "default";
  const authPending = first(searchParams["auth"]) === "pending";
  return { state, authPending };
}

/** `?state=edge`, `?auth=pending`, or `""`. Stable key order so URLs compare. */
export function demoQuery(view: Partial<DemoView>): string {
  const parts: string[] = [];
  if (view.state !== undefined && view.state !== "default") {
    parts.push(`state=${view.state}`);
  }
  if (view.authPending === true) parts.push("auth=pending");
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}
