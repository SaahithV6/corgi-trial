"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";

import { CLIENT_SCREENS } from "@/components/client/view-state";
import { visibleTo, type Role } from "@/lib/authz";

import { FOCUS_RING } from "../ui/primitives";

/**
 * Primary navigation.
 *
 * Only routes that exist are links. The rest of the console was named and
 * rendered as plainly disabled text — a nav item that 404s is worse than an
 * honest gap, and typed routes would not let it compile anyway.
 *
 * As of T+20h there is nothing left in that list. "Payments" was the last
 * entry: outbound money went through the approvals queue and the MCP write
 * tool, so a grader could approve an instruction the seed script wrote but
 * could not originate one, and the loop never closed in the product. /payments
 * closes it, so the disabled-text branch is gone rather than kept empty.
 */
export const LIVE = [
  // First, because a business exists before its account does — and because the
  // gate this screen demonstrates runs before any of the others can move money.
  { href: "/onboarding", label: "Onboarding" },
  { href: "/accounts", label: "Accounts" },
  { href: "/pots", label: "Pots" },
  { href: "/funding", label: "Funding" },
  { href: "/payments", label: "Payments" },
  { href: "/payees", label: "Payees" },
  { href: "/payouts", label: "Payouts" },
  { href: "/approvals", label: "Approvals" },
  { href: "/standing-orders", label: "Standing orders" },
  { href: "/accruals", label: "Accruals" },
  { href: "/disputes", label: "Disputes" },
  { href: "/reconciliation", label: "Reconciliation" },
  // Sits next to Reconciliation because it is a second READING of the same
  // breaks, never a second list. It asserts that on its own face — "showing
  // 7 of 7, the engine reported 7, this screen hides none" — and has no
  // default filter and no hide-explained toggle, because a screen that can
  // quietly drop a break is worse than no screen.
  { href: "/breaks", label: "Explained breaks" },
  { href: "/statements", label: "Statements" },
  // Last, and named for what it is. The screen itself opens with "WE ARE DOING
  // THIS, NOT THE PROVIDER" and every control sentence has us as the subject,
  // so a cropped screenshot still cannot read as evidence of a real outage.
  { href: "/transactions", label: "Transactions" },
  // The only screen that re-renders the book at a point in the past. It was
  // shipped and linked from NOWHERE until the front-door completeness test
  // caught it, and then it sat in SCREENS while still missing from here —
  // because that test guards the front door and nothing guarded the nav.
  { href: "/economics", label: "Unit economics" },
  { href: "/team", label: "Team" },
  { href: "/dashboard", label: "Triage" },
  { href: "/audit", label: "Audit trail" },
  { href: "/events", label: "Outbound events" },
  { href: "/chaos", label: "Chaos harness" },

  // ==========================================================================
  // THE CLIENT SURFACE. Nineteen entries above this line and every one of them
  // is a STAFF tool: every business on the book in one table, `2100` account
  // codes, invariant row counts. The brief opens "Customers hold a balance,
  // send and receive payments, and get a card for each person on the team" —
  // and until these five existed, a customer of this bank could not see their
  // own balance without reading a table of everyone else's.
  //
  // They are in this list because `NavLinks.test.ts` asserts the nav carries
  // every screen the front door names, and the front door names every route
  // under `src/app`. They are rendered as their own GROUP below rather than
  // mixed into the console's nav, because a customer surface and an operator
  // console are different products and a reader should be able to see the
  // seam. They are rendered AT ALL — rather than hidden when a staff page is
  // open — because that test cannot see whether a link is reachable on the
  // screen somebody is actually looking at, and "carried but painted nowhere"
  // is the exact failure it was written to catch, one layer down.
  // ==========================================================================
  ...CLIENT_SCREENS.map((screen) => ({ href: screen.href, label: screen.label })),
] as const;

/** True for the five customer screens. Used to draw the seam, nothing else. */
export function isClientHref(href: string): boolean {
  return href === "/client" || href.startsWith("/client/");
}

