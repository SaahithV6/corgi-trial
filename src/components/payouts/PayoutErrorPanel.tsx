import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";
import { RetryButton } from "@/components/ui/RetryButton";
import type { ErrorShape } from "@/lib/result";

/**
 * The error state.
 *
 * It says the thing somebody staring at this page needs to know first: NO
 * QUOTE WAS RAISED, NOTHING WAS COMMITTED AND NOTHING WAS WRITTEN. There is no
 * half-made offer and no customer who now believes a rate we do not hold.
 *
 * That claim is structural rather than careful coding. Rendering this page
 * raises nothing — raising a quote is an operator action with an actor
 * attached and two append-only rows at the end of it — and those two rows are
 * one transaction, so a failure mid-flight writes neither. Retrying is safe
 * and is the intended recovery.
 *
 * The second thing it says is the one that matters for money, and it is the
 * opposite of what the payee screen says in the same place. THE PAYOUT GATE
 * FAILS CLOSED. If the quote book is unreadable, `requireAcceptedQuote()` does
 * not wave payouts through on the grounds that it could not check — it refuses
 * them. An outage here stops cross-border payouts, which somebody notices;
 * failing open would send unpriced money into another currency, which nobody
 * notices until the customer does.
 */
export function PayoutErrorPanel({ error }: { readonly error: ErrorShape }) {
  return (
    <section
      aria-labelledby="payout-error-title"
      className="rounded-lg border border-negative/40 bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <h2 id="payout-error-title" className="text-sm font-semibold tracking-tight text-negative">
          The quote book could not be loaded
        </h2>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          This is a read failure. No rate was fetched, no quote was raised and nothing was
          accepted — rendering this page commits nothing, and raising a quote is one transaction
          that writes both the rate observation and the offer or writes neither. Retrying is safe.
        </p>
      </div>

      <div className="px-5 py-4">
        <dl className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Code</dt>
          <dd className="font-mono text-xs">{error.code}</dd>

          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Message</dt>
          <dd className="max-w-prose text-sm">{error.message}</dd>
        </dl>

        <p className="mt-5 max-w-prose text-xs leading-relaxed text-muted">
          Cross-border payouts are stopped while this is down, and that is deliberate. The gate in
          front of them answers from this same database, and an unknown answer is a refusal there,
          not a pass — a payout that cannot prove the customer agreed a price does not leave.
          Domestic payments and card settlement are unaffected: they do not consult this book at
          all.
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <RetryButton />
          <Link
            href="/payouts"
            className={`rounded px-2 py-1.5 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
          >
            Leave the error state
          </Link>
        </div>
      </div>
    </section>
  );
}
