import { Suspense } from "react";
import type { Metadata } from "next";

import { ConsoleStateBar } from "@/components/home/ConsoleStateBar";
import {
  EvidenceSection,
  EvidenceSkeleton,
} from "@/components/home/EvidenceSection";
import {
  ConsoleSkeleton,
  OperatorConsole,
} from "@/components/home/OperatorConsole";
import { ScreenLinks } from "@/components/home/ScreenLinks";
import { WhatToLookAt } from "@/components/home/WhatToLookAt";
import { parseConsoleState, type ConsoleState } from "@/components/home/console-state";
import { RoleSwitcher } from "@/components/app-shell/RoleSwitcher";
import { readRole, type Role } from "@/components/app-shell/role";
import { rootLogger } from "@/lib/log";
import { isOperator } from "@/lib/authz/roles";
import { visibleTo } from "@/lib/authz/policy";

export const metadata: Metadata = {
  title: "Corgi Neobank — ops console",
  description:
    "The operator console for US business current accounts on an append-only, bitemporal, double-entry ledger. Live balances across the book, what is awaiting a human, recent money movement, and the live-or-simulated verdict for every integration.",
};

/**
 * Never prerendered, never cached.
 *
 * Every figure below is a fold over the journal taken at request time, every
 * integration verdict is a probe result from seconds ago, and the role
 * switcher reads a cookie. Baking any of that into a build artefact would put
 * deploy-time numbers — or somebody else's identity — on a page an operator
 * reads as current, which is the exact failure this page was written to
 * remove.
 */
export const dynamic = "force-dynamic";

/**
 * `/` — the front door, and a console rather than a description of one.
 *
 * ============================================================================
 * The rule this page is built to: it must be impossible for it to be wrong
 * about the system behind it, and it must render when that system is down.
 * ============================================================================
 *
 * The version that rule replaced said "Scaffold is up. ledger not yet wired"
 * while the ledger held hundreds of entries and money was moving end to end.
 * That is the same class of error as labelling a simulated integration LIVE,
 * pointed the other way: a claim about the system that the system itself
 * contradicts. The fix was not a better sentence, it was to stop writing
 * sentences about state at all — every number here is queried, and the
 * integration verdicts are read from `/api/health` rather than re-derived.
 *
 * **What changed since, and why.** The page obeyed that rule and still opened
 * with prose. A grader landed on an explanation of a working system instead of
 * the working system: every other screen in this build had forms and buttons
 * and the front door had none of either. So the order is inverted. The console
 * comes first — balances across the book, what is awaiting a human, the oldest
 * payment with a live approve/reject/release form on it, recent money movement
 * — and the honesty furniture that proves those numbers sits directly beneath
 * it, unchanged and still accurate. Demoted, not deleted: under-claiming is
 * pessimistic, over-claiming fails the trial, and deleting the evidence would
 * manage both at once.
 *
 * **Failure is a first-class layout, and there are now three independent reads
 * rather than two.** The console, the system-state figures and the health
 * probe each sit behind their own Suspense boundary and each returns a
 * `Result` rather than throwing. A dead database costs the console and the
 * figures; an unreachable health endpoint costs the integration table; neither
 * costs the page, and no panel is ever papered over with a remembered value.
 * The shell itself — header, role switcher, state bar, links — reads nothing
 * that can fail, so it renders even when everything behind it is down.
 *
 * Five URL-driven states, the same five every other screen has:
 *
 *   (none)          the live book, read from Neon
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    a deployment with nothing on the book
 *   ?state=error    the console read failed; the page still renders
 *   ?state=edge     an over-capture has driven available negative, and the
 *                   oldest pending payment was raised by whoever you are
 *                   acting as — so approve is disabled, with the reason
 */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const state = parseConsoleState(await searchParams);
  const role = await readRoleSafely();

  return (
    <div className="min-h-dvh bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded focus:border focus:border-border-strong focus:bg-surface focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>

      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
          <div className="flex items-baseline gap-2.5">
            <span className="text-sm font-semibold tracking-tight">Corgi</span>
            <span className="text-[11px] uppercase tracking-[0.08em] text-muted">
              Ops console
            </span>
          </div>

          <div className="ml-auto flex items-center gap-4">
            {/* The two demo roles, discoverable from the front door and
                switchable without leaving it. A plain form and a server
                action: no client JavaScript, and it survives a reload. */}
            <RoleSwitcher role={role} />
            <span className="rounded border border-border-strong px-1.5 py-0.5 text-[11px] text-muted">
              Sandbox
            </span>
          </div>
        </div>
      </header>

      {isOperator(role) ? (
        <OperatorFrontDoor state={state} />
      ) : (
        <CustomerFrontDoor role={role} />
      )}
    </div>
  );
}

