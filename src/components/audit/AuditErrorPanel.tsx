import { Note, Panel } from "@/components/ui/primitives";
import { isRetryable } from "@/components/ui/error-detail";
import { RetryButton } from "@/components/ui/RetryButton";
import type { ErrorShape } from "@/lib/result";

/**
 * The error state.
 *
 * It says the one thing a reader of an audit screen needs to hear first:
 * NOTHING MOVED. This screen only reads, so a failed read cannot have changed
 * the book — and unlike a half-written audit log, a projection that fails
 * leaves no partial row behind to be reconciled later. That is a genuine
 * property of the read-only design and it is worth stating on the failure
 * path, where it is load-bearing.
 *
 * `title` and `description` default to the failed-read wording and are
 * overridden for the cause that is not a failed read — no database configured
 * at all. Both refuse identically: no business, no action, no completeness.
 * The screen used to answer that cause with the FIXTURE instead, which drew a
 * named business and a reconciliation count on a deployment that had read
 * nothing; see `./unreadable.ts`.
 *
 * TWO THINGS CHANGED HERE. It takes an `ErrorShape` rather than a bare string,
 * so the code is on the panel and a reader has something to quote; and the
 * retry control is dropped when the failure says it is not retryable. It used
 * to offer "Retry the read" on every failure this screen can have, which put a
 * button next to the words "Retryable no" on the one failure retrying cannot
 * clear. A refresh does not configure a database.
 */
export function AuditErrorPanel({
  error,
  title = "The trail could not be read",
  description = "A read failed. The book is unchanged.",
}: {
  readonly error: ErrorShape;
  readonly title?: string;
  readonly description?: string;
}) {
  const retryable = isRetryable(error);

  return (
    <Panel
      title={title}
      description={description}
      actions={retryable ? <RetryButton label="Retry the read" /> : null}
    >
      <div className="space-y-3 px-5 py-4">
        <Note emphasis title="Nothing moved">
          This screen issues SELECTs and nothing else — it owns no rows and writes none — so a
          failure here cannot have left a partial record behind.{" "}
          {retryable
            ? "Retrying re-issues exactly the same queries."
            : "No retry is offered here because re-issuing exactly the same queries would fail in exactly the same way."}
        </Note>

        <dl className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Code</dt>
          <dd className="font-mono text-xs">{error.code}</dd>

          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Message</dt>
          <dd className="max-w-prose text-sm">{error.message}</dd>

          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Retryable</dt>
          <dd className="font-mono text-xs">{retryable ? "yes" : "no"}</dd>
        </dl>
      </div>
    </Panel>
  );
}
