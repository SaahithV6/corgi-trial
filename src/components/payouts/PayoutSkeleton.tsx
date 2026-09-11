/**
 * The loading state.
 *
 * Shaped like the screen it stands in for — the request form, then the quote
 * with its arithmetic rows, then the book — so nothing jumps when the data
 * lands. It is the real Suspense fallback, not a decoration: `?state=loading`
 * makes the fixture genuinely slow and this is what renders while it is.
 */
function Bar({ className = "" }: { readonly className?: string }) {
  return <span className={`block rounded bg-border ${className}`} />;
}

function ArithmeticRow() {
  return (
    <div className="flex items-start justify-between gap-6 border-t border-border px-5 py-3">
      <div className="flex-1">
        <Bar className="h-3 w-32" />
        <Bar className="mt-2 h-2.5 w-full max-w-md" />
      </div>
      <Bar className="h-3 w-24" />
    </div>
  );
}

export function PayoutSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className="animate-pulse space-y-6">
      <span className="sr-only">Reading the quote book and the rate behind each quote…</span>

      <div>
        <Bar className="h-5 w-64" />
        <Bar className="mt-2 h-3 w-96" />
      </div>

      <div className="rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-5 py-4">
          <Bar className="h-3 w-40" />
          <Bar className="mt-2 h-2.5 w-80" />
        </div>
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
          {["a", "b", "c", "d"].map((key) => (
            <div key={key}>
              <Bar className="h-2.5 w-24" />
              <Bar className="mt-2 h-8 w-full" />
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-5 py-4">
          <Bar className="h-3 w-48" />
          <Bar className="mt-2 h-2.5 w-72" />
        </div>
        <ArithmeticRow />
        <ArithmeticRow />
        <ArithmeticRow />
        <ArithmeticRow />
        <ArithmeticRow />
      </div>

      <div className="rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-5 py-4">
          <Bar className="h-3 w-28" />
          <Bar className="mt-2 h-2.5 w-64" />
        </div>
        {["a", "b", "c"].map((key) => (
          <div key={key} className="flex items-center gap-6 border-t border-border px-5 py-4">
            <Bar className="h-3 w-28" />
            <Bar className="h-3 w-36" />
            <Bar className="h-3 flex-1" />
            <Bar className="h-3 w-20" />
            <Bar className="h-3 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
