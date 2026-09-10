import type { ReactNode } from "react";

import { AppHeader } from "@/components/app-shell/AppHeader";
import { readRole } from "@/components/app-shell/role";

/**
 * The console shell.
 *
 * Route group, not a path segment: everything under `(app)` gets the header,
 * the business context and the role switcher, and the URLs stay clean
 * (`/accounts/...`, not `/app/accounts/...`).
 *
 * Reading the role cookie makes this layout dynamic, which is correct — a
 * financial console must never serve a cached page that was rendered for
 * someone else's role or someone else's books.
 */
export default async function AppLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  const role = await readRole();

  return (
    <div className="min-h-dvh bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded focus:border focus:border-border-strong focus:bg-surface focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>

      <AppHeader role={role} />

      <main id="main" className="mx-auto max-w-6xl px-6 py-8">
        {children}
      </main>
    </div>
  );
}
