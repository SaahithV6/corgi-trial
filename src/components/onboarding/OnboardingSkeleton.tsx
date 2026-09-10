/**
 * The loading state.
 *
 * Shaped like the screen it stands in for — a header, the wiring strip, then
 * one card per business with a leg table and a control row — so nothing jumps
 * when the data lands. It is the real Suspense fallback: `?state=loading` makes
 * the read genuinely slow and this is what renders while it is.
 */
function Bar({ className = "" }: { readonly className?: string }) {
  return <span className={`block rounded bg-border ${className}`} />;
}

function Card() {
  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-8 px-5 py-4">
        <div className="space-y-2">
          <Bar className="h-5 w-56" />
          <Bar className="h-3 w-40" />
        </div>
        <div className="space-y-2">
          <Bar className="h-2.5 w-44" />
          <Bar className="h-2.5 w-36" />
        </div>
      </div>
      <div className="space-y-2 border-t border-border px-5 py-4">
        <Bar className="h-2.5 w-full max-w-2xl" />
        <Bar className="h-2.5 w-full max-w-xl" />
      </div>
      <div className="flex gap-2 border-t border-border px-5 py-4">
        <Bar className="h-7 w-36" />
        <Bar className="h-7 w-24" />
        <Bar className="h-7 w-40" />
      </div>
    </div>
  );
}

export function OnboardingSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className="animate-pulse space-y-6">
      <span className="sr-only">Loading the verification state…</span>

      <div className="space-y-2">
        <Bar className="h-5 w-64" />
        <Bar className="h-3 w-96" />
      </div>

      <div className="rounded-lg border border-border bg-surface px-5 py-4">
        <Bar className="h-3 w-48" />
        <div className="mt-3 space-y-2">
          <Bar className="h-2.5 w-full max-w-2xl" />
          <Bar className="h-2.5 w-full max-w-xl" />
        </div>
      </div>

      <div className="space-y-4">
        <Card />
        <Card />
      </div>
    </div>
  );
}
