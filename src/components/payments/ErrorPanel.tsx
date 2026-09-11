import Link from "next/link";

import { isRetryable } from "@/components/ui/error-detail";
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
 *
 * `title` and `description` default to the failed-read wording and are
 * overridden for the cause that is not a failed read — no database configured
 * at all. Both refuse identically: no account, no gate verdict, no threshold.
 * The difference worth wording separately is what the reader is being told:
 * a failed read means the book was there and could not be fetched; no database
 * means there is no book on this deployment, and the form will not come back
 * on a refresh.
 *
 * THE ESCAPE LINK IS DROPPED when `offerExit` is false. "Leave the error state"
 * is a way out of `?state=error`, which is a demo state with a URL to leave.
 * There is no leaving a deployment with no database: the link points at this
 * same screen, which would answer identically, so it is a control whose action
 * cannot work and it is not drawn.
 *
 * TWO THINGS CHANGED HERE. There is a `Retryable` row, read off the failure
 * rather than assumed; and the retry control is dropped when the failure says
 * it is not retryable. This panel used to hardcode "Retrying is safe." and draw
 * the button on every failure this screen can have, which put a retry beside
 * the one failure retrying cannot clear. A refresh does not configure a
 * database.
 */
export function ErrorPanel({
  error,
  title = "The payment form could not be drawn",
  description = "No instruction was raised and no money moved. This is a failure of the preflight READ — the account list, the KYB gate and the threshold policy — and a read cannot queue a payment. Raising one is an explicit INSERT this application performs on submit, and none was attempted.",
  offerExit = true,
}: {
  readonly error: ErrorShape;
  readonly title?: string;
  readonly description?: string;
  readonly offerExit?: boolean;
}) {
  const retryable = isRetryable(error);

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
          {title}
        </h2>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          {description}{" "}
          {retryable
            ? "Retrying is safe: it re-issues the same SELECTs and writes nothing."
            : "No retry is offered, because re-issuing the same read would fail in exactly the same way."}
        </p>
      </div>

      <div className="px-5 py-4">
        <dl className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Code</dt>
          <dd className="font-mono text-xs">{error.code}</dd>
          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Message</dt>
          <dd className="max-w-prose text-sm">{error.message}</dd>
          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Retryable</dt>
          <dd className="font-mono text-xs">{retryable ? "yes" : "no"}</dd>
        </dl>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {retryable ? <RetryButton /> : null}
          {offerExit ? (
            <Link
              href="/payments"
              className={`rounded px-2 py-1.5 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
            >
              Leave the error state
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}
