/**
 * URL-driven state for `/breaks`.
 *
 * Same posture as `./view-state.ts`: everything the screen can show is
 * reachable by editing the query string and by nothing else, so every state
 * can be demonstrated in order in front of a panel without touching the
 * database, and a screenshot of any state carries the URL that reproduces it.
 *
 * This is a SEPARATE module from `./view-state.ts` rather than a parameter on
 * it, for one reason that is not taste: `breakHref` there builds
 * `/reconciliation/...` and four other components call it. Threading a base
 * path through would have edited a file the reconciliation screen depends on
 * to add a screen it does not know about.
 */

import { CORRECTION_CLASSES, type CorrectionClass } from "@/lib/recon/explain";
import { BREAK_KINDS, isBreakKind, type BreakKind } from "@/lib/recon/types";

export const EXPLAIN_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type ExplainState = (typeof EXPLAIN_STATES)[number];

export const EXPLAIN_STATE_LABELS: Record<ExplainState, string> = {
  default: "Default",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · correction in flight",
};

export const EXPLAIN_STATE_HINTS: Record<ExplainState, string> = {
  default: "Last night's file, classified. Live from the ledger.",
  loading: "Skeleton, held open by a genuinely slow read.",
  empty: "A file that reconciled clean and holds no corrections to explain.",
  error: "The read failed. Nothing moved: this screen is read-only.",
  edge: "A break whose correction group is INCOMPLETE — a reversal with no re-book yet. Explainable, and emphatically not resolved.",
};

export type ExplainFilter = {
  readonly state: ExplainState;
  /** `null` means every category. */
  readonly kind: BreakKind | null;
  /** `null` means every class. */
  readonly correctionClass: CorrectionClass | null;
  /** Which run to show. `null` means the most recent. */
  readonly runId: string | null;
  /** `<kind>:<breakKey>` of the row whose timeline is open. */
  readonly selected: string | null;
};

export const ALL_BREAK_KINDS: readonly BreakKind[] = BREAK_KINDS;
export const ALL_CORRECTION_CLASSES: readonly CorrectionClass[] = CORRECTION_CLASSES;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isExplainState(value: string | undefined): value is ExplainState {
  return EXPLAIN_STATES.some((s) => s === value);
}

function isCorrectionClass(value: string | undefined): value is CorrectionClass {
  return CORRECTION_CLASSES.some((c) => c === value);
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this string shaped like a run id at all?
 *
 * A run id reaches the reader as a `uuid` bind parameter, so a value that is
 * not a uuid does not come back as "no such run" — it comes back as Postgres
 * refusing to cast it, and the screen drew that as RECON_EXPLAIN_READ_FAILED
 * with a retry button. The read had not failed and retrying could not help:
 * the same string would be rejected the same way for ever. Measured on
 * `/breaks?run=not-a-uuid`.
 *
 * The caller checks this before putting the value in a query, so a malformed
 * run id is answered the same way an absent one is — by name, on the page,
 * with the way back — instead of by the database.
 */
export function isRunId(value: string | null): value is string {
  return value !== null && RUN_ID.test(value);
}

/**
 * Read the view out of `searchParams`.
 *
 * Anything unrecognised falls back rather than throwing. A mistyped filter
 * shows the whole table; a 500 on a bad query string is a worse answer than
 * ignoring it.
 */
export function parseExplainFilter(
  searchParams: Record<string, string | string[] | undefined>,
): ExplainFilter {
  const rawState = first(searchParams["state"]);
  const rawKind = first(searchParams["kind"]);
  const rawClass = first(searchParams["class"]);
  const rawRun = first(searchParams["run"]);
  const rawSelected = first(searchParams["break"]);

  return {
    state: isExplainState(rawState) ? rawState : "default",
    kind: isBreakKind(rawKind) ? rawKind : null,
    correctionClass: isCorrectionClass(rawClass) ? rawClass : null,
    runId: rawRun !== undefined && rawRun !== "" ? rawRun : null,
    selected: rawSelected !== undefined && rawSelected !== "" ? rawSelected : null,
  };
}

/** Stable key order, so two URLs for the same view compare equal. */
export function explainQuery(filter: Partial<ExplainFilter>): string {
  const parts: string[] = [];
  if (filter.state !== undefined && filter.state !== null && filter.state !== "default") {
    parts.push(`state=${encodeURIComponent(filter.state)}`);
  }
  if (filter.kind !== undefined && filter.kind !== null) {
    parts.push(`kind=${encodeURIComponent(filter.kind)}`);
  }
  if (filter.correctionClass !== undefined && filter.correctionClass !== null) {
    parts.push(`class=${encodeURIComponent(filter.correctionClass)}`);
  }
  if (filter.runId !== undefined && filter.runId !== null) {
    parts.push(`run=${encodeURIComponent(filter.runId)}`);
  }
  if (filter.selected !== undefined && filter.selected !== null) {
    parts.push(`break=${encodeURIComponent(filter.selected)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

export function explainHref(
  current: ExplainFilter,
  patch: Partial<ExplainFilter>,
): string {
  return `/breaks${explainQuery({ ...current, ...patch })}`;
}

/**
 * Apply the filters to the rows.
 *
 * ===========================================================================
 * THIS IS A DISPLAY FILTER AND IT IS THE ONLY ONE ON THIS SCREEN
 * ===========================================================================
 *
 * It hides rows only when the operator has explicitly asked for a subset in
 * the URL, and the table ALWAYS prints "n of m" so a filtered view can never
 * be mistaken for an empty one. There is no default filter, no "hide
 * explained" toggle, and no severity floor. A screen whose default view is a
 * subset is a screen that trains people to believe the subset is the whole,
 * and "explained rows are collapsed by default" is exactly how an explainable
 * break becomes a suppressed one.
 */
export function applyExplainFilter<
  T extends { readonly kind: BreakKind; readonly correctionClass: CorrectionClass },
>(rows: readonly T[], filter: ExplainFilter): readonly T[] {
  return rows.filter(
    (row) =>
      (filter.kind === null || row.kind === filter.kind) &&
      (filter.correctionClass === null || row.correctionClass === filter.correctionClass),
  );
}
