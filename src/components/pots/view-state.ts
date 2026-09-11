/**
 * URL-driven state for the pots screen.
 *
 * Everything the screen can show is reachable by editing the query string and
 * by nothing else: which demo state, which customer. No client state, no
 * feature flag, no seeded row.
 *
 * Same reason as the standing-orders and breaks screens, and it is about a demo
 * being watched rather than about purity. Every state can be shown live, in
 * order, in front of a panel. And a screenshot of any state carries the URL
 * that reproduces it — which for a refused transfer is the thing somebody will
 * paste into a ticket when the customer rings up asking why they could not set
 * aside money they can see on their own balance.
 */

export const DEMO_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type DemoState = (typeof DEMO_STATES)[number];

export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  default: "Default",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · more into a pot than is available",
};

export const DEMO_STATE_HINTS: Record<DemoState, string> = {
  default:
    "Live pots, live balances, and every internal transfer they have seen — all of it summed from journal_line.",
  loading: "Skeleton, held open by a genuinely slow read.",
  empty: "This customer has opened no pots. Nothing to show, nothing wrong.",
  error: "The pots read failed. No money moved; this path only reads. Retry is live.",
  edge:
    "A move of one cent MORE than the live available balance, decided by the same function the transaction uses — refused, with the subtraction that refused it. Nothing is posted: the amount is synthetic, the four balances it is judged against are not.",
};

export type PotsFilter = {
  readonly state: DemoState;
  /** `null` means "the first customer on the book". */
  readonly businessId: string | null;
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isDemoState(value: string | undefined): value is DemoState {
  return DEMO_STATES.some((s) => s === value);
}

/** A uuid and nothing else. Guards the `::uuid` casts in the query layer. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asId(value: string | undefined): string | null {
  return value !== undefined && UUID.test(value) ? value : null;
}

/**
 * Read the view out of `searchParams`.
 *
 * Anything unrecognised falls back rather than throwing: a mistyped business id
 * shows the first customer, and a malformed URL shows the real screen. A 500 on
 * a bad query string is a worse answer than ignoring it.
 */
export function parsePotsFilter(
  searchParams: Record<string, string | string[] | undefined>,
): PotsFilter {
  const rawState = first(searchParams["state"]);
  return {
    state: isDemoState(rawState) ? rawState : "default",
    businessId: asId(first(searchParams["business"])),
  };
}

/**
 * Build a query string from a filter, dropping defaults.
 *
 * Stable key order so two URLs for the same view compare equal — which is what
 * makes `aria-current` on the links honest and what stops the browser
 * accumulating near-identical history entries.
 */
export function potsQuery(filter: Partial<PotsFilter>): string {
  const parts: string[] = [];
  if (filter.state !== undefined && filter.state !== null && filter.state !== "default") {
    parts.push(`state=${encodeURIComponent(filter.state)}`);
  }
  if (filter.businessId !== undefined && filter.businessId !== null) {
    parts.push(`business=${encodeURIComponent(filter.businessId)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** `/pots?...` for a filter, with the current one as the base. */
export function potsHref(current: PotsFilter, patch: Partial<PotsFilter>): string {
  return `/pots${potsQuery({ ...current, ...patch })}`;
}
