/**
 * URL-driven demo states for the funding screen.
 *
 * Same contract as every other screen: every state is reachable by editing the
 * query string, each has a URL that reproduces it, and switching between them
 * writes nothing.
 *
 * TWO STATES ARE LIVE, and `edge` is the one worth arguing about.
 *
 * The edge case here is not a picture of a boundary. It is the account as it
 * genuinely stands after a deposit has posted and before the return window has
 * closed: ledger UP by the full amount, available NOT MOVED by a cent, and the
 * uncleared-credit hold itemised with the banking date and the 09:00 New York
 * instant it releases on. That state is a real position in the live database —
 * `hold.kind = 'uncleared_credit'` with an `available_at` in the future — and a
 * fixture of it would demonstrate the arithmetic while proving nothing about
 * it. So `edge` reads Neon and shows the real hold, and if no such hold exists
 * right now it says so rather than drawing one.
 *
 * The other three stay fixtures, because `loading` has to be slow on demand,
 * `error` has to be showable without breaking Neon, and `empty` has to be
 * showable without closing the only deposit accounts on the book.
 */

export const DEMO_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type DemoState = (typeof DEMO_STATES)[number];

export type FundingView = {
  readonly state: DemoState;
};

/** `default` and `edge` read Neon; the rest are fixtures. */
export function isLiveState(state: DemoState): boolean {
  return state === "default" || state === "edge";
}

export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  default: "Default · live",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · live · funded, not yet available",
};

export const DEMO_STATE_HINTS: Record<DemoState, string> = {
  default:
    "The real screen, against the live ledger and the live funds_availability_policy table.",
  loading: "Skeleton, held open long enough to see.",
  empty: "No deposit account on this book for an inbound credit to land in.",
  error: "The preflight read failed. Nothing was funded; retry is live.",
  edge:
    "Funded but not yet available: the ledger balance is up by the full deposit, available has not moved, and the uncleared-credit hold that explains the difference is itemised with the banking day and the 09:00 ET instant it releases on.",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isDemoState(value: string | undefined): value is DemoState {
  return DEMO_STATES.some((state) => state === value);
}

/** Anything unrecognised falls back to the live screen, never to an error page. */
export function parseFundingView(
  searchParams: Record<string, string | string[] | undefined>,
): FundingView {
  const raw = first(searchParams["state"]);
  return { state: isDemoState(raw) ? raw : "default" };
}

/** `?state=edge`, or `""` for the live default. */
export function demoQuery(state: DemoState): string {
  return state === "default" ? "" : `?state=${state}`;
}
