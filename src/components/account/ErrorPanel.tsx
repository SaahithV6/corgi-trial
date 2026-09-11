import Link from "next/link";

import type { ErrorShape } from "@/lib/result";
import { isRetryable } from "@/components/ui/error-detail";
import { RetryButton } from "@/components/ui/RetryButton";
import { FOCUS_RING } from "@/components/ui/primitives";

import { demoQuery } from "./demo-state";

/**
 * The error state.
 *
 * Says four things, in this order, because that is the order an operator needs
 * them: nothing moved, here is the machine-readable code, here is whether
 * trying again can help, and — only when it can — here is a retry.
 *
 * THE FOURTH ONE USED TO BE A LIE ON TWO OF THIS SCREEN'S FAILURES. The panel
 * printed "Retrying is safe." and an unconditional `<RetryButton />` for every
 * `ErrorShape` it was handed, including the two that arrive carrying
 * `{ retryable: false }` in their own details:
 *
 *   ACCOUNT_NOT_FOUND      no such 2100 account on this book. Two clicks from
 *                          the front door: open a row in the Demo accounts
 *                          table, then press "Default" in the state bar.
 *   ACCOUNT_NO_DATABASE    nothing to read from at all. See `./unreadable.ts`.
 *
 * Neither can be cleared by a refresh, and a Retry button under the words
 * "retrying is safe" gives the reader no way to tell which of the two the
 * screen means. So the flag is now PRINTED as a row, and the control is drawn
 * only when the failure says trying again might answer differently — which
 * makes the absence of the button mean something.
 *
 * "Retrying is safe" and "retrying is useful" are separate claims and this
 * panel now keeps them apart. A SELECT cannot move money whatever it returns,
 * so the first sentence holds for every failure here and is still said for
 * every failure here; only the offer to re-run it is conditional.
 */
export function ErrorPanel({
  error,
  accountId,
}: {
  readonly error: ErrorShape;
  readonly accountId: string;
}) {
  const retryable = isRetryable(error);

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
          hold changed — the ledger is append-only and a query cannot alter it.{" "}
          {retryable
            ? "Retrying is safe."
            : "Trying again cannot change this answer, so no retry is offered: this failure is a fact about the deployment or the id, not a query that did not come back."}
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

          <dt className="text-xs uppercase tracking-[0.08em] text-muted">
            Retryable
          </dt>
          <dd className="font-mono text-xs">{retryable ? "yes" : "no"}</dd>
        </dl>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {retryable ? <RetryButton /> : null}
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
