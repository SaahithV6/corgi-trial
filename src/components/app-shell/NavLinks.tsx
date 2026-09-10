"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { FOCUS_RING } from "../ui/primitives";

/**
 * Primary navigation.
 *
 * Only routes that exist are links. The rest of the console is named but
 * rendered as plainly disabled text — a nav item that 404s is worse than an
 * honest gap, and typed routes would not let it compile anyway.
 */
const LIVE = [
  { href: "/accounts", label: "Accounts" },
  { href: "/approvals", label: "Approvals" },
  { href: "/reconciliation", label: "Reconciliation" },
  { href: "/statements", label: "Statements" },
] as const;

const PLANNED = ["Payments"] as const;

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

      {PLANNED.map((label) => (
        <span
          key={label}
          aria-disabled="true"
          title="Not in this build"
          className="cursor-default px-2.5 py-1.5 text-sm text-muted/60"
        >
          {label}
        </span>
      ))}
    </nav>
  );
}
