import Link from "next/link";

import { Badge, FOCUS_RING } from "@/components/ui/primitives";

import {
  DEMO_STATES,
  DEMO_STATE_HINTS,
  DEMO_STATE_LABELS,
  teamQuery,
  type TeamFilter,
} from "./view-state";

/** The three states that read the database. The other two draw a fixture. */
const LIVE_STATES = new Set(["default", "edge", "loading"]);

/**
 * What the state bar says when there is nothing to read.
 *
 * One sentence, used in two places — the line under the links, and the tooltip
 * on each of the three states that would otherwise have read the database. The
 * tooltips mattered: they promise live people, live cards and "live rows, not a
 * fixture", and left those promises hoverable on a screen whose badge says NO
 * DATABASE. One screen, one claim, includes the claims a reader has to hover to
 * find.
 */
const NO_DATABASE_HINT =
  "No database is configured for this deployment. Nobody was read, no card was listed and no invariant was counted — an empty team on this screen is not a business nobody has been added to.";

/**
 * Live switch between the screen's five states.
 *
 * Styled as scaffolding — dashed, muted, obviously not part of the product —
 * because it is a demo control, and a demo control that looks like a feature is
 * a lie.
 *
 * `default` and `edge` both read the database; `edge` is a FILTER over the same
 * rows rather than a second query, so the two can never disagree. `loading`
 * slows the real read. `empty` and `error` are fixtures and print FIXTURE on
 * their own face.
 *
 * The customer is carried across a state switch, because here the customer is
 * the subject of the screen and landing on somebody else's team when you
 * clicked "edge" would answer a question nobody asked. The expanded member is
 * NOT carried, because a member who is the point of one state is usually not
 * the point of the next.
 *
 * ONE SCREEN, ONE CLAIM ABOUT ITS DATA SOURCE. This bar used to carry no source
 * badge at all, which was survivable only while the board below it always drew
 * one. It does not: with no database the board is a refusal and badges nothing,
 * so the screen would have made no claim whatever about what it had read.
 * `noDatabase` comes from `page.tsx`, which resolved it once with
 * `hasDatabase()` and handed the same value to `TeamBody`, and when it is set
 * on one of the three live states this bar carries the screen's only source
 * badge.
 */
export function TeamStateBar({
  filter,
  noDatabase = false,
}: {
  readonly filter: TeamFilter;
  readonly noDatabase?: boolean;
}) {
  const refusing = noDatabase && LIVE_STATES.has(filter.state);

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
                href={`/team${teamQuery({ state, businessId: filter.businessId })}`}
                aria-current={current ? "page" : undefined}
                title={noDatabase && LIVE_STATES.has(state) ? NO_DATABASE_HINT : DEMO_STATE_HINTS[state]}
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
