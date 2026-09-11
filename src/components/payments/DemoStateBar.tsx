import Link from "next/link";

import { Badge, FOCUS_RING } from "@/components/ui/primitives";

import {
  DEMO_STATES,
  DEMO_STATE_HINTS,
  DEMO_STATE_LABELS,
  demoQuery,
  isLiveState,
  type PaymentsView,
  type SourceClaim,
} from "./demo-state";

/**
 * What the bar says when there is nothing to read.
 *
 * One sentence, used in two places — the line under the links, and the tooltip
 * on each of the two states that would otherwise have read the database. The
 * tooltips matter as much as the line: `default` promised "the live account
 * list and the live policy table" and `edge` promised a $2,500.00 payment
 * against a business verified on simulated evidence, and leaving either
 * hoverable over a screen whose badge says NO DATABASE is a second claim, made
 * quietly, to whoever hovers. One screen, one claim about its data source,
 * including the claims a reader has to hover to find.
 */
const NO_DATABASE_HINT =
  "No database is configured for this deployment. The account list, the KYB gate and the threshold policy were not read, so no form is drawn below and no account, verdict or threshold on this screen is a statement about this book.";

/**
 * Live switch between the screen's five states.
 *
 * Dashed and muted on purpose — it is scaffolding, and scaffolding that looks
 * like a feature is a lie. Every entry is a plain link to the same route with a
 * different query string, so each state has a URL that reproduces it. Switching
 * between them writes nothing: the two live states read the account list and
 * the policy table, and the other three read nothing at all.
 *
 * ONE SCREEN, ONE CLAIM ABOUT ITS DATA SOURCE. `claim` comes from `page.tsx`,
 * which resolved it once with `sourceClaim()` and handed the same value to
 * `PaymentsView`. When it reads NO DATABASE this bar carries the screen's only
 * source badge — the board below is a refusal and badges nothing — the two live
 * hints are replaced, and the note that says a live state "submits for real" is
 * replaced too, because on this deployment it does not.
 */
export function DemoStateBar({
  view,
  claim = "LIVE",
}: {
  readonly view: PaymentsView;
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
                href={`/payments${demoQuery(state)}`}
                aria-current={current ? "page" : undefined}
                title={
                  refusing && isLiveState(state)
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
        {refusing ? (
          <>
            {NO_DATABASE_HINT} There is no submit control below, because there is
            nothing to submit against.
          </>
        ) : (
          <>
            {DEMO_STATE_HINTS[view.state]}
            {isLiveState(view.state)
              ? " This state submits for real: the form raises a payment_instruction row and a 'requested' event, and nothing else."
              : " This state cannot submit — there is no live account list behind it, and the button says so rather than pretending."}
          </>
        )}
      </p>
    </aside>
  );
}
