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
  /**
   * How many postings the Activity table asks for.
   *
   * `?rows=` on the URL, clamped by the data source to `MAX_POSTINGS_LIMIT`.
   * It exists because the table is a PAGE and the balances above it are a fold
   * over the whole journal: with a fixed 25 rows, a payment released earlier the
   * same day was simply absent from the only screen that lists it, and nothing
   * on the page said so. Garbage and out-of-range values fall back to the
   * default rather than refusing the page — a mistyped query string must not
   * hide an account.
   */
  readonly postingRows: number;
};

/** What `?rows=` defaults to, and the most it can ask for. */
export const DEFAULT_POSTING_ROWS = 25;
export const MAX_POSTING_ROWS = 200;

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
  const rows = Number.parseInt(first(searchParams["rows"]) ?? "", 10);
  const postingRows =
    Number.isFinite(rows) && rows > 0 ? Math.min(rows, MAX_POSTING_ROWS) : DEFAULT_POSTING_ROWS;
  return { state, authPending, postingRows };
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
