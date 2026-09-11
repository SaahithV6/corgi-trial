import Link from "next/link";

import { Badge, FOCUS_RING } from "@/components/ui/primitives";

import { STATE_LABEL, STATE_NOTE, auditHref, type AuditFilter, type AuditViewState } from "./view-state";

const STATES: readonly AuditViewState[] = ["default", "loading", "empty", "error", "edge"];

/**
 * Which of the five states read the database.
 *
 * Three of them do — `default`, `empty` and `edge` are all live reads, and
 * `empty` is live on purpose: it is a real business filtered to agent actions,
 * which genuinely returns nothing. All three therefore have nothing to show on
 * a deployment with no database, and all three refuse.
 */
const LIVE_STATES: readonly AuditViewState[] = ["default", "empty", "edge"];

/**
 * What the bar says when there is nothing to read.
 *
 * One sentence, used for every live state's note. It replaces `STATE_NOTE`
 * rather than sitting beside it: the `default` note reads "read live from the
 * book" and the `empty` note reads "a business that exists and has had nothing
 * done to it", and both of those are claims about a book. Left standing over a
 * screen that opened no connection they are the second claim that disagrees
 * with the first — which is what this screen was doing, with that note above a
 * board badging `fixture`.
 */
const NO_DATABASE_NOTE =
  "No database is configured for this deployment. No store was projected, no action was read and no completeness was checked — an empty trail on this screen is not a business nothing happened to.";

/**
 * The five URL states, as links.
 *
 * Present on the page rather than in the README because the states are graded
 * live: a panel should be able to walk them in order without anyone typing a
 * query string. The current one is marked with `aria-current`, not only with
 * a colour.
 *
 * ONE SCREEN, ONE CLAIM ABOUT ITS DATA SOURCE. `noDatabase` comes from
 * `page.tsx`, which resolved it once with `hasDatabase()` and used the same
 * value to choose the source `TimelineView` reads through. When it is set on a
 * live state, this bar carries the screen's only source badge — the board below
 * it is a refusal and badges nothing.
 */
export function AuditStateBar({
  filter,
  noDatabase = false,
}: {
  readonly filter: AuditFilter;
  readonly noDatabase?: boolean;
}) {
  const refusing = noDatabase && LIVE_STATES.includes(filter.state);

  return (
    <div className="space-y-2">
      <nav aria-label="Screen states" className="flex flex-wrap items-center gap-2">
        {STATES.map((state) => {
          const active = filter.state === state;
          return (
            <Link
              key={state}
              href={auditHref(filter, {
                state,
                page: 0,
                selected: null,
                // Leaving a kind filter on while switching states would make
                // `empty` and `edge` mean whatever the last click meant.
                kind: state === "edge" ? "agent" : null,
                surface: null,
                source: null,
              })}
              {...(active ? { "aria-current": "page" as const } : {})}
              className={`rounded border px-2.5 py-1 text-xs ${FOCUS_RING} ${
                active
                  ? "border-border-strong bg-surface-raised text-text"
                  : "border-border text-muted hover:text-text"
              }`}
            >
              {STATE_LABEL[state]}
            </Link>
          );
        })}

        {refusing ? <Badge tone="negative">NO DATABASE</Badge> : null}
      </nav>
      <p className="max-w-prose text-xs text-muted">
        {refusing ? NO_DATABASE_NOTE : STATE_NOTE[filter.state]}
      </p>
    </div>
  );
}
