/**
 * URL-driven state for the front door.
 *
 * The same five states every other screen in this console has, reachable the
 * same way — by editing the query string and by nothing else. `?state=empty`
 * is a bank with no accounts on the book, `?state=error` is the console read
 * failing, `?state=edge` is an overdrawn account and a payment the signed-in
 * actor raised themselves.
 *
 * Only `default` touches the database. That split is the whole reason the
 * states exist: an outage, an empty book and an over-capture are not
 * conditions you seed on a live ledger to show somebody, and a screenshot of
 * any of them carries the URL that reproduces it.
 */

export const CONSOLE_STATES = [
  "default",
  "loading",
  "empty",
  "error",
  "edge",
] as const;

export type ConsoleState = (typeof CONSOLE_STATES)[number];

export const CONSOLE_STATE_LABELS: Record<ConsoleState, string> = {
  default: "Default",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · overdrawn",
};

export const CONSOLE_STATE_HINTS: Record<ConsoleState, string> = {
  default: "The live book. Every figure is queried when you load the page.",
  loading: "The skeleton, held open by a genuinely slow read rather than faked.",
  empty: "A deployment with no accounts opened and nothing awaiting a human.",
  error: "The console read failed. The page still renders, and says what broke.",
  edge: "An over-capture has driven available negative, and the oldest payment awaiting approval was raised by whoever you are acting as.",
};

/** How long `?state=loading` holds the skeleton open. Long enough to see. */
export const CONSOLE_LOADING_MS = 6_000;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isConsoleState(value: string | undefined): value is ConsoleState {
  return CONSOLE_STATES.some((state) => state === value);
}

/**
 * Read the state out of `searchParams`.
 *
 * Anything unrecognised falls back to `default` rather than throwing. A
 * mistyped query string shows the real console; a 500 on the front door
 * because somebody fat-fingered a URL would be a worse answer than ignoring
 * it.
 */
export function parseConsoleState(
  searchParams: Record<string, string | string[] | undefined>,
): ConsoleState {
  const raw = first(searchParams["state"]);
  return isConsoleState(raw) ? raw : "default";
}

/** `?state=edge`, or `""` for the live default. Stable, so URLs compare. */
export function consoleQuery(state: ConsoleState): string {
  return state === "default" ? "" : `?state=${state}`;
}

/** Only the default state is read from the database. */
export function isLiveState(state: ConsoleState): boolean {
  return state === "default";
}
