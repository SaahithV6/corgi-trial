import Link from "next/link";

import { Badge, FOCUS_RING } from "@/components/ui/primitives";

import {
  EXPLAIN_STATES,
  EXPLAIN_STATE_HINTS,
  EXPLAIN_STATE_LABELS,
  explainQuery,
  type ExplainFilter,
} from "./explain-view-state";

/**
 * What the state bar says when there is nothing to read.
 *
 * One sentence, used in two places — the line under the links, and the tooltip
 * on the state that would otherwise have read the ledger. The tooltip matters:
 * the `default` hint reads "Live from the ledger", and leaving that hoverable
 * over a screen badged NO DATABASE is a second claim about the data source. One
 * screen, one claim, includes the claims a reader has to hover to find.
 */
const NO_DATABASE_HINT =
  "No database is configured for this deployment. No settlement file was read, no journal entry was fetched and no correction is classified below — the absence of a break on this screen is not a statement that there is none.";

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
 *
 * ONE SCREEN, ONE CLAIM ABOUT ITS DATA SOURCE. `noDatabase` comes from
 * `page.tsx`, which resolved it once with `hasDatabase()` and handed the same
 * value to `ExplainedBreaksView`. When it is set, this bar carries the screen's
 * only source badge — the board below it is a refusal and badges nothing — and
 * the `default` hint is replaced rather than left standing over a screen that
 * read nothing.
 */
export function ExplainStateBar({
  filter,
  noDatabase = false,
}: {
  readonly filter: ExplainFilter;
  readonly noDatabase?: boolean;
}) {
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
                title={
                  noDatabase && state === "default"
                    ? NO_DATABASE_HINT
                    : EXPLAIN_STATE_HINTS[state]
                }
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

        {refusing ? <Badge tone="negative">NO DATABASE</Badge> : null}
      </div>

      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        {refusing ? NO_DATABASE_HINT : EXPLAIN_STATE_HINTS[filter.state]}
      </p>
    </aside>
  );
}
