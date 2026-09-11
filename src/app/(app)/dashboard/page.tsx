import { Suspense } from "react";
import type { Metadata } from "next";

import { DashboardStateBar } from "@/components/dashboard/DashboardStateBar";
import { TriageSkeleton, TriageView } from "@/components/dashboard/TriageView";
import { createFixtureTriageSource } from "@/components/dashboard/fixtures";
import { createUnreadableTriageSource } from "@/components/dashboard/unreadable";
import type { TriageDataSource } from "@/components/dashboard/data-contract";
import {
  parseDashboardView,
  resolveSourceClaim,
  type SourceClaim,
} from "@/components/dashboard/view-state";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "./has-database";

export const metadata: Metadata = {
  title: "Triage · Corgi ops console",
};

/**
 * Never cached, never prerendered.
 *
 * The whole claim of this screen is "this is the book right now". A cached
 * "nothing is wrong" served while something is would be the single worst
 * failure it could have — the same reason `/chaos` carries this line, and for
 * a strictly larger blast radius.
 */
export const dynamic = "force-dynamic";

/**
 * `/dashboard` — the screen an operator opens at the start of a shift.
 *
 * This build has 21 screens. Opening it otherwise means already knowing which
 * one holds the thing that is wrong, which is exactly the knowledge a person
 * starting a shift does not have. This screen answers three questions in
 * order, and the order is the product:
 *
 *   1. Is anything wrong right now — and is it NEW, or was it DECIDED?
 *   2. What is waiting on a human?
 *   3. What did the machine do while I was away, and what did it refuse?
 *
 * It is deliberately not a metrics dashboard. Counts that only go up are
 * wallpaper; every figure here is either a queue depth that falls when the work
 * is done, or a comparison against something written down.
 *
 * Five URL states, all reachable from the query string:
 *
 *   (none)          LIVE — every invariant view, every queue, the real traces
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    a quiet shift: nothing red, nothing queued
 *   ?state=error    the read failed; this is never rendered as an all-clear
 *   ?state=edge     a DECIDED red sitting next to a NEW one — see
 *                   `view-state.ts` for why this one is a fixture and says so
 *
 * And one state the URL cannot ask for: NO DATABASE CONFIGURED. It is not a
 * sixth demo state, because it is not a demonstration of anything — it is what
 * this deployment is. The badge reads NO DATABASE, the board is replaced by
 * the refusal panel, and no count, queue or tick is drawn. See `selectSource`
 * below for what this used to do instead.
 *
 * The Suspense boundary is what makes the loading state honest: `TriageView` is
 * an async server component, the fallback is the real skeleton, and
 * `?state=loading` slows the read rather than faking the render. The `key`
 * forces a fresh boundary per state so switching re-suspends instead of showing
 * the previous state's rows under a new heading.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseDashboardView(await searchParams);
  const claim = resolveSourceClaim(view.state, hasDatabase());
  const source = await selectSource(claim);

  return (
    <div className="space-y-6">
      <DashboardStateBar view={view} claim={claim} />

      <Suspense key={view.state} fallback={<TriageSkeleton />}>
        <TriageView source={source} view={view} claim={claim} />
      </Suspense>
    </div>
  );
}

/**
 * Which source answers this claim.
 *
 * The live module is imported DYNAMICALLY because importing it evaluates
 * `src/lib/env.ts`, which refuses to load without a full set of keys. That is
 * the right behaviour for the app and the wrong behaviour for a page that must
 * be able to render the words "no database configured" — so the import happens
 * only on the branch that has already established there is a database to read.
 *
 * WHAT THIS FUNCTION USED TO DO, AND WHY IT IS THE DEFECT THIS SCREEN CARRIES.
 * It asked `hasDatabase()` by importing `./live-source`, which throws without
 * `APP_DATABASE_URL`, so the guard could never run in the one case it was
 * written for. If it had run, it returned `createFixtureTriageSource("empty")`
 * — four invariant views holding, no queue, nothing refused, under the
 * headline "Nothing new." A clean shift, rendered by a deployment that had not
 * read a row. The screen whose entire job is to say when something is wrong
 * reported that nothing was, precisely when it could see nothing at all.
 *
 * With no database the answer is now a REFUSAL, from `./unreadable.ts`, which
 * `TriageView` renders the same way it renders a failed read: no board, no
 * counts, no tick. "I cannot see" and "I looked and it is fine" are different
 * screens.
 */
async function selectSource(claim: SourceClaim): Promise<TriageDataSource> {
  if (claim.kind === "fixture") return createFixtureTriageSource(claim.state);
  if (claim.kind === "unreadable") return createUnreadableTriageSource();

  const { createLiveTriageSource } = await import("./live-source");
  return createLiveTriageSource();
}
