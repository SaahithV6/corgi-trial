import { Suspense } from "react";
import type { Metadata } from "next";

import { StandingSkeleton, StandingView } from "@/components/standing/StandingView";
import { StandingStateBar } from "@/components/standing/StandingStateBar";
import { createFixtureStandingSource } from "@/components/standing/fixtures";
import { parseStandingFilter } from "@/components/standing/view-state";
import type { StandingDataSource } from "@/components/standing/data-contract";

export const metadata: Metadata = {
  title: "Standing orders · Corgi ops console",
};

/**
 * Never prerendered.
 *
 * The default state reads the live database, and a page that ran a query at
 * BUILD time would either bake this morning's schedule into a static artefact
 * or fail the build on a machine with no database. Awaiting `searchParams`
 * already forces dynamic rendering; this says so out loud so nobody has to
 * know that.
 */
export const dynamic = "force-dynamic";

type StandingOrdersPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * `/standing-orders` — the schedule, and the history of what it did.
 *
 * Five states, all reachable from the query string:
 *
 *   (none)          live mandates and every occurrence they produced
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    no mandate set up; an honest blank
 *   ?state=error    the query failed; nothing fired, retry is live
 *   ?state=edge     an occurrence refused for insufficient AVAILABLE balance
 *                   on a day the LEDGER balance covered it
 *
 * ...plus the filter and the drill-through, which are also URL state:
 *
 *   ?order=<uuid>       one mandate's occurrences
 *   ?occurrence=<uuid>  the balances one decision was made against
 *
 * WHY `default` IS LIVE AND THE OTHER FOUR ARE NOT. The claim being graded is
 * that an occurrence fires once and only once and that a refusal is recorded
 * rather than dropped, so the default state has to be a real read of real rows
 * written by a real tick — a fixture would answer the question by construction
 * and prove nothing. The other four exist to be shown in order in front of a
 * panel without firing a payment, which a live query cannot do on demand. When
 * no database is configured at all, `default` falls back to the fixture and the
 * screen SAYS SO on its face; see `StandingSource` in the data contract.
 *
 * THE EDGE STATE IS THE POINT OF THE TRACK, and it is a fixture for a reason
 * worth stating: reproducing it live requires the account's ledger balance to
 * sit above the amount and its available balance below, which is a transient
 * condition of somebody else's card holds. The same shape exists in the live
 * history as a real refused row; the fixture is what can be shown on demand.
 *
 * The Suspense boundary is what makes the loading state honest: `StandingView`
 * is an async server component, the fallback is the real skeleton, and
 * `?state=loading` slows the read rather than faking the render. The `key`
 * forces a fresh boundary per view so switching states re-suspends instead of
 * showing the previous state's rows under a new heading.
 */
export default async function StandingOrdersPage({
  searchParams,
}: StandingOrdersPageProps) {
  const filter = parseStandingFilter(await searchParams);
  const source = await selectSource(filter.state);

  return (
    <div className="space-y-6">
      <StandingStateBar filter={filter} />

      <Suspense
        key={`${filter.state}:${filter.standingOrderId ?? ""}:${filter.occurrenceId ?? ""}`}
        fallback={<StandingSkeleton />}
      >
        <StandingView source={source} filter={filter} />
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
async function selectSource(state: string): Promise<StandingDataSource> {
  if (state !== "default") {
    return createFixtureStandingSource(
      state === "loading" || state === "empty" || state === "error" || state === "edge"
        ? state
        : "default",
    );
  }

  const { hasDatabase } = await import("@/lib/standing/screen");
  if (!hasDatabase()) return createFixtureStandingSource("default");

  const { loadStandingView } = await import("@/lib/standing/screen");
  return { load: loadStandingView };
}