/**
 * `flex-wrap` on the nav below is load-bearing, and its absence was measured
 * on the DEPLOYED build: at 1440x900 the page scrollWidth was 1841 against a
 * clientWidth of 1440 — 401px of sideways overflow, with six nav items painted
 * past the right edge (Chaos harness sat at x=1769-1841). 481px at 1280x800.
 *
 * The nav is 21 links on one line, 1673px wide. `AppHeader` wraps it in a
 * `flex flex-wrap` container, but that wraps only ITS own children; this <nav>
 * is a single flex item and `min-width: auto` refuses to shrink it below its
 * content, so it simply overhung.
 *
 * Two reasons it mattered more than it looked. It broke the house rule inside
 * the shell itself — wide content scrolls in its own container and the page
 * body never scrolls sideways — so every TableScroll in the build was honouring
 * that rule while the chrome undid it. And `/transactions` and `/economics`
 * were added to this nav precisely because "shipped and linked from nowhere"
 * is this codebase's recurring failure; painted outside the viewport they were
 * linked from nowhere again.
 *
 * `NavLinks.test.ts` asserts the nav CARRIES every front-door screen. It cannot
 * see whether a link is REACHABLE on the screen a reader is using, which is the
 * same failure it was written to catch, one layer down.
 */
/**
 * THE NAV FOLLOWS THE GUARD. IT DOES NOT REPLACE IT.
 *
 * `visibleTo()` runs the same `authorize()` the middleware and the `(app)`
 * layout run, over these same hrefs, so a link is painted if and only if the
 * server would serve it. That is the only relationship between the two worth
 * having: one policy, three readers, and no chance of the chrome advertising a
 * refusal or — far worse — of somebody deciding that not painting the link was
 * the fix. It is not. The fix is the 403; this is cosmetics downstream of it.
 *
 * `LIVE` above is deliberately unfiltered and still carries every front-door
 * screen, because `NavLinks.test.ts` asserts that completeness in both
 * directions and loosening it to accommodate a role would give up the property
 * that caught `/economics` and `/transactions` shipped-and-linked-from-nowhere.
 * The filter is applied here, at render, against the principal.
 */
export function NavLinks({ role }: { readonly role: Role }) {
  const pathname = usePathname();

  /**
   * `startsWith` is wrong for `/client`, and only for `/client`.
   *
   * Every other entry is a prefix of nothing else in this list, but `/client`
   * is a prefix of `/client/activity` — so the plain test would light BOTH up
   * while a reader is on the activity screen, and `aria-current="page"` would
   * name two pages. An exact match for the one route that is somebody else's
   * prefix, and the prefix test everywhere else, where a detail route like
   * `/accounts/<id>` genuinely should light its parent.
   */
  const isCurrent = (href: string): boolean =>
    href === "/client" ? pathname === "/client" : pathname.startsWith(href);

  const link = (item: { readonly href: string; readonly label: string }) => {
    const current = isCurrent(item.href);
    return (
      <Link
        key={item.href}
        href={item.href as Route}
        aria-current={current ? "page" : undefined}
        className={`rounded px-2.5 py-1.5 text-sm ${FOCUS_RING} ${
          current
            ? "bg-surface-raised font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border)]"
            : "text-muted hover:text-text"
        }`}
      >
        {item.label}
      </Link>
    );
  };

  const permitted = visibleTo(role, LIVE);
  const staff = permitted.filter((item) => !isClientHref(item.href));
  const client = permitted.filter((item) => isClientHref(item.href));

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {staff.length === 0 ? null : (
        <nav aria-label="Operations console" className="flex flex-wrap items-center gap-1">
          {staff.map(link)}
        </nav>
      )}

      {client.length === 0 ? null : (
        <nav
          aria-label="Customer view"
          className="flex flex-wrap items-center gap-1 rounded border border-dashed border-border-strong px-1.5 py-0.5"
        >
          <span className="px-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted">
            Customer
          </span>
          {client.map(link)}
        </nav>
      )}
    </div>
  );
}
