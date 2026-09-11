import Link from "next/link";

import { isRetryable } from "@/components/ui/error-detail";
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
 *
 * `title` and `description` default to the failed-read wording and are
 * overridden for the cause that is not a failed read — no database configured
 * at all. Both refuse identically: no payment, no policy version, no decision
 * button. The difference worth wording separately is what the reader is being
 * reassured about. A failed read means the queue was there and could not be
 * fetched; no database means nobody has looked, and "nothing was decided" is
 * not the sentence that settles that.
 *
 * THE ESCAPE LINK IS DROPPED TOO when `offerExit` is false. "Leave the error
 * state" is a way out of `?state=error`, which is a demo state with a URL to
 * leave. There is no leaving a deployment with no database: the link points at
 * this same screen, which would answer identically, so it is a control whose
 * action cannot work and it is not drawn.
 *
 * TWO THINGS CHANGED HERE. There is a `Retryable` row, read off the failure
 * rather than assumed; and the retry control is dropped when the failure says
 * it is not retryable. This panel used to hardcode "Retrying is safe." and draw
 * the button on every failure, which on the one failure a retry cannot clear
 * put a button next to a row nobody could read, because there was no row. A
 * refresh does not configure a database.
 */
export function ErrorPanel({
  error,
  title = "The approvals queue could not be read",
  description = "Nothing was approved, rejected or released. This is a read failure, and a read cannot change a payment: every lifecycle event is an INSERT that the application performs explicitly, and none was attempted.",
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
      aria-labelledby="approvals-error-title"
      className="rounded-lg border border-negative/40 bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <h2
          id="approvals-error-title"
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
              href="/approvals"
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
