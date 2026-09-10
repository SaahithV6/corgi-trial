import { Suspense } from "react";
import type { Metadata } from "next";

import { StatementStateBar } from "@/components/statements/StatementStateBar";
import { StatementsSkeleton, StatementsView } from "@/components/statements/StatementsView";
import { createFixtureStatementsSource } from "@/components/statements/fixtures";
import { parseStatementFilter } from "@/components/statements/view-state";
import type { StatementsDataSource } from "@/components/statements/data-contract";

export const metadata: Metadata = {
  title: "Statements · Corgi ops console",
};

/**
 * Never prerendered.
 *
 * The default state re-derives a published document from the live ledger and
 * checks its hash. A page that ran that at BUILD time would either bake a
 * stale verification into a static artefact — the worst possible thing to bake,
 * since the whole claim is that it is checked NOW — or fail the build on a
 * machine with no database. Awaiting `searchParams` already forces dynamic
 * rendering; this says so out loud so nobody has to know that.
 */
export const dynamic = "force-dynamic";

type StatementsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * `/statements` — the reproducible closed-day statement, and both readings of it.
 *
 * Five states, all reachable from the query string:
 *
 *   (none)          a closed day's published statement, LIVE from the ledger
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    a day closed with no statement issued yet
 *   ?state=error    the statement query failed; retry is live
 *   ?state=edge     published, then corrected by a reversal and re-book at
 *                   that day's own value date — both figures true at once
 *
 * ...plus the pickers, which are also URL state:
 *
 *   ?account=<uuid>   which customer's book
 *   ?day=YYYY-MM-DD   which closed business day
 *   ?v=<n>            which published version is the as-published side
 *
 * WHY `default` IS LIVE AND THE OTHER FOUR ARE NOT. The claim under test is
 * "re-running a closed day's statement produces a byte-identical document,
 * forever", and a fixture would satisfy it by construction and prove nothing.
 * So the default state re-derives the document from the real book at its own
 * frozen watermark and shows the hash it produced beside the hash that was
 * stored when it was issued. The other four exist to be shown in order in
 * front of a panel — which matters more here than on any other screen, because
 * the two writes behind this one (closing a day, issuing a document) are
 * append-only and permanent. There is no undo to demo with.
 *
 * When no database is configured at all, `default` falls back to the fixture
 * and the screen SAYS SO on its face; see `StatementSource` in the contract.
 *
 * The Suspense boundary is what makes the loading state honest: `StatementsView`
 * is an async server component, the fallback is the real skeleton, and
 * `?state=loading` slows the read rather than faking the render. The `key`
 * forces a fresh boundary per view so switching states or days re-suspends
 * instead of showing the previous document under a new heading — which on a
 * statements screen would be worse than a flicker.
 */
export default async function StatementsPage({ searchParams }: StatementsPageProps) {
  const filter = parseStatementFilter(await searchParams);
  const source = await selectSource(filter.state);

  return (
    <div className="space-y-6">
      <StatementStateBar filter={filter} />

      <Suspense
        key={`${filter.state}:${filter.accountId ?? ""}:${filter.businessDate ?? ""}:${filter.version ?? ""}`}
        fallback={<StatementsSkeleton />}
      >
        <StatementsView source={source} filter={filter} />
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
async function selectSource(state: string): Promise<StatementsDataSource> {
  if (state !== "default") {
    return createFixtureStatementsSource(
      state === "loading" || state === "empty" || state === "error" || state === "edge"
        ? state
        : "default",
    );
  }

  const { hasDatabase } = await import("@/lib/statements/screen");
  if (!hasDatabase()) return createFixtureStatementsSource("default");

  const { loadStatementsView } = await import("@/lib/statements/screen");
  return { load: loadStatementsView };
}
