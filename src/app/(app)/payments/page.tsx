import { Suspense } from "react";
import type { Metadata } from "next";

import { DemoStateBar } from "@/components/payments/DemoStateBar";
import { PaymentsSkeleton, PaymentsView } from "@/components/payments/PaymentsView";
import { parsePaymentsView } from "@/components/payments/demo-state";

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

  return (
    <div className="space-y-6">
      <DemoStateBar view={view} />

      <Suspense key={view.state} fallback={<PaymentsSkeleton />}>
        <PaymentsView view={view} />
      </Suspense>
    </div>
  );
}
