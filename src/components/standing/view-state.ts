/**
 * URL-driven state for the standing-orders screen.
 *
 * Everything the screen can show is reachable by editing the query string and
 * by nothing else: which demo state, which mandate, which occurrence is drilled
 * into. No client state, no feature flag, no seeded row.
 *
 * The reason is the same as on the breaks and statements screens, and it is
 * about a demo being watched rather than about purity. Every state can be shown
 * live, in order, in front of a panel without firing a payment. And a
 * screenshot of any state carries the URL that reproduces it — which for a
 * refused occurrence is the thing somebody will paste into a ticket when the
 * payee rings up asking where the rent went.
 */

export const DEMO_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type DemoState = (typeof DEMO_STATES)[number];

export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  default: "Default",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · ledger covered it, available did not",
};

export const DEMO_STATE_HINTS: Record<DemoState, string> = {
  default: "Live mandates and every occurrence they have produced, from the database.",
  loading: "Skeleton, held open by a genuinely slow read.",
  empty: "No mandate has been set up. Nothing to show, nothing wrong.",
  error: "The standing-orders query failed. Nothing fired; retry is live.",
  edge:
    "An occurrence refused for insufficient AVAILABLE balance while the LEDGER balance covered it — the money was committed to a card hold and an uncleared credit.",
};

export type StandingFilter = {
  readonly state: DemoState;
  /** `null` means every mandate. */
  readonly standingOrderId: string | null;
  /** The occurrence drilled into. */
  readonly occurrenceId: string | null;
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
 * Anything unrecognised falls back rather than throwing: a mistyped mandate id
 * shows every mandate, and a malformed URL shows the real screen. A 500 on a
 * bad query string is a worse answer than ignoring it.
 */
export function parseStandingFilter(
  searchParams: Record<string, string | string[] | undefined>,
): StandingFilter {
  const rawState = first(searchParams["state"]);
  return {
    state: isDemoState(rawState) ? rawState : "default",
    standingOrderId: asId(first(searchParams["order"])),
    occurrenceId: asId(first(searchParams["occurrence"])),
  };
}

/**
 * Build a query string from a filter, dropping defaults.
 *
 * Stable key order so two URLs for the same view compare equal — which is what
 * makes `aria-current` on the links honest and what stops the browser
 * accumulating near-identical history entries.
 */
export function standingQuery(filter: Partial<StandingFilter>): string {
  const parts: string[] = [];
  if (filter.state !== undefined && filter.state !== null && filter.state !== "default") {
    parts.push(`state=${encodeURIComponent(filter.state)}`);
  }
  if (filter.standingOrderId !== undefined && filter.standingOrderId !== null) {
    parts.push(`order=${encodeURIComponent(filter.standingOrderId)}`);
  }
  if (filter.occurrenceId !== undefined && filter.occurrenceId !== null) {
    parts.push(`occurrence=${encodeURIComponent(filter.occurrenceId)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** `/standing-orders?...` for a filter, with the current one as the base. */
export function standingHref(
  current: StandingFilter,
  patch: Partial<StandingFilter>,
): string {
  return `/standing-orders${standingQuery({ ...current, ...patch })}`;
}
