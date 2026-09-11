import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";

import {
  DEMO_STATES,
  DEMO_STATE_HINTS,
  DEMO_STATE_LABELS,
  demoQuery,
  isLiveState,
  type FundingView,
} from "./demo-state";

/**
 * Live switch between the screen's five states.
 *
 * Dashed and muted on purpose — it is scaffolding, and scaffolding that looks
 * like a feature is a lie. Every entry is a plain link to the same route with a
 * different query string, so each state has a URL that reproduces it. Switching
 * between them writes nothing and moves no money: the two live states read the
 * ledger and the policy table, and the other three read nothing at all.
 *
 * EVERY LINK CARRIES `?business=` FORWARD. A state bar that dropped it would
 * send somebody who had selected a customer, pressed `edge` to look at their
 * uncleared hold, and pressed `default` to come back, to a different customer's
 * balances under the same heading.
 */
export function DemoStateBar({ view }: { readonly view: FundingView }) {
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
                href={`/funding${demoQuery({ state, businessId: view.businessId })}`}
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
        {DEMO_STATE_HINTS[view.state]}
        {isLiveState(view.state)
          ? " This state calls Plaid and posts to the live ledger when you press the button: five real HTTP requests to sandbox.plaid.com, one financial entry and one memo entry through postEntry(), in one transaction."
          : " This state cannot fund anything — there is no live account behind it, and the button says so rather than pretending."}
      </p>
    </aside>
  );
}
