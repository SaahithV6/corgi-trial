import { Suspense } from "react";
import type { Metadata } from "next";

import { ChaosStateBar } from "@/components/chaos/ChaosStateBar";
import { ChaosSkeleton, ChaosView } from "@/components/chaos/ChaosView";
import { createFixtureChaosSource } from "@/components/chaos/fixtures";
import { createUnreadableChaosSource } from "@/components/chaos/unreadable";
import type { ChaosDataSource } from "@/components/chaos/data-contract";
import { parseChaosView } from "@/components/chaos/view-state";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

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
  // ONE VALUE, TWO SURFACES. The state bar's badge and note, and which source
  // `ChaosView` reads through, both come from this line, so they cannot
  // disagree about what this screen read.
  const noDatabase = !hasDatabase();
  const source = await selectSource(view.state, noDatabase);

  return (
    <div className="space-y-6">
      <ChaosStateBar view={view} noDatabase={noDatabase} />

      <Suspense key={view.state} fallback={<ChaosSkeleton />}>
        <ChaosView source={source} />
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
 *
 * WHAT THIS FUNCTION USED TO DO, AND WHY IT IS THE DEFECT THIS SCREEN CARRIED.
 * It asked `hasDatabase()` by destructuring it off
 * `await import("./live-source")`, and that module opens with
 * `import { sql } from "@/lib/ledger/db"`, which reaches `@/lib/env` and throws
 * `EnvironmentError` at module scope without `APP_DATABASE_URL`. The guard was
 * unreachable in the one case it was written for: the import on its own line
 * only succeeds when a database IS configured, and the predicate returns false
 * only when one is not. Measured with the variable deleted, the render threw
 * and the operator got the framework's error page.
 *
 * If it HAD run, it returned `createFixtureChaosSource("empty")`, and its
 * comment called that the honest answer. It is not. The empty fixture draws
 * CHAOS OFF with four controls unarmed and four expiry clocks at zero, and it
 * draws the invariant panel as fifteen views at nought rows with the badge
 * saying they hold. Those are the two things somebody opens this screen to
 * settle, and neither was read. A FIXTURE badge does not withdraw them: it
 * tells a reader the ROWS are invented, not that the STATE OF THE SWITCHES is
 * unknown.
 *
 * With no database the answer is now a REFUSAL, from
 * `@/components/chaos/unreadable`, which `ChaosView` renders the same way it
 * renders a failed read: no switch, no countdown, no invariant verdict, and no
 * control to press.
 */
async function selectSource(
  state: string,
  noDatabase: boolean,
): Promise<ChaosDataSource> {
  // The three drawn states are checked FIRST, and stay drawn whether or not a
  // database is configured: they are demonstrations, and "no database" does not
  // make a drawing any more or less drawn.
  if (state === "loading" || state === "empty" || state === "error") {
    return createFixtureChaosSource(state);
  }

  if (noDatabase) return createUnreadableChaosSource();

  const { createLiveChaosSource } = await import("./live-source");
  return createLiveChaosSource();
}
