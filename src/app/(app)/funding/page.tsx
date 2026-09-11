import { Suspense } from "react";
import type { Metadata } from "next";

import { DemoStateBar } from "@/components/funding/DemoStateBar";
import { FundingSkeleton, FundingView } from "@/components/funding/FundingView";
import { parseFundingView } from "@/components/funding/demo-state";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

export const metadata: Metadata = {
  title: "Funding · Corgi ops console",
};

/**
 * Never prerendered. This page reads the role cookie, the live balances, the
 * live hold list and the availability policy table at request time. A financial
 * console must never serve a cached balance — or a cached availability date —
 * from whenever the build happened to run.
 */
export const dynamic = "force-dynamic";

/**
 * `/funding` — leg two of the published core loop.
 *
 * Open an account behind a real KYB check, **fund it from a linked external
 * bank**, issue a card, authorise and settle, pay out with a second approver,
 * survive a reversal, reconcile. Until this route existed the loop stopped
 * here: Plaid was a webhook verifier and a health probe, and there was no way
 * in the product to link a bank or to move a balance from one.
 *
 * Five states, all reachable from the query string:
 *
 *   (none)          the LIVE screen: real balances, real holds, real policy
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    no deposit account on the book for a credit to land in
 *   ?state=error    the preflight read failed; nothing is funded, retry is live
 *   ?state=edge     LIVE, and the case the whole screen exists for — funded but
 *                   NOT YET AVAILABLE: ledger up, available unchanged, and the
 *                   uncleared-credit hold itemised with its release date
 *
 * `?business=<uuid>` picks the customer, the same lever `/accounts`, `/pots`,
 * `/payouts` and `/disputes` already honour. It composes with `?state=`, it is
 * matched against the businesses actually on the book, and it grants nothing:
 * the KYB gate is read for whichever business is selected and re-read inside
 * the write path, so pointing this screen at an unverified business shows the
 * refusal and its code rather than a form.
 *
 * The Suspense boundary makes the loading state honest: `FundingView` is an
 * async server component, the fallback is the real skeleton, and `?state=loading`
 * slows the read rather than faking the render. The `key` forces a fresh
 * boundary per state so switching re-suspends instead of showing the previous
 * state's balances under a new heading.
 */
export default async function FundingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseFundingView(await searchParams);
  // ONE VALUE, TWO SURFACES. The state bar's badge and note, and whether
  // `FundingView` reads live or refuses, both come from this line, so they
  // cannot disagree about what this screen read.
  const noDatabase = !hasDatabase();

  return (
    <div className="space-y-6">
      <DemoStateBar view={view} noDatabase={noDatabase} />

      {/*
        The key carries the business as well as the state. Switching customer
        must re-suspend, or React reuses the resolved boundary and shows the
        previous business's balances under the new business's heading — which on
        a financial console is not a cosmetic bug.
      */}
      <Suspense key={`${view.state}:${view.businessId ?? "default"}`} fallback={<FundingSkeleton />}>
        <FundingView view={view} noDatabase={noDatabase} />
      </Suspense>
    </div>
  );
}
