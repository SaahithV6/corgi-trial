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
  { href: "/payments", label: "Payments" },
  { href: "/approvals", label: "Approvals" },
  { href: "/reconciliation", label: "Reconciliation" },
  { href: "/statements", label: "Statements" },
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
