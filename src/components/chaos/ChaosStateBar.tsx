import Link from 'next/link';

import { FOCUS_RING } from '@/components/ui/primitives';

import {
  DEMO_STATES,
  DEMO_STATE_HINTS,
  DEMO_STATE_LABELS,
  demoQuery,
  isLiveState,
  type ChaosViewState,
} from './view-state';

export function ChaosStateBar({ view }: { readonly view: ChaosViewState }) {
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
      </div>

      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        {DEMO_STATE_HINTS[view.state]}
        {isLiveState(view.state)
          ? ' The controls on this state are armed against the live book.'
          : ' Nothing on this state is a statement about a real book, and the controls are disabled.'}
      </p>
    </aside>
  );
}
