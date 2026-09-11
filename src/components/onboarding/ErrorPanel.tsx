import Link from "next/link";

import { RetryButton } from "@/components/ui/RetryButton";
import { isRetryable } from "@/components/ui/error-detail";
import { Badge, FOCUS_RING } from "@/components/ui/primitives";
import type { ErrorShape } from "@/lib/result";

import { ONBOARDING_STATE_UNREADABLE } from "./unreadable";

/**
 * The error state.
 *
 * Answers the frightening question first, the way the approvals error panel
 * does: nobody was verified and nobody was un-verified. A read failure on this
 * screen cannot change a KYB state, and the reason is structural rather than
 * reassuring — `kyb_verification_leg` is append-only, `corgi_app` holds no
 * UPDATE or DELETE on it, and a status that changes is a new row rather than an
 * edit. There is nothing here for a failed SELECT to damage.
 *
 * TWO CAUSES, ONE PANEL, DIFFERENT WORDS. A read that failed and a deployment
 * with no database configured both arrive here, and both refuse identically —
 * no business, no leg, no verdict. They differ in their code, in the sentence
 * under the heading, and in whether a retry is offered. The retry control is
 * dropped when the failure says it is not retryable: a button offering to
 * re-run a read that cannot succeed sits next to the words "retryable: no" and
 * contradicts them, and a refresh does not configure a database.
 */
export function ErrorPanel({ error }: { readonly error: ErrorShape }) {
  const retryable = isRetryable(error);
  const noDatabase = error.code === ONBOARDING_STATE_UNREADABLE.code;

  return (
    <section
      aria-labelledby="onboarding-error-title"
      className="rounded-lg border border-negative/40 bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2
            id="onboarding-error-title"
            className="text-sm font-semibold tracking-tight text-negative"
          >
            {noDatabase
              ? "The verification state was not read"
              : "The verification state could not be read"}
          </h2>
          {noDatabase ? <Badge tone="negative">NO DATABASE</Badge> : null}
        </div>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          {noDatabase
            ? "No verification was started, changed or withdrawn — and none was read either. No business was listed, no leg was fetched and no composite state was derived, so no card is drawn: a verdict this screen did not read is not a verdict, and an empty list is not a queue somebody has cleared."
            : "No verification was started, changed or withdrawn. This is a read, and the evidence table it reads is append-only — the application role holds SELECT and INSERT on it and nothing else, so there is no statement a failed page load could have issued. Retrying is safe."}
        </p>
        <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
          While this screen is down the gate is not: <code className="font-mono">canTransact()</code>{" "}
          reads the same view on every payment path and fails closed, so an unreadable state denies
          rather than allows.
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
          <Link
            href="/onboarding"
            className={`rounded px-2 py-1.5 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
          >
            Leave the error state
          </Link>
        </div>
      </div>
    </section>
  );
}
