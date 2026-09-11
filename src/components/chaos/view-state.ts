/**
 * The five URL states, for the chaos screen.
 *
 * House standard, and the same shape every other feature uses: `?state=` with
 * five values, anything unrecognised falling back to the live default rather
 * than to an error page.
 *
 * WHICH STATES READ THE LIVE DATABASE, AND WHY THAT MATTERS MORE HERE
 *
 *   default  live. The real switches, the real inbox, the real invariants.
 *   edge     live. The same read, and the controls still work — `edge` is a
 *            LABEL for the most interesting real state, not a fake one.
 *   loading  fixture. A skeleton, held open long enough to see.
 *   empty    fixture. Chaos has never been armed and no episode has run.
 *   error    fixture. The read failed and the screen says so instead of
 *            drawing a dashboard from nothing.
 *
 * A fixture on this screen is a specific hazard: the entire claim it renders
 * is "these invariants held against the live book while that ran", and a
 * screenshot of a fixture making that claim would be exactly the kind of thing
 * this build refuses to ship. So the source is on the screen, always, and the
 * three fixture states say in prose that nothing on them is a statement about
 * a real book.
 */

export const DEMO_STATES = ['default', 'loading', 'empty', 'error', 'edge'] as const;

export type DemoState = (typeof DEMO_STATES)[number];

export type ChaosViewState = {
  readonly state: DemoState;
};

/** `default` and `edge` read Neon; the rest are fixtures. */
export function isLiveState(state: DemoState): boolean {
  return state === 'default' || state === 'edge';
}

export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  default: 'Default · live',
  loading: 'Loading',
  empty: 'Empty',
  error: 'Error',
  edge: 'Edge · live · everything armed at once',
};

export const DEMO_STATE_HINTS: Record<DemoState, string> = {
  default:
    'The real switches, the real webhook inbox and the real invariant views, read from the live book.',
  loading: 'Skeleton, held open long enough to see.',
  empty: 'Chaos has never been armed on this deployment and no episode has run.',
  error:
    'The read failed. No dashboard is drawn from nothing, and no chaos control is armed by a failed read.',
  edge:
    'All four controls armed together — withheld, delayed, duplicated and reversed at once — against a card nobody has registered. The hardest thing the delivery pipeline is asked to absorb.',
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isDemoState(value: string | undefined): value is DemoState {
  return DEMO_STATES.some((state) => state === value);
}

/** Anything unrecognised falls back to the live screen, never to an error page. */
export function parseChaosView(
  searchParams: Record<string, string | string[] | undefined>,
): ChaosViewState {
  const raw = first(searchParams['state']);
  return { state: isDemoState(raw) ? raw : 'default' };
}

/** `?state=edge`, or `""` for the live default. */
export function demoQuery(state: DemoState): string {
  return state === 'default' ? '' : `?state=${state}`;
}
