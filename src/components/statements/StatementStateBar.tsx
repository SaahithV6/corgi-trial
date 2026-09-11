import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";

import {
  DEMO_STATES,
  DEMO_STATE_HINTS,
  DEMO_STATE_LABELS,
  statementQuery,
  type StatementFilter,
} from "./view-state";

/**
 * Live switch between the screen's five states.
 *
 * Styled as scaffolding — dashed, muted, obviously not part of the product —
 * because it is a demo control, and a demo control that looks like a feature
 * is a lie. Each entry is a plain link to the same route with a different
 * query string.
 *
 * `default` and `edge` read the database. `edge` is live on purpose: the edge
 * state IS the corrected day, and a corrected day rendered from typed-in
 * numbers would be the one thing on this screen worth nothing — so it resolves
 * to the most recent value date this book actually reversed and re-booked, and
 * falls back to the fixture only when there is no database or no correction to
 * find. `loading`, `empty` and `error` stay fixtures even when a database is
 * configured, so they can be shown in order in front of a panel without
 * closing a day or issuing a document — both of which are permanent, because
 * `book_day` and `statement` are append-only. There is no undo.
 */
export function StatementStateBar({ filter }: { readonly filter: StatementFilter }) {
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
            const current = state === filter.state;
            return (
              <Link
                key={state}
                // The account, day and version are dropped when switching: a
                // day carried into the empty state would explain the emptiness
                // with the wrong reason.
                href={`/statements${statementQuery({ state })}`}
                aria-current={current ? "page" : undefined}
                title={DEMO_STATE_HINTS[state]}
                className={`rounded px-2 py-1 text-xs ${FOCUS_RING} ${
                  current
                    ? "bg-surface-raised font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
                    : "text-muted hover:text-text"
                }`}
              >
                {DEMO_STATE_LABELS[state]}
              </Link>
            );
          })}
        </div>
      </div>

      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        {DEMO_STATE_HINTS[filter.state]}
      </p>
    </aside>
  );
}
