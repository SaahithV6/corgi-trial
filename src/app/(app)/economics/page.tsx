import { Suspense } from "react";
import type { Metadata } from "next";

import { EconomicsRefusal } from "@/components/economics/EconomicsRefusal";
import { EconomicsStateBar } from "@/components/economics/EconomicsStateBar";
import { createFixtureEconomicsSource } from "@/components/economics/fixtures";
import { ECONOMICS_BOOK_UNREADABLE } from "@/components/economics/unreadable";
import { parseEconomicsFilter } from "@/components/economics/view-state";
import type { EconomicsDataSource } from "@/lib/interchange/screen";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

export const metadata: Metadata = {
  title: "Unit economics · Corgi ops console",
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

type EconomicsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * `/economics` — does the card programme make money.
 *
 * THIS IS THE ONE SCREEN IN THE CONSOLE THAT ANSWERS A BUSINESS QUESTION.
 * Every other posting in this build answers a correctness question — did the
 * money move, did it balance, can we prove what we believed on Tuesday. This
 * one asks whether the thing is worth running: interchange earned on card
 * settlement, less the interest paid on the deposits that funded the balances
 * and the platform fee charged against them, per customer, from postings rather
 * than from a spreadsheet.
 *
 * Five states, all reachable from the query string:
 *
 *   (none)          live: every business, every band of the rate card, the most
 *                   recent priced settlements and the three guards, counted
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    a programme that has never settled a card; an honest blank
 *                   that still shows the rate card, because the card is in
 *                   force whether or not anything has priced against it
 *   ?state=error    the read failed; nothing is shown rather than a stale number
 *   ?state=edge     THE TWO CASES THIS FEATURE TURNS ON, side by side:
 *                   an EXACT half-cent tie broken to the even cent (DESIGN
 *                   §12.2 — the case half-up would get different, and the
 *                   reason §12.2 gives for half-even is literally about
 *                   interchange), and a settlement the merchant took back whose
 *                   interchange was unbooked at the ORIGINAL value date, now
 *                   worth exactly zero.
 *
 * ...plus the drill-through, which is also URL state:
 *
 *   ?settlement=<uuid>   the whole arithmetic for one priced settlement, as
 *                        integers, with the entry ids on both sides
 *
 * WHY `default` IS LIVE AND THE OTHER FOUR ARE NOT. The claim being graded is
 * that interchange is booked on real settlements at a real effective-dated rate
 * card and that a reversal unbooks it — so the default state has to be a real
 * read of real entries posted through `postEntry()`. A fixture would answer the
 * question by construction and prove nothing. The other four exist to be shown
 * in order in front of a panel without waiting for the book to be in the right
 * shape.
 *
 * And one state the URL cannot ask for: NO DATABASE CONFIGURED. It is not a
 * sixth demo state, because it is not a demonstration of anything — it is what
 * this deployment is. The badge on the state bar reads NO DATABASE, the board
 * is replaced by the refusal panel, and no contribution, rate band, settlement
 * or guard is drawn. See `selectSource` below for what this used to do instead.
 *
 * THE BOARD IS LOADED DYNAMICALLY, AND THAT IS PART OF THE SAME REPAIR.
 * `EconomicsView.tsx` imports `portfolioTotals` and `formatBps` from
 * `@/lib/interchange/screen` as VALUES, and that module reaches
 * `@/lib/ledger/db` -> `@/lib/env`, which throws at module scope with no
 * `APP_DATABASE_URL`. Imported statically it took this page module down with
 * it, so every fixture state was unreachable too — a screen cannot say "no
 * database configured" out of a module that cannot be evaluated without one.
 * `EconomicsRefusal` is in its own file for the same reason, and imports
 * nothing from `@/lib/interchange/**`.
 *
 * The Suspense boundary is what makes the loading state honest: `EconomicsView`
 * is an async server component, the fallback is the real skeleton, and
 * `?state=loading` slows the READ rather than faking the render. The `key`
 * forces a fresh boundary per view so switching states re-suspends instead of
 * showing the previous state's rows under a new heading.
 */
export default async function EconomicsPage({ searchParams }: EconomicsPageProps) {
  const filter = parseEconomicsFilter(await searchParams);
  // ONE VALUE, TWO SURFACES. The state bar's badge and whether the board is
  // loaded at all both come from this line, so they cannot disagree about what
  // this screen read.
  const noDatabase = !hasDatabase();

  if (noDatabase && filter.state === "default") {
    return (
      <div className="space-y-6">
        <EconomicsStateBar filter={filter} noDatabase={noDatabase} />
        <EconomicsRefusal
          error={ECONOMICS_BOOK_UNREADABLE}
          title="This screen cannot see the book"
          description="No database is configured for this deployment, so nothing was priced and nothing is shown. Nothing here says the programme has earned nothing; nothing here could."
        />
      </div>
    );
  }

  const source = await selectSource(filter.state);
  const { EconomicsSkeleton, EconomicsView } = await import(
    "@/components/economics/EconomicsView"
  );

  return (
    <div className="space-y-6">
      <EconomicsStateBar filter={filter} noDatabase={noDatabase} />

      <Suspense key={`${filter.state}:${filter.settlementId ?? ""}`} fallback={<EconomicsSkeleton />}>
        <EconomicsView source={source} filter={filter} />
      </Suspense>
    </div>
  );
}

/**
 * Live for `default`, fixture for everything else.
 *
 * It is only ever called once the caller has established that there IS a
 * database to read, which is why it no longer asks. The live module is still
 * imported dynamically because importing it evaluates `src/lib/env.ts`, which
 * refuses to load without a full set of keys.
 *
 * WHAT THIS FUNCTION USED TO DO, AND WHY IT IS THE DEFECT THIS SCREEN CARRIED.
 * It asked `hasDatabase()` by importing `@/lib/interchange/screen`, which
 * reaches `@/lib/ledger/db` -> `@/lib/env` and throws `EnvironmentError`
 * without `APP_DATABASE_URL`. The guard was therefore unreachable in the one
 * case it was written for. On this screen it did not even get that far:
 * `EconomicsView` imports the same module as a value, so the PAGE module threw
 * while loading and all five states went down together.
 *
 * If it HAD run, it returned `createFixtureEconomicsSource("empty")` — and the
 * empty state of this screen is not a blank page, it is a finding. It says "No
 * card has settled yet" and "this page will not invent a figure to fill
 * itself", over a rate card described as "already in force". Those are three
 * statements about a book, made by a deployment that opened no connection, and
 * "nothing has settled" is the one an operator acts on by not looking further.
 *
 * The answer is now a REFUSAL, rendered by the caller from
 * `@/components/economics/unreadable`, with a code and `retryable` stated.
 */
async function selectSource(state: string): Promise<EconomicsDataSource> {
  if (state !== "default") {
    // A demo state stays a fixture whether or not a database is configured:
    // those four are drawn on purpose, and "no database" does not make a
    // drawing any more or less drawn.
    return createFixtureEconomicsSource(
      state === "loading" || state === "empty" || state === "error" || state === "edge"
        ? state
        : "default",
    );
  }

  const { loadEconomicsView } = await import("@/lib/interchange/screen");
  return { load: () => loadEconomicsView() };
}
