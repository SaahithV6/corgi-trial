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
 * The first one carries more weight here than anywhere else in the console.
 * This is the screen somebody stares at while wondering whether a failed load
 * means a statement got half-issued. It cannot: the load path holds no
 * capability to write, and issuing a document is one transaction that either
 * wrote a `statement` row or wrote nothing — `corgi_app` has `INSERT` and no
 * `UPDATE`, so there is not even a shape for a partially-issued document to
 * take. Retrying is safe, and the panel says why rather than asking for trust.
 *
 * `title` and `description` default to the failed-read wording and are
 * overridden for the cause that is not a failed read — no database configured
 * at all. Both refuse identically: no reading, no document, no hash. The
 * screen used to answer that cause with the `default` FIXTURE instead, which
 * drew a complete statement — a named business, a closing balance read twice,
 * a day close, a version history and the words HASH REPRODUCED — on a
 * deployment that had opened no connection; see `./unreadable.ts`.
 *
 * The retry control is dropped when the failure says it is not retryable. A
 * button offering to re-run a read that cannot succeed sits next to the words
 * "retryable: no" and contradicts them, and a refresh does not configure a
 * database.
 */
export function StatementsErrorPanel({
  error,
  title = "The statement could not be loaded",
  description = "This is a read failure. No money moved, no document was issued and no day was closed — rendering a statement is a query, and the published rows it reads are append-only. There is no half-issued statement to unpick either: a publish is a single transaction, and the application role holds INSERT and no UPDATE.",
}: {
  readonly error: ErrorShape;
  readonly title?: string;
  readonly description?: string;
}) {
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

          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Message</dt>
          <dd className="max-w-prose text-sm">{error.message}</dd>

          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Retryable</dt>
          <dd className="font-mono text-xs">{isRetryable(error) ? "yes" : "no"}</dd>
        </dl>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {isRetryable(error) ? <RetryButton /> : null}
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
