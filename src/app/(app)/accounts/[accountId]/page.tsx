import { Suspense } from "react";
import type { Metadata } from "next";

import { Badge } from "@/components/ui/primitives";
import { AccountSkeleton, AccountView } from "@/components/account/AccountView";
import { DemoStateBar } from "@/components/account/DemoStateBar";
import { parseDemoView } from "@/components/account/demo-state";
import { isLiveView } from "@/components/account/fixtures";

export const metadata: Metadata = {
  title: "Account · Corgi ops console",
};

/**
 * Never prerendered. Every figure on this page is a fold taken at request
 * time against the live journal.
 */
export const dynamic = "force-dynamic";

type AccountPageProps = {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * `/accounts/[accountId]` — the account screen.
 *
 * The bare URL is the LIVE ledger: balances, holds and postings are read from
 * the journal through `src/lib/ledger/queries.ts`, folded as of one instant
 * and one booking watermark. Everything else is a fixture, on purpose:
 *
 *   (none)          live — the real account, read at request time
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    opened, nothing booked
 *   ?state=error    the balance query failed; retry is live
 *   ?state=edge     available is negative after an over-capture
 *   ?auth=pending   lands a $50.00 fuel-pump authorisation, as a fixture
 *
 * Which one is on screen is stated rather than implied. A console that shows
 * seeded demo money in the same chrome as a customer's real balance, with
 * nothing to tell them apart, is one screenshot away from a very bad meeting.
 *
 * The Suspense boundary is what makes the loading state honest: `AccountView`
 * is an async server component, the fallback is the real skeleton, and
 * `?state=loading` slows the read rather than faking the render. The `key`
 * forces a fresh boundary per state so switching states re-suspends instead of
 * showing the previous state's data under a new heading.
 */
export default async function AccountPage({
  params,
  searchParams,
}: AccountPageProps) {
  const { accountId } = await params;
  const view = parseDemoView(await searchParams);
  const live = isLiveView(view);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {live ? (
          <Badge tone="positive" title="Read from the journal at request time.">
            live ledger
          </Badge>
        ) : (
          <Badge
            tone="quiet"
            title="Demo data. Nothing on this view was read from the database."
          >
            fixture
          </Badge>
        )}
        <p className="text-xs text-muted">
          {live
            ? "Every figure below is a fold over journal lines, taken as of one instant and one booking watermark. No balance is stored anywhere in this schema."
            : "Demo data behind the same interface the live ledger implements. The query string is the only thing that selects it, and nothing here was written to the database."}
        </p>
      </div>

      <DemoStateBar accountId={accountId} view={view} />

      <Suspense
        key={`${view.state}:${String(view.authPending)}`}
        fallback={<AccountSkeleton />}
      >
        <AccountView accountId={accountId} view={view} />
      </Suspense>
    </div>
  );
}
