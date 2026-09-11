import { Suspense } from "react";
import type { Metadata } from "next";

import { AccrualSkeleton, AccrualView } from "@/components/accrual/AccrualView";
import { AccrualStateBar } from "@/components/accrual/AccrualStateBar";
import { createFixtureAccrualSource } from "@/components/accrual/fixtures";
import { createUnreadableAccrualSource } from "@/components/accrual/unreadable";
import { parseAccrualFilter } from "@/components/accrual/view-state";
import type { AccrualDataSource } from "@/components/accrual/data-contract";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

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
 * TWO PRODUCTS ON ONE SCREEN AND ONE TICK. The platform fee (DESIGN §12.3,
 * largest remainder, because a month's price is split across its days) and
 * daily interest (DESIGN §12.2, half to even, because there is no total to
 * split). They are deliberately not two pages: the interesting thing about
 * them is that they round by different rules on the same book for a stated
 * reason, and you cannot see that if they are apart.
 *
 * Five states, all reachable from the query string:
 *
 *   (none)          every schedule and every day either product accrued, live
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    nobody enrolled; an honest blank
 *   ?state=error    the query failed; nothing accrued, retry is live
 *   ?state=edge     TWO ONE-CENT STEPS, ONE PER PRODUCT, on adjacent days of
 *                   one account each, for two different reasons.
 *                   THE FEE: the 10th and the 11th of a 30-day month — the last
 *                   day that carries a residual penny and the first that does
 *                   not (§12.3/§12.4).
 *                   THE INTEREST: the 8th and the 9th of September — the last
 *                   day priced by the 1.50% card and the first priced by the
 *                   1.25% one. The balance went UP between them and the amount
 *                   went DOWN, so nothing but the rate explains it, and a
 *                   replay of the 8th still resolves the 1.50% card.
 *
 * ...plus the filters and the drill-throughs, which are also URL state:
 *
 *   ?schedule=<uuid>  one enrolment's days (either product)
 *   ?day=<uuid>       the full working for one FEE date
 *   ?interest=<uuid>  the full working for one INTEREST date
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
 * fixture computes its figures with the same `allocateForDate()` and
 * `computeDailyInterest()` the ledger calls, so it cannot disagree with either
 * rule. What it borrows is the calendar: it puts the two days of each pair on
 * one screen so the one-cent step is visible now rather than tomorrow. Both
 * steps exist in the live table as real entries — 2026-09-10 accrues 84¢ and
 * 2026-09-11 accrues 83¢ on the $25.00 plan; 2026-09-08 accrues 8¢ and
 * 2026-09-09 accrues 7¢ on Kettle & Crumb's balance — and the live rows are
 * the evidence; the fixture is the demo.
 *
 * WHAT THE EDGE STATE DOES *NOT* SHOW, AND WHY. The natural edge for an
 * interest product is the day an account crosses zero, so that both rates
 * appear on one account in one view. This book has no such day:
 * `v_overdrawn_accounts` is empty and no deposit leaf has been in debit on any
 * value date in the catch-up window — measured, at the live watermark, before
 * a line of this was written. The screen says so on its face in the overdraft
 * measurement panel rather than manufacturing an overdraft to photograph. The
 * rate-change edge is the one this book can actually demonstrate, and it tests
 * the same machinery: two rates on one account on adjacent days, resolved by
 * the accrual date.
 *
 * The Suspense boundary is what makes the loading state honest: `AccrualView`
 * is an async server component, the fallback is the real skeleton, and
 * `?state=loading` slows the read rather than faking the render. The `key`
 * forces a fresh boundary per view so switching states re-suspends instead of
 * showing the previous state's rows under a new heading.
 */
export default async function AccrualsPage({ searchParams }: AccrualsPageProps) {
  const filter = parseAccrualFilter(await searchParams);
  // ONE VALUE, TWO SURFACES. The state bar's badge and note, and which source
  // `AccrualView` reads through, both come from this line, so they cannot
  // disagree about what this screen read.
  const noDatabase = !hasDatabase();
  const source = await selectSource(filter.state, noDatabase);

  return (
    <div className="space-y-6">
      <AccrualStateBar filter={filter} noDatabase={noDatabase} />

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
 * It asked `hasDatabase()` by destructuring it off
 * `await import("@/lib/accrual/screen")`, and that module reaches
 * `@/lib/ledger/db` -> `@/lib/env`, which throws `EnvironmentError` at module
 * scope without `APP_DATABASE_URL`. The guard was unreachable in the one case
 * it was written for: the import on its own line only succeeds when a database
 * IS configured, and the predicate returns false only when one is not.
 * Measured with the variable deleted, the render threw and the operator got the
 * framework's error page.
 *
 * If it HAD run, it returned `createFixtureAccrualSource("default")`: a
 * schedule table, a month table, priced days, and the four invariant counts
 * rendered by `SummaryTiles` as the word EXACT beside "no closed month is a
 * cent out". Nought rows in `v_accrual_month_drift` means a month summed to its
 * price to the cent BECAUSE THE VIEW WAS QUERIED; nought from a deployment that
 * opened no connection is a clean bill on a book nobody looked at. The `gap`
 * tile is the same failure pointing the other way: a gap of nought is what
 * tells an operator the tick is keeping up.
 *
 * With no database the answer is now a REFUSAL, from
 * `@/components/accrual/unreadable`, which `AccrualView` renders the same way it
 * renders a failed read: no schedule, no day, no invariant verdict.
 */
async function selectSource(
  state: string,
  noDatabase: boolean,
): Promise<AccrualDataSource> {
  // The four drawn states are checked FIRST, and stay drawn whether or not a
  // database is configured: they are demonstrations, and "no database" does not
  // make a drawing any more or less drawn.
  if (state !== "default") {
    return createFixtureAccrualSource(
      state === "loading" || state === "empty" || state === "error" || state === "edge"
        ? state
        : "default",
    );
  }

  if (noDatabase) return createUnreadableAccrualSource();

  const { loadAccrualView } = await import("@/lib/accrual/screen");
  return { load: loadAccrualView };
}
