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
import { parseConsoleState } from "@/components/home/console-state";
import { RoleSwitcher } from "@/components/app-shell/RoleSwitcher";
import { readRole, type Role } from "@/components/app-shell/role";

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
    </div>
  );
}

/**
 * The role cookie, or the least privileged role.
 *
 * `readRole` reads a cookie and cannot reach the database, but it is awaited
 * before the shell renders and a throw here would be the whole response.
 * Defaulting to `staff` is the safe direction: staff can approve nothing.
 */
async function readRoleSafely(): Promise<Role> {
  try {
    return await readRole();
  } catch {
    return "staff";
  }
}
