import Link from "next/link";

import { RetryButton } from "@/components/ui/RetryButton";
import { FOCUS_RING } from "@/components/ui/primitives";
import type { ErrorShape } from "@/lib/result";

/**
 * The error state.
 *
 * Says the one thing an approver needs before anything else: NOTHING WAS
 * DECIDED. A failure on a screen that approves money is frightening in a way a
 * failure on a balance screen is not, and the first line has to answer "did I
 * just approve something?" rather than make someone infer it from a code.
 */
export function ErrorPanel({ error }: { readonly error: ErrorShape }) {
  return (
    <section
      aria-labelledby="approvals-error-title"
      className="rounded-lg border border-negative/40 bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <h2
          id="approvals-error-title"
          className="text-sm font-semibold tracking-tight text-negative"
        >
          The approvals queue could not be read
        </h2>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          Nothing was approved, rejected or released. This is a read failure, and a read cannot
          change a payment: every lifecycle event is an INSERT that the application performs
          explicitly, and none was attempted. Retrying is safe.
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
            href="/approvals"
            className={`rounded px-2 py-1.5 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
          >
            Leave the error state
          </Link>
        </div>
      </div>
    </section>
  );
}
