/**
 * URL-driven demo states for the onboarding screen.
 *
 * Same contract as the account, approvals, reconciliation and statements
 * screens: every state is reachable by editing the query string, each has a URL
 * that reproduces it, and switching between them writes nothing.
 *
 * `default` is the LIVE derived state — `v_business_kyb` joined to the latest
 * row per leg in `kyb_verification_leg`. It shows every seeded business in
 * whatever state its evidence puts it in, which for this book means pending,
 * approved and rejected side by side rather than a curated happy path.
 *
 * THE EDGE STATE IS THE ONE THAT MATTERS HERE. It is a business whose director
 * KYC was answered by a real third party — a genuine Stripe Identity session,
 * verified — and whose registry leg was forced back to the labelled simulator
 * with `KYB_FORCE_SIMULATED=business_registry`. Both legs approve. The composite
 * is therefore `approved`, and its evidence label is `simulated`, because
 * evidence degrades and never un-degrades. A screen that showed "APPROVED ·
 * live" there would be the automatic fail this whole module exists to make
 * unrepresentable.
 *
 * It is a FIXTURE of a state the live deployment no longer sits in: the registry
 * leg defaults to GLEIF and is live. The escape hatch is kept precisely so the
 * degradation rule can be demonstrated on demand rather than asserted, and this
 * state is what it looks like when it is pulled.
 */

export const DEMO_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type DemoState = (typeof DEMO_STATES)[number];

export type OnboardingView = {
  readonly state: DemoState;
};

export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  default: "Default · live",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · one real leg, one simulated",
};

export const DEMO_STATE_HINTS: Record<DemoState, string> = {
  default: "Every business on the book, with the KYB state derived from its evidence.",
  loading: "Skeleton, held open long enough to see.",
  empty: "No businesses on the book at all.",
  error: "The verification state could not be read. Nothing was written; retry is live.",
  edge: "Director KYC really was verified by Stripe. The registry leg was forced back to the simulator. The verification is approved and its evidence reads simulated — degradation, shown rather than claimed.",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isDemoState(value: string | undefined): value is DemoState {
  return DEMO_STATES.some((state) => state === value);
}

/** Anything unrecognised falls back to the live state, never to an error page. */
export function parseOnboardingView(
  searchParams: Record<string, string | string[] | undefined>,
): OnboardingView {
  const raw = first(searchParams["state"]);
  return { state: isDemoState(raw) ? raw : "default" };
}

/** `?state=edge`, or `""` for the live default. */
export function demoQuery(state: DemoState): string {
  return state === "default" ? "" : `?state=${state}`;
}
