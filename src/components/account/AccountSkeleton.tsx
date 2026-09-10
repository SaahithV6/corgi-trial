/**
 * The loading state.
 *
 * Shaped like the screen it is standing in for — two balance blocks, a
 * reconciliation, then two tables — so the layout does not jump when the data
 * lands. It is the real Suspense fallback, not a decoration: `?state=loading`
 * makes the fixture genuinely slow and this is what renders while it is.
 */
function Bar({ className = "" }: { readonly className?: string }) {
  return <span className={`block rounded bg-border ${className}`} />;
}

function Row() {
  return (
    <div className="flex items-center gap-6 border-t border-border px-5 py-4">
      <Bar className="h-3 w-40" />
      <Bar className="h-3 flex-1" />
      <Bar className="h-3 w-24" />
      <Bar className="h-3 w-24" />
    </div>
  );
}

export function AccountSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="animate-pulse space-y-6"
    >
      <span className="sr-only">Loading account balances…</span>

      <div>
        <Bar className="h-5 w-64" />
        <Bar className="mt-2 h-3 w-96" />
      </div>

      <div className="rounded-lg border border-border bg-surface">
        <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
          {["ledger", "available"].map((key) => (
            <div key={key} className="px-5 py-5">
              <Bar className="h-2.5 w-28" />
              <Bar className="mt-3 h-8 w-48" />
              <Bar className="mt-3 h-2.5 w-full max-w-xs" />
            </div>
          ))}
        </div>
        <div className="space-y-3 border-t border-border px-5 py-5">
          {["a", "b", "c", "d"].map((key) => (
            <div key={key} className="flex items-center justify-between gap-8">
              <Bar className="h-3 w-56" />
              <Bar className="h-3 w-24" />
            </div>
          ))}
        </div>
      </div>

      {["holds", "activity"].map((key) => (
        <div key={key} className="rounded-lg border border-border bg-surface">
          <div className="px-5 py-4">
            <Bar className="h-3.5 w-32" />
            <Bar className="mt-2 h-2.5 w-80" />
          </div>
          <Row />
          <Row />
          <Row />
        </div>
      ))}
    </div>
  );
}
