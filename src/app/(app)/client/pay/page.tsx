import { Suspense } from "react";
import type { Metadata } from "next";

import { ClientErrorPanel, ClientNav, ClientSkeleton, ClientStateBar } from "@/components/client/Chrome";
import { PayView } from "@/components/client/PayView";
import { parseClientView, type ClientView } from "@/components/client/view-state";

import { loadPay } from "../sources";

export const metadata: Metadata = {
  title: "Send a payment · Corgi",
};

export const dynamic = "force-dynamic";

/**
 * `/client/pay` — the customer's side of the money-out path.
 *
 * THERE IS NO SECOND MONEY-OUT PATH IN THIS BUILD. This form posts to
 * `raisePaymentAction` in `src/app/(app)/payments/actions.ts` — the staff
 * console's own server action, imported and not copied — which calls
 * `requestPayment()`. The KYB gate, the payee confirmation, the approval
 * threshold, the content hash and the idempotency key all apply unchanged,
 * because they are not applied here at all: they are applied inside one
 * transaction in `src/lib/approvals/instructions.ts`, and this screen is one
 * more caller of it alongside the console, the MCP write tool, the standing
 * order runner and the public API.
 *
 * Five states, all in the URL:
 *
 *   (none)          LIVE. The real form, the live policy, this customer's payees
 *   ?state=loading  the real skeleton, held open by a genuinely slow read
 *   ?state=empty    FIXTURE. A business that has not passed its checks
 *   ?state=error    FIXTURE. The preflight read failed; the form is not drawn
 *   ?state=edge     LIVE, prefilled at exactly the approval threshold — the
 *                   amount one cent below which nobody else has to sign
 */
export default async function ClientPayPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseClientView(await searchParams);

  return (
    <div className="space-y-6">
      <ClientNav current="/client/pay" view={view} />
      <ClientStateBar screen="/client/pay" view={view} />
      <Suspense
        key={`${view.state}:${view.businessId ?? ""}`}
        fallback={<ClientSkeleton rows={3} />}
      >
        <PaySection view={view} />
      </Suspense>
    </div>
  );
}

async function PaySection({ view }: { readonly view: ClientView }) {
  const loaded = await loadPay(view);
  if (!loaded.ok) {
    return <ClientErrorPanel code={loaded.code} message={loaded.message} />;
  }
  return (
    <PayView
      screen={loaded.value}
      view={view}
      prefillAtThreshold={view.state === "edge"}
    />
  );
}
