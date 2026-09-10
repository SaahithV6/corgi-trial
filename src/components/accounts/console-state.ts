/**
 * The five URL-driven states of the card & hold console, and the business it
 * is pointed at.
 *
 * Every state is reachable by editing the query string and by nothing else —
 * no feature flag, no seeded row, no build variable. `?state=` selects which
 * source answers the console's contract:
 *
 *   (none) / default   LIVE. Real Neon rows, real Lithic cards, real holds.
 *   ?state=loading     the skeleton, held open by a genuinely slow read.
 *   ?state=empty       a business with an account and nothing on it.
 *   ?state=error       the console read failed; retry is live.
 *   ?state=edge        the over-capture: authorised $50.00, cleared $73.40,
 *                      available NEGATIVE and not clamped.
 *
 * `?business=` picks which customer the live console operates on. It is a
 * REFERENCE and nothing more: every action re-reads the business, its accounts
 * and its cards from the database, so a hand-edited uuid can only select a row
 * that already exists or fail closed.
 *
 * The four fixture states write nothing and read nothing. That is deliberate.
 * An over-capture and a failed balance query are not conditions you seed on a
 * live ledger to show someone, and a console that could only demonstrate them
 * by moving real money would be a worse console.
 */

export const CONSOLE_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type ConsoleState = (typeof CONSOLE_STATES)[number];

export type ConsoleView = {
  readonly state: ConsoleState;
  /** Which business the live console operates on. `null` = pick the default. */
  readonly businessId: string | null;
};

export const CONSOLE_STATE_LABELS: Record<ConsoleState, string> = {
  default: "Default · live",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · over-capture",
};

export const CONSOLE_STATE_HINTS: Record<ConsoleState, string> = {
  default:
    "Live. Real cards, real holds, real balances — and the controls that move them.",
  loading:
    "The live read, held open for four seconds so the real skeleton can be seen.",
  empty: "A verified business with an account, no card and nothing held.",
  error: "The console read failed. Nothing moved; a query cannot alter an append-only ledger.",
  edge: "Authorised $50.00, cleared $73.40. Available goes negative and is not clamped.",
};

/** How long `?state=loading` holds the read open. Long enough to look at. */
export const CONSOLE_LOADING_MS = 4_000;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isConsoleState(value: string | undefined): value is ConsoleState {
  return CONSOLE_STATES.some((state) => state === value);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Read the console view out of `searchParams`.
 *
 * Anything unrecognised falls back to the live default. A malformed URL shows
 * the real screen; it never shows an error page, and it never selects a
 * business that is not a well-formed id.
 */
export function parseConsoleView(
  searchParams: Record<string, string | string[] | undefined>,
): ConsoleView {
  const rawState = first(searchParams["state"]);
  const rawBusiness = first(searchParams["business"]);
  return {
    state: isConsoleState(rawState) ? rawState : "default",
    businessId: isUuid(rawBusiness) ? rawBusiness : null,
  };
}

/** `?state=edge&business=…`, or `""`. Stable key order so URLs compare. */
export function consoleQuery(view: Partial<ConsoleView>): string {
  const parts: string[] = [];
  if (view.state !== undefined && view.state !== "default") {
    parts.push(`state=${view.state}`);
  }
  if (view.businessId !== undefined && view.businessId !== null) {
    parts.push(`business=${view.businessId}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/**
 * True when this view is answered by the live database rather than a fixture.
 *
 * `loading` is on the live side deliberately. The point of that state is to
 * show the REAL skeleton for long enough to look at, and the only way to know
 * a skeleton is correct is to see it in front of the read it actually stands
 * in for. So `?state=loading` is the live console with the read held open, not
 * a mock of one.
 */
export function isLiveConsole(view: ConsoleView): boolean {
  return view.state === "default" || view.state === "loading";
}
