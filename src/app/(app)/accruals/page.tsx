import { Suspense } from "react";
import type { Metadata } from "next";

import { AccrualSkeleton, AccrualView } from "@/components/accrual/AccrualView";
import { AccrualStateBar } from "@/components/accrual/AccrualStateBar";
import { createFixtureAccrualSource } from "@/components/accrual/fixtures";
import { parseAccrualFilter } from "@/components/accrual/view-state";
import type { AccrualDataSource } from "@/components/accrual/data-contract";

export const metadata: Metadata = {
  title: "Accruals · Corgi ops console",
};

/**
 * Never prerendered.
 *
 * The default state reads the live database, and a page that ran a query at
 * BUILD time would either bake this morning's postings into a static artefact
 * or fail the build on a machine with no database. Awaiting `searchParams`
 * already forces dynamic rendering; this says so out loud so nobody has to
 * know that.
 */
export const dynamic = "force-dynamic";

type AccrualsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * `/accruals` — what accrued, on which day, and the arithmetic that produced it.
 *
 * Five states, all reachable from the query string:
 *
 *   (none)          every schedule and every day it has accrued, live
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    nobody enrolled; an honest blank
 *   ?state=error    the query failed; nothing accrued, retry is live
 *   ?state=edge     THE DAY THE RESIDUAL PENNY LANDS — the 10th and the 11th of
 *                   a 30-day month side by side, differing by one cent for one
 *                   stated reason
 *
 * ...plus the filter and the drill-through, which are also URL state:
 *
 *   ?schedule=<uuid>  one plan's days
 *   ?day=<uuid>       the full working for one date
 *
 * WHY `default` IS LIVE AND THE OTHER FOUR ARE NOT. The claim being graded is
 * that a fee accrues once per day, at the right value date, and that a month of
 * them sums to the price exactly — so the default state has to be a real read
 * of real entries posted by a real tick. A fixture would answer the question by
 * construction and prove nothing. The other four exist to be shown in order in
 * front of a panel without running the tick, which matters more here than on
 * any other screen in this console: an accrual tick posts money to a customer's
 * account with no human in between. When no database is configured at all,
 * `default` falls back to the fixture and the screen SAYS SO on its face.
 *
 * THE EDGE STATE IS A FIXTURE, AND THE THING IT SHOWS IS NOT MADE UP. The
 * fixture computes its figures with the same `allocateForDate()` the ledger
 * calls, so it cannot disagree with the rule. What it borrows is the calendar:
 * it puts the 10th and the 11th on one screen so the one-cent step is visible
 * now rather than tomorrow. The same step exists in the live table as real
 * entries — 2026-09-10 accrues 84¢ and 2026-09-11 accrues 83¢ on the $25.00
 * plan — and the live rows are the evidence; the fixture is the demo.
 *
 * The Suspense boundary is what makes the loading state honest: `AccrualView`
 * is an async server component, the fallback is the real skeleton, and
 * `?state=loading` slows the read rather than faking the render. The `key`
 * forces a fresh boundary per view so switching states re-suspends instead of
 * showing the previous state's rows under a new heading.
 */
export default async function AccrualsPage({ searchParams }: AccrualsPageProps) {
  const filter = parseAccrualFilter(await searchParams);
  const source = await selectSource(filter.state);

  return (
    <div className="space-y-6">
      <AccrualStateBar filter={filter} />

      <Suspense
        key={`${filter.state}:${filter.scheduleId ?? ""}:${filter.accrualDayId ?? ""}`}
        fallback={<AccrualSkeleton />}
      >
        <AccrualView source={source} filter={filter} />
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
async function selectSource(state: string): Promise<AccrualDataSource> {
  if (state !== "default") {
    return createFixtureAccrualSource(
      state === "loading" || state === "empty" || state === "error" || state === "edge"
        ? state
        : "default",
    );
  }

  const { hasDatabase } = await import("@/lib/accrual/screen");
  if (!hasDatabase()) return createFixtureAccrualSource("default");

  const { loadAccrualView } = await import("@/lib/accrual/screen");
  return { load: loadAccrualView };
}
