import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";

import {
  DEMO_STATES,
  DEMO_STATE_HINTS,
  DEMO_STATE_LABELS,
  demoQuery,
  type DemoView,
} from "./demo-state";

/**
 * Live switch between the screen's five states.
 *
 * Deliberately styled as scaffolding — dashed, muted, obviously not part of
 * the product — because it is a demo control, and a demo control that looks
 * like a feature is a lie. Each entry is a plain link to the same route with a
 * different query string, so every state has a URL that reproduces it and none
 * of them touch the database.
 */
export function DemoStateBar({
  accountId,
  view,
}: {
  readonly accountId: string;
  readonly view: DemoView;
}) {
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
                href={`/accounts/${accountId}${demoQuery({ state })}`}
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

        {view.state === "default" ? (
          <Link
            href={`/accounts/${accountId}${demoQuery({
              state: "default",
              authPending: !view.authPending,
            })}`}
            className={`ml-auto rounded border border-border-strong px-2.5 py-1 text-xs hover:bg-surface-raised ${FOCUS_RING}`}
          >
            {view.authPending
              ? "Reverse the $50.00 fuel-pump authorisation"
              : "Land a $50.00 fuel-pump authorisation"}
          </Link>
        ) : null}
      </div>

      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        {view.state === "default" && !view.authPending
          ? "Land the authorisation and watch the available balance drop by $50.00 while the ledger balance does not move a cent. Nothing is written: the state lives in the query string."
          : DEMO_STATE_HINTS[view.state]}
      </p>
    </aside>
  );
}
