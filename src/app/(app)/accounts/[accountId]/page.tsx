import { Suspense } from "react";
import type { Metadata } from "next";

import { AccountSkeleton, AccountView } from "@/components/account/AccountView";
import { DemoStateBar } from "@/components/account/DemoStateBar";
import { parseDemoView } from "@/components/account/demo-state";

export const metadata: Metadata = {
  title: "Account · Corgi ops console",
};

type AccountPageProps = {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * `/accounts/[accountId]` — the account screen.
 *
 * Five states, all reachable from the query string and none of them requiring
 * a database write:
 *
 *   (none)          funded account, live holds and an uncleared credit
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    opened, nothing booked
 *   ?state=error    the balance query failed; retry is live
 *   ?state=edge     available is negative after an over-capture
 *   ?auth=pending   lands a $50.00 fuel-pump authorisation on the default state
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

  return (
    <div className="space-y-6">
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
