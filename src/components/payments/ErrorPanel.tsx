import Link from "next/link";

import { RetryButton } from "@/components/ui/RetryButton";
import { FOCUS_RING } from "@/components/ui/primitives";
import type { ErrorShape } from "@/lib/result";

/**
 * The error state.
 *
 * Says the one thing the person in front of it needs before anything else:
 * NOTHING WAS RAISED. On a screen whose whole purpose is to originate money
 * movement, the first question a failure provokes is "did I just queue
 * something?", and that has to be answered in the first sentence rather than
 * inferred from an error code.
 *
 * The form is not rendered underneath. A form drawn from an account list and a
 * policy table that could not be read would be offering choices nobody has
 * checked — and the one thing worse than refusing to draw a payment form is
 * drawing one that quotes a threshold it made up.
 */
export function ErrorPanel({ error }: { readonly error: ErrorShape }) {
  return (
    <section
      aria-labelledby="payments-error-title"
      className="rounded-lg border border-negative/40 bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <h2
          id="payments-error-title"
          className="text-sm font-semibold tracking-tight text-negative"
        >
          The payment form could not be drawn
        </h2>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          No instruction was raised and no money moved. This is a failure of the preflight READ —
          the account list, the KYB gate and the threshold policy — and a read cannot queue a
          payment. Raising one is an explicit INSERT this application performs on submit, and none
          was attempted. Retrying is safe.
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
            href="/payments"
            className={`rounded px-2 py-1.5 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
          >
            Leave the error state
          </Link>
        </div>
      </div>
    </section>
  );
}
