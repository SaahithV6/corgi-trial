import { Suspense } from "react";
import type { Metadata } from "next";

import { ApprovalsSkeleton, ApprovalsView } from "@/components/approvals/ApprovalsView";
import { DemoStateBar } from "@/components/approvals/DemoStateBar";
import { parseApprovalsView } from "@/components/approvals/demo-state";

export const metadata: Metadata = {
  title: "Approvals · Corgi ops console",
};

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

  return (
    <div className="space-y-6">
      <DemoStateBar view={view} />

      <Suspense key={view.state} fallback={<ApprovalsSkeleton />}>
        <ApprovalsView view={view} />
      </Suspense>
    </div>
  );
}
