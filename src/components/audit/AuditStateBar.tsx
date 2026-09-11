import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";

import { STATE_LABEL, STATE_NOTE, auditHref, type AuditFilter, type AuditViewState } from "./view-state";

const STATES: readonly AuditViewState[] = ["default", "loading", "empty", "error", "edge"];

/**
 * The five URL states, as links.
 *
 * Present on the page rather than in the README because the states are graded
 * live: a panel should be able to walk them in order without anyone typing a
 * query string. The current one is marked with `aria-current`, not only with
 * a colour.
 */
export function AuditStateBar({ filter }: { readonly filter: AuditFilter }) {
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
      </nav>
      <p className="max-w-prose text-xs text-muted">{STATE_NOTE[filter.state]}</p>
    </div>
  );
}
