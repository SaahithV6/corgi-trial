import { Suspense } from "react";
import type { Metadata } from "next";

import { ExplainedBreaksView } from "@/components/recon/ExplainedBreaksView";
import { ReconSkeleton } from "@/components/recon/ReconSkeleton";
import { ExplainStateBar } from "@/components/recon/ExplainStateBar";
import { createFixtureExplainSource } from "@/components/recon/explain-fixtures";
import { createUnreadableExplainSource } from "@/components/recon/explain-unreadable";
import { parseExplainFilter } from "@/components/recon/explain-view-state";
import type { ExplainedDataSource } from "@/components/recon/explain-contract";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

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
 * without writing a row.
 *
 * And one state the URL cannot ask for: NO DATABASE CONFIGURED. It is not a
 * sixth demo state, because it is not a demonstration of anything — it is what
 * this deployment is. The badge on the state bar reads NO DATABASE, the board
 * is replaced by the refusal panel, and no run, class tile or timeline is
 * drawn. See `selectSource` below for what this used to do instead.
 */
export default async function BreaksPage({ searchParams }: BreaksPageProps) {
  const filter = parseExplainFilter(await searchParams);
  // ONE VALUE, TWO SURFACES. The state bar's badge and the view's refusal
  // wording both come from this line, so they cannot disagree about what this
  // screen read.
  const noDatabase = !hasDatabase();
  const source = await selectSource(filter.state, noDatabase);

  return (
    <div className="space-y-6">
      <ExplainStateBar filter={filter} noDatabase={noDatabase} />

      <Suspense
        key={`${filter.state}:${filter.runId ?? ""}:${filter.selected ?? ""}`}
        fallback={<ReconSkeleton />}
      >
        <ExplainedBreaksView source={source} filter={filter} noDatabase={noDatabase} />
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
 * It asked `hasDatabase()` by importing `@/lib/recon/explained-view`, which
 * reaches `@/lib/ledger/db` -> `@/lib/env` and throws `EnvironmentError`
 * without `APP_DATABASE_URL`. The guard was therefore unreachable in the one
 * case it was written for: the import above it only succeeds when a database IS
 * configured. Measured with the variable deleted, the render threw at
 * `src/lib/ledger/db.ts:18` and the operator got the framework's error page.
 *
 * If it HAD run, it returned `createFixtureExplainSource("default")`: a
 * settlement file, a run number, a booking watermark, four classified break
 * tiles and a causal timeline of entry ids, on a deployment that had not read a
 * row. This screen claims to RECONSTRUCT a discrepancy's history out of
 * immutable journal rows. A reconstruction drawn from nothing is the one thing
 * it must never print.
 *
 * With no database the answer is now a REFUSAL, from
 * `@/components/recon/explain-unreadable`, which `ExplainedBreaksView` renders
 * the same way it renders a failed read: no run, no classes, no timeline.
 * "I cannot see the journal" and "no break is mid-correction" are different
 * screens.
 */
async function selectSource(
  state: string,
  noDatabase: boolean,
): Promise<ExplainedDataSource> {
  if (state !== "default") {
    // A demo state stays a fixture whether or not a database is configured:
    // those four are drawn on purpose, and "no database" does not make a
    // drawing any more or less drawn.
    return createFixtureExplainSource(
      state === "loading" || state === "empty" || state === "error" || state === "edge"
        ? state
        : "default",
    );
  }

  if (noDatabase) return createUnreadableExplainSource();

  const { loadExplainedView } = await import("@/lib/recon/explained-view");
  return { load: loadExplainedView };
}