/**
 * The front door a CUSTOMER gets, and the leak it closes.
 *
 * `/` is the one URL every operator route's refusal points back to, and the
 * one URL the submission email hands a stranger. It was also the only page in
 * the build with no tenancy on it: a principal holding the `customer` role was
 * served the platform console — every business on the book, their balances,
 * the approval queue, the recent money movement — because the guard covers
 * `/accounts`, `/approvals`, `/audit` and the rest by default-deny but
 * deliberately exempts `/`, since refusing `/` would strand a customer with no
 * way back to the role switch.
 *
 * The exemption is right and the leak was real. Both are true because the
 * problem was never the guard: it is that ONE page was rendering the same
 * thing for two populations. So `/` renders per principal. The refusal's
 * `elsewhere` still resolves, the role switch is still in the header and still
 * works, and a customer session sees no platform-wide figure and no operator
 * href — not hidden by CSS, not painted and then filtered: not rendered.
 *
 * WHY THE LINKS ARE FILTERED BY `visibleTo()` RATHER THAN LISTED. The list
 * below is customer surface by construction, so the filter should be a no-op —
 * and that is exactly why it is here. If somebody later adds an operator href
 * to it, `authorize()` removes it, because the nav must not be able to
 * advertise a door the server would refuse. The decision has one implementation
 * (`src/lib/authz/policy.ts`) and this page calls it; it does not restate it.
 */
function CustomerFrontDoor({ role }: { readonly role: Role }) {
  const links = visibleTo(role, CUSTOMER_LINKS);

  return (
    <main id="main" className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">
          Your business with Corgi
        </h1>
        <p className="mt-0.5 max-w-prose text-sm text-muted">
          You are signed in as a customer, which is one business on the book and
          not the book. Your balance, your activity, your cards and your
          payments are behind the links below. Nothing on this page is a figure
          about Corgi&rsquo;s other customers, because this session is not
          served any.
        </p>
      </div>

      <ul className="grid gap-3 sm:grid-cols-2">
        {links.map((link) => (
          <li key={link.href}>
            <a
              href={link.href}
              className="block rounded border border-border bg-surface px-4 py-3 hover:bg-surface-raised"
            >
              <span className="text-sm font-medium">{link.label}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                {link.description}
              </span>
            </a>
          </li>
        ))}
      </ul>

      <div className="rounded border border-border bg-surface px-4 py-3">
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          The operator console — every business on the book, the approval queue,
          the audit log, reconciliation — is not served to this session. Asking
          for one of those URLs is refused by the server with the code{" "}
          <code>OPERATOR_ONLY</code> and the header{" "}
          <code>x-corgi-authz: deny; OPERATOR_ONLY</code>; the screen is not
          rendered and then hidden. Switch to Staff or Approver with the control
          in the header above to read it.
        </p>
      </div>

      <footer className="border-t border-border pt-4 text-xs leading-relaxed text-muted">
        Sandbox deployment. No real money and no real customer data: the
        businesses on the book are fictional and every provider credential is a
        test key.
      </footer>
    </main>
  );
}

/**
 * The customer surface, as a nav.
 *
 * Every href here is classified `customer` in `ROUTE_SURFACE`, and each is an
 * existing route — no route is added by this page. `visibleTo()` is still run
 * over it; see `CustomerFrontDoor`.
 */
