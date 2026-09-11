import Link from "next/link";

import { Badge, FOCUS_RING } from "@/components/ui/primitives";

import {
  DEMO_STATES,
  DEMO_STATE_HINTS,
  DEMO_STATE_LABELS,
  demoQuery,
  type ApprovalsView,
  type SourceClaim,
} from "./demo-state";

/**
 * What the bar says when there is nothing to read.
 *
 * One sentence, used in two places — the line under the links, and the tooltip
 * on the state that would otherwise have read the database. The tooltip matters
 * as much as the line: it carried the `default` hint, "The real pending queue,
 * read from the live database", and leaving that hoverable over a screen whose
 * badge says NO DATABASE is a second claim, made quietly, to whoever hovers.
 * One screen, one claim about its data source, including the claims a reader
 * has to hover to find.
 */
const NO_DATABASE_HINT =
  "No database is configured for this deployment. The pending queue was not read, no payment is listed below, and the absence of a payment here is not a statement that none is waiting on a checker.";

/**
 * Live switch between the screen's five states.
 *
 * Dashed and muted on purpose — it is scaffolding, and scaffolding that looks
 * like a feature is a lie. Every entry is a plain link to the same route with a
 * different query string, so each state has a URL that reproduces it and only
 * `default` touches the database.
 *
 * ONE SCREEN, ONE CLAIM ABOUT ITS DATA SOURCE. `claim` comes from `page.tsx`,
 * which resolved it once with `sourceClaim()` and handed the same value to
 * `ApprovalsView`. When it reads NO DATABASE this bar carries the screen's only
 * source badge — the board below is a refusal and badges nothing — and the
 * `default` hint is replaced rather than left standing over a queue nobody
 * read.
 */
export function DemoStateBar({
  view,
  claim = "LIVE",
}: {
  readonly view: ApprovalsView;
  readonly claim?: SourceClaim;
}) {
  const refusing = claim === "NO DATABASE";

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
                title={
                  refusing && state === "default"
                    ? NO_DATABASE_HINT
                    : DEMO_STATE_HINTS[state]
                }
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

        {refusing ? <Badge tone="negative">NO DATABASE</Badge> : null}
      </div>

      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        {refusing
          ? NO_DATABASE_HINT
          : view.state === "edge"
            ? "The row at the top was raised by whoever you are currently acting as. Approve is disabled with the reason stated — flip the role switcher and it stays disabled, because the reason is who raised it, not which role you hold."
            : DEMO_STATE_HINTS[view.state]}
      </p>
    </aside>
  );
}
