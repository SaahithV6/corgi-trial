import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";
import { isRetryable } from "@/components/ui/error-detail";
import { RetryButton } from "@/components/ui/RetryButton";
import type { ErrorShape } from "@/lib/result";

/**
 * The error state.
 *
 * Says three things, in the order an operator needs them: nothing moved, here
 * is the machine-readable code, here is a retry.
 *
 * The first one is the one that matters and it is stronger here than on the
 * account screen. Reconciliation is the screen somebody stares at while
 * wondering whether the nightly job half-ran. So the panel states the two
 * facts that settle it: the query is read-only, and a run is one transaction
 * that either wrote a `recon_run` row or wrote nothing. There is no partial
 * run to clean up, because there is no way to express one.
 *
 * `title` and `description` default to the failed-read wording and are
 * overridden for the cause that is not a failed read — no database configured
 * at all. Both refuse identically: no run, no break list, no age histogram.
 * The screen used to answer that cause with the `default` FIXTURE instead,
 * which drew last night's file on a deployment that had read nothing; see
 * `./unreadable.ts`.
 *
 * The retry control is dropped when the failure says it is not retryable. A
 * button offering to re-run a read that cannot succeed sits next to the words
 * "retryable: no" and contradicts them, and a refresh does not configure a
 * database.
 */
export function ReconErrorPanel({
  error,
  title = "Breaks could not be loaded",
  description = "This is a read failure. No money moved, no posting was written and no match was recorded — the ledger is append-only and a query cannot alter it. A reconciliation run is a single transaction, so there is no half-finished run to unpick either: retrying is safe.",
}: {
  readonly error: ErrorShape;
  readonly title?: string;
  readonly description?: string;
}) {
  return (
    <section
      aria-labelledby="recon-error-title"
      className="rounded-lg border border-negative/40 bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <h2
          id="recon-error-title"
          className="text-sm font-semibold tracking-tight text-negative"
        >
          {title}
        </h2>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          {description}
        </p>
      </div>

      <div className="px-5 py-4">
        <dl className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Code</dt>
          <dd className="font-mono text-xs">{error.code}</dd>

          <dt className="text-xs uppercase tracking-[0.08em] text-muted">
            Message
          </dt>
          <dd className="max-w-prose text-sm">{error.message}</dd>

          <dt className="text-xs uppercase tracking-[0.08em] text-muted">
            Retryable
          </dt>
          <dd className="font-mono text-xs">{isRetryable(error) ? "yes" : "no"}</dd>
        </dl>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {isRetryable(error) ? <RetryButton /> : null}
          <Link
            href="/reconciliation"
            className={`rounded px-2 py-1.5 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
          >
            Leave the error state
          </Link>
        </div>
      </div>
    </section>
  );
}
