import { Suspense } from "react";
import type { Metadata } from "next";

import { ClientErrorPanel, ClientSkeleton } from "@/components/client/Chrome";
import { DisputesView } from "@/components/client/disputes/DisputesView";
import { parseClientView, type ClientView } from "@/components/client/view-state";

import { loadClientDisputes } from "./source";

export const metadata: Metadata = {
  title: "Disputed payments · Corgi",
};

export const dynamic = "force-dynamic";

/**
 * `/client/disputes` — the customer's half of dispute intake.
 *
 * The brief's stretch ladder asks for "dispute intake on a settled card
 * transaction, with provisional credit done honestly". Intake is the customer
 * raising the claim; this build had only the operator's half, at `/disputes`.
 *
 * The screen is LIVE only. The other five client screens carry five URL states
 * because each is a read and a fixture proves the renderer; this one has a
 * write on it, and a fixture state beside a button that raises a real case on a
 * real book invites somebody to press it believing nothing will happen. The
 * `?business=` parameter still applies and still means what it means everywhere
 * else on this surface: whose book, resolved into a `WHERE business_id = $1`
 * and never into a filter.
 */
export default async function ClientDisputesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseClientView(await searchParams);

  return (
    <div className="space-y-6">
      <Suspense key={view.businessId ?? ""} fallback={<ClientSkeleton rows={6} />}>
        <DisputesSection view={view} />
      </Suspense>
    </div>
  );
}

async function DisputesSection({ view }: { readonly view: ClientView }) {
  const loaded = await loadClientDisputes(view);
  if (!loaded.ok) {
    return <ClientErrorPanel code={loaded.code} message={loaded.message} />;
  }
  return <DisputesView screen={loaded.value} view={view} />;
}
