export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6 py-16">
      <div className="rounded-lg border border-border bg-surface p-8">
        <h1 className="text-lg font-semibold tracking-tight">Corgi Neobank</h1>
        <p className="mt-1 text-sm text-muted">
          Business current accounts · operations console
        </p>

        <hr className="my-6 border-border" />

        <p className="text-sm">
          Scaffold is up. <span className="text-muted">ledger not yet wired</span>
        </p>
      </div>
    </main>
  );
}
