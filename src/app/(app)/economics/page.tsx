import { Suspense } from "react";
import type { Metadata } from "next";

import { EconomicsSkeleton, EconomicsView } from "@/components/economics/EconomicsView";
import { EconomicsStateBar } from "@/components/economics/EconomicsStateBar";
import { createFixtureEconomicsSource } from "@/components/economics/fixtures";
import { parseEconomicsFilter } from "@/components/economics/view-state";
import type { EconomicsDataSource } from "@/lib/interchange/screen";

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
 * shape. When no database is configured at all, `default` falls back to the
 * fixture and the state bar says so on its face.
 *
 * The Suspense boundary is what makes the loading state honest: `EconomicsView`
 * is an async server component, the fallback is the real skeleton, and
 * `?state=loading` slows the READ rather than faking the render. The `key`
 * forces a fresh boundary per view so switching states re-suspends instead of
 * showing the previous state's rows under a new heading.
 */
export default async function EconomicsPage({ searchParams }: EconomicsPageProps) {
  const filter = parseEconomicsFilter(await searchParams);
  const source = await selectSource(filter.state);

  return (
    <div className="space-y-6">
      <EconomicsStateBar filter={filter} />

      <Suspense key={`${filter.state}:${filter.settlementId ?? ""}`} fallback={<EconomicsSkeleton />}>
        <EconomicsView source={source} filter={filter} />
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
async function selectSource(state: string): Promise<EconomicsDataSource> {
  if (state !== "default") {
    return createFixtureEconomicsSource(
      state === "loading" || state === "empty" || state === "error" || state === "edge"
        ? state
        : "default",
    );
  }

  const { hasDatabase } = await import("@/lib/interchange/screen");
  if (!hasDatabase()) return createFixtureEconomicsSource("empty");

  const { loadEconomicsView } = await import("@/lib/interchange/screen");
  return { load: () => loadEconomicsView() };
}
