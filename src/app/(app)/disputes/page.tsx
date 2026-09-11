import { Suspense } from "react";
import type { Metadata } from "next";

import { readRole } from "@/components/app-shell/role";
import { createFixtureDisputesSource } from "@/components/disputes/fixtures";
import { DisputesSkeleton, DisputesView } from "@/components/disputes/DisputesView";
import { DisputesStateBar } from "@/components/disputes/DisputesStateBar";
import { parseDisputesFilter } from "@/components/disputes/view-state";
import type { DisputesDataSource } from "@/components/disputes/data-contract";

export const metadata: Metadata = {
  title: "Disputes · Corgi ops console",
  description:
    "Dispute intake on a settled card transaction, and provisional credit that is held rather than spendable until the network decides.",
};

/**
 * Never prerendered.
 *
 * The default state reads the live database and the role cookie, and a page
 * that ran a query at BUILD time would either bake this morning's cases into a
 * static artefact or fail the build on a machine with no database. Awaiting
 * `searchParams` already forces dynamic rendering; this says so out loud.
 */
export const dynamic = "force-dynamic";

/**
 * `/disputes` — a claim against a settled card transaction, and the provisional
 * credit that sits between the claim and the answer.
 *
 * The five states, and which of them touch the ledger:
 *
 *   default   LIVE. Every case on the customer, their live position, and the
 *             settled charges still disputable — every figure a journal sum.
 *   loading   FIXTURE. A genuinely slow source behind a real Suspense boundary,
 *             so the skeleton is the one a slow database produces.
 *   empty     FIXTURE. A customer who has never disputed anything. Not an error.
 *   error     FIXTURE. The read failed. Nothing posted; this path only reads.
 *   edge      LIVE. The case that teaches the most: a dispute LOST after
 *             provisional credit was granted, with both entries on their own
 *             value dates, neither of them a reversal, and the customer's
 *             ledger and available balance at each step of the episode.
 *
 * The edge state is live rather than a fixture on purpose. A fabricated
 * clawback would prove nothing; the whole claim is that the ledger really
 * behaves this way, and the entry ids on that screen can be looked up.
 */
export default async function DisputesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parseDisputesFilter(await searchParams);
  const role = await readRole();
  const source = await selectSource(filter.state);
  const actor = await currentActorSummary(filter.state);

  return (
    <div className="space-y-6">
      <DisputesStateBar filter={filter} />

      <Suspense
        key={`${filter.state}:${filter.businessId ?? ""}:${filter.disputeId ?? ""}`}
        fallback={<DisputesSkeleton />}
      >
        <DisputesView
          source={source}
          filter={filter}
          actorName={actor?.displayName ?? (role === "approver" ? "approver" : "staff")}
          canApprove={actor?.canApprove ?? false}
        />
      </Suspense>
    </div>
  );
}

/**
 * Live for `default` and `edge`, fixture for the rest — and fixture for the
 * live states too when there is no database to read.
 *
 * The live module is imported dynamically because importing it evaluates
 * `src/lib/env.ts`, which refuses to load without a full set of keys. That is
 * the right behaviour for the app and the wrong behaviour for a page that must
 * be able to render the words "no database configured".
 */
async function selectSource(state: string): Promise<DisputesDataSource> {
  if (state !== "default" && state !== "edge") {
    return createFixtureDisputesSource(
      state === "loading" || state === "empty" || state === "error" ? state : "default",
    );
  }

  const { hasDatabase } = await import("@/lib/disputes/screen");
  if (!hasDatabase()) return createFixtureDisputesSource("default");

  const { loadDisputesView } = await import("@/lib/disputes/screen");
  return { load: loadDisputesView };
}

/**
 * Who the console is acting as.
 *
 * Shown beside the controls rather than used to hide any of them. Maker-checker
 * lives in the trigger, so a control the current actor is not entitled to press
 * is pressed, refused by the database, and the refusal is rendered — which is a
 * far better demonstration of the control than a greyed-out button.
 */
async function currentActorSummary(
  state: string,
): Promise<{ displayName: string; canApprove: boolean } | null> {
  if (state !== "default" && state !== "edge") return null;
  try {
    const { hasDatabase } = await import("@/lib/disputes/screen");
    if (!hasDatabase()) return null;
    const { currentActor } = await import("@/lib/approvals/session");
    const actor = await currentActor();
    return actor === null ? null : { displayName: actor.displayName, canApprove: actor.canApprove };
  } catch {
    // A console that cannot name its own operator is still a usable console.
    return null;
  }
}
