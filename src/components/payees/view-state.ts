/**
 * URL-driven state for the payee screen.
 *
 * Every state the screen can show is reachable by editing the query string and
 * by nothing else. No client state, no feature flag, no seeded row.
 *
 * The reason is the same as on the standing-orders and breaks screens, and it
 * is about a demo being watched rather than about purity: every state can be
 * shown live, in order, in front of a panel without running a check or writing
 * a row — and a screenshot of any state carries the URL that reproduces it.
 *
 * The `edge` state is the one worth pausing on. It is the payee whose last
 * check WARNED and whose warning nobody has signed for: a real name mismatch
 * on a payee that is otherwise perfectly well-formed, which is precisely the
 * case this feature exists to put in front of a human and precisely the case a
 * hard block would have got wrong.
 */

export const DEMO_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type DemoState = (typeof DEMO_STATES)[number];

export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  default: "Default",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · warned, unsigned",
};

export const DEMO_STATE_HINTS: Record<DemoState, string> = {
  default: "The live payee book and every check recorded against it, from the database.",
  loading: "Skeleton, held open by a genuinely slow read.",
  empty: "No payee has been added. Nothing to show, nothing wrong.",
  error: "The payee query failed. No check ran, nothing was written; retry is live.",
  edge:
    "A payee whose last check warned and whose warning nobody has signed for — the name does " +
    "not match, the routing number is perfectly valid, and a payment to it is held until " +
    "somebody puts their name to the difference.",
};

export type PayeeFilter = {
  readonly state: DemoState;
  /** `null` means every payee. */
  readonly payeeId: string | null;
  /** Show the refused candidates rather than the book. */
  readonly showRefusals: boolean;
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
 * Anything unrecognised falls back rather than throwing: a mistyped payee id
 * shows every payee, and a malformed URL shows the real screen. A 500 on a bad
 * query string is a worse answer than ignoring it.
 */
export function parsePayeeFilter(
  searchParams: Record<string, string | string[] | undefined>,
): PayeeFilter {
  const rawState = first(searchParams["state"]);
  return {
    state: isDemoState(rawState) ? rawState : "default",
    payeeId: asId(first(searchParams["payee"])),
    showRefusals: first(searchParams["refusals"]) === "1",
  };
}

/**
 * Build a query string from a filter, dropping defaults.
 *
 * Stable key order so two URLs for the same view compare equal — which is what
 * makes `aria-current` on the links honest and what stops the browser
 * accumulating near-identical history entries.
 */
export function payeeQuery(filter: Partial<PayeeFilter>): string {
  const parts: string[] = [];
  if (filter.state !== undefined && filter.state !== null && filter.state !== "default") {
    parts.push(`state=${encodeURIComponent(filter.state)}`);
  }
  if (filter.payeeId !== undefined && filter.payeeId !== null) {
    parts.push(`payee=${encodeURIComponent(filter.payeeId)}`);
  }
  if (filter.showRefusals === true) parts.push("refusals=1");
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** The href for a view of the payee screen. The route is named in one place. */
export function payeeHref(filter: Partial<PayeeFilter>): string {
  return `/payees${payeeQuery(filter)}`;
}
