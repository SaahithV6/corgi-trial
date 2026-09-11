import { Suspense } from "react";
import type { Metadata } from "next";

import { ClientErrorPanel, ClientSkeleton } from "@/components/client/Chrome";
import { PayoutsView } from "@/components/client/payouts/PayoutsView";
import { parseClientView, type ClientView } from "@/components/client/view-state";

import { loadPayouts } from "./source";

export const metadata: Metadata = {
  title: "Send money abroad · Corgi",
};

/**
 * Never prerendered. This reads one customer's live balance and their own quote
 * book. A bank must never serve a cached page that was rendered for somebody
 * else's books.
 */
export const dynamic = "force-dynamic";

/**
 * `/client/payouts` — the half of the FX feature the customer is in.
 *
 * The brief's stretch ladder asks for "the cross-border USDC payout with an FX
 * quote THE CUSTOMER ACCEPTS". `/payouts` is the operator's console for the
 * same book: staff raise a quote on a customer's behalf and click accept for
 * them, which is the right screen for a bank to have and is not the feature the
 * sentence describes. A rate is a commitment because somebody was shown it and
 * said yes; a rate nobody was shown is a charge.
 *
 * This page therefore does three things and no more:
 *
 *   1. shows what the customer can commit, and what their earlier acceptances
 *      are already holding;
 *   2. quotes a corridor on request, with the mid rate, the fee and the spread
 *      each on their own line;
 *   3. accepts one, which reserves the money it commits — or refuses, by name,
 *      when the money is not there.
 *
 * It settles nothing and broadcasts nothing. That path exists elsewhere.
 *
 * `?business=<uuid>` picks whose account is in view. In this build that is a
 * demo control and not an authorisation decision — there is nothing to sign
 * into (`docs/DEMO.md` §1) — and it is safe to ship today for the reason
 * `view-state.ts` gives at length: the id is never a filter applied after the
 * fact. It becomes `WHERE business_id = $1` inside Postgres on every read, and
 * on the accept path it is half of a two-column predicate that decides whether
 * the quote reference on the form is this customer's at all.
 */
export default async function ClientPayoutsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseClientView(await searchParams);

  return (
    <div className="space-y-6">
      <Suspense key={`${view.state}:${view.businessId ?? ""}`} fallback={<ClientSkeleton rows={3} />}>
        <PayoutsSection view={view} />
      </Suspense>
    </div>
  );
}

async function PayoutsSection({ view }: { readonly view: ClientView }) {
  const loaded = await loadPayouts(view);
  if (!loaded.ok) {
    return <ClientErrorPanel code={loaded.code} message={loaded.message} />;
  }
  return <PayoutsView screen={loaded.value} view={view} />;
}
