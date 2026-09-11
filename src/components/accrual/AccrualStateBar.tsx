import Link from "next/link";

import { Badge, FOCUS_RING } from "@/components/ui/primitives";

import {
  DEMO_STATES,
  DEMO_STATE_HINTS,
  DEMO_STATE_LABELS,
  accrualQuery,
  type AccrualFilter,
} from "./view-state";

/**
 * Live switch between the screen's five states.
 *
 * Styled as scaffolding — dashed, muted, obviously not part of the product —
 * because it is a demo control, and a demo control that looks like a feature is
 * a lie. Each entry is a plain link to the same route with a different query
 * string.
 *
 * `default` is the only state that reads the database. The other four are
 * fixtures even when a database is configured, so they can be shown in order in
 * front of a panel without running the tick — and an accrual tick is the one
 * job on this console that posts money with no human in between, so a screen
 * that could trigger one by being looked at would be indefensible.
 *
 * ONE SCREEN, ONE CLAIM ABOUT ITS DATA SOURCE. `noDatabase` comes from
 * `page.tsx`, which resolved it once with `hasDatabase()` and used the same
 * value to choose the source `AccrualView` reads through. On the `default`
 * state — the only live one — it replaces the hint rather than sitting beside
 * it: the default hint reads "from the database", and left standing over a
 * screen that opened no connection it is a second claim that disagrees with the
 * first.
 */
const NO_DATABASE_NOTE =
  "No database is configured for this deployment. No schedule was listed, no day was read and no invariant view was counted — an empty day table here is not a tick with nothing to do, and a drift count of nought is a view nobody queried.";

export function AccrualStateBar({
  filter,
  noDatabase = false,
}: {
  readonly filter: AccrualFilter;
  readonly noDatabase?: boolean;
}) {
  // `default` is the only state that reads the database, so it is the only one
  // that has nothing to show without one.
  const refusing = noDatabase && filter.state === "default";

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
                // The schedule filter and the drill-through are dropped when
                // switching: a filter carried into the empty state would
                // explain the emptiness with the wrong reason.
                href={`/accruals${accrualQuery({ state })}`}
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

        {refusing ? <Badge tone="negative">NO DATABASE</Badge> : null}
      </div>

      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        {refusing ? NO_DATABASE_NOTE : DEMO_STATE_HINTS[filter.state]}
      </p>
    </aside>
  );
}
