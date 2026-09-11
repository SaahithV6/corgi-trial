import Link from 'next/link';

import { Badge, FOCUS_RING } from '@/components/ui/primitives';

import {
  DEMO_STATES,
  DEMO_STATE_HINTS,
  DEMO_STATE_LABELS,
  demoQuery,
  isLiveState,
  type ChaosViewState,
} from './view-state';

/**
 * What the bar says when there is nothing to read.
 *
 * It replaces the state hint rather than sitting beside it. The `default` hint
 * reads "read from the live book" and the `edge` hint describes four controls
 * armed against it; over a screen that opened no connection, either is a second
 * claim that disagrees with the first.
 */
const NO_DATABASE_NOTE =
  'No database is configured for this deployment. No control was read, no delivery was listed and no invariant view was queried — this screen cannot say whether chaos is armed, and no control on it can be pressed.';

/**
 * ONE SCREEN, ONE CLAIM ABOUT ITS DATA SOURCE. `noDatabase` comes from
 * `page.tsx`, which resolved it once with `hasDatabase()` and used the same
 * value to choose the source `ChaosView` reads through. When it is set on a
 * live state, this bar carries the screen's only source badge — the dashboard
 * below it is a refusal and badges nothing.
 */
export function ChaosStateBar({
  view,
  noDatabase = false,
}: {
  readonly view: ChaosViewState;
  readonly noDatabase?: boolean;
}) {
  const refusing = noDatabase && isLiveState(view.state);

  return (
    <aside
      aria-label="Demo states"
      className="rounded-lg border border-dashed border-border-strong px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Demo state
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {DEMO_STATES.map((state) => {
            const current = state === view.state;
            return (
              <Link
                key={state}
                href={`/chaos${demoQuery(state)}`}
                aria-current={current ? 'page' : undefined}
                title={DEMO_STATE_HINTS[state]}
                className={`rounded px-2 py-1 text-xs ${FOCUS_RING} ${
                  current
                    ? 'bg-surface-raised font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]'
                    : 'text-muted hover:text-text'
                }`}
              >
                {DEMO_STATE_LABELS[state]}
              </Link>
            );
          })}
        </div>

        {refusing ? <Badge tone="negative">NO DATABASE</Badge> : null}
      </div>

      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        {refusing ? (
          NO_DATABASE_NOTE
        ) : (
          <>
            {DEMO_STATE_HINTS[view.state]}
            {isLiveState(view.state)
              ? ' The controls on this state are armed against the live book.'
              : ' Nothing on this state is a statement about a real book, and the controls are disabled.'}
          </>
        )}
      </p>
    </aside>
  );
}
