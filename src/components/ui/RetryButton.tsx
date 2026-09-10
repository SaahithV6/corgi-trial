"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { FOCUS_RING } from "./primitives";

/**
 * Re-runs the server render for the current URL.
 *
 * A real retry, not a page reload: `router.refresh()` re-issues the same
 * queries through the same data source and swaps the result in, so a
 * transient ledger failure clears without losing the demo state in the query
 * string. The pending state is a transition, so the button reports that
 * something is happening rather than looking inert while the query runs.
 */
export function RetryButton({ label = "Retry" }: { readonly label?: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        startTransition(() => {
          router.refresh();
        });
      }}
      className={`inline-flex items-center rounded border border-border-strong bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-raised disabled:opacity-60 ${FOCUS_RING}`}
    >
      {isPending ? "Retrying…" : label}
    </button>
  );
}
