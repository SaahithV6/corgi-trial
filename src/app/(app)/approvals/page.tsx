import { Suspense } from "react";
import type { Metadata } from "next";

import { ApprovalsSkeleton, ApprovalsView } from "@/components/approvals/ApprovalsView";
import { DemoStateBar } from "@/components/approvals/DemoStateBar";
import type {
  ActorSource,
  ApprovalsDataSource,
} from "@/components/approvals/data-contract";
import { parseApprovalsView, sourceClaim, type DemoState } from "@/components/approvals/demo-state";
import { createFixtureSource } from "@/components/approvals/fixtures";
import {
  UNRESOLVED_ACTOR,
  createUnreadableApprovalsSource,
} from "@/components/approvals/unreadable";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

export const metadata: Metadata = {
  title: "Approvals · Corgi ops console",
};

/**
 * Never prerendered.
 *
 * The default state reads the live queue and the role cookie, and a page that
 * ran that query at BUILD time would either bake one afternoon's pending
 * payments into a static artefact or fail the build on a machine with no
 * database. Awaiting `searchParams` already forces dynamic rendering; this says
 * so out loud, so nobody has to know that.
 */
export const dynamic = "force-dynamic";

/**
 * `/approvals` — maker-checker on money out.
 *
 * Five states, all reachable from the query string:
 *
 *   (none)          the LIVE pending queue, read from Neon
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    nothing awaiting a decision
 *   ?state=error    the queue read failed; retry is live
 *   ?state=edge     a payment raised by the signed-in actor — approve is
 *                   visibly disabled, with the reason stated
 *
 * And one state the URL cannot ask for: NO DATABASE CONFIGURED. It is not a
 * sixth demo state, because it is not a demonstration of anything — it is what
 * this deployment is. The badge on the demo-state bar reads NO DATABASE, the
 * board is replaced by the refusal panel, and no payment, policy version or
 * decision button is drawn. See `selectSource` below for what this used to do
 * instead, which was nothing at all.
 *
 * The Suspense boundary makes the loading state honest: `ApprovalsView` is an
 * async server component, the fallback is the real skeleton, and
 * `?state=loading` slows the read rather than faking the render. The `key`
 * forces a fresh boundary per state so switching re-suspends instead of showing
 * the previous state's rows under a new heading.
 *
 * This route is dynamic by construction — it reads the role cookie and queries
 * the database. A financial console must never serve a cached queue that was
 * rendered for somebody else's identity.
 */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseApprovalsView(await searchParams);
  // ONE VALUE, TWO SURFACES. The bar's badge and the board's badge are both
  // derived from this line, so they cannot disagree about what this screen
  // read.
  const noDatabase = !hasDatabase();
  const claim = sourceClaim(view.state, noDatabase);
  const [source, actorSource] = await Promise.all([
    selectSource(view.state, noDatabase),
    selectActorSource(noDatabase),
  ]);

  return (
    <div className="space-y-6">
      <DemoStateBar view={view} claim={claim} />

      <Suspense key={view.state} fallback={<ApprovalsSkeleton />}>
        <ApprovalsView claim={claim} source={source} actorSource={actorSource} />
      </Suspense>
    </div>
  );
}

/**
 * Live for `default`, fixture for the other four — and a REFUSAL for `default`
 * when there is no database to read.
 *
 * The live module is imported dynamically because importing it evaluates
 * `src/lib/env.ts`, which refuses to load without a full set of keys. That is
 * the right behaviour for the app and the wrong behaviour for a page that must
 * be able to render the words "no database configured" — so the import happens
 * only on the branch that has already established there is a database to read.
 *
 * WHAT THIS SCREEN USED TO DO, AND WHY IT IS WORSE THAN THE DEFECT ITS
 * SIBLINGS CARRIED. There was no `selectSource`. `ApprovalsView` imported
 * `@/lib/approvals/screen` and `@/lib/approvals/session` at module scope, and
 * `page.tsx` imported `ApprovalsView`, so the chain from this file to
 * `@/lib/ledger/db` -> `@/lib/env` was static. Without `APP_DATABASE_URL` the
 * PAGE MODULE threw while it was being loaded, measured at
 * `src/lib/ledger/db.ts:18`. There was no render to guard and no fallback to
 * get wrong, because nothing ran.
 *
 * It took the four fixture states with it. `loading`, `empty`, `error` and
 * `edge` read nothing and were never going to, and all four answered with the
 * framework's error page, because they live behind this module.
 *
 * With no database the live state is now a REFUSAL, from
 * `@/components/approvals/unreadable`, which `ApprovalsView` renders the same
 * way it renders a failed read: no payment, no policy version, no decision
 * button. "I did not look at the queue" and "the queue is empty" are different
 * screens, and `QueueList`'s empty panel — which says in as many words that an
 * empty queue is not a failure — is reachable only from a read that happened.
 */
async function selectSource(
  state: DemoState,
  noDatabase: boolean,
): Promise<ApprovalsDataSource> {
  // The four drawn states are checked FIRST and stay drawn whether or not a
  // database is configured: they are demonstrations, and "no database" does not
  // make a drawing any more or less drawn.
  if (state !== "default") return createFixtureSource(state);

  if (noDatabase) return createUnreadableApprovalsSource();

  const { createLiveApprovalsSource } = await import("@/lib/approvals/screen");
  return createLiveApprovalsSource();
}

/**
 * Who this session is acting as.
 *
 * Resolved for the fixture states too, and that is deliberate: the edge state's
 * row is initiated by whoever is signed in, which is what makes it a true
 * statement about the person reading the screen rather than a picture of one.
 *
 * `currentActor()` is a SELECT against the `actor` table, so it is reached
 * through the same dynamic import as the queue, on the same branch, for the
 * same reason — `@/lib/approvals/session` imports `@/lib/ledger/db` at module
 * scope. With no database nobody is resolved, the header prints `unresolved`,
 * and every gate falls through to `no_actor`, which is the right answer rather
 * than a softer one.
 */
async function selectActorSource(noDatabase: boolean): Promise<ActorSource> {
  if (noDatabase) return UNRESOLVED_ACTOR;

  const { currentActor } = await import("@/lib/approvals/session");
  return {
    async current() {
      const session = await currentActor();
      if (session === null) return null;
      return {
        id: session.id,
        displayName: session.displayName,
        kind: session.kind,
        canApprove: session.canApprove,
      };
    },
  };
}
