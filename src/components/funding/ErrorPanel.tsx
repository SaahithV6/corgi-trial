import Link from "next/link";

import { RetryButton } from "@/components/ui/RetryButton";
import { FOCUS_RING } from "@/components/ui/primitives";
import type { ErrorShape } from "@/lib/result";

/**
 * The error state.
 *
 * Says the one thing the person in front of it needs before anything else:
 * NOTHING WAS FUNDED. This screen posts real money to the ledger, so the first
 * question a failure provokes is "did that just book a deposit?", and it has to
 * be answered in the first sentence rather than inferred from an error code.
 *
 * The answer is structural, not reassurance: the failure is in the READ that
 * draws the screen — balances, holds and the availability policy — and a SELECT
 * cannot post an entry. Funding is an explicit action somebody presses.
 *
 * The form is not rendered underneath. A form drawn from balances that could
 * not be read would be offering to fund an account whose position nobody has
 * checked, and quoting a hold period it made up.
 */
export function ErrorPanel({ error }: { readonly error: ErrorShape }) {
  return (
    <section
      aria-labelledby="funding-error-title"
      className="rounded-lg border border-negative/40 bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <h2
          id="funding-error-title"
          className="text-sm font-semibold tracking-tight text-negative"
        >
          The funding screen could not be drawn
        </h2>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          No deposit was booked, no hold was opened and no Plaid Item was created. This is a
          failure of the preflight READ — the balances, the holds and the{" "}
          <code className="font-mono">funds_availability_policy</code> table — and a read cannot
          post a journal entry. Retrying is safe.
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
            href="/funding"
            className={`rounded px-2 py-1.5 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
          >
            Leave the error state
          </Link>
        </div>
      </div>
    </section>
  );
}
