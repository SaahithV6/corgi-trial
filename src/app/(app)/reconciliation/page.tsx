import { Suspense } from "react";
import type { Metadata } from "next";

import { ReconSkeleton, ReconView } from "@/components/recon/ReconView";
import { ReconStateBar } from "@/components/recon/ReconStateBar";
import { createFixtureReconSource } from "@/components/recon/fixtures";
import { parseBreakFilter } from "@/components/recon/view-state";
import type { ReconDataSource } from "@/components/recon/data-contract";

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
 * cannot do on demand. When no database is configured at all, `default` falls
 * back to the fixture and the screen SAYS SO on its face; see `ReconSource` in
 * the data contract.
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
  const source = await selectSource(filter.state);

  return (
    <div className="space-y-6">
      <ReconStateBar filter={filter} />

      <Suspense
        key={`${filter.state}:${filter.runId ?? ""}:${filter.selected ?? ""}`}
        fallback={<ReconSkeleton />}
      >
        <ReconView source={source} filter={filter} />
      </Suspense>
    </div>
  );
}

/**
 * Live for `default`, fixture for everything else — and fixture for `default`
 * too when there is no database to read.
 *
 * The live module is imported dynamically because importing it evaluates
 * `src/lib/env.ts`, which refuses to load without a full set of keys. That is
 * the right behaviour for the app and the wrong behaviour for a page that must
 * be able to render the words "no database configured".
 */
async function selectSource(state: string): Promise<ReconDataSource> {
  if (state !== "default") {
    return createFixtureReconSource(
      state === "loading" || state === "empty" || state === "error" || state === "edge"
        ? state
        : "default",
    );
  }

  const { hasDatabase } = await import("@/lib/recon/screen");
  if (!hasDatabase()) return createFixtureReconSource("default");

  const { loadReconView } = await import("@/lib/recon/screen");
  return { load: loadReconView };
}
