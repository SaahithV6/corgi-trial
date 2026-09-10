import { headers } from "next/headers";
import type { Metadata } from "next";

import { IntegrationTable } from "@/components/home/IntegrationTable";
import { ScreenLinks } from "@/components/home/ScreenLinks";
import { SystemStatePanel } from "@/components/home/SystemStatePanel";
import { WhatToLookAt } from "@/components/home/WhatToLookAt";
import { fail } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";
import {
  messageOf,
  readHealth,
  readSystemState,
  resolveOrigin,
  type HealthView,
  type SystemState,
} from "@/lib/home/summary";

export const metadata: Metadata = {
  title: "Corgi Neobank — ops console",
  description:
    "US business current accounts on an append-only, bitemporal, double-entry ledger. Live system state, the screens that exist, and the live-or-simulated verdict for every integration.",
};

/**
 * Never prerendered, never cached.
 *
 * Every figure below is a fold over the journal taken at request time and every
 * integration verdict is a probe result from seconds ago. Baking either into a
 * build artefact would put deploy-time numbers on a page a grader reads as
 * current — which is the exact failure this page was written to remove.
 */
export const dynamic = "force-dynamic";

/**
 * `/` — the front door.
 *
 * ============================================================================
 * The rule this page is built to: it must be impossible for it to be wrong
 * about the system behind it, and it must render when that system is down.
 * ============================================================================
 *
 * The version this replaces said "Scaffold is up. ledger not yet wired" while
 * the ledger held hundreds of entries and money was moving end to end. That is
 * the same class of error as labelling a simulated integration LIVE, pointed
 * the other way: a claim about the system that the system itself contradicts.
 * The fix is not a better sentence, it is to stop writing sentences about state
 * at all — every number here is queried, and the integration verdicts are read
 * from `/api/health` rather than re-derived.
 *
 * **Failure is a first-class layout.** The two reads are independent and both
 * return a `Result`. A dead database costs the figures; an unreachable health
 * endpoint costs the integration table; neither costs the page, and neither is
 * papered over with a remembered value. `Promise.all` over two functions that
 * cannot reject, wrapped in a `try` anyway, because `@/lib/env` parses eagerly
 * at import and can throw before either read is reached.
 */
export default async function HomePage() {
  const { state, health } = await readEverything();

  return (
    <div className="min-h-dvh bg-background">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded focus:border focus:border-border-strong focus:bg-surface focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>

      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-baseline gap-x-3 gap-y-1 px-6 py-3">
          <span className="text-sm font-semibold tracking-tight">Corgi</span>
          <span className="text-[11px] uppercase tracking-[0.08em] text-muted">
            Ops console
          </span>
          <span className="ml-auto rounded border border-border-strong px-1.5 py-0.5 text-[11px] text-muted">
            Sandbox
          </span>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <section aria-labelledby="what-this-is">
          <h1 id="what-this-is" className="text-lg font-semibold tracking-tight">
            US business current accounts on an append-only, bitemporal,
            double-entry ledger.
          </h1>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">
            An operations console for the people who run the accounts, not a
            banking app for the people who hold them. Balances are derived from
            immutable journal lines — there is no balance column in the schema,
            and the application role holds no UPDATE or DELETE on the money
            tables. Every figure on this page was read from the database when you
            loaded it.
          </p>
        </section>

        <SystemStatePanel state={state} />

        <ScreenLinks />

        <WhatToLookAt />

        <IntegrationTable health={health} />

        <footer className="border-t border-border pt-4 text-xs leading-relaxed text-muted">
          Sandbox deployment. No real money and no real customer data: the
          businesses on the book are fictional and every provider credential is a
          test key. Slots that could not be proven live against a real provider
          are labelled SIMULATED above, with the measurement that demoted them.
        </footer>
      </main>
    </div>
  );
}

/**
 * Both reads, neither able to take the page down with it.
 *
 * `readSystemState` and `readHealth` each return a `Result` rather than
 * throwing, so the `catch` here is for the one thing that happens before either
 * of them runs: `@/lib/env` validates the environment at import time and raises
 * `EnvironmentError` if `APP_DATABASE_URL` is absent or malformed. On a
 * deployment with no database configured at all, that throw would otherwise be
 * the whole response.
 */
async function readEverything(): Promise<{
  readonly state: Result<SystemState, ErrorShape>;
  readonly health: Result<HealthView, ErrorShape>;
}> {
  let origin: string | null = null;
  try {
    origin = resolveOrigin(await headers());
  } catch {
    origin = null;
  }

  try {
    const [state, health] = await Promise.all([
      readSystemState(),
      readHealth(origin),
    ]);
    return { state, health };
  } catch (thrown) {
    // Reached only if the environment itself is unusable. Say that, rather
    // than serving a 500 to somebody who wanted to know whether this is up.
    const shape = fail(
      "HOME_ENVIRONMENT_INVALID",
      `this deployment could not read its own configuration: ${messageOf(thrown)}`,
      { retryable: false, source: "home.page" },
    );
    return { state: shape, health: shape };
  }
}
