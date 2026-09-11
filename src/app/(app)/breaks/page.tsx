import { Suspense } from "react";
import type { Metadata } from "next";

import { ExplainedBreaksView } from "@/components/recon/ExplainedBreaksView";
import { ReconSkeleton } from "@/components/recon/ReconSkeleton";
import { ExplainStateBar } from "@/components/recon/ExplainStateBar";
import { createFixtureExplainSource } from "@/components/recon/explain-fixtures";
import { parseExplainFilter } from "@/components/recon/explain-view-state";
import type { ExplainedDataSource } from "@/components/recon/explain-contract";

export const metadata: Metadata = {
  title: "Breaks · Corgi ops console",
};

/**
 * Never prerendered.
 *
 * The default state reads the live ledger, and a page that ran a query at
 * BUILD time would either bake last night's breaks into a static artefact or
 * fail the build on a machine with no database. Awaiting `searchParams`
 * already forces dynamic rendering; this says so out loud.
 */
export const dynamic = "force-dynamic";

type BreaksPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * `/breaks` — the reconciliation break that explains itself.
 *
 * `/reconciliation` answers "what does not match". This answers "and why", by
 * reconstructing the causal history of a discrepancy out of immutable journal
 * rows: the original, the reversal and the re-book, each carrying BOTH of the
 * system's time axes — the value date the money belongs to, and the booking
 * position at which the book learned.
 *
 * Five states, all reachable from the query string:
 *
 *   (none)          last night's file, classified, LIVE from the ledger
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    a file that reconciled clean, with nothing to explain
 *   ?state=error    the read failed; nothing moved, retry is live
 *   ?state=edge     a break whose correction group is INCOMPLETE — a reversal
 *                   with no re-book yet
 *
 * ...plus the filters and the drill-through, which are also URL state:
 *
 *   ?kind=amount_mismatch        one break category
 *   ?class=correction_open       one correction class
 *   ?run=<uuid>                  a specific run, resolved by id
 *   ?break=<kind>:<key>          open one break's timeline
 *
 * WHY THE EDGE STATE IS THE INCOMPLETE GROUP. It is the state an operator most
 * needs to understand and the one most likely to render wrong, because it is
 * the one where every signal points at "explained" — there IS a correction
 * group, the system CAN narrate it end to end — and the money is still
 * missing. A screen that gets this state wrong has taught its users that a
 * timeline means a closed ticket.
 *
 * WHY `default` IS LIVE AND THE OTHER FOUR ARE NOT. The graders plant a break
 * and drive a bitemporal correction, so the state they will exercise has to be
 * a real query against a real book; a fixture would answer the question by
 * construction. The other four exist to be shown in order in front of a panel
 * without writing a row. When no database is configured at all, `default`
 * falls back to the fixture and the screen SAYS SO on its face.
 */
export default async function BreaksPage({ searchParams }: BreaksPageProps) {
  const filter = parseExplainFilter(await searchParams);
  const source = await selectSource(filter.state);

  return (
    <div className="space-y-6">
      <ExplainStateBar filter={filter} />

      <Suspense
        key={`${filter.state}:${filter.runId ?? ""}:${filter.selected ?? ""}`}
        fallback={<ReconSkeleton />}
      >
        <ExplainedBreaksView source={source} filter={filter} />
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
async function selectSource(state: string): Promise<ExplainedDataSource> {
  if (state !== "default") {
    return createFixtureExplainSource(
      state === "loading" || state === "empty" || state === "error" || state === "edge"
        ? state
        : "default",
    );
  }

  const { hasDatabase } = await import("@/lib/recon/explained-view");
  if (!hasDatabase()) return createFixtureExplainSource("default");

  const { loadExplainedView } = await import("@/lib/recon/explained-view");
  return { load: loadExplainedView };
}
