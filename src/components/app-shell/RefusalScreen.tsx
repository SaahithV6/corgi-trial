import Link from "next/link";
import type { Route } from "next";

import { CLIENT_SCREENS } from "@/components/client/view-state";

import { FOCUS_RING } from "../ui/primitives";

/**
 * The inner refusal.
 *
 * `src/middleware.ts` normally answers a denied request itself, with a 403 and
 * a self-contained page, before anything under `src/app` runs. This component
 * is what renders when the middleware did NOT run — a matcher gap, a runtime
 * that skipped it, a path nobody thought of — because `src/app/(app)/layout.tsx`
 * re-derives the same decision and fails closed rather than trusting that the
 * outer layer fired.
 *
 * It is a page and not a redirect for the same reason the outer one is: a
 * person who clicked something is owed the sentence "the server refused this",
 * with the code, rather than being quietly put somewhere else and left to
 * wonder whether the screen exists.
 *
 * Note what it does NOT do: it does not render `{children}`. The operator page
 * component is never invoked, so its readers never run and there is no figure
 * on this request to leak. Hiding a rendered screen would be the defect, not
 * the fix.
 */
export function RefusalScreen({
  code,
  reason,
}: {
  readonly code: string;
  readonly reason: string;
}) {
  return (
    <section
      aria-labelledby="refusal-heading"
      className="rounded-lg border border-border bg-surface"
    >
      <header className="border-b border-border px-5 py-4">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.08em] text-negative">
          Refused · {code}
        </p>
        <h1 id="refusal-heading" className="mt-2 text-lg font-semibold tracking-tight">
          You are acting as a customer.
        </h1>
        <p className="mt-2 max-w-prose text-sm text-muted">{reason}</p>
      </header>

      <div className="px-5 py-5">
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          This is an authorisation decision and not a sign-in wall. The role you
          are acting as is the demo credential in the header above; switch it
          back to Staff or Approver and the operator console opens again. What
          changed is that being a customer now restricts what the server will
          serve, rather than only what the console draws.
        </p>

        <h2 className="mt-5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Your screens
        </h2>
        <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {CLIENT_SCREENS.map((screen) => (
            <li key={screen.href}>
              <Link
                href={screen.href as Route}
                className={`block rounded border border-border px-3 py-2 text-sm hover:border-border-strong ${FOCUS_RING}`}
              >
                {screen.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
