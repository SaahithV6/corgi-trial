import Link from "next/link";

import { Badge, FOCUS_RING } from "@/components/ui/primitives";

import {
  DEMO_STATES,
  DEMO_STATE_HINTS,
  DEMO_STATE_LABELS,
  payeeQuery,
  type PayeeFilter,
} from "./view-state";

/**
 * What the state bar says when there is nothing to read.
 *
 * One sentence, used in two places — the line under the links, and the tooltip
 * on the one state that would otherwise have read the database. The tooltip
 * mattered: it carried the `default` hint, which promises "the live payee book
 * and every check recorded against it", and left that promise hoverable on a
 * screen whose badge says NO DATABASE. One screen, one claim, includes the
 * claims a reader has to hover to find.
 */
const NO_DATABASE_HINT =
  "No database is configured for this deployment. No payee was read, no check was found and no book is drawn below — the absence of a warning on this screen is not a statement that there is none.";

/**
 * Live switch between the screen's five states.
 *
 * Styled as scaffolding — dashed, muted, obviously not part of the product —
 * because it is a demo control, and a demo control that looks like a feature
 * is a lie.
 *
 * `default` is the only state that reads the database. The other four are
 * fixtures even when a database is configured, so they can be shown in order
 * in front of a panel without running a check or writing a row — and so the
 * state where a real refusal has to be found is unambiguously the live one.
 *
 * ONE SCREEN, ONE CLAIM ABOUT ITS DATA SOURCE. This bar used to carry no
 * source badge at all, which was survivable only while the board below it
 * always drew one. It does not: with no database the board is a refusal and
 * badges nothing, so the screen would have made no claim whatever about what
 * it had read. `noDatabase` comes from `page.tsx`, which resolved it once with
 * `hasDatabase()` and handed the same value to `PayeeBookView`, and when it is
 * set this bar carries the screen's only source badge — and the `default`
 * hint, which promises the live book, is replaced rather than left standing
 * over a screen that read nothing.
 */
export function PayeeStateBar({
  filter,
  noDatabase = false,
}: {
  readonly filter: PayeeFilter;
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
          {DEMO_STATES.map((state) => {
            const current = state === filter.state;
            return (
              <Link
                key={state}
                // The payee drill-through is dropped when switching: a
                // selection carried into the empty state would explain the
                // emptiness with the wrong reason.
                href={`/payees${payeeQuery({ state })}`}
                aria-current={current ? "page" : undefined}
                title={noDatabase && state === "default" ? NO_DATABASE_HINT : DEMO_STATE_HINTS[state]}
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
        {refusing ? NO_DATABASE_HINT : DEMO_STATE_HINTS[filter.state]}
      </p>
    </aside>
  );
}
