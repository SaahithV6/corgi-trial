/**
 * URL-driven demo states for the payments screen.
 *
 * Same contract as every other screen: every state is reachable by editing the
 * query string, each has a URL that reproduces it, and switching between them
 * writes nothing.
 *
 * TWO STATES ARE LIVE HERE, WHICH IS ONE MORE THAN THE APPROVALS SCREEN.
 *
 * `default` is live for the obvious reason. `edge` is live for a less obvious
 * one: the edge case on this screen is not a picture of a boundary, it is a
 * payment you can actually raise ON the boundary — $2,500.00 on ACH, where the
 * seeded policy's test is `amount_cents >= threshold_cents` and the equal case
 * is the one everybody gets wrong. A fixture form with a disabled button would
 * demonstrate the arithmetic and prove nothing about it. So `edge` prefills the
 * live form and lets you submit it, and the receipt says whether the database
 * agreed that equal crosses the line.
 *
 * The other three stay fixtures, because `loading` has to be slow on demand,
 * `error` has to be showable without breaking Neon, and `empty` has to be
 * showable without closing the only two deposit accounts on the book.
 */

export const DEMO_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type DemoState = (typeof DEMO_STATES)[number];

export type PaymentsView = {
  readonly state: DemoState;
};

/** `default` and `edge` read Neon; the rest are fixtures. */
export function isLiveState(state: DemoState): boolean {
  return state === "default" || state === "edge";
}

export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  default: "Default · live",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · live · on the threshold",
};

export const DEMO_STATE_HINTS: Record<DemoState, string> = {
  default: "The real form, against the live account list and the live policy table.",
  loading: "Skeleton, held open long enough to see.",
  empty: "No account on this book can originate a payment.",
  error: "The preflight read failed. Nothing was raised; retry is live.",
  edge:
    "$2,500.00 on ACH — exactly the threshold, where the rule is >= and equal crosses it. The source business is verified on SIMULATED evidence, so the same payment is refused under the stricter policy.",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isDemoState(value: string | undefined): value is DemoState {
  return DEMO_STATES.some((state) => state === value);
}

/** Anything unrecognised falls back to the live form, never to an error page. */
export function parsePaymentsView(
  searchParams: Record<string, string | string[] | undefined>,
): PaymentsView {
  const raw = first(searchParams["state"]);
  return { state: isDemoState(raw) ? raw : "default" };
}

/** `?state=edge`, or `""` for the live default. */
export function demoQuery(state: DemoState): string {
  return state === "default" ? "" : `?state=${state}`;
}
