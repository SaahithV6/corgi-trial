import { Panel } from "@/components/ui/primitives";

/**
 * The real Suspense fallback.
 *
 * Not a mock of a slow read — it IS what a reader sees while the read happens,
 * because `TransactionsSection` is an async server component and this is its
 * fallback. `?state=loading` makes the read genuinely slow rather than faking
 * the render, which is the difference between demonstrating a loading state
 * and drawing a picture of one.
 *
 * The shape matches the loaded page: two reading tiles, a difference between
 * them, and a table. A skeleton with a different shape causes a layout jump on
 * every load, which is a worse experience than no skeleton.
 */
export function TransactionsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Reading the ledger at the requested point.</span>

      <div>
        <div className="h-5 w-64 animate-pulse rounded bg-surface-raised" />
        <div className="mt-2 h-4 w-full max-w-prose animate-pulse rounded bg-surface-raised" />
      </div>

      <div className="h-24 animate-pulse rounded-lg border border-dashed border-border-strong bg-surface-raised" />

      <Panel title="Closing balance, read twice" description="Same value date. Same rows. One argument changed.">
        <div className="grid gap-px bg-border sm:grid-cols-[1fr_auto_1fr]">
          {[0, 1, 2].map((column) => (
            <div key={column} className="bg-surface px-5 py-4">
              <div className="h-3 w-32 animate-pulse rounded bg-surface-raised" />
              <div className="mt-2 h-7 w-40 animate-pulse rounded bg-surface-raised" />
              <div className="mt-2 h-3 w-28 animate-pulse rounded bg-surface-raised" />
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="The postings, as they stood at that point">
        <div className="space-y-3 px-5 py-4">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="h-5 animate-pulse rounded bg-surface-raised" />
          ))}
        </div>
      </Panel>
    </div>
  );
}
