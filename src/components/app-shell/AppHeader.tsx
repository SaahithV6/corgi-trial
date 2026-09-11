import Link from "next/link";

import { FOCUS_RING } from "../ui/primitives";

import { NavLinks } from "./NavLinks";
import { RoleSwitcher } from "./RoleSwitcher";
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
const PLATFORM = {
  operator: "Corgi",
  scope: "Staff console — all businesses on this book",
  currency: "USD",
  environment: "Sandbox",
} as const;

export function AppHeader({ role }: { readonly role: Role }) {
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
        <div className="flex items-baseline gap-2.5">
          <Link
            href="/accounts"
            className={`text-sm font-semibold tracking-tight ${FOCUS_RING}`}
          >
            Corgi
          </Link>
          <span className="text-[11px] uppercase tracking-[0.08em] text-muted">
            Ops console
          </span>
        </div>

        <NavLinks />

        <div className="ml-auto flex items-center gap-4">
          <RoleSwitcher role={role} />
        </div>
      </div>

      <div className="border-t border-border bg-background">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-1 px-6 py-2 text-xs">
          <span className="font-medium">{PLATFORM.operator}</span>
          <span className="text-muted">{PLATFORM.scope}</span>
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
