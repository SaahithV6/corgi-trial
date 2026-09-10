import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";
import { RetryButton } from "@/components/ui/RetryButton";
import type { ErrorShape } from "@/lib/result";

/**
 * The error state.
 *
 * Says three things, in the order an operator needs them: nothing fired, here
 * is the machine-readable code, here is a retry.
 *
 * The first is the one that matters and it is stronger here than on a read-only
 * screen. This is the page somebody stares at while wondering whether the
 * nightly tick half-ran and whether the rent went out twice. So the panel
 * states the two facts that settle it. This screen never fires anything — the
 * firing routine is a cron and an authenticated POST, never a render. And a
 * failed tick cannot have half-fired: each occurrence is one transaction, and
 * the payment it raises carries an idempotency key derived from the standing
 * order and the scheduled date, which is UNIQUE in the database. Re-running is
 * not just safe, it is the intended recovery.
 */
export function StandingErrorPanel({ error }: { readonly error: ErrorShape }) {
  return (
    <section
      aria-labelledby="standing-error-title"
      className="rounded-lg border border-negative/40 bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <h2
          id="standing-error-title"
          className="text-sm font-semibold tracking-tight text-negative"
        >
          The schedule could not be loaded
        </h2>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          This is a read failure. Nothing fired, no payment was raised and no
          occurrence was claimed — rendering this page never fires a standing
          order, and a firing tick is one transaction per occurrence. Even a
          tick that died mid-flight cannot pay twice: the instruction it raises
          is keyed on the standing order and the scheduled date, and that key is
          UNIQUE. Retrying is safe.
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
            href="/standing-orders"
            className={`rounded px-2 py-1.5 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
          >
            Leave the error state
          </Link>
        </div>
      </div>
    </section>
  );
}
