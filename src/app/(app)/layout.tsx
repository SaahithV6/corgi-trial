import { headers } from "next/headers";

import type { ReactNode } from "react";

import { AppHeader } from "@/components/app-shell/AppHeader";
import {
  READ_ONLY_ATTRIBUTE,
  ReadOnlyNotice,
  consoleIsReadOnly,
} from "@/components/app-shell/ReadOnlyNotice";
import { RefusalScreen } from "@/components/app-shell/RefusalScreen";
import { readRole } from "@/components/app-shell/role";
import { authorize, isOperator, OPERATOR_ONLY } from "@/lib/authz";
import { ProviderHealthBanner } from "@/components/system/ProviderHealthBanner";

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
 *
 * ============================================================================
 * THE INNER GUARD — and why there are two
 * ============================================================================
 *
 * `src/middleware.ts` already refused this request if it should have been
 * refused: 403, code `OPERATOR_ONLY`, before any of this ran. So in production
 * the branch below is dead code, and that is exactly why it is here.
 *
 * The middleware has a MATCHER. The comment that shipped with that file, about
 * a different control, says the thing worth saying: *a matcher is exactly where
 * coverage goes missing without anyone noticing.* A layout has no matcher. It
 * runs for every page under `(app)` because Next.js composes it, and nobody can
 * add a screen here that skips it.
 *
 * So this re-derives the SAME decision from the SAME module — one policy, two
 * enforcement points — and it FAILS CLOSED: if the pathname header the
 * middleware sets is missing, a customer is refused rather than served, because
 * a missing header means the outer guard did not run and the only safe reading
 * of "I don't know which screen this is" on a console that spans every business
 * is no.
 *
 * A customer who is legitimately on `/client` with a broken matcher therefore
 * sees a refusal. That is the correct direction to be wrong in, it is loud, and
 * `coverage.test.ts` fails the build before it can happen.
 *
 * `{children}` is not rendered on refusal, so the operator page component is
 * never invoked and its readers never run. The screen is not drawn and then
 * hidden; it is not drawn.
 */
export default async function AppLayout({
  children,
}: {
  readonly children: ReactNode;
}) {
  const role = await readRole();

  /**
   * READ-ONLY WITHOUT A SESSION. The console renders to anybody; only writes
   * need the credential (`src/middleware.ts` control 3, and again inside every
   * operator action). This attribute is what tells the screen to SAY so: it
   * scopes the rules in `ReadOnlyNotice` that paint every form under `#main`
   * inert, with the reason beside it, rather than letting a visitor find out by
   * pressing a button. It grants nothing and refuses nothing — the refusals are
   * two layers below it — and a forged one can only make the page look MORE
   * restricted than it is.
   */
  const readOnly = await consoleIsReadOnly();

  const pathname = (await headers()).get("x-corgi-pathname");
  const decision = isOperator(role)
    ? { allowed: true as const }
    : pathname === null
      ? {
          allowed: false as const,
          code: OPERATOR_ONLY,
          reason:
            "The request arrived without the path header the guard reads, so this session could not be shown to be on the customer surface. A customer session is refused when the answer is unknown.",
        }
      : authorize(role, pathname);

  if (!decision.allowed) {
    return (
      <div className="min-h-dvh bg-background" {...{ [READ_ONLY_ATTRIBUTE]: String(readOnly) }}>
        <AppHeader role={role} />
        <main id="main" className="mx-auto max-w-6xl px-6 py-8">
          <RefusalScreen code={decision.code} reason={decision.reason} />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-background" {...{ [READ_ONLY_ATTRIBUTE]: String(readOnly) }}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded focus:border focus:border-border-strong focus:bg-surface focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>

      <AppHeader role={role} />

      <main id="main" className="mx-auto max-w-6xl px-6 py-8">
        {/* Above the content on every console screen, not just one. A feed
            outage is a property of the system, and a banner that only appears
            on the page you happen to be looking at is a banner you will miss. */}
        <ProviderHealthBanner />
        {readOnly ? <ReadOnlyNotice /> : null}
        {children}
      </main>
    </div>
  );
}
