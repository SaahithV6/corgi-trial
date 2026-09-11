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

/**
 * What the bar says when there is nothing to read.
 *
 * `default` is the only state that reads the database, so it is the only one
 * this replaces. It matters that it replaces the tooltip too: `STATE_DESCRIPTION`
 * for `default` promises a live read, and leaving that hoverable over a screen
 * badged NO DATABASE is a second claim about the data source that a reader has
 * to hover to find.
 */
const NO_DATABASE_NOTE =
  "No database is configured for this deployment. No settlement was priced, no rate card was resolved and no guard was counted below — a page with no figures on it here is not a programme that has yet to earn any.";

/**
 * ONE SCREEN, ONE CLAIM ABOUT ITS DATA SOURCE. `noDatabase` comes from
 * `page.tsx`, which resolved it once with `hasDatabase()` and used the same
 * value to decide whether to load the board at all. When it is set, this bar
 * carries the screen's only source badge.
 *
 * It used to carry NONE in that case: the `fixture` badge below renders only
 * when the state is not `default`, so on the no-database path the screen made
 * no claim about where its numbers came from while asserting that no card had
 * ever settled.
 */
export function EconomicsStateBar({
  filter,
  noDatabase = false,
}: {
  readonly filter: EconomicsFilter;
  readonly noDatabase?: boolean;
}) {
  const refusing = noDatabase && filter.state === "default";

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
                title={
                  noDatabase && state === "default"
                    ? NO_DATABASE_NOTE
                    : STATE_DESCRIPTION[state]
                }
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
      {refusing ? (
        <p className="mt-3 text-xs text-muted">
          <Badge tone="negative">NO DATABASE</Badge>{" "}
          <span className="ml-1">{NO_DATABASE_NOTE}</span>
        </p>
      ) : filter.state === "default" ? null : (
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
