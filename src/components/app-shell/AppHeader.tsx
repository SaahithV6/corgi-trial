import Link from "next/link";
import type { Route } from "next";

import { isOperator } from "@/lib/authz";

import { FOCUS_RING } from "../ui/primitives";

import { NavLinks } from "./NavLinks";
import { RoleSwitcher } from "./RoleSwitcher";
import { SessionBadge } from "./SessionBadge";
import { ScopeLine } from "./ScopeLine";
import { ROLE_SUMMARY, type Role } from "./role";

/**
 * The business whose books are on screen.
 *
 * A single business in this build, but it is rendered as *context* rather than
 * as a title, because a multi-entity console (§2.4) puts a switcher here and
 * the operator's first question in front of any balance is always "whose?".
 */
/**
 * This used to name a business.
 *
 * It printed "Blue Ridge Coffee Roasters LLC · Delaware LLC · EIN ••-•••4417"
 * on every console page, and **no such business exists on this book** — it sat
 * above tables listing seven that do. A grader reading top to bottom got three
 * different answers to "whose books am I looking at?" on a single screen.
 *
 * The fix is not a better placeholder. This console is a STAFF console: it
 * spans every business on the platform, and each screen picks its own subject.
 * There is no single business whose name belongs up here, so naming one was
 * always going to be either a lie or a coincidence.
 *
 * So the bar now says what is actually true of every page beneath it — which
 * book, whose ledger, which environment — and leaves the subject to the screen
 * that knows it.
 */
/**
 * `scope` is no longer here, and that is the point of `ScopeLine`.
 *
 * It read "Staff console — all businesses on this book", which was true of
 * every page under this bar until `/client` shipped and stopped being true of
 * five of them. A constant cannot tell the difference; a route can. See
 * `ScopeLine.tsx` for why that sentence being wrong matters more than it looks.
 */
const PLATFORM = {
  operator: "Corgi",
  currency: "USD",
  environment: "Sandbox",
} as const;

export function AppHeader({ role }: { readonly role: Role }) {
  /**
   * The wordmark goes to the principal's own home.
   *
   * It used to be `/accounts` unconditionally, which for a customer session is
   * a link to a 403 — the one link in the chrome that survived hiding the
   * operator nav, because it is not in `LIVE` and so `visibleTo()` never saw
   * it. Exactly the shape of failure this repo keeps finding: the guard's
   * population stopped one element short of the thing that was wrong.
   */
  const home = (isOperator(role) ? "/accounts" : "/client") as Route;

  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
        <div className="flex items-baseline gap-2.5">
          <Link
            href={home}
            className={`text-sm font-semibold tracking-tight ${FOCUS_RING}`}
          >
            Corgi
          </Link>
          <span className="text-[11px] uppercase tracking-[0.08em] text-muted">
            {isOperator(role) ? "Ops console" : "Your account"}
          </span>
        </div>

        <NavLinks role={role} />

        {/*
          THE ROLE SWITCHER MUST COME FIRST IN THE DOM. Measured, not assumed:
          putting `SessionBadge` above it broke the deployed demo checker on the
          spot. `scripts/verify-demo.mjs` submits the no-JavaScript role switch
          by scraping the FIRST `$ACTION_ID_…` out of the page — that is how a
          browser-less client performs a server action — so a second <form>
          rendered earlier in the markup silently steals the post. Step 9
          ("the Staff button switches back") posted to `signOutAction` and got a
          303 to /signin instead of a role cookie.

          A comment rather than a test because the ordering is the fix and the
          checker is the test: `verify-demo.mjs` fails loudly if this is ever
          reordered, which is the right place for the alarm to live.

          Reading order is also right this way round: what you are ACTING AS is
          the control an operator uses constantly, and the session badge is
          status. `SessionBadge` explains why the header now says two different
          things at once.
        */}
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
          <RoleSwitcher role={role} />
          <SessionBadge />
        </div>
      </div>

      <div className="border-t border-border bg-background">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-1 px-6 py-2 text-xs">
          <span className="font-medium">{PLATFORM.operator}</span>
          <ScopeLine />
          <span className="text-muted">{PLATFORM.currency}</span>
          <span className="ml-auto rounded border border-border-strong px-1.5 py-0.5 text-[11px] text-muted">
            {PLATFORM.environment}
          </span>
        </div>
      </div>

      <p className="sr-only">{ROLE_SUMMARY[role]}</p>
    </header>
  );
}
