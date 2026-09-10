/**
 * The loading state.
 *
 * Shaped like the screen it stands in for — a header block, a four-figure
 * balance strip, a note, a form panel and a holds table — so nothing jumps when
 * the data lands. It is the real Suspense fallback: `?state=loading` makes the
 * preflight read genuinely slow and this is what renders while it is.
 */
function Bar({ className = "" }: { readonly className?: string }) {
  return <span className={`block rounded bg-border ${className}`} />;
}

function FieldPair() {
  return (
    <div className="space-y-2">
      <Bar className="h-2.5 w-24" />
      <Bar className="h-8 w-full" />
    </div>
  );
}

function Figure() {
  return (
    <div className="space-y-2 px-5 py-4">
      <Bar className="h-2.5 w-20" />
      <Bar className="h-6 w-28" />
    </div>
  );
}

export function FundingSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className="animate-pulse space-y-6">
      <span className="sr-only">Loading balances, holds and the availability policy…</span>

      <div className="space-y-2">
        <Bar className="h-5 w-48" />
        <Bar className="h-3 w-96" />
      </div>

      <div className="grid grid-cols-2 gap-px rounded-lg border border-border bg-border sm:grid-cols-4">
        <div className="bg-surface">
          <Figure />
        </div>
        <div className="bg-surface">
          <Figure />
        </div>
        <div className="bg-surface">
          <Figure />
        </div>
        <div className="bg-surface">
          <Figure />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface px-5 py-4">
        <Bar className="h-3 w-64" />
        <div className="mt-3 space-y-2">
          <Bar className="h-2.5 w-full max-w-2xl" />
          <Bar className="h-2.5 w-full max-w-xl" />
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-5 py-4">
          <Bar className="h-3 w-56" />
          <Bar className="mt-2 h-2.5 w-full max-w-lg" />
        </div>
        <div className="space-y-5 px-5 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldPair />
            <FieldPair />
            <FieldPair />
            <FieldPair />
          </div>
          <FieldPair />
          <Bar className="h-12 w-full max-w-3xl" />
          <div className="flex gap-3">
            <Bar className="h-7 w-56" />
            <Bar className="h-7 w-40" />
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-5 py-4">
          <Bar className="h-3 w-64" />
        </div>
        <div className="space-y-3 px-5 py-4">
          <Bar className="h-3 w-full max-w-3xl" />
          <Bar className="h-3 w-full max-w-2xl" />
        </div>
      </div>
    </div>
  );
}
