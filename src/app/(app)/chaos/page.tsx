import { Suspense } from "react";
import type { Metadata } from "next";

import { ChaosStateBar } from "@/components/chaos/ChaosStateBar";
import { ChaosSkeleton, ChaosView } from "@/components/chaos/ChaosView";
import { createFixtureChaosSource } from "@/components/chaos/fixtures";
import type { ChaosDataSource } from "@/components/chaos/data-contract";
import { parseChaosView } from "@/components/chaos/view-state";

export const metadata: Metadata = {
  title: "Chaos mode · Corgi ops console",
};

/**
 * Never cached, never prerendered.
 *
 * Stronger here than on any other screen: this page renders whether chaos is
 * ARMED, and a cached "chaos is off" served while a control is armed would be
 * the single worst failure this feature could have. The countdown on it must
 * be true at the moment it is read.
 */
export const dynamic = "force-dynamic";

export default async function ChaosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseChaosView(await searchParams);
  const source = await selectSource(view.state);

  return (
    <div className="space-y-6">
      <ChaosStateBar view={view} />

      <Suspense key={view.state} fallback={<ChaosSkeleton />}>
        <ChaosView source={source} view={view} />
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
 * `default` and `edge` are both live and both read the same thing. `edge` is a
 * LABEL for the most interesting real state — all four controls armed at once
 * against an unregistered card — and not a second, fake dataset: a fixture
 * claiming "the invariants held while that ran" would be a claim about a real
 * book made by something that has never seen one.
 */
async function selectSource(state: string): Promise<ChaosDataSource> {
  if (state === "loading" || state === "empty" || state === "error") {
    return createFixtureChaosSource(state);
  }

  const { hasDatabase } = await import("./live-source");
  if (!hasDatabase()) {
    // No database. The honest answer is the empty fixture with the source
    // badge reading FIXTURE, not a confident dashboard drawn from nothing.
    return createFixtureChaosSource("empty");
  }

  const { createLiveChaosSource } = await import("./live-source");
  return createLiveChaosSource();
}
