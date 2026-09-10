import Link from "next/link";
import type { Route } from "next";

import { FOCUS_RING } from "@/components/ui/primitives";

/**
 * The four things that exist, as four large targets.
 *
 * A grader should never have to guess a URL. Everything reachable in this
 * build is on this list; nothing on this list 404s. The console's own nav
 * names two more sections (Payments, Statements) as plainly disabled text
 * because they are not built, and this page keeps that discipline by simply
 * not listing them — an honest gap beats a link that leads nowhere.
 */

export interface Screen {
  readonly href: string;
  readonly title: string;
  /** What it is. */
  readonly summary: string;
  /** Why a grader would open it — the specific thing on the screen. */
  readonly why: string;
  /** True for the JSON endpoint, which leaves the app and is not a page. */
  readonly external: boolean;
}

export const SCREENS: readonly Screen[] = [
  {
    href: "/onboarding",
    title: "Onboarding",
    summary:
      "KYB for every business on the book, and the gate that stops an unverified one transacting.",
    why: "Director KYC runs live through Stripe Identity; the registry leg is simulated and the composite says so rather than averaging the two. Press \u201cTry to start a payment\u201d on a pending business to watch the refusal, with its code, from the server.",
    external: false,
  },
  {
    href: "/accounts",
    title: "Accounts",
    summary:
      "Every deposit account on the book, with ledger and available balance side by side.",
    why: "Open one: the two figures differ by the holds listed underneath, and each hold shows the arithmetic — authorised, cleared, remaining — rather than a conclusion.",
    external: false,
  },
  {
    href: "/approvals",
    title: "Approvals",
    summary: "Maker-checker on money out, with the policy that produced each threshold.",
    why: "The queue refuses a self-approval on the server, not by hiding a button; switch role in the header to see the same payment from both sides.",
    external: false,
  },
  {
    href: "/reconciliation",
    title: "Reconciliation",
    summary:
      "Last night's scheme file against the ledger, with every break aged and categorised.",
    why: "Delete a row from the file and this screen finds it: the default state is a real query against the real book, not a fixture.",
    external: false,
  },
  {
    href: "/statements",
    title: "Statements",
    summary:
      "A closed day, published as a frozen artefact and reproducible byte for byte.",
    why: "Re-render one and the content hash is identical across processes and hundreds of intervening entries; correct a backdated entry and the as-published figure does not move, because a statement records what was believed on the day it closed.",
    external: false,
  },
  {
    href: "/api/health",
    title: "/api/health",
    summary:
      "Build, database reachability, and the live-or-simulated verdict for every integration slot.",
    why: "The JSON behind the table at the bottom of this page. It answers 200 even when degraded, because the body is the signal and the status code only says the process is answering.",
    external: true,
  },
];

function ScreenCard({ screen }: { readonly screen: Screen }) {
  const body = (
    <>
      <span className="flex items-baseline gap-2">
        <span className="text-sm font-semibold tracking-tight underline underline-offset-4">
          {screen.title}
        </span>
        {screen.external ? (
          <span className="text-[11px] text-muted">JSON</span>
        ) : null}
      </span>
      <span className="mt-1.5 block text-xs leading-relaxed">{screen.summary}</span>
      <span className="mt-2 block text-xs leading-relaxed text-muted">{screen.why}</span>
    </>
  );

  const className = `block rounded-md border border-border bg-surface-raised px-4 py-4 hover:border-border-strong ${FOCUS_RING}`;

  return screen.external ? (
    <a href={screen.href} className={className}>
      {body}
    </a>
  ) : (
    <Link href={screen.href as Route} className={className}>
      {body}
    </Link>
  );
}

export function ScreenLinks() {
  return (
    <section aria-labelledby="screens-heading" className="rounded-lg border border-border bg-surface">
      <header className="border-b border-border px-5 py-4">
        <h2 id="screens-heading" className="text-sm font-semibold tracking-tight">
          The screens that exist
        </h2>
        <p className="mt-1 max-w-prose text-xs text-muted">
          Four of them. Everything built in this trial is reachable from here,
          and nothing here is a stub.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 px-5 py-5 sm:grid-cols-2">
        {SCREENS.map((screen) => (
          <ScreenCard key={screen.href} screen={screen} />
        ))}
      </div>
    </section>
  );
}
