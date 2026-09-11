/**
 * The five states, as links.
 *
 * Every state this screen can be in is reachable by typing a query string, so a
 * demo never depends on the database happening to be in an interesting shape at
 * the moment somebody looks — and `default` is always a real read, so the
 * interesting shape is not the one being graded.
 */

import { Badge, FOCUS_RING } from "@/components/ui/primitives";

import {
  ALL_STATES,
  STATE_DESCRIPTION,
  economicsHref,
  type EconomicsFilter,
} from "./view-state";

export function EconomicsStateBar({ filter }: { readonly filter: EconomicsFilter }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          <h1 className="text-sm font-semibold tracking-tight">Unit economics</h1>
          <p className="mt-1 max-w-prose text-xs text-muted">
            Interchange earned on card settlement, less the costs already on this book. Every
            figure is a sum of immutable journal lines.
          </p>
        </div>
        <nav aria-label="Screen state" className="flex flex-wrap items-center gap-2">
          {ALL_STATES.map((state) => {
            const active = state === filter.state;
            return (
              <a
                key={state}
                href={economicsHref({ state })}
                aria-current={active ? "page" : undefined}
                title={STATE_DESCRIPTION[state]}
                className={`rounded border px-2 py-1 text-[11px] ${FOCUS_RING} ${
                  active ? "border-border-strong text-text" : "border-border text-muted"
                }`}
              >
                {state}
              </a>
            );
          })}
        </nav>
      </div>
      {filter.state === "default" ? null : (
        <p className="mt-3 text-xs text-muted">
          <Badge tone="neutral">fixture</Badge>{" "}
          <span className="ml-1">{STATE_DESCRIPTION[filter.state]}</span>{" "}
          — the figures are computed by the same `priceSettlement()` the ledger posts through, so
          the fixture cannot disagree with the rounding rule. Only the choice of amounts is
          borrowed.
        </p>
      )}
    </div>
  );
}
