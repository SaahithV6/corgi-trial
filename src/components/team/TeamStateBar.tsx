import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";

import {
  DEMO_STATES,
  DEMO_STATE_HINTS,
  DEMO_STATE_LABELS,
  teamQuery,
  type TeamFilter,
} from "./view-state";

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
 */
export function TeamStateBar({ filter }: { readonly filter: TeamFilter }) {
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
