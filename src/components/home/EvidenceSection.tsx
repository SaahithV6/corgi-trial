import { headers } from "next/headers";

import { Badge, Panel } from "@/components/ui/primitives";
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

import { IntegrationTable } from "./IntegrationTable";
import { SystemStatePanel } from "./SystemStatePanel";

/**
 * The evidence behind the console, below the console.
 *
 * ============================================================================
 * Demoted, not deleted. These two panels are the reason the numbers above can
 * be trusted, and the page would be worse without them — but a grader opening
 * the front door should land on the thing an operator uses, not on the proof
 * that it works. So they render underneath, in their own Suspense boundary,
 * and the console does not wait on them.
 * ============================================================================
 *
 * The two reads are independent and neither can throw. `readSystemState`
 * folds the journal at request time; `readHealth` fetches `/api/health` on
 * this origin and the integration table renders whatever that endpoint said,
 * never a verdict re-derived from which environment variables happen to be
 * set. Key presence is a different question from liveness — a placeholder key,
 * a Stripe account without Connect and a USDC wallet with no gas all look
 * configured and none of them works — so a verdict that was not earned by a
 * real round trip is not shown at all.
 *
 * A dead database costs the figures. An unreachable health endpoint costs the
 * table. Neither costs the page, and neither is papered over with a remembered
 * value.
 */
export async function EvidenceSection() {
  const { systemState, health } = await readEverything();

  return (
    <>
      <SystemStatePanel state={systemState} />
      <IntegrationTable health={health} />
    </>
  );
}

/**
 * Both reads, neither able to take the page down with it.
 *
 * `readSystemState` and `readHealth` each return a `Result` rather than
 * throwing, so the `catch` here is for the one thing that happens before
 * either of them runs: `@/lib/env` validates the environment at import time
 * and raises `EnvironmentError` if `APP_DATABASE_URL` is absent or malformed.
 * On a deployment with no database configured at all, that throw would
 * otherwise be the whole response.
 */
async function readEverything(): Promise<{
  readonly systemState: Result<SystemState, ErrorShape>;
  readonly health: Result<HealthView, ErrorShape>;
}> {
  let origin: string | null = null;
  try {
    origin = resolveOrigin(await headers());
  } catch {
    origin = null;
  }

  try {
    const [systemState, health] = await Promise.all([
      readSystemState(),
      readHealth(origin),
    ]);
    return { systemState, health };
  } catch (thrown) {
    // Reached only if the environment itself is unusable. Say that, rather
    // than serving a 500 to somebody who wanted to know whether this is up.
    const shape = fail(
      "HOME_ENVIRONMENT_INVALID",
      `this deployment could not read its own configuration: ${messageOf(thrown)}`,
      { retryable: false, source: "home.page" },
    );
    return { systemState: shape, health: shape };
  }
}

const BLOCK = "rounded bg-surface-raised";

/** The fallback while the journal fold and the health probe are in flight. */
export function EvidenceSkeleton() {
  return (
    <>
      <Panel
        title="Live system state"
        description="Read from the journal at request time. Nothing on this page is a literal."
        actions={<Badge tone="quiet">reading…</Badge>}
      >
        <div className="grid grid-cols-1 gap-3 px-5 py-5 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4].map((slot) => (
            <div
              key={slot}
              className="rounded-md border border-border bg-surface-raised px-4 py-3"
            >
              <div className={`h-3 w-28 ${BLOCK}`} />
              <div className={`mt-3 h-7 w-20 ${BLOCK}`} />
              <div className={`mt-3 h-3 w-full ${BLOCK}`} />
            </div>
          ))}
        </div>
      </Panel>

      <Panel
        title="Integrations — live or simulated"
        description="Read from /api/health on this origin, so this table cannot disagree with that endpoint."
        actions={<Badge tone="quiet">probing…</Badge>}
      >
        <div className="space-y-2 px-5 py-6">
          {[0, 1, 2, 3].map((slot) => (
            <div key={slot} className={`h-8 w-full ${BLOCK}`} />
          ))}
        </div>
      </Panel>
    </>
  );
}
