import Link from "next/link";
import type { Route } from "next";

import { FOCUS_RING } from "@/components/ui/primitives";

/**
 * Four things worth clicking, and what to look at once you are there.
 *
 * Not a feature list. Each item names one screen, one figure on it, and the
 * reason that figure is the interesting one — the questions this build was
 * made to answer out loud, in the order they are quickest to check.
 */

export interface LookAtItem {
  readonly key: string;
  /** A route on this deployment, or an anchor on this page. */
  readonly href: string;
  readonly linkText: string;
  /** What to do when you get there, and what it proves. */
  readonly text: string;
}

export const LOOK_AT: readonly LookAtItem[] = [
  {
    key: "available",
    href: "/accounts",
    linkText: "Open an account",
    text: "Ledger and available sit side by side and they differ. The gap is the holds listed underneath, and each hold shows its arithmetic — authorised, cleared, remaining — instead of a verdict. On the over-captured fuel-pump authorisation the settlement lands above the amount authorised and available goes negative; that is deliberately not clamped to zero, because the customer really is overdrawn.",
  },
  {
    key: "breaks",
    href: "/reconciliation",
    linkText: "Reconciliation",
    text: "Last night's scheme file against the ledger, every break aged and categorised. Drill into one and you get the file row and the ledger group that failed to match it, side by side. The default state is a live query, so deleting a row from the file is a test this screen can actually fail.",
  },
  {
    key: "maker-checker",
    href: "/approvals?state=edge",
    linkText: "A payment raised by the signed-in actor",
    text: "Approve is disabled and the reason is on the screen — and the refusal is on the server too, so it survives someone re-enabling the button. Use the role switcher in the header to look at the same payment as the checker.",
  },
  {
    key: "simulated",
    href: "#integrations",
    linkText: "The two SIMULATED rows",
    text: "Both carry the measurement that demoted them: Stripe Connect is not enabled, and the USDC wallet holds twenty dollars with zero gas to move it. Each was reported LIVE by an earlier probe that checked the credential instead of the capability, which is the failure this table exists to prevent.",
  },
];

export function WhatToLookAt() {
  return (
    <section
      aria-labelledby="look-at-heading"
      className="rounded-lg border border-border bg-surface"
    >
      <header className="border-b border-border px-5 py-4">
        <h2 id="look-at-heading" className="text-sm font-semibold tracking-tight">
          What to look at
        </h2>
        <p className="mt-1 max-w-prose text-xs text-muted">
          Four specific things, rather than a tour.
        </p>
      </header>

      <ol className="divide-y divide-border">
        {LOOK_AT.map((item, index) => (
          <li key={item.key} className="flex gap-4 px-5 py-4">
            <span
              aria-hidden="true"
              className="money mt-0.5 shrink-0 text-xs text-muted"
            >
              {index + 1}
            </span>
            <p className="max-w-prose text-xs leading-relaxed text-muted">
              {item.href.startsWith("#") ? (
                <a
                  href={item.href}
                  className={`font-medium text-text underline underline-offset-4 ${FOCUS_RING}`}
                >
                  {item.linkText}
                </a>
              ) : (
                <Link
                  href={item.href as Route}
                  className={`font-medium text-text underline underline-offset-4 ${FOCUS_RING}`}
                >
                  {item.linkText}
                </Link>
              )}
              {" — "}
              {item.text}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}
