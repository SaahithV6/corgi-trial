import { Suspense } from "react";
import type { Metadata } from "next";

import { DashboardStateBar } from "@/components/dashboard/DashboardStateBar";
import { TriageSkeleton, TriageView } from "@/components/dashboard/TriageView";
import { createFixtureTriageSource } from "@/components/dashboard/fixtures";
import type { TriageDataSource } from "@/components/dashboard/data-contract";
import { parseDashboardView } from "@/components/dashboard/view-state";

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
  const source = await selectSource(view.state);

  return (
    <div className="space-y-6">
      <DashboardStateBar view={view} />

      <Suspense key={view.state} fallback={<TriageSkeleton />}>
        <TriageView source={source} view={view} />
      </Suspense>
    </div>
  );
}

/**
 * Which source answers this state.
 *
 * The live module is imported DYNAMICALLY because importing it evaluates
 * `src/lib/env.ts`, which refuses to load without a full set of keys. That is
 * the right behaviour for the app and the wrong behaviour for a page that must
 * be able to render the words "no database configured".
 *
 * With no database the honest answer is the EMPTY fixture with the badge
 * reading FIXTURE — never a confident triage board drawn from nothing, and
 * never a green tick standing in for a book nobody read.
 */
async function selectSource(state: string): Promise<TriageDataSource> {
  if (state === "loading" || state === "empty" || state === "error" || state === "edge") {
    return createFixtureTriageSource(state);
  }

  const { hasDatabase } = await import("./live-source");
  if (!hasDatabase()) return createFixtureTriageSource("empty");

  const { createLiveTriageSource } = await import("./live-source");
  return createLiveTriageSource();
}
