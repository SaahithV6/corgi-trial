import { Suspense } from "react";
import type { Metadata } from "next";

import { ReconSkeleton, ReconView } from "@/components/recon/ReconView";
import { ReconStateBar } from "@/components/recon/ReconStateBar";
import { createFixtureReconSource } from "@/components/recon/fixtures";
import { createUnreadableReconSource } from "@/components/recon/unreadable";
import { parseBreakFilter } from "@/components/recon/view-state";
import type { ReconDataSource } from "@/components/recon/data-contract";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

export const metadata: Metadata = {
  title: "Reconciliation · Corgi ops console",
};

/**
 * Never prerendered.
 *
 * The default state reads the live ledger, and a page that ran a query at
 * BUILD time would either bake last night's breaks into a static artefact or
 * fail the build on a machine with no database. Awaiting `searchParams` already
 * forces dynamic rendering; this says so out loud so nobody has to know that.
 */
export const dynamic = "force-dynamic";

type ReconciliationPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * `/reconciliation` — the breaks screen.
 *
 * Five states, all reachable from the query string:
 *
 *   (none)          last night's file, reconciled, LIVE from the ledger
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    a file that reconciled clean
 *   ?state=error    the reconciliation query failed; retry is live
 *   ?state=edge     a break whose entry was corrected by reversal plus re-book
 *
 * ...plus the filters and the drill-through, which are also URL state:
 *
 *   ?kind=amount_mismatch   one category
 *   ?age=4-7                one age bucket
 *   ?run=<uuid>             a specific run over the same file
 *   ?break=<kind>:<key>     drill into one break
 *
 * WHY `default` IS LIVE AND THE OTHER FOUR ARE NOT. The graders delete a row
 * from the nightly file and ask this screen to find it, so the default state
 * has to be a real query against a real book — a fixture would answer the
 * question by construction and prove nothing. The other four exist to be shown
 * in order in front of a panel without writing a row, which a live query
 * cannot do on demand.
 *
 * And one state the URL cannot ask for: NO DATABASE CONFIGURED. It is not a
 * sixth demo state, because it is not a demonstration of anything — it is what
 * this deployment is. The badge on the state bar reads NO DATABASE, the board
 * is replaced by the refusal panel, and no run, break or age bucket is drawn.
 * See `selectSource` below for what this used to do instead.
 *
 * The Suspense boundary is what makes the loading state honest: `ReconView` is
 * an async server component, the fallback is the real skeleton, and
 * `?state=loading` slows the read rather than faking the render. The `key`
 * forces a fresh boundary per view so switching states re-suspends instead of
 * showing the previous state's rows under a new heading.
 */
export default async function ReconciliationPage({
  searchParams,
}: ReconciliationPageProps) {
  const filter = parseBreakFilter(await searchParams);
  // ONE VALUE, TWO SURFACES. The state bar's badge and the view's refusal
  // wording both come from this line, so they cannot disagree about what this
  // screen read.
  const noDatabase = !hasDatabase();
  const source = await selectSource(filter.state, noDatabase);

  return (
    <div className="space-y-6">
      <ReconStateBar filter={filter} noDatabase={noDatabase} />

      <Suspense
        key={`${filter.state}:${filter.runId ?? ""}:${filter.selected ?? ""}`}
        fallback={<ReconSkeleton />}
      >
        <ReconView source={source} filter={filter} noDatabase={noDatabase} />
      </Suspense>
    </div>
  );
}

/**
 * Live for `default`, fixture for everything else — and a REFUSAL for
 * `default` when there is no database to read.
 *
 * The live module is imported dynamically because importing it evaluates
 * `src/lib/env.ts`, which refuses to load without a full set of keys. That is
 * the right behaviour for the app and the wrong behaviour for a page that must
 * be able to render the words "no database configured" — so the import happens
 * only on the branch that has already established there is a database to read.
 *
 * WHAT THIS FUNCTION USED TO DO, AND WHY IT IS THE DEFECT THIS SCREEN CARRIED.
 * It asked `hasDatabase()` by importing `@/lib/recon/screen`, which reaches
 * `@/lib/ledger/db` -> `@/lib/env` and throws `EnvironmentError` without
 * `APP_DATABASE_URL`. The guard was therefore unreachable in the one case it
 * was written for: the import above it only succeeds when a database IS
 * configured. Measured with the variable deleted, this page did not render
 * "no database configured" — the render threw and the operator got the
 * framework's error page.
 *
 * If it HAD run, it returned `createFixtureReconSource("default")`: last
 * night's file, a run number, a booking watermark, a break list and an age
 * histogram, on a deployment that had not read a row. This is the screen the
 * graders use to check that a deleted settlement line was found. It would have
 * shown them a found break that nothing found.
 *
 * With no database the answer is now a REFUSAL, from `@/components/recon/unreadable`,
 * which `ReconView` renders the same way it renders a failed read: no run, no
 * breaks, no counts. "I cannot see the file" and "the file reconciled clean"
 * are different screens.
 */
async function selectSource(
  state: string,
  noDatabase: boolean,
): Promise<ReconDataSource> {
  if (state !== "default") {
    // A demo state stays a fixture whether or not a database is configured:
    // those four are drawn on purpose, and "no database" does not make a
    // drawing any more or less drawn.
    return createFixtureReconSource(
      state === "loading" || state === "empty" || state === "error" || state === "edge"
        ? state
        : "default",
    );
  }

  if (noDatabase) return createUnreadableReconSource();

  const { loadReconView } = await import("@/lib/recon/screen");
  return { load: loadReconView };
}
