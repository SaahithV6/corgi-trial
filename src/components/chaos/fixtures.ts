/**
 * The fixture source: the three states that cannot be produced on demand.
 *
 * `DEMO_NOW` is a fixed instant rather than `Date.now()`, so countdowns and
 * ages are reproducible, the screen is a pure function of the URL, and the
 * server render cannot disagree with the client hydration.
 *
 * NOTE WHAT IS NOT HERE. There is no fixture for `default` or `edge`. Both read
 * the live database, because the claim this screen makes — "these invariants
 * held while that ran" — is a claim about a real book and a fixture cannot make
 * it. When the database is absent the page falls back to the `empty` fixture
 * and the source badge says FIXTURE, rather than drawing a confident dashboard
 * out of nothing.
 */

import { fail, ok, type ErrorShape, type Result } from '@/lib/result';

import type { ChaosControlView, ChaosDataSource, ChaosView } from './data-contract';
import type { DemoState } from './view-state';

export const DEMO_NOW = '2026-09-11T14:22:00.000Z';
export const DEMO_LOADING_MS = 6_000;

const CONTROLS: ChaosControlView[] = [
  {
    control: 'webhooks_off',
    label: 'Webhooks off',
    effect: 'We withhold the deliveries we originated. Nothing leaves our outbox.',
    armed: false,
    setting: 'lithic',
    expiresAt: null,
    secondsRemaining: 0,
    armedBy: null,
  },
  {
    control: 'settlement_delay',
    label: 'Settlement delay',
    effect: 'We hold our own clearing delivery back before releasing it.',
    armed: false,
    setting: '45 seconds',
    expiresAt: null,
    secondsRemaining: 0,
    armedBy: null,
  },
  {
    control: 'duplicate_delivery',
    label: 'Duplicate delivery',
    effect: 'We send each of our own deliveries N times, byte for byte, same id.',
    armed: false,
    setting: '3 copies',
    expiresAt: null,
    secondsRemaining: 0,
    armedBy: null,
  },
  {
    control: 'reorder_window',
    label: 'Reorder window',
    effect: 'We release our own deliveries backwards inside a window.',
    armed: false,
    setting: '20 seconds',
    expiresAt: null,
    secondsRemaining: 0,
    armedBy: null,
  },
];

const INVARIANTS = [
  ['v_entry_unbalanced', 'every entry sums to zero, per currency'],
  ['v_line_denorm_drift', 'denormalised clocks match their entry'],
  ['v_hold_drift', 'the memo book equals the fold over card events'],
  ['v_hold_release_drift', 'a released hold withholds nothing'],
  ['v_book_not_zero', 'the whole book nets to zero, per entity and book'],
  ['v_refused_auth_hold', 'no hold withholds money against an authorisation the network refused'],
].map(([view, claim]) => ({ view: view ?? '', claim: claim ?? '', rows: 0, error: null }));

function emptyView(): ChaosView {
  return {
    source: 'fixture',
    asOf: DEMO_NOW,
    chaos: {
      on: false,
      controls: CONTROLS,
      allClearAt: null,
      secondsUntilAllClear: 0,
      expired: [],
    },
    invariants: INVARIANTS,
    invariantsHold: true,
    invariantsUnreadable: 0,
    inbox: { pending: 0, parked: 0, dead: 0, done: 0 },
    parked: [],
    trialBalanceCents: '0',
    position: null,
    latestRun: null,
    timeline: [],
  };
}

export function createFixtureChaosSource(state: DemoState): ChaosDataSource {
  return {
    async load(): Promise<Result<ChaosView, ErrorShape>> {
      if (state === 'loading') {
        await new Promise((resolve) => setTimeout(resolve, DEMO_LOADING_MS));
        return ok(emptyView());
      }

      if (state === 'error') {
        return fail(
          'CHAOS_READ_FAILED',
          'The chaos switches, the webhook inbox and the invariant views could not be read: ' +
            'connection terminated unexpectedly. No control was armed and no delivery was released ' +
            '— this is a read, and a read cannot arm a switch.',
        );
      }

      // `empty` is also the honest fallback when there is no database at all.
      return ok(emptyView());
    },
  };
}
