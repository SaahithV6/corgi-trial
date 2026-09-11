import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";
import { RetryButton } from "@/components/ui/RetryButton";
import type { ErrorShape } from "@/lib/result";

/**
 * The error state.
 *
 * Says three things, in the order an operator needs them: nothing accrued, here
 * is the machine-readable code, here is a retry.
 *
 * The first is the one that matters, and it is stronger here than on a
 * read-only screen, because this is the page somebody stares at while wondering
 * whether last night's tick half-ran and whether a customer has been billed
 * twice. So the panel states the two facts that settle it. Rendering this page
 * never accrues anything — the tick is a cron and an authenticated POST. And a
 * failed tick cannot have half-posted: each day is one transaction, and the
 * entry it posts carries an idempotency key derived from the schedule and the
 * accrual date, which is UNIQUE in `journal_entry`. Re-running is not just safe,
 * it is the intended recovery.
 */
export function AccrualErrorPanel({ error }: { readonly error: ErrorShape }) {
  return (
    <section
      aria-labelledby="accrual-error-title"
      className="rounded-lg border border-negative/40 bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <h2 id="accrual-error-title" className="text-sm font-semibold tracking-tight text-negative">
          The accrual ledger could not be loaded
        </h2>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          This is a read failure. Nothing accrued, no entry was posted and no day
          was claimed — rendering this page never runs the tick, and a tick is
          one transaction per day. Even one that died mid-flight cannot bill
          twice: the entry it posts is keyed on the schedule and the accrual
          date, and that key is UNIQUE. Retrying is safe.
        </p>
      </div>

      <div className="px-5 py-4">
        <dl className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Code</dt>
          <dd className="font-mono text-xs">{error.code}</dd>

          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Message</dt>
          <dd className="max-w-prose text-sm">{error.message}</dd>
        </dl>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <RetryButton />
          <Link
            href="/accruals"
            className={`rounded px-2 py-1.5 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
          >
            Leave the error state
          </Link>
        </div>
      </div>
    </section>
  );
}
