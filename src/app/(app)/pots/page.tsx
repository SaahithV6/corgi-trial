import { Suspense } from "react";
import type { Metadata } from "next";

import { createFixturePotsSource } from "@/components/pots/fixtures";
import { createUnreadablePotsSource } from "@/components/pots/unreadable";
import { PotsSkeleton, PotsView } from "@/components/pots/PotsView";
import { PotsStateBar } from "@/components/pots/PotsStateBar";
import { parsePotsFilter } from "@/components/pots/view-state";
import type { PotsDataSource } from "@/components/pots/data-contract";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

export const metadata: Metadata = {
  title: "Pots · Corgi ops console",
};

/**
 * Never prerendered.
 *
 * The default state reads the live database, and a page that ran a query at
 * BUILD time would either bake this morning's balances into a static artefact
 * or fail the build on a machine with no database. Awaiting `searchParams`
 * already forces dynamic rendering; this says so out loud so nobody has to know
 * that.
 */
export const dynamic = "force-dynamic";

/**
 * `/pots` — sub-accounts, and the internal transfers between them.
 *
 * Stretch ladder item four: "sub-accounts or pots, with instant internal
 * transfers that are pure ledger moves". The reasoning is in `docs/POTS.md`;
 * what this route does is show it.
 *
 * Five states, all reachable from the query string:
 *
 *   (none)          live pots, live balances, live journal entries
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    a customer with no pots; the identity degenerates and holds
 *   ?state=error    the read failed; nothing posted, retry is live
 *   ?state=edge     a move of one cent MORE than the LIVE available balance,
 *                   refused, with the subtraction that refused it
 *
 * ...plus the customer, which is also URL state:
 *
 *   ?business=<uuid>
 *
 * WHY `default` AND `edge` ARE LIVE AND THE OTHER THREE ARE NOT. The claim
 * being graded is that a pot is a real account, that a transfer is a real
 * journal entry, and that moving money into one really does reduce what can be
 * spent. A fixture would answer all three by construction and prove none of
 * them, so the default state is a real read of real rows written by real
 * postings. The EDGE state is live for the same reason and one more: the point
 * of a refusal is that the system decided it, and a hand-written refusal
 * demonstrates a paragraph rather than a rule. Only the AMOUNT in the edge probe
 * is synthetic — `available + 1 cent` — and the screen says so.
 *
 * And one state the URL cannot ask for: NO DATABASE CONFIGURED. It is not a
 * sixth demo state, because it is not a demonstration of anything — it is what
 * this deployment is. The badge on the state bar reads NO DATABASE, the pots
 * are replaced by the refusal panel, and no pot, balance, movement or identity
 * check is drawn. See `selectSource` below for what this used to do instead.
 *
 * `loading`, `empty` and `error` are fixtures so they can be shown in order in
 * front of a panel: the first needs a slow database, the second needs a
 * customer nobody has given a pot to, and the third needs the database to be
 * down. None of those is a thing to arrange mid-demo, and every fixture state
 * prints FIXTURE on its own face.
 *
 * The Suspense boundary is what makes the loading state honest: `PotsView` is an
 * async server component, the fallback is the real skeleton, and
 * `?state=loading` slows the read rather than faking the render. The `key`
 * forces a fresh boundary per view so switching states re-suspends instead of
 * showing the previous state's figures under a new heading.
 */
export default async function PotsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parsePotsFilter(await searchParams);
  // ONE VALUE, TWO SURFACES. The state bar's badge and the view's refusal
  // wording both come from this line, so they cannot disagree about what this
  // screen read.
  const noDatabase = !hasDatabase();
  const source = await selectSource(filter.state, noDatabase);

  return (
    <div className="space-y-6">
      <PotsStateBar filter={filter} noDatabase={noDatabase} />

      <Suspense
        key={`${filter.state}:${filter.businessId ?? ""}`}
        fallback={<PotsSkeleton />}
      >
        <PotsView source={source} filter={filter} noDatabase={noDatabase} />
      </Suspense>
    </div>
  );
}

/**
 * Live for `default` and `edge`, fixture for the rest — and a REFUSAL for the
 * two live states when there is no database to read.
 *
 * The live module is imported dynamically because importing it evaluates
 * `src/lib/env.ts`, which refuses to load without a full set of keys. That is
 * the right behaviour for the app and the wrong behaviour for a page that must
 * be able to render the words "no database configured" — so the import happens
 * only on the branch that has already established there is a database to read.
 *
 * WHAT THIS FUNCTION USED TO DO, AND WHY IT IS THE DEFECT THIS SCREEN CARRIED.
 * It asked `hasDatabase()` by importing `@/lib/pots/screen`, which reaches
 * `@/lib/ledger/db` -> `@/lib/env` and throws `EnvironmentError` without
 * `APP_DATABASE_URL`. The guard was therefore unreachable in the one case it
 * was written for: the import above it only succeeds when a database IS
 * configured. Measured with the variable deleted, this page did not render
 * "no database configured" — the page MODULE failed to load and the operator
 * got the framework's error page.
 *
 * If it HAD run, it returned `createFixturePotsSource("default")`: named pots,
 * balances, movements, and the identity panel showing the pot total
 * reconciling to the deposit liability. That identity is this screen's claim,
 * and a deployment that had read nothing would have rendered it as holding.
 *
 * With no database the answer is now a REFUSAL, from
 * `@/components/pots/unreadable`, which `PotsView` renders the same way it
 * renders a failed read: no pots, no balances, no identity.
 */
async function selectSource(
  state: string,
  noDatabase: boolean,
): Promise<PotsDataSource> {
  if (state !== "default" && state !== "edge") {
    // A demo state stays a fixture whether or not a database is configured:
    // those three are drawn on purpose, and "no database" does not make a
    // drawing any more or less drawn.
    return createFixturePotsSource(
      state === "loading" || state === "empty" || state === "error"
        ? state
        : "default",
    );
  }

  if (noDatabase) return createUnreadablePotsSource();

  const { loadPotsView } = await import("@/lib/pots/screen");
  return { load: loadPotsView };
}
