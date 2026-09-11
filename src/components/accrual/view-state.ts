/**
 * URL-driven state for the accruals screen.
 *
 * Everything the screen can show is reachable by editing the query string and
 * by nothing else: which demo state, which schedule, which day is drilled into.
 * No client state, no feature flag, no seeded row.
 *
 * Same reason as the standing-orders and breaks screens, and it is about a demo
 * being watched rather than about purity. Every state can be shown live, in
 * order, in front of a panel without running the tick. And a screenshot of any
 * state carries the URL that reproduces it — which for a disputed 84¢ is
 * exactly what somebody will paste into a ticket.
 */

export const DEMO_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type DemoState = (typeof DEMO_STATES)[number];

export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  default: "Default",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · the day the price changes under the same account",
};

export const DEMO_STATE_HINTS: Record<DemoState, string> = {
  default: "Every schedule and every day it has accrued, from the database.",
  loading: "Skeleton, held open by a genuinely slow read.",
  empty: "Nobody is enrolled in a daily-accrued charge. Nothing to show, nothing wrong.",
  error: "The accrual query failed. Nothing accrued; retry is live.",
  edge:
    "Two edges, both a one-cent step under one account on adjacent days, for two different reasons. THE FEE: $25.00 over 30 days is 83¢ with 10¢ left over, so days 1–10 accrue 84¢ and day 11 accrues 83¢ — §12.3 placing the last residual penny. THE INTEREST: the rate card was cut from 1.50% to 1.25% overnight, so the same balance accrues 8¢ and then 7¢ — and the balance went UP between the two days, so nothing but the rate explains it. One ledger, two clauses of DESIGN §12, and the screen says which is which.",
};

export type AccrualFilter = {
  readonly state: DemoState;
  /** `null` means every schedule. */
  readonly scheduleId: string | null;
  /** The fee day drilled into. */
  readonly accrualDayId: string | null;
  /** The interest day drilled into. Separate from the fee's: different arithmetic. */
  readonly interestDayId: string | null;
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
 * Anything unrecognised falls back rather than throwing: a mistyped schedule id
 * shows every schedule, and a malformed URL shows the real screen. A 500 on a
 * bad query string is a worse answer than ignoring it.
 */
export function parseAccrualFilter(
  searchParams: Record<string, string | string[] | undefined>,
): AccrualFilter {
  const rawState = first(searchParams["state"]);
  return {
    state: isDemoState(rawState) ? rawState : "default",
    scheduleId: asId(first(searchParams["schedule"])),
    accrualDayId: asId(first(searchParams["day"])),
    interestDayId: asId(first(searchParams["interest"])),
  };
}

/**
 * Build a query string from a filter, dropping defaults.
 *
 * Stable key order so two URLs for the same view compare equal — which is what
 * makes `aria-current` on the links honest and what stops the browser
 * accumulating near-identical history entries.
 */
export function accrualQuery(filter: Partial<AccrualFilter>): string {
  const parts: string[] = [];
  if (filter.state !== undefined && filter.state !== null && filter.state !== "default") {
    parts.push(`state=${encodeURIComponent(filter.state)}`);
  }
  if (filter.scheduleId !== undefined && filter.scheduleId !== null) {
    parts.push(`schedule=${encodeURIComponent(filter.scheduleId)}`);
  }
  if (filter.accrualDayId !== undefined && filter.accrualDayId !== null) {
    parts.push(`day=${encodeURIComponent(filter.accrualDayId)}`);
  }
  if (filter.interestDayId !== undefined && filter.interestDayId !== null) {
    parts.push(`interest=${encodeURIComponent(filter.interestDayId)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** `/accruals?...` for a filter, with the current one as the base. */
export function accrualHref(current: AccrualFilter, patch: Partial<AccrualFilter>): string {
  return `/accruals${accrualQuery({ ...current, ...patch })}`;
}
