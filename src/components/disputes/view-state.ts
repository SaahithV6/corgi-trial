/**
 * URL-driven state for the disputes screen.
 *
 * Everything the screen can show is reachable by editing the query string and
 * by nothing else: which demo state, which customer, which case. No client
 * state, no feature flag, no seeded row.
 *
 * The reason is the same one the pots and breaks screens give, and it matters
 * most here: the edge state is a customer's money being taken back off them,
 * and the URL that produced that screenshot is what somebody pastes into a
 * ticket when the customer rings up asking why.
 */

export const DEMO_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type DemoState = (typeof DEMO_STATES)[number];

export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  default: "Default",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · lost after provisional credit, clawed back",
};

export const DEMO_STATE_HINTS: Record<DemoState, string> = {
  default:
    "Live cases, live balances, and the settled card charges that are still disputable — every figure a sum over the journal itself.",
  loading: "Skeleton, held open by a genuinely slow read.",
  empty: "No dispute has ever been raised on this customer. Nothing to show, nothing wrong.",
  error: "The disputes read failed. No money moved; this path only reads. Retry is live.",
  edge:
    "A real case, lost AFTER provisional credit was granted. Both entries, on their own two value dates, neither of them a reversal — and the customer's ledger and available balance at each step, so you can see that available never moved and the clawback could not overdraw them.",
};

export type DisputesFilter = {
  readonly state: DemoState;
  /** `null` means "the first customer on the book". */
  readonly businessId: string | null;
  /** `null` means "whichever case the state picks". */
  readonly disputeId: string | null;
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
 * Anything unrecognised falls back rather than throwing: a mistyped case id
 * shows the list, and a malformed URL shows the real screen. A 500 on a bad
 * query string is a worse answer than ignoring it.
 */
export function parseDisputesFilter(
  searchParams: Record<string, string | string[] | undefined>,
): DisputesFilter {
  const rawState = first(searchParams["state"]);
  return {
    state: isDemoState(rawState) ? rawState : "default",
    businessId: asId(first(searchParams["business"])),
    disputeId: asId(first(searchParams["case"])),
  };
}

/**
 * Build a query string from a filter, dropping defaults.
 *
 * Stable key order so two URLs for the same view compare equal — which is what
 * makes `aria-current` on the links honest and what stops the browser
 * accumulating near-identical history entries.
 */
export function disputesQuery(filter: Partial<DisputesFilter>): string {
  const parts: string[] = [];
  if (filter.state !== undefined && filter.state !== null && filter.state !== "default") {
    parts.push(`state=${encodeURIComponent(filter.state)}`);
  }
  if (filter.businessId !== undefined && filter.businessId !== null) {
    parts.push(`business=${encodeURIComponent(filter.businessId)}`);
  }
  if (filter.disputeId !== undefined && filter.disputeId !== null) {
    parts.push(`case=${encodeURIComponent(filter.disputeId)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** `/disputes?...` for a filter, with the current one as the base. */
export function disputesHref(
  current: DisputesFilter,
  patch: Partial<DisputesFilter>,
): string {
  return `/disputes${disputesQuery({ ...current, ...patch })}`;
}

/** Tone for a status badge. Closed-and-recovered is not a failure; it is the answer. */
export function statusTone(status: string): "neutral" | "quiet" | "negative" | "positive" {
  switch (status) {
    case "provisional_credit_granted":
      return "neutral";
    case "closed_won":
      return "positive";
    case "lost_pending_recovery":
      return "negative";
    case "closed_lost_recovered":
    case "closed_lost_written_off":
    case "withdrawn":
      return "quiet";
    default:
      return "quiet";
  }
}

/** `provisional_credit_granted` reads badly in a table cell. */
export function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}
