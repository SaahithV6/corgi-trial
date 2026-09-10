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
 * The first one carries more weight here than anywhere else in the console.
 * This is the screen somebody stares at while wondering whether a failed load
 * means a statement got half-issued. It cannot: the load path holds no
 * capability to write, and issuing a document is one transaction that either
 * wrote a `statement` row or wrote nothing — `corgi_app` has `INSERT` and no
 * `UPDATE`, so there is not even a shape for a partially-issued document to
 * take. Retrying is safe, and the panel says why rather than asking for trust.
 */
export function StatementsErrorPanel({ error }: { readonly error: ErrorShape }) {
  return (
    <section
      aria-labelledby="statements-error-title"
      className="rounded-lg border border-negative/40 bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <h2
          id="statements-error-title"
          className="text-sm font-semibold tracking-tight text-negative"
        >
          The statement could not be loaded
        </h2>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          This is a read failure. No money moved, no document was issued and no
          day was closed — rendering a statement is a query, and the published
          rows it reads are append-only. There is no half-issued statement to
          unpick either: a publish is a single transaction, and the application
          role holds <code>INSERT</code> and no <code>UPDATE</code>.
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
            href="/statements"
            className={`rounded px-2 py-1.5 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
          >
            Leave the error state
          </Link>
        </div>
      </div>
    </section>
  );
}
