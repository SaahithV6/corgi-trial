/**
 * URL-driven state for the breaks screen.
 *
 * Everything the screen can show is reachable by editing the query string and
 * by nothing else: which demo state, which category, which age bucket, which
 * run, which break is drilled into. No client state, no feature flag, no
 * seeded row.
 *
 * Two reasons that matters, and both of them are about a demo being watched
 * rather than about purity. Every state can be shown live, in order, in front
 * of a panel without touching the database. And a screenshot of any state
 * carries the URL that reproduces it — including the drill-through, which is
 * the one thing somebody will want to paste into a ticket.
 */

import {
  AGE_BUCKETS,
  BREAK_KINDS,
  isAgeBucket,
  isBreakKind,
  type AgeBucket,
  type BreakKind,
} from "@/lib/recon/types";

export const DEMO_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type DemoState = (typeof DEMO_STATES)[number];

export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  default: "Default",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · explained break",
};

export const DEMO_STATE_HINTS: Record<DemoState, string> = {
  default: "Last night's file, reconciled. Live from the ledger.",
  loading: "Skeleton, held open by a genuinely slow read.",
  empty: "A file that reconciled clean. Nothing to work.",
  error: "The reconciliation query failed. Retry is live.",
  edge: "A break whose entry was corrected by reversal plus re-book: real, and already answered.",
};

export type BreakFilter = {
  readonly state: DemoState;
  /** `null` means every category. */
  readonly kind: BreakKind | null;
  /** `null` means every age. */
  readonly age: AgeBucket | null;
  /** Which run to show. `null` means the most recent. */
  readonly runId: string | null;
  /** `<kind>:<breakKey>` of the drilled-into break. */
  readonly selected: string | null;
};

export const ALL_KINDS: readonly BreakKind[] = BREAK_KINDS;
export const ALL_AGES: readonly AgeBucket[] = AGE_BUCKETS;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isDemoState(value: string | undefined): value is DemoState {
  return DEMO_STATES.some((s) => s === value);
}

/**
 * Read the view out of `searchParams`.
 *
 * Anything unrecognised falls back rather than throwing: a mistyped filter
 * shows the whole table, and a malformed URL shows the real screen. A 500 on a
 * bad query string is a worse answer than ignoring it.
 */
export function parseBreakFilter(
  searchParams: Record<string, string | string[] | undefined>,
): BreakFilter {
  const rawState = first(searchParams["state"]);
  const rawKind = first(searchParams["kind"]);
  const rawAge = first(searchParams["age"]);
  const rawRun = first(searchParams["run"]);
  const rawBreak = first(searchParams["break"]);

  return {
    state: isDemoState(rawState) ? rawState : "default",
    kind: isBreakKind(rawKind) ? rawKind : null,
    age: isAgeBucket(rawAge) ? rawAge : null,
    runId: rawRun !== undefined && rawRun !== "" ? rawRun : null,
    selected: rawBreak !== undefined && rawBreak !== "" ? rawBreak : null,
  };
}

/**
 * Build a query string from a filter, dropping defaults.
 *
 * Stable key order so two URLs for the same view compare equal — which is what
 * makes `aria-current` on the filter chips honest and what stops the browser
 * accumulating near-identical history entries.
 */
export function breakQuery(filter: Partial<BreakFilter>): string {
  const parts: string[] = [];
  if (filter.state !== undefined && filter.state !== null && filter.state !== "default") {
    parts.push(`state=${encodeURIComponent(filter.state)}`);
  }
  if (filter.kind !== undefined && filter.kind !== null) {
    parts.push(`kind=${encodeURIComponent(filter.kind)}`);
  }
  if (filter.age !== undefined && filter.age !== null) {
    parts.push(`age=${encodeURIComponent(filter.age)}`);
  }
  if (filter.runId !== undefined && filter.runId !== null) {
    parts.push(`run=${encodeURIComponent(filter.runId)}`);
  }
  if (filter.selected !== undefined && filter.selected !== null) {
    parts.push(`break=${encodeURIComponent(filter.selected)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** `/reconciliation?...` for a filter, with the current one as the base. */
export function breakHref(
  current: BreakFilter,
  patch: Partial<BreakFilter>,
): string {
  return `/reconciliation${breakQuery({ ...current, ...patch })}`;
}

/**
 * Apply the filters to the rows.
 *
 * Done here rather than in SQL on purpose: the whole break list for one file
 * is small — tens of rows, not thousands — and filtering in the query would
 * make the summary tiles disagree with the table, because the tiles have to
 * count what the filter is hiding. One read, one list, two consumers.
 */
export function applyFilter<
  T extends { readonly kind: BreakKind; readonly ageBucket: AgeBucket },
>(rows: readonly T[], filter: BreakFilter): readonly T[] {
  return rows.filter(
    (row) =>
      (filter.kind === null || row.kind === filter.kind) &&
      (filter.age === null || row.ageBucket === filter.age),
  );
}
