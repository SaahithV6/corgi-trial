import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";

import {
  DEMO_STATES,
  DEMO_STATE_HINTS,
  DEMO_STATE_LABELS,
  demoQuery,
  type ApprovalsView,
} from "./demo-state";

/**
 * Live switch between the screen's five states.
 *
 * Dashed and muted on purpose — it is scaffolding, and scaffolding that looks
 * like a feature is a lie. Every entry is a plain link to the same route with a
 * different query string, so each state has a URL that reproduces it and only
 * `default` touches the database.
 */
export function DemoStateBar({ view }: { readonly view: ApprovalsView }) {
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
            const current = state === view.state;
            return (
              <Link
                key={state}
                href={`/approvals${demoQuery(state)}`}
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
        {view.state === "edge"
          ? "The row at the top was raised by whoever you are currently acting as. Approve is disabled with the reason stated — flip the role switcher and it stays disabled, because the reason is who raised it, not which role you hold."
          : DEMO_STATE_HINTS[view.state]}
      </p>
    </aside>
  );
}
