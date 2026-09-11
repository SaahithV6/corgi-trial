/**
 * The loading state.
 *
 * Shaped like the screen it stands in for — the pickers, the two-figure
 * headline, then the document — so nothing jumps when the data lands. It is
 * the real Suspense fallback, not a decoration: `?state=loading` makes the
 * fixture genuinely slow and this is what renders while it is.
 */
function Bar({ className = "" }: { readonly className?: string }) {
  return <span className={`block rounded bg-border ${className}`} />;
}

function Row() {
  return (
    <div className="flex items-center gap-6 border-t border-border px-5 py-4">
      <Bar className="h-3 w-24" />
      <Bar className="h-3 flex-1" />
      <Bar className="h-3 w-24" />
      <Bar className="h-3 w-28" />
    </div>
  );
}

export function StatementsSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="animate-pulse space-y-6"
    >
      <span className="sr-only">Re-deriving both readings from the ledger…</span>

      <div>
        <Bar className="h-5 w-56" />
        <Bar className="mt-2 h-3 w-96" />
      </div>

      <div className="flex flex-wrap gap-2">
        {["a1", "a2"].map((key) => (
          <Bar key={key} className="h-7 w-48 rounded-full" />
        ))}
      </div>

      <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
        {["f1", "f2", "f3"].map((key) => (
          <div key={key} className="bg-surface px-5 py-4">
            <Bar className="h-2.5 w-28" />
            <Bar className="mt-3 h-7 w-32" />
            <Bar className="mt-3 h-2.5 w-40" />
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-5 py-4">
          <Bar className="h-3 w-64" />
          <Bar className="mt-2 h-2.5 w-80" />
        </div>
        <Row />
        <Row />
        <Row />
        <div className="border-t border-border px-5 py-4">
          <Bar className="h-3 w-full max-w-xl" />
        </div>
      </div>
    </div>
  );
}
