/**
 * The five URL states, for the triage screen.
 *
 * House standard, same shape as every other feature: `?state=` with five
 * values, anything unrecognised falling back to the live default rather than
 * to an error page.
 *
 *   default  live. The real invariant readings, the real queues, the real
 *            audit trail.
 *   loading  fixture. The skeleton, held open long enough to see.
 *   empty    fixture. Nothing red, nothing queued, nothing to do.
 *   error    fixture. The read failed and the screen says so rather than
 *            drawing a triage board from nothing.
 *   edge     FIXTURE, and this is the one that needs its reason stated.
 *
 * WHY `edge` IS A FIXTURE HERE WHEN `/chaos` COULD MAKE ITS OWN LIVE
 *
 * The edge case this screen exists to show is a DELIBERATE red sitting beside
 * one that is NOT — because telling those two apart at a glance is the whole
 * job of section 1. Against this book that state does not currently exist:
 * `node scripts/dbcheck.mjs` reads 42 passed / 4 failed and all four failures
 * are on the register in `./decided.ts` with their arguments attached. There
 * is no fifth, undecided red to show.
 *
 * The two dishonest ways to produce one would be to drop a view off the
 * register so a decided red renders as new, or to draw a row that no view
 * returned. Both are a screen inventing a finding, which is the exact failure
 * this build keeps cataloguing. So `edge` is a fixture, it carries the FIXTURE
 * badge every other screen uses, and it says on its own face that nothing on
 * it is a statement about a real book.
 *
 * If a genuinely new red appears while the deployment is up, the DEFAULT state
 * shows it — ranked above the decided four, in the `new` band — and no URL
 * state is needed to see it. That is the design working, not a gap in it.
 */

export const DEMO_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type DemoState = (typeof DEMO_STATES)[number];

export type DashboardViewState = {
  readonly state: DemoState;
};

/** Only `default` reads Neon. See the header for why `edge` does not. */
export function isLiveState(state: DemoState): boolean {
  return state === "default";
}

export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  default: "Default · live",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · fixture · a decided red beside a new one",
};

export const DEMO_STATE_HINTS: Record<DemoState, string> = {
  default:
    "Every invariant view read at one instant, every queue that is waiting on a person, and what the machine wrote while nobody was watching — all from the live book.",
  loading: "Skeleton, held open long enough to see.",
  empty:
    "Nothing red, nothing queued, nothing the machine refused. What a quiet shift looks like.",
  error:
    "The read failed. No triage board is drawn from nothing, and a failed read is never rendered as an all-clear.",
  edge:
    "FIXTURE. A red invariant that is DECIDED, sitting next to one that is NEW. This book has no new red right now — dbcheck reads 42/4 and all four are on the register — so this state is drawn rather than read, and it says so.",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isDemoState(value: string | undefined): value is DemoState {
  return DEMO_STATES.some((state) => state === value);
}

/** Anything unrecognised falls back to the live screen, never to an error page. */
export function parseDashboardView(
  searchParams: Record<string, string | string[] | undefined>,
): DashboardViewState {
  const raw = first(searchParams["state"]);
  return { state: isDemoState(raw) ? raw : "default" };
}

/** `?state=edge`, or `""` for the live default. */
export function dashboardQuery(state: DemoState): string {
  return state === "default" ? "" : `?state=${state}`;
}
