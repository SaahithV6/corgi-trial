import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";

import {
  EXPLAIN_STATES,
  EXPLAIN_STATE_HINTS,
  EXPLAIN_STATE_LABELS,
  explainQuery,
  type ExplainFilter,
} from "./explain-view-state";

/**
 * Live switch between `/breaks`'s five states.
 *
 * Styled as scaffolding — dashed, muted, obviously not part of the product —
 * because it is a demo control, and a demo control that looks like a feature
 * is a lie.
 *
 * A near-copy of `ReconStateBar` rather than a shared one with a base-path
 * prop: that component's links are hard-coded to `/reconciliation` and four
 * other components depend on it, so parameterising it would have edited a
 * screen this branch does not own in order to add one it does. The duplication
 * is eleven lines and the blast radius is zero.
 *
 * `default` is the only state that reads the database. The other four are
 * fixtures even when a database is configured, so the state the planted break
 * has to be found in is unambiguously the live one.
 */
export function ExplainStateBar({ filter }: { readonly filter: ExplainFilter }) {
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
          {EXPLAIN_STATES.map((state) => {
            const current = state === filter.state;
            return (
              <Link
                key={state}
                // Filters and the drill-through are dropped when switching: a
                // filter carried into the empty state would explain the
                // emptiness with the wrong reason.
                href={`/breaks${explainQuery({ state })}`}
                aria-current={current ? "page" : undefined}
                title={EXPLAIN_STATE_HINTS[state]}
                className={`rounded px-2 py-1 text-xs ${FOCUS_RING} ${
                  current
                    ? "bg-surface-raised font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
                    : "text-muted hover:text-text"
                }`}
              >
                {EXPLAIN_STATE_LABELS[state]}
              </Link>
            );
          })}
        </div>
      </div>

      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        {EXPLAIN_STATE_HINTS[filter.state]}
      </p>
    </aside>
  );
}
