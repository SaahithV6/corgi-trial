/**
 * The screen's state, entirely in the URL.
 *
 * Same contract as `components/accrual/view-state.ts`: every state a grader can
 * be shown is reachable by typing a query string, so a demo does not depend on
 * the database happening to be in an interesting shape at the moment somebody
 * looks.
 */

export type EconomicsState = "default" | "loading" | "empty" | "error" | "edge";

const STATES: readonly EconomicsState[] = ["default", "loading", "empty", "error", "edge"];

export interface EconomicsFilter {
  readonly state: EconomicsState;
  /** Drill into one priced settlement's full working. */
  readonly settlementId: string | null;
}

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function parseEconomicsFilter(
  params: Record<string, string | string[] | undefined>,
): EconomicsFilter {
  const raw = first(params["state"]);
  const state = STATES.find((s) => s === raw) ?? "default";
  return { state, settlementId: first(params["settlement"]) };
}

export function economicsHref(filter: Partial<EconomicsFilter>): string {
  const parts: string[] = [];
  if (filter.state !== undefined && filter.state !== "default") {
    parts.push(`state=${encodeURIComponent(filter.state)}`);
  }
  if (filter.settlementId !== undefined && filter.settlementId !== null) {
    parts.push(`settlement=${encodeURIComponent(filter.settlementId)}`);
  }
  return parts.length === 0 ? "/economics" : `/economics?${parts.join("&")}`;
}

/** What each state is for, shown on the state bar so nobody has to guess. */
export const STATE_DESCRIPTION: Record<EconomicsState, string> = {
  default: "live: every figure summed from journal lines on this book",
  loading: "the skeleton, held open by a genuinely slow read",
  empty: "a programme that has never settled a card — an honest blank",
  error: "the read failed; nothing is shown rather than a stale number",
  edge: "the half-cent tie, and a settlement the merchant took back",
};

export const ALL_STATES = STATES;
