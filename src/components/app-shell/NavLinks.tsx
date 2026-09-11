"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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
const LIVE = [
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
  { href: "/team", label: "Team" },
  { href: "/audit", label: "Audit trail" },
  { href: "/events", label: "Outbound events" },
  { href: "/chaos", label: "Chaos harness" },
] as const;

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className="flex items-center gap-1">
      {LIVE.map((item) => {
        const current = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
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
      })}
    </nav>
  );
}
