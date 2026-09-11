import { Suspense } from "react";
import type { Metadata } from "next";

import { DemoStateBar } from "@/components/payments/DemoStateBar";
import { PaymentsSkeleton, PaymentsView } from "@/components/payments/PaymentsView";
import type { ActorSource, PaymentsDataSource } from "@/components/payments/data-contract";
import {
  isLiveState,
  parsePaymentsView,
  sourceClaim,
  type DemoState,
} from "@/components/payments/demo-state";
import { createFixtureSource } from "@/components/payments/fixtures";
import {
  UNRESOLVED_ACTOR,
  createUnreadablePaymentsSource,
} from "@/components/payments/unreadable";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

export const metadata: Metadata = {
  title: "Payments · Corgi ops console",
};

/**
 * Never prerendered. This page reads the role cookie, the live account list and
 * the KYB gate at request time. A financial console must never serve a cached
 * form that was drawn for somebody else's identity, or that quotes a threshold
 * from whenever the build ran.
 */
export const dynamic = "force-dynamic";

/**
 * `/payments` — originating money movement.
 *
 * The other half of the loop. `/approvals` could always check a payment; until
 * this route existed, nothing in the product could raise one — `requestPayment()`
 * was reachable from the MCP write tool and from the seed script and from no app
 * route at all, so a person could approve money out but could not ask for it.
 *
 * Five states, all reachable from the query string:
 *
 *   (none)          the LIVE form, against the live account list and policies
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    no deposit account on the book to pay from
 *   ?state=error    the preflight read failed; the form is not drawn, retry is live
 *   ?state=edge     LIVE, prefilled at exactly the ACH threshold, against a
 *                   business verified only on simulated evidence
 *
 * And one state the URL cannot ask for: NO DATABASE CONFIGURED. It is not a
 * sixth demo state, because it is not a demonstration of anything — it is what
 * this deployment is. The badge on the demo-state bar reads NO DATABASE, the
 * form is replaced by the refusal panel, and no account, gate verdict or
 * threshold is drawn. Both LIVE states refuse; see `selectSource` below.
 *
 * The Suspense boundary makes the loading state honest: `PaymentsView` is an
 * async server component, the fallback is the real skeleton, and `?state=loading`
 * slows the read rather than faking the render. The `key` forces a fresh
 * boundary per state so switching re-suspends instead of showing the previous
 * state's form under a new heading.
 */
export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parsePaymentsView(await searchParams);
  // ONE VALUE, EVERY SURFACE. The bar's badge, the board's badge and the form
  // panel's badge are all derived from this line, so they cannot disagree about
  // what this screen read.
  const noDatabase = !hasDatabase();
  const claim = sourceClaim(view.state, noDatabase);
  const [source, actorSource] = await Promise.all([
    selectSource(view.state, noDatabase),
    selectActorSource(noDatabase),
  ]);

  return (
    <div className="space-y-6">
      <DemoStateBar view={view} claim={claim} />

      <Suspense key={view.state} fallback={<PaymentsSkeleton />}>
        <PaymentsView
          view={view}
          claim={claim}
          source={source}
          actorSource={actorSource}
        />
      </Suspense>
    </div>
  );
}

/**
 * Live for `default` and `edge`, fixture for the other three — and a REFUSAL
 * for both live states when there is no database to read.
 *
 * The live module is imported dynamically because importing it evaluates
 * `src/lib/env.ts`, which refuses to load without a full set of keys. That is
 * the right behaviour for the app and the wrong behaviour for a page that must
 * be able to render the words "no database configured" — so the import happens
 * only on the branch that has already established there is a database to read.
 *
 * WHAT THIS SCREEN USED TO DO. There was no `selectSource`. `PaymentsView.tsx`
 * opened with `import { createLivePaymentsSource } from "./live-source"`, which
 * reaches `@/lib/ledger/db` -> `@/lib/env`, so without `APP_DATABASE_URL` the
 * PAGE MODULE threw while it was being loaded, measured at
 * `src/lib/ledger/db.ts:18`. There was no render to guard and no fallback to
 * get wrong, because nothing ran — and `loading`, `empty` and `error`, which
 * read nothing and wanted no database, were unreachable for the same reason.
 *
 * BOTH LIVE STATES REFUSE, and `edge` is the one worth saying out loud. It is
 * live precisely so a person can submit $2,500.00 on ACH and watch a real
 * policy row decide whether equal crosses the threshold. Drawn from nothing
 * that demonstration is a prefilled form quoting a threshold nobody fetched,
 * with a submit button behind it, which is the failure this screen's own error
 * panel already names.
 */
async function selectSource(
  state: DemoState,
  noDatabase: boolean,
): Promise<PaymentsDataSource> {
  // The three drawn states are checked FIRST and stay drawn whether or not a
  // database is configured: they are demonstrations, and "no database" does not
  // make a drawing any more or less drawn.
  if (!isLiveState(state)) {
    // Narrowed by `isLiveState`; the fixture source has no case for the two
    // live states because writing one would be writing a fake payment form.
    return createFixtureSource(state as "loading" | "empty" | "error");
  }

  if (noDatabase) return createUnreadablePaymentsSource();

  const { createLivePaymentsSource } = await import("@/app/(app)/payments/live-source");
  return createLivePaymentsSource();
}

/**
 * Who this session would raise an instruction as.
 *
 * Resolved for the fixture states too, because the initiator this form would
 * attribute an instruction to is a true fact about whoever is reading the
 * screen, not part of the demo data.
 *
 * `currentActor()` is a SELECT against the `actor` table, so it is reached
 * through the same dynamic import as the account list, on the same branch, for
 * the same reason — `@/lib/approvals/session` imports `@/lib/ledger/db` at
 * module scope. With no database nobody is resolved and the header prints
 * `unresolved`, which is the right answer rather than a softer one.
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
