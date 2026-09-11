import Link from "next/link";
import type { Route } from "next";

import { Badge, FOCUS_RING } from "@/components/ui/primitives";

import {
  DEMO_STATES,
  DEMO_STATE_HINTS,
  DEMO_STATE_LABELS,
  dashboardQuery,
  isLiveState,
  type DashboardViewState,
} from "./view-state";

/**
 * The five URL states, as links.
 *
 * The LIVE/FIXTURE badge sits on the state bar as well as on the board itself,
 * because a cropped screenshot has to carry it. On this screen that matters
 * more than on any other in the build: the claim being made is "nothing new is
 * wrong with the ledger".
 */
export function DashboardStateBar({ view }: { readonly view: DashboardViewState }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          URL state
        </span>
        {DEMO_STATES.map((state) => {
          const current = state === view.state;
          return (
            <Link
              key={state}
              href={`/dashboard${dashboardQuery(state)}` as Route}
              aria-current={current ? "page" : undefined}
              className={`rounded border px-2 py-1 text-xs ${
                current
                  ? "border-border-strong font-medium"
                  : "border-border text-muted hover:text-text"
              } ${FOCUS_RING}`}
            >
              {DEMO_STATE_LABELS[state]}
            </Link>
          );
        })}
        <Badge tone={isLiveState(view.state) ? "positive" : "negative"}>
          {isLiveState(view.state) ? "LIVE" : "FIXTURE"}
        </Badge>
      </div>
      <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
        {DEMO_STATE_HINTS[view.state]}
      </p>
    </div>
  );
}
