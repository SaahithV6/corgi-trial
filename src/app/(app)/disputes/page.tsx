import { Suspense } from "react";
import type { Metadata } from "next";

import { readRole } from "@/components/app-shell/role";
import { createFixtureDisputesSource } from "@/components/disputes/fixtures";
import { createUnreadableDisputesSource } from "@/components/disputes/unreadable";
import { DisputesSkeleton, DisputesView } from "@/components/disputes/DisputesView";
import { DisputesStateBar } from "@/components/disputes/DisputesStateBar";
import { parseDisputesFilter } from "@/components/disputes/view-state";
import type { DisputesDataSource } from "@/components/disputes/data-contract";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

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
 *
 * And one state the URL cannot ask for: NO DATABASE CONFIGURED. It is not a
 * sixth demo state, because it is not a demonstration of anything — it is what
 * this deployment is. The badge on the state bar reads NO DATABASE, the cases
 * are replaced by the refusal panel, and no case, balance or settled charge is
 * drawn. See `selectSource` below for what this used to do instead.
 */
export default async function DisputesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parseDisputesFilter(await searchParams);
  // ONE VALUE, TWO SURFACES. The state bar's badge and the view's refusal
  // wording both come from this line, so they cannot disagree about what this
  // screen read.
  const noDatabase = !hasDatabase();
  const source = await selectSource(filter.state, noDatabase);
  // Neither the role cookie nor the actor is read when the screen is refusing.
  // There is no board to label and no control to sit beside one, and naming an
  // operator on a screen that read nothing is a second claim about a session
  // this deployment cannot check either.
  const role = noDatabase ? "staff" : await readRole();
  const actor = noDatabase ? null : await currentActorSummary(filter.state);

  return (
    <div className="space-y-6">
      <DisputesStateBar filter={filter} noDatabase={noDatabase} />

      <Suspense
        key={`${filter.state}:${filter.businessId ?? ""}:${filter.disputeId ?? ""}`}
        fallback={<DisputesSkeleton />}
      >
        <DisputesView
          source={source}
          filter={filter}
          actorName={actor?.displayName ?? (role === "approver" ? "approver" : "staff")}
          canApprove={actor?.canApprove ?? false}
          noDatabase={noDatabase}
        />
      </Suspense>
    </div>
  );
}

/**
 * Live for `default` and `edge`, fixture for the rest — and a REFUSAL for the
 * two live states when there is no database to read.
 *
 * The live module is imported dynamically because importing it evaluates
 * `src/lib/env.ts`, which refuses to load without a full set of keys. That is
 * the right behaviour for the app and the wrong behaviour for a page that must
 * be able to render the words "no database configured" — so the import happens
 * only on the branch that has already established there is a database to read.
 *
 * WHAT THIS FUNCTION USED TO DO, AND WHY IT IS THE DEFECT THIS SCREEN CARRIED.
 * It asked `hasDatabase()` by importing `@/lib/disputes/screen`, which reaches
 * `@/lib/ledger/db` -> `@/lib/env` and throws `EnvironmentError` without
 * `APP_DATABASE_URL`. The guard was therefore unreachable in the one case it
 * was written for: the import above it only succeeds when a database IS
 * configured. Measured with the variable deleted, this page did not render
 * "no database configured" — the page MODULE failed to load and the operator
 * got the framework's error page.
 *
 * If it HAD run, it returned `createFixtureDisputesSource("default")`: a named
 * customer, a ledger balance, an available balance and a list of cases with
 * their states. Every one of those is a claim about somebody's money, printed
 * next to a name by a deployment that had read nothing.
 *
 * With no database the answer is now a REFUSAL, from
 * `@/components/disputes/unreadable`, which `DisputesView` renders the same way
 * it renders a failed read: no cases, no balances, no charges.
 */
async function selectSource(
  state: string,
  noDatabase: boolean,
): Promise<DisputesDataSource> {
  if (state !== "default" && state !== "edge") {
    // A demo state stays a fixture whether or not a database is configured:
    // those three are drawn on purpose, and "no database" does not make a
    // drawing any more or less drawn.
    return createFixtureDisputesSource(
      state === "loading" || state === "empty" || state === "error" ? state : "default",
    );
  }

  if (noDatabase) return createUnreadableDisputesSource();

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
 *
 * Only reached when there IS a database: the caller does not ask otherwise. The
 * `await import("@/lib/disputes/screen")` that used to stand here to check that
 * is gone, because it was the defective shape twice over — the import evaluates
 * `@/lib/env` and throws without `APP_DATABASE_URL`, so the check below it
 * could not run in the case it was written for, and the throw was then caught
 * by the `catch` below and reported as "cannot name the operator" rather than
 * as the configuration state it was.
 */
async function currentActorSummary(
  state: string,
): Promise<{ displayName: string; canApprove: boolean } | null> {
  if (state !== "default" && state !== "edge") return null;
  try {
    const { currentActor } = await import("@/lib/approvals/session");
    const actor = await currentActor();
    return actor === null ? null : { displayName: actor.displayName, canApprove: actor.canApprove };
  } catch {
    // A console that cannot name its own operator is still a usable console.
    return null;
  }
}
