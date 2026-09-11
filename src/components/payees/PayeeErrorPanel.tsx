import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";
import { isRetryable } from "@/components/ui/error-detail";
import { RetryButton } from "@/components/ui/RetryButton";
import type { ErrorShape } from "@/lib/result";

/**
 * The error state.
 *
 * Says the thing somebody staring at this page actually needs to know first:
 * NOTHING WAS CHECKED AND NOTHING WAS WRITTEN, so no payee is now in a
 * half-verified state and no payment was let through on the strength of a
 * check that did not finish.
 *
 * That claim is structural rather than careful coding. Rendering this page
 * never runs a check — running one is an operator action with an actor
 * attached and a row at the end of it — and a check that fails mid-flight
 * writes nothing, because the payee and its first verification are one
 * transaction. Retrying is safe and is the intended recovery.
 *
 * The second thing it says is the one that matters for money: the payment
 * gate does not depend on this screen. If the payee book is unreadable, an
 * impossible routing number is still refused by arithmetic in
 * `requestPayment()`, and by a CHECK constraint under that.
 *
 * `title`, `description` and `note` default to the failed-read wording and are
 * overridden for the cause that is not a failed read — no database configured
 * at all. Both refuse identically: no payee, no tile, no refusal row. See
 * `./unreadable.ts` for why this screen had no answer to that cause whatever.
 *
 * THE RETRY CONTROL IS DROPPED WHEN THE FAILURE SAYS IT IS NOT RETRYABLE, and
 * the `Retryable` row is what makes that legible. This panel used to print the
 * code and the message, offer `Retry` on every failure this screen can have,
 * and never say whether trying again could work. A button offering to re-run a
 * read that cannot succeed teaches an operator to keep pressing it; a refresh
 * does not configure a database.
 */
export function PayeeErrorPanel({
  error,
  title = "The payee book could not be loaded",
  description = "This is a read failure. No check ran, no payee was written and no warning was signed for — rendering this page never checks anything, and a check is one transaction that either writes a payee with its first verification or writes neither. Retrying is safe.",
  note = "Payments are not waiting on this screen. The check digit is arithmetic and runs inside the payment transaction with no database read and no provider call, and an impossible routing number cannot be stored as a payee in the first place — that is a CHECK constraint, not a service that can be down.",
}: {
  readonly error: ErrorShape;
  readonly title?: string;
  readonly description?: string;
  readonly note?: string;
}) {
  return (
    <section
      aria-labelledby="payee-error-title"
      className="rounded-lg border border-negative/40 bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <h2 id="payee-error-title" className="text-sm font-semibold tracking-tight text-negative">
          {title}
        </h2>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{description}</p>
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

        <p className="mt-5 max-w-prose text-xs leading-relaxed text-muted">{note}</p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {isRetryable(error) ? <RetryButton /> : null}
          <Link
            href="/payees"
            className={`rounded px-2 py-1.5 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
          >
            Leave the error state
          </Link>
        </div>
      </div>
    </section>
  );
}
