import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";
import { isRetryable } from "@/components/ui/error-detail";
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
 *
 * `title` and `description` default to the failed-read wording and are
 * overridden for the cause that is not a failed read — no database configured
 * at all. Both refuse identically: no mandate, no occurrence, no invariant
 * tile. The screen used to answer that cause with the `default` FIXTURE
 * instead, which printed `unresolved: 0` and `doubleFires: 0` on a deployment
 * that had counted nothing; see `./unreadable.ts`.
 *
 * The retry control is dropped when the failure says it is not retryable. A
 * button offering to re-run a read that cannot succeed sits next to the words
 * "retryable: no" and contradicts them, and a refresh does not configure a
 * database.
 */
export function StandingErrorPanel({
  error,
  title = "The schedule could not be loaded",
  description = "This is a read failure. Nothing fired, no payment was raised and no occurrence was claimed — rendering this page never fires a standing order, and a firing tick is one transaction per occurrence. Even a tick that died mid-flight cannot pay twice: the instruction it raises is keyed on the standing order and the scheduled date, and that key is UNIQUE. Retrying is safe.",
}: {
  readonly error: ErrorShape;
  readonly title?: string;
  readonly description?: string;
}) {
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
