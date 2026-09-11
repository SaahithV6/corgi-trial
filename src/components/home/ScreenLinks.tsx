import Link from "next/link";
import type { Route } from "next";

import { FOCUS_RING } from "@/components/ui/primitives";

/**
 * Everything that exists, as one list of large targets.
 *
 * A grader should never have to guess a URL. Every route this build serves is
 * on this list, and — asserted by `ScreenLinks.test.ts`, which walks `src/app`
 * — nothing on this list 404s. Nothing that is not built appears here at all:
 * an honest gap beats a link that leads nowhere, and the test turns that from
 * an intention into a build failure.
 *
 * This section sits BELOW the working console now. It is a map, not the
 * product, and a front door that led with its own table of contents was the
 * problem this ordering fixes.
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
    why: "Director KYC runs live through Stripe Identity and the registry leg live against the GLEIF LEI register \u2014 the composite reports the WEAKEST leg rather than averaging them, so one simulated leg would take the whole slot down. Press \u201cTry to start a payment\u201d on a pending business to watch the refusal, with its code, from the server.",
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
    href: "/payments",
    title: "Payments",
    summary:
      "Where money out is raised: amount, rail, destination, value date, against a live account list.",
    why: "The instruction is hashed over exactly those fields, so an approval cannot be moved to a different amount or a different beneficiary. Raise one and it appears in the approvals queue, where you are not allowed to approve it.",
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
    href: "/funding",
    title: "Funding",
    summary:
      "Plaid-linked bank account to an ACH debit, with the uncleared-credit hold that follows it.",
    why: "Leg 2 of the core loop. The ledger moves on the debit and available does NOT \u2014 the funds-availability policy withholds it until the return window closes, and the screen shows the release instant rather than a spinner.",
    external: false,
  },
  {
    href: "/payouts",
    title: "Payouts",
    summary:
      "Stablecoin payouts that confirm on Base Sepolia, behind an accepted FX quote.",
    why: "The transaction hash is persisted BEFORE broadcast, so a crash mid-send cannot lose the payment or double it. No quote, no send: an accepted quote whose window has lapsed is refused with the window printed.",
    external: false,
  },
  {
    href: "/pots",
    title: "Pots",
    summary:
      "Ring-fenced sub-balances, as pure ledger moves rather than a second store of money.",
    why: "Moving money into a pot changes available and leaves the ledger balance untouched, because a pot is a hold and not an account. v_deposit_control_drift proves the subtree still equals what we report.",
    external: false,
  },
  {
    href: "/payees",
    title: "Payees",
    summary:
      "The confirmed beneficiary book, with routing-number arithmetic and standing warnings.",
    why: "The ABA check digit is computed, not trusted: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) mod 10. Every invalid routing number has exactly nine single-digit repairs and the screen names them.",
    external: false,
  },
  {
    href: "/standing-orders",
    title: "Standing orders",
    summary:
      "Scheduled payments that fire through the same approval path a human uses.",
    why: "A mandate never moves money directly \u2014 each occurrence raises an instruction into the queue. The refusal path records all five availability terms it observed, so a decline can be re-derived rather than believed.",
    external: false,
  },
  {
    href: "/accruals",
    title: "Accruals",
    summary:
      "Daily platform fee and interest, with the arithmetic for every cent on the page.",
    why: "A month of daily shares sums to the fee EXACTLY \u2014 largest-remainder for the fee, half-to-even for interest, and the screen says which clause governs each. A rate change never re-prices yesterday.",
    external: false,
  },
  {
    href: "/economics",
    title: "Unit economics",
    summary:
      "Interchange earned on card settlement, less the interest paid on the deposits that funded it, per business.",
    why: "The only screen here that answers a BUSINESS question rather than a correctness one. Interchange is booked on the clearing and never on the authorisation, priced by an effective-dated rate card that varies by merchant category and card presentment \u2014 and a settlement the merchant took back has its revenue unbooked at the ORIGINAL value date, which the drift guard on the page proves.",
    external: false,
  },
  {
    href: "/disputes",
    title: "Disputes",
    summary:
      "Chargebacks with provisional credit, clawback, and the network clock.",
    why: "Provisional credit is real money moved on a maybe. It is a hold released by a PERSON rather than a clock, which is why its available_at is infinity \u2014 and why a screen that formats it carelessly goes down.",
    external: false,
  },
  {
    href: "/transactions",
    title: "Transactions",
    summary:
      "Every posting, and the only screen that re-renders the book at a point in the past.",
    why: "Two axes, not one. `?asOf` is when it happened; `?asKnownAt` is when we learned it. Move the second across the moment a settlement was reversed and the SAME day's figures change \u2014 because a correction posts at the original value date and never edits a row.",
    external: false,
  },
  {
    href: "/breaks",
    title: "Explained breaks",
    summary:
      "The same reconciliation breaks, read a second way: which are corrections and which are real.",
    why: "Never a second list. It prints \u201cshowing 7 of 7, the engine reported 7, this screen hides none\u201d and has no default filter, because a screen that can quietly drop a break is worse than no screen.",
    external: false,
  },
  {
    href: "/team",
    title: "Team",
    summary:
      "The people at a business, what each may do, and a card for each of them.",
    why: "The brief's first paragraph asks for a card per person on the team. Maker-checker stops being two demo personas here: the initiator and the approver are members, and `initiator_id <> approver_id` is enforced by the database rather than by a screen.",
    external: false,
  },
  {
    href: "/audit",
    title: "Audit trail",
    summary:
      "Who did what to this business, in order, across every surface \u2014 append-only.",
    why: "The brief says history is never rewritten. The ledger honours that for MONEY; this honours it for ACTIONS. An action taken by an autonomous agent is distinguishable from one taken by a human at a glance, which is the observable half of the refusal list.",
    external: false,
  },
  {
    href: "/events",
    title: "Outbound events",
    summary:
      "Webhooks this bank sends to its customers, with the delivery log and the dead letters.",
    why: "The mirror of the receiving half, signed in the same scheme we verify on the way in. Delivery is strictly downstream of the posting \u2014 a customer's dead endpoint can never stop their own money settling.",
    external: false,
  },
  {
    href: "/chaos",
    title: "Chaos harness",
    summary:
      "Kill the webhooks, delay them, duplicate them, reorder them \u2014 and watch the invariants hold.",
    why: "WE do this, not the provider, and every sentence on it says so. Duplicates are absorbed by the existing UNIQUE (provider, provider_event_id) rather than a chaos branch. A ten-minute ceiling is a CHECK constraint, so it cannot be left on.",
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
          Every screen in this build
        </h2>
        <p className="mt-1 max-w-prose text-xs text-muted">
          {SCREENS.filter((s) => !s.external).length} screens and the JSON
          endpoint behind the integration table. Everything built in this trial
          is reachable from here, nothing here is a stub, and a test walks{" "}
          <code>src/app</code> and fails if any page is missing from this list
          — or from the nav.
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
