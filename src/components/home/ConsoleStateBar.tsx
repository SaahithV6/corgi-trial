import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";

import {
  CONSOLE_STATES,
  CONSOLE_STATE_HINTS,
  CONSOLE_STATE_LABELS,
  consoleQuery,
  type ConsoleState,
} from "./console-state";

/**
 * Live switch between the console's five states.
 *
 * Dashed and muted on purpose — it is scaffolding, and scaffolding that looks
 * like a feature is a lie. Every entry is a plain link to `/` with a different
 * query string, so each state has a URL that reproduces it and only `default`
 * touches the database.
 */
export function ConsoleStateBar({ state }: { readonly state: ConsoleState }) {
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
          {CONSOLE_STATES.map((candidate) => {
            const current = candidate === state;
            return (
              <Link
                key={candidate}
                href={`/${consoleQuery(candidate)}`}
                aria-current={current ? "page" : undefined}
                title={CONSOLE_STATE_HINTS[candidate]}
                className={`rounded px-2 py-1 text-xs ${FOCUS_RING} ${
                  current
                    ? "bg-surface-raised font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
                    : "text-muted hover:text-text"
                }`}
              >
                {CONSOLE_STATE_LABELS[candidate]}
              </Link>
            );
          })}
        </div>
      </div>

      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        {CONSOLE_STATE_HINTS[state]}
      </p>
    </aside>
  );
}
