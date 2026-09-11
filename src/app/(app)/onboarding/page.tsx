import { Suspense } from "react";
import type { Metadata } from "next";

import { DemoStateBar } from "@/components/onboarding/DemoStateBar";
import { OnboardingSkeleton, OnboardingView } from "@/components/onboarding/OnboardingView";
import { parseOnboardingView } from "@/components/onboarding/demo-state";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

export const metadata: Metadata = {
  title: "Onboarding · Corgi ops console",
};

/**
 * `/onboarding` — KYB / KYC, and the gate on transacting.
 *
 * Five states, all reachable from the query string:
 *
 *   (none)          the LIVE derived state, read from Neon
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    no businesses on the book
 *   ?state=error    the state read failed; retry is live
 *   ?state=edge     a business whose director KYC was verified by a real Stripe
 *                   Identity session and whose registry leg was simulated —
 *                   approved, on evidence labelled `simulated`, because a
 *                   composite is only as live as its least live leg
 *
 * The Suspense boundary makes the loading state honest: `OnboardingView` is an
 * async server component, the fallback is the real skeleton, and
 * `?state=loading` slows the read rather than faking the render. The `key`
 * forces a fresh boundary per state so switching re-suspends instead of showing
 * the previous state's rows under a new heading.
 *
 * Never prerendered. The KYB state on this page is a fold over an append-only
 * evidence table taken at request time; baking it into a build artefact would
 * put a deploy-time verification status on a screen a compliance operator reads
 * as current — and that status is the thing that decides whether money may move.
 */
export const dynamic = "force-dynamic";

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseOnboardingView(await searchParams);
  // ONE VALUE, TWO SURFACES. The state bar's badge and note, and whether
  // `OnboardingView` reads live or refuses, both come from this line, so they
  // cannot disagree about what this screen read.
  const noDatabase = !hasDatabase();

  return (
    <div className="space-y-6">
      <DemoStateBar view={view} noDatabase={noDatabase} />

      <Suspense key={view.state} fallback={<OnboardingSkeleton />}>
        <OnboardingView view={view} noDatabase={noDatabase} />
      </Suspense>
    </div>
  );
}
