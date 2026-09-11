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

/* -------------------------------------------------------------------------- */
/* What this screen is about to read — decided once, read by both badges      */
/*                                                                            */
/* `isLiveState(state)` used to live above, and it is deliberately gone. It    */
/* answered "does this URL state ASK for a live read", which the state bar     */
/* then printed as LIVE — a claim about the request, rendered as a claim about */
/* the data. Only `default` reads Neon, and the header says why `edge` does    */
/* not, but neither fact is enough to put the word LIVE on a screen: that also */
/* needs a database to have been there. A second predicate answering           */
/* three-quarters of the same question is how the two badges drifted apart.    */
/* -------------------------------------------------------------------------- */

/**
 * Where the figures on this screen came from.
 *
 * ============================================================================
 * ONE SCREEN, ONE CLAIM ABOUT ITS DATA SOURCE. This type is that claim, and it
 * is resolved exactly once per render, in `page.tsx`.
 * ============================================================================
 *
 * The state bar and the board each used to work it out for themselves, from
 * different values: the bar from the URL state alone, the board from
 * the snapshot it was handed (`triage.live`). On a deployment with no database
 * the two disagreed — the bar said LIVE, and twelve lines of markup later the
 * board said FIXTURE — and a reader had no way to tell which of the two was
 * the screen's actual claim. Two badges on one screen making opposite claims
 * about the same read is not a styling defect; on this screen the badge IS the
 * difference between evidence and a drawing.
 *
 *   live        the default state, on a deployment with a database. Every
 *               figure is a row, read at one instant.
 *   fixture     one of the four demo states. Every figure is drawn.
 *   unreadable  there is no database to read. No figures at all — see
 *               `./unreadable.ts`, which refuses rather than drawing.
 */
export type SourceClaim =
  | { readonly kind: "live" }
  | { readonly kind: "fixture"; readonly state: Exclude<DemoState, "default"> }
  | { readonly kind: "unreadable" };

/**
 * The one derivation. `hasDatabase` is passed in rather than read here because
 * this module is imported by components, and nothing under
 * `src/components/**` reads the environment.
 *
 * A demo state stays a fixture whether or not a database is configured: those
 * four states are drawn on purpose, and "no database" does not make a drawing
 * any more or less drawn.
 */
export function resolveSourceClaim(state: DemoState, hasDatabase: boolean): SourceClaim {
  if (state !== "default") return { kind: "fixture", state };
  return hasDatabase ? { kind: "live" } : { kind: "unreadable" };
}

/**
 * The badge text, for every surface that carries one.
 *
 * NO DATABASE is its own word rather than FIXTURE because they are not the
 * same claim. A fixture screen is showing something; this one is showing
 * nothing, and a reader who took NO DATABASE for FIXTURE would be looking for
 * a board that is not there.
 */
export function sourceBadge(claim: SourceClaim): string {
  if (claim.kind === "live") return "LIVE";
  return claim.kind === "fixture" ? "FIXTURE" : "NO DATABASE";
}

/** Only a live read is positive. The other two are not readings. */
export function sourceIsLive(claim: SourceClaim): boolean {
  return claim.kind === "live";
}

/**
 * What this screen is showing, in one sentence, under the state links.
 *
 * The `default` hint promises "all from the live book", which is false when
 * there is no book to read — so the unreadable claim answers with its own
 * sentence rather than letting the state's hint stand.
 */
export function sourceHint(claim: SourceClaim, state: DemoState): string {
  if (claim.kind === "unreadable") {
    return "No database is configured for this deployment. Nothing below was read, no board is drawn, and the absence of a red finding on this screen is not a statement that there is none.";
  }
  return DEMO_STATE_HINTS[state];
}

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
