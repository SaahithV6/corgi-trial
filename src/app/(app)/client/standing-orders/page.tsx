import { randomUUID } from "node:crypto";
import { Suspense } from "react";
import type { Metadata } from "next";

import { ClientErrorPanel, ClientSkeleton } from "@/components/client/Chrome";
import { ClientStandingOrdersView } from "@/components/client/standing-orders/StandingOrdersView";
import { parseClientView, type ClientView } from "@/components/client/view-state";

import { readClientStandingScreen } from "./reader";

export const metadata: Metadata = {
  title: "Recurring payments · Corgi",
};

export const dynamic = "force-dynamic";

/**
 * `/client/standing-orders` — the customer's own recurring payments.
 *
 * A mandate could be created on the operator's screen and nowhere else, which
 * meant a customer who wanted to pay their rent on the 1st had to ring the bank
 * and ask a member of staff to do it for them. This screen is the other half:
 * set one up, see what it has done, and stop it.
 *
 * ===========================================================================
 * RENDERING THIS PAGE FIRES NOTHING
 * ===========================================================================
 *
 * `runStandingOrders()` is not imported here, is not imported by the reader,
 * and is not reachable from either. The only writes on this screen are two
 * server actions behind buttons somebody presses. Firing is a cron plus an
 * authenticated POST to `/api/cron/standing`, and that is the only place it
 * happens.
 *
 * ===========================================================================
 * THE MANDATE KEY IS MINTED HERE, ONCE PER RENDER
 * ===========================================================================
 *
 * `randomUUID()` on the server, carried into the form's hidden field. A
 * double-press or a browser replaying the POST therefore arrives under the SAME
 * key, hits `ON CONFLICT (mandate_key) DO NOTHING`, and gets back the row that
 * already exists. Minting it in the browser would produce a fresh key per
 * attempt — exactly the duplicate the UNIQUE index exists to refuse. `export
 * const dynamic = "force-dynamic"` is what keeps this a per-request value
 * rather than one baked into a cached page.
 */
export default async function ClientStandingOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseClientView(await searchParams);

  return (
    <div className="space-y-6">
      <Suspense
        key={`${view.state}:${view.businessId ?? ""}`}
        fallback={<ClientSkeleton rows={4} />}
      >
        <StandingSection view={view} />
      </Suspense>
    </div>
  );
}

async function StandingSection({ view }: { readonly view: ClientView }) {
  const loaded = await readClientStandingScreen(view.businessId, randomUUID());
  if (!loaded.ok) {
    return <ClientErrorPanel code={loaded.code} message={loaded.message} />;
  }
  return <ClientStandingOrdersView screen={loaded.value} />;
}
