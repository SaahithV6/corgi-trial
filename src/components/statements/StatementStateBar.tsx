import Link from "next/link";

import { Badge, FOCUS_RING } from "@/components/ui/primitives";

import {
  DEMO_STATES,
  DEMO_STATE_HINTS,
  DEMO_STATE_LABELS,
  statementQuery,
  type StatementFilter,
} from "./view-state";

/**
 * What the state bar says when there is nothing to read.
 *
 * One sentence, used in two places — the line under the links, and the
 * tooltip on every state that would otherwise have read the database. The
 * tooltip mattered: it carried the `default` hint, which promises live rows,
 * and left that promise hoverable on a screen whose badge says NO DATABASE.
 * One screen, one claim, includes the claims a reader has to hover to find.
 */
const NO_DATABASE_HINT =
  "No database is configured for this deployment. No value date was read, neither reading was derived and no hash was recomputed — nothing below was reproduced from anything, and no document is drawn in its place.";

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
 *
 * ONE SCREEN, ONE CLAIM ABOUT ITS DATA SOURCE. `noDatabase` comes from
 * `page.tsx`, which resolved it once with `hasDatabase()` and handed the same
 * value to `StatementsView`. When it is set, this bar carries the screen's only
 * source badge — the document below it is a refusal and badges nothing — and
 * the hint, which promises "Live from the ledger", is replaced rather than left
 * standing over a screen that read nothing.
 */
export function StatementStateBar({
  filter,
  noDatabase = false,
}: {
  readonly filter: StatementFilter;
  readonly noDatabase?: boolean;
}) {
  const refusing =
    noDatabase && (filter.state === "default" || filter.state === "edge");

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
                title={noDatabase && (state === "default" || state === "edge") ? NO_DATABASE_HINT : DEMO_STATE_HINTS[state]}
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
        {refusing
          ? NO_DATABASE_HINT
          : DEMO_STATE_HINTS[filter.state]}
      </p>
    </aside>
  );
}
