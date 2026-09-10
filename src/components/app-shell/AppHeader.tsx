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
const BUSINESS = {
  name: "Blue Ridge Coffee Roasters LLC",
  entity: "Delaware LLC",
  ein: "••-•••4417",
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
          <span className="font-medium">{BUSINESS.name}</span>
          <span className="text-muted">{BUSINESS.entity}</span>
          <span className="text-muted">EIN {BUSINESS.ein}</span>
          <span className="text-muted">USD</span>
          <span className="ml-auto rounded border border-border-strong px-1.5 py-0.5 text-[11px] text-muted">
            {BUSINESS.environment}
          </span>
        </div>
      </div>

      <p className="sr-only">{ROLE_SUMMARY[role]}</p>
    </header>
  );
}