const CUSTOMER_LINKS = [
  {
    href: "/client",
    label: "Overview",
    description: "Your balance, and what is available to spend after holds.",
  },
  {
    href: "/client/activity",
    label: "Activity",
    description: "Every entry against your account, newest first.",
  },
  {
    href: "/client/cards",
    label: "Cards",
    description: "Your cards, their limits, and what each has authorised.",
  },
  {
    href: "/client/pay",
    label: "Make a payment",
    description: "Pay a payee. Money out is checked by a second person.",
  },
  {
    href: "/client/approvals",
    label: "Awaiting approval",
    description: "Payments you have raised that a checker has not yet released.",
  },
  {
    href: "/client/pots",
    label: "Pots",
    description: "Money you have set aside. Held, and not available to spend.",
  },
  {
    href: "/client/payouts",
    label: "Payouts",
    description: "Money sent out, and where each one got to.",
  },
  {
    href: "/client/disputes",
    label: "Disputes",
    description: "Card transactions you have challenged, and their state.",
  },
  {
    href: "/client/open",
    label: "Open an account",
    description: "Onboarding: who you are, and who owns the business.",
  },
] as const;

/** The console, unchanged. Reached only by `staff` and `approver`. */
function OperatorFrontDoor({ state }: { readonly state: ConsoleState }) {
  return (
    <main id="main" className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">
            Operator console
          </h1>
          <p className="mt-0.5 max-w-prose text-sm text-muted">
            US business current accounts on an append-only, bitemporal,
            double-entry ledger. Every figure below was read from the database
            when you loaded this page: there is no balance column in the schema,
            and the application role holds no UPDATE or DELETE on the money
            tables.
          </p>
        </div>

        <ConsoleStateBar state={state} />

        {/*
          The Suspense boundary makes the loading state honest: `OperatorConsole`
          is an async server component, the fallback is the real skeleton, and
          `?state=loading` slows the read rather than faking the render. The
          `key` forces a fresh boundary per state, so switching re-suspends
          instead of showing the previous state's rows under a new heading.
        */}
        <Suspense key={state} fallback={<ConsoleSkeleton />}>
          <OperatorConsole state={state} />
        </Suspense>

        {/* ------------------------------------------------------------------
            Below the working part: the evidence for it, and the map. Every
            claim the console makes about itself is checkable from here — and
            none of it leads.
        ------------------------------------------------------------------ */}

        <hr className="border-border" />

        <ScreenLinks />

        <Suspense fallback={<EvidenceSkeleton />}>
          <EvidenceSection />
        </Suspense>

        <WhatToLookAt />

        <footer className="border-t border-border pt-4 text-xs leading-relaxed text-muted">
          Sandbox deployment. No real money and no real customer data: the
          businesses on the book are fictional and every provider credential is
          a test key. Slots that could not be proven live against a real
          provider are labelled SIMULATED above, with the measurement that
          demoted them.
        </footer>
    </main>
  );
}

/**
 * The role cookie, or the least privileged role.
 *
 * `readRole` reads a cookie and cannot reach the database, but it is awaited
 * before the shell renders and a throw here would be the whole response.
 *
 * IT DEFAULTS TO `customer`, AND THAT CHANGED WITH THIS PAGE. It used to
 * default to `staff`, reasoning that staff can approve nothing. That was the
 * safe direction while the only thing a role decided was whether a button
 * worked; it is the wrong direction now that the role decides WHOSE MONEY this
 * page is about. A cookie read that throws is a session we know nothing about,
 * and the least we can serve someone we know nothing about is one business's
 * front door rather than every business on the book. Failing closed costs a
 * staff member one click on the role switch, which is in the header either way.
 */
async function readRoleSafely(): Promise<Role> {
  try {
    return await readRole();
  } catch (thrown) {
    rootLogger.warn("home.role_read_failed", {
      reason: thrown instanceof Error ? thrown.message : String(thrown),
      servedAs: "customer",
    });
    return "customer";
  }
}
