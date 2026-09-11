/**
 * The five URL-driven states of the card control panel.
 *
 * Every state is reachable by editing the query string and by nothing else —
 * no feature flag, no seeded row, no build variable. The panel shares
 * `/accounts` with the card & hold console, so it reads its own parameter
 * (`?controls=`) rather than that screen's `?state=`: the two are independent,
 * and a reviewer can put the console in its over-capture edge state while the
 * control panel is showing a fail-closed decline, which is exactly the sort of
 * combination a screenshot is asked for.
 *
 *   (none) / default   LIVE. Real cards, real control versions, real decisions.
 *   ?controls=loading  the live read, held open so the real skeleton is visible.
 *   ?controls=empty    a card that exists and has never had a control set.
 *   ?controls=error    the control read failed. Nothing moved; a query cannot
 *                      alter an append-only table.
 *   ?controls=edge     THE FAIL-CLOSED DECLINE. A decision taken while the
 *                      control store did not answer inside its 600 ms deadline:
 *                      declined, recorded, and explainable. This is the state
 *                      the whole feature is argued around and it is the one you
 *                      cannot produce on demand against a healthy database.
 *
 * NOTE THIS FILE IS CLIENT-SAFE. It imports nothing from `server-only` and
 * nothing that reaches a database, because the forms are a client component and
 * they build these URLs too.
 */

export const CONTROL_VIEWS = ["default", "loading", "empty", "error", "edge"] as const;

export type ControlViewState = (typeof CONTROL_VIEWS)[number];

export const CONTROL_VIEW_LABELS: Record<ControlViewState, string> = {
  default: "Default · live",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · fail closed",
};

export const CONTROL_VIEW_HINTS: Record<ControlViewState, string> = {
  default:
    "Live. Real control versions from Neon, real decisions, and whether Lithic is actually enrolled to call us.",
  loading:
    "The live read, held open for three seconds so the real skeleton can be seen in front of the read it stands in for.",
  empty: "A card that exists and has never had a control set. Not an error — a card with no controls is not a control that failed.",
  error:
    "The panel's own read failed. Nothing moved: card_control_version and card_auth_decision are append-only and a query cannot alter them.",
  edge:
    "The fail-closed decline. The control store missed its 600 ms deadline, so the authorisation was refused rather than guessed at — and the row says exactly that.",
};

/** How long `?controls=loading` holds the read open. Long enough to look at. */
export const CONTROL_LOADING_MS = 3_000;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function isControlView(value: unknown): value is ControlViewState {
  return CONTROL_VIEWS.some((state) => state === value);
}

/**
 * Read the panel's state out of `searchParams`.
 *
 * Anything unrecognised falls back to the live default. A malformed URL shows
 * the real screen; it never shows an error page.
 */
export function parseControlView(
  searchParams: Record<string, string | string[] | undefined>,
): ControlViewState {
  const raw = first(searchParams["controls"]);
  return isControlView(raw) ? raw : "default";
}

/**
 * `?controls=edge`, preserving whatever else is already in the query string.
 *
 * The console's `?state=` and `?business=` have to survive, or switching the
 * panel's state would silently move the screen above it back to live.
 */
export function controlQuery(
  searchParams: Record<string, string | string[] | undefined>,
  next: ControlViewState,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "controls") continue;
    const single = first(value);
    if (single !== undefined && single !== "") params.set(key, single);
  }
  if (next !== "default") params.set("controls", next);
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/** True when this state is answered by the database rather than a fixture. */
export function isLiveControlView(state: ControlViewState): boolean {
  return state === "default" || state === "loading";
}

/* -------------------------------------------------------------------------- */
/* What a control action hands back to the form that fired it                 */
/* -------------------------------------------------------------------------- */

/**
 * The server-action result shape.
 *
 * It lives here rather than beside the actions because a file carrying
 * `"use server"` may export nothing but async functions — a type exported from
 * one is a build error — and because the client component that renders the
 * result needs it too.
 *
 * TWO RULES, BOTH THE SAME AS THE CONSOLE'S OWN `action-result.ts`:
 *
 *   1. IT CROSSES THE SERIALISATION BOUNDARY, so it holds strings and nothing
 *      else. No rows, no `Date`, no `bigint`.
 *   2. MONEY CROSSES AS A DECIMAL STRING OF INTEGER CENTS. A `number` here
 *      would be a float waiting to happen, in a type whose whole subject is
 *      spending limits.
 */
export type ControlActionStatus = "idle" | "ok" | "failed";

export type ControlActionFact = {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
};

export type CardControlsActionResult = {
  readonly status: ControlActionStatus;
  readonly intent: "set_controls" | "replay" | null;
  readonly code: string | null;
  readonly message: string;
  readonly facts: readonly ControlActionFact[];
  /** Which card the result is about, so a panel can attach it to the right one. */
  readonly cardId: string | null;
  /** Monotonic per submission so a repeated identical result still re-renders. */
  readonly at: string;
};

export const IDLE_CONTROL_RESULT: CardControlsActionResult = {
  status: "idle",
  intent: null,
  code: null,
  message: "",
  facts: [],
  cardId: null,
  at: "",
};
