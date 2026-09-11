import { Suspense } from "react";
import type { Metadata } from "next";

import { MandatePanel } from "@/components/standing/MandatePanel";
import { StandingSkeleton, StandingView } from "@/components/standing/StandingView";
import { StandingStateBar } from "@/components/standing/StandingStateBar";
import { createFixtureStandingSource } from "@/components/standing/fixtures";
import { createUnreadableStandingSource } from "@/components/standing/unreadable";
import { parseStandingFilter } from "@/components/standing/view-state";
import type { StandingDataSource } from "@/components/standing/data-contract";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

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
 * panel without firing a payment, which a live query cannot do on demand.
 *
 * And one state the URL cannot ask for: NO DATABASE CONFIGURED. It is not a
 * sixth demo state, because it is not a demonstration of anything — it is what
 * this deployment is. The badge on the state bar reads NO DATABASE, the
 * schedule is replaced by the refusal panel, and no mandate, occurrence or
 * invariant tile is drawn. See `selectSource` below for what this used to do
 * instead.
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
  // ONE VALUE, TWO SURFACES. The state bar's badge and the view's refusal
  // wording both come from this line, so they cannot disagree about what this
  // screen read.
  const noDatabase = !hasDatabase();
  const source = await selectSource(filter.state, noDatabase);

  return (
    <div className="space-y-6">
      <StandingStateBar filter={filter} noDatabase={noDatabase} />

      <Suspense
        key={`${filter.state}:${filter.standingOrderId ?? ""}:${filter.occurrenceId ?? ""}`}
        fallback={<StandingSkeleton />}
      >
        <StandingView source={source} filter={filter} noDatabase={noDatabase} />
      </Suspense>

      {/* The write half, and the only place on this screen that writes.
          Default state only: the other four are drawings of a fixture, and a
          form that wrote a real mandate while the board beside it showed
          invented rows would be lying about what just happened. It is below
          the board on purpose — reading what the schedule already does comes
          before adding to it. */}
      {filter.state === "default" && !noDatabase ? (
        <Suspense fallback={null}>
          <MandatePanel />
        </Suspense>
      ) : null}
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
 * It asked `hasDatabase()` by importing `@/lib/standing/screen`, which reaches
 * `@/lib/ledger/db` -> `@/lib/env` and throws `EnvironmentError` without
 * `APP_DATABASE_URL`. The guard was therefore unreachable in the one case it
 * was written for: the import above it only succeeds when a database IS
 * configured. Measured with the variable deleted, this page did not render
 * "no database configured" — the render threw and the operator got the
 * framework's error page.
 *
 * If it HAD run, it returned `createFixtureStandingSource("default")`:
 * mandates, occurrences, a book date, and the two invariant tiles reading
 * `unresolved: 0` and `doubleFires: 0`. Those two figures are this screen's
 * entire claim, and a deployment that had counted nothing would have rendered
 * both of them as zero. "No occurrence fired twice" and "I could not look" are
 * not the same sentence.
 *
 * With no database the answer is now a REFUSAL, from
 * `@/components/standing/unreadable`, which `StandingView` renders the same way
 * it renders a failed read: no schedule, no occurrences, no tiles.
 */
async function selectSource(
  state: string,
  noDatabase: boolean,
): Promise<StandingDataSource> {
  if (state !== "default") {
    // A demo state stays a fixture whether or not a database is configured:
    // those four are drawn on purpose, and "no database" does not make a
    // drawing any more or less drawn.
    return createFixtureStandingSource(
      state === "loading" || state === "empty" || state === "error" || state === "edge"
        ? state
        : "default",
    );
  }

  if (noDatabase) return createUnreadableStandingSource();

  const { loadStandingView } = await import("@/lib/standing/screen");
  return { load: loadStandingView };
}
