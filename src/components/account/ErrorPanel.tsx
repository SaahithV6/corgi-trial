import Link from "next/link";

import type { ErrorShape } from "@/lib/result";
import { RetryButton } from "@/components/ui/RetryButton";
import { FOCUS_RING } from "@/components/ui/primitives";

import { demoQuery } from "./demo-state";

/**
 * The error state.
 *
 * Says three things, in this order, because that is the order an operator
 * needs them: nothing moved, here is the machine-readable code, here is a
 * retry. A balance that failed to load is a read failure and it is safe to
 * retry — but the screen states that explicitly rather than leaving the
 * operator to wonder whether a payment went out.
 */
export function ErrorPanel({
  error,
  accountId,
}: {
  readonly error: ErrorShape;
  readonly accountId: string;
}) {
  return (
    <section
      aria-labelledby="account-error-title"
      className="rounded-lg border border-negative/40 bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <h2
          id="account-error-title"
          className="text-sm font-semibold tracking-tight text-negative"
        >
          Balances could not be loaded
        </h2>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          This is a read failure. No money moved, no posting was written, and no
          hold changed — the ledger is append-only and a query cannot alter it.
          Retrying is safe.
        </p>
      </div>

      <div className="px-5 py-4">
        <dl className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Code</dt>
          <dd className="font-mono text-xs">{error.code}</dd>

          <dt className="text-xs uppercase tracking-[0.08em] text-muted">
            Message
          </dt>
          <dd className="max-w-prose text-sm">{error.message}</dd>
        </dl>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <RetryButton />
          <Link
            href={`/accounts/${accountId}${demoQuery({ state: "default" })}`}
            className={`rounded px-2 py-1.5 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
          >
            Leave the error state
          </Link>
        </div>
      </div>
    </section>
  );
}
