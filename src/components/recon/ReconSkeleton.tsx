/**
 * The loading state.
 *
 * Shaped like the screen it stands in for — four summary tiles, a filter row,
 * then the table — so nothing jumps when the data lands. It is the real
 * Suspense fallback, not a decoration: `?state=loading` makes the fixture
 * genuinely slow and this is what renders while it is.
 */
function Bar({ className = "" }: { readonly className?: string }) {
  return <span className={`block rounded bg-border ${className}`} />;
}

function Row() {
  return (
    <div className="flex items-center gap-6 border-t border-border px-5 py-4">
      <Bar className="h-3 w-44" />
      <Bar className="h-3 w-24" />
      <Bar className="h-3 flex-1" />
      <Bar className="h-3 w-20" />
      <Bar className="h-3 w-24" />
    </div>
  );
}

export function ReconSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className="animate-pulse space-y-6"
    >
      <span className="sr-only">Reconciling last night&rsquo;s file…</span>

      <div>
        <Bar className="h-5 w-72" />
        <Bar className="mt-2 h-3 w-96" />
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
        {["a", "b", "c", "d"].map((key) => (
          <div key={key} className="bg-surface px-5 py-4">
            <Bar className="h-2.5 w-24" />
            <Bar className="mt-3 h-6 w-20" />
            <Bar className="mt-3 h-2.5 w-28" />
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-border bg-surface">
        <div className="flex flex-wrap gap-2 border-b border-border px-5 py-4">
          {["k1", "k2", "k3", "k4"].map((key) => (
            <Bar key={key} className="h-6 w-28 rounded-full" />
          ))}
        </div>
        <Row />
        <Row />
        <Row />
        <Row />
      </div>
    </div>
  );
}
