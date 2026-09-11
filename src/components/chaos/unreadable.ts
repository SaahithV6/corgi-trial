/**
 * The source `/chaos` uses on a deployment with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a book. This is a refusal to draw one, and this
 * screen is the one where the distinction was already written down and then not
 * honoured. `./view-state.ts` says it in its own header: the entire claim this
 * screen renders is "these invariants held against the live book while that
 * ran", and a fixture cannot make it. `page.tsx` nevertheless answered "there
 * is no database" with `createFixtureChaosSource("empty")`.
 *
 * WHAT THE EMPTY FIXTURE CLAIMED. Two things, and both are the answer to a
 * question somebody opens this screen to settle.
 *
 *   CHAOS OFF, no control armed. That is the line a reader checks before
 *   believing a demo, and before walking away from a console. "No control is
 *   armed" from a deployment that opened no connection is not knowledge that
 *   nothing is armed; it is the absence of knowledge, printed in the shape of
 *   knowledge. The four expiry clocks are the same: a countdown nobody read is
 *   not a countdown at zero.
 *
 *   THE INVARIANT PANEL, fifteen views at nought rows and the badge reading
 *   that they hold. `InvariantPanel` is deliberate about this in the other
 *   direction — it renders an UNREADABLE view as a failure and never as a pass,
 *   because "a guard that reports healthy when it cannot see is the exact
 *   pattern this repository keeps finding in its own guards". Fifteen guards
 *   reporting healthy off a fixture, on a machine with no database, is that
 *   pattern one level up.
 *
 * It never actually reached that fallback. The guard destructured
 * `hasDatabase` off `await import("./live-source")`, and that module opens with
 * `import { sql } from "@/lib/ledger/db"`, which reaches `@/lib/env` and throws
 * `EnvironmentError` at module scope without `APP_DATABASE_URL`. The import on
 * the line above only succeeds when a database IS configured; the predicate on
 * the line below returns false only when one is not. Measured with the variable
 * deleted, the render threw and the operator got the framework's error page.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database, and the chaos error panel drops the retry control when a failure
 * says so.
 */

import { fail } from '@/lib/result';
import type { ErrorShape, Result } from '@/lib/result';

import type { ChaosDataSource, ChaosView } from './data-contract';

export const CHAOS_STATE_UNREADABLE: ErrorShape = {
  code: 'CHAOS_STATE_UNREADABLE',
  message:
    'No database is configured for this deployment, so no control was read, no delivery was listed and no invariant view was queried. Nothing on this screen is a statement about whether chaos is armed. CHAOS OFF here is not four switches somebody checked, and fifteen invariants at nought rows is not fifteen guards that held — it is fifteen views nobody opened.',
  details: {
    retryable: false,
    source: 'chaos.live-source',
    operation: 'the chaos dashboard',
  },
};

/**
 * A source that reads nothing and says so.
 *
 * It is a `ChaosDataSource` rather than a branch in the page so the refusal
 * arrives through the same channel as every other failure: one component
 * renders the dashboard, one component renders the refusal, and there is no
 * second path on which this screen could be drawn from nothing. The controls go
 * with it — they are rendered by the dashboard, and a switch that arms the live
 * book must not be offered by a screen that cannot see the live book.
 */
export function createUnreadableChaosSource(
  error: ErrorShape = CHAOS_STATE_UNREADABLE,
): ChaosDataSource {
  return {
    load(): Promise<Result<ChaosView, ErrorShape>> {
      return Promise.resolve(fail(error.code, error.message, error.details));
    },
  };
}
