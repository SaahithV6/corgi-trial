import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";
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
 */
export function ReconErrorPanel({ error }: { readonly error: ErrorShape }) {
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
          Breaks could not be loaded
        </h2>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          This is a read failure. No money moved, no posting was written and no
          match was recorded — the ledger is append-only and a query cannot
          alter it. A reconciliation run is a single transaction, so there is no
          half-finished run to unpick either: retrying is safe.
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
        </dl>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <RetryButton />
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
