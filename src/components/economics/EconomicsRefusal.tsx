import { Note, Panel } from "@/components/ui/primitives";
import { isRetryable } from "@/components/ui/error-detail";
import { RetryButton } from "@/components/ui/RetryButton";
import type { ErrorShape } from "@/lib/result";

/**
 * The one thing this screen draws when it has no figures.
 *
 * IT IMPORTS NOTHING FROM `@/lib/interchange/**`, AND THAT IS THE ENTIRE
 * REASON IT IS ITS OWN FILE. `EconomicsView.tsx` imports `portfolioTotals` and
 * `formatBps` from `@/lib/interchange/screen` as values, and that module
 * reaches `@/lib/ledger/db` -> `@/lib/env`, which throws `EnvironmentError` at
 * module scope with no `APP_DATABASE_URL`. A refusal panel that lived inside
 * `EconomicsView.tsx` could not be rendered in the one case it exists for — the
 * same trap `src/lib/has-database.ts` was carved out of, one layer up.
 *
 * So `page.tsx` renders this INSTEAD of loading that module, and
 * `EconomicsView` renders this same component for a read that failed for any
 * other reason. Two causes, one panel, differing in their code and their
 * words: nothing here draws a figure, a rate band or a guard, whichever of the
 * two brought it up.
 *
 * The retry control is dropped when the failure says it is not retryable. This
 * screen used to offer a bare `Retry` link with no code beside it and no
 * statement of whether trying again could change the answer; a refresh does not
 * configure a database.
 */
export function EconomicsRefusal({
  error,
  title,
  description,
}: {
  readonly error: ErrorShape;
  readonly title: string;
  readonly description: string;
}) {
  const retryable = isRetryable(error);

  return (
    <Panel title={title} description={description}>
      <div className="space-y-4 px-5 py-5">
        <Note emphasis title="Nothing moved">
          This page only reads. Every figure it shows is derived from journal lines at query
          time, so there is no cached total to have gone stale and nothing to repair.{" "}
          {retryable
            ? "The read can simply be tried again."
            : "No retry is offered here because re-issuing the same query would fail in the same way."}
        </Note>

        <dl className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Code</dt>
          <dd className="font-mono text-xs">{error.code}</dd>

          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Message</dt>
          <dd className="max-w-prose text-sm">{error.message}</dd>

          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Retryable</dt>
          <dd className="font-mono text-xs">{retryable ? "yes" : "no"}</dd>
        </dl>

        {retryable ? <RetryButton /> : null}
      </div>
    </Panel>
  );
}
