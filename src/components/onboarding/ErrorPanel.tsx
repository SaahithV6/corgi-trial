import Link from "next/link";

import { RetryButton } from "@/components/ui/RetryButton";
import { FOCUS_RING } from "@/components/ui/primitives";
import type { ErrorShape } from "@/lib/result";

/**
 * The error state.
 *
 * Answers the frightening question first, the way the approvals error panel
 * does: nobody was verified and nobody was un-verified. A read failure on this
 * screen cannot change a KYB state, and the reason is structural rather than
 * reassuring — `kyb_verification_leg` is append-only, `corgi_app` holds no
 * UPDATE or DELETE on it, and a status that changes is a new row rather than an
 * edit. There is nothing here for a failed SELECT to damage.
 */
export function ErrorPanel({ error }: { readonly error: ErrorShape }) {
  return (
    <section
      aria-labelledby="onboarding-error-title"
      className="rounded-lg border border-negative/40 bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <h2
          id="onboarding-error-title"
          className="text-sm font-semibold tracking-tight text-negative"
        >
          The verification state could not be read
        </h2>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          No verification was started, changed or withdrawn. This is a read, and the evidence table
          it reads is append-only — the application role holds SELECT and INSERT on it and nothing
          else, so there is no statement a failed page load could have issued. Retrying is safe.
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
        </dl>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <RetryButton />
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
