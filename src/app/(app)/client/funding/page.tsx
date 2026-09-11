import { Suspense } from "react";
import type { Metadata } from "next";

import { ClientErrorPanel, ClientSkeleton } from "@/components/client/Chrome";
import { FundingClientView } from "@/components/client/funding/FundingClientView";
import { parseClientView, type ClientView } from "@/components/client/view-state";
import { bookDateOf } from "@/lib/rails/plaid/adapter";

import { fundFromLinkedBankAction, linkClientBankAction } from "./actions";
import { loadClientFunding } from "./source";

export const metadata: Metadata = {
  title: "Add money · Corgi",
};

/**
 * Never prerendered. The read is live, and a page that ran it at BUILD time
 * would bake this morning's balances into a static artefact — or fail the build
 * on a machine with no database.
 */
export const dynamic = "force-dynamic";

/**
 * `/client/funding` — the customer's half of funding.
 *
 * ===========================================================================
 * WHY THIS ROUTE EXISTS
 * ===========================================================================
 *
 * The brief says customers fund the account "from an external bank THEY LINK
 * THEMSELVES". This build had the whole feature at `/funding`, on the STAFF
 * console: a member of bank staff could link a Plaid Item on a customer's
 * behalf and pull money in, and the customer whose money it was could do
 * neither. Linking your own bank is an act of consent. The operator needs to
 * see it; the customer needs to perform it.
 *
 * Nothing here reimplements the feature. `linkExternalAccount()`,
 * `recordLinkedItem()` and `fundFromLinkedAccount()` in `@/lib/rails/plaid/**`
 * are the same functions `/funding` calls, reached through the library rather
 * than through the other screen, so the availability policy, the idempotency
 * indexes and the double-entry posting are one implementation with two callers.
 * `src/app/(app)/funding/**` is untouched.
 *
 * ===========================================================================
 * THE STATES
 * ===========================================================================
 *
 *   (none)          LIVE. This business's real linked banks and real balances.
 *   ?state=loading  the real skeleton, held open by a genuinely slow read
 *   ?state=error    LIVE, and honest: there is no fixture on this screen
 *   ?business=<id>  whose book — a predicate, never permission
 *
 * `empty` is deliberately absent rather than faked: a customer with no linked
 * bank is not a fixture here, it is the ordinary first visit, it is what this
 * page renders when the list is empty, and it is one click away from stopping
 * being true.
 */
export default async function ClientFundingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseClientView(await searchParams);

  return (
    <Suspense
      key={`${view.state}:${view.businessId ?? ""}`}
      fallback={<ClientSkeleton rows={5} />}
    >
      <FundingSection view={view} />
    </Suspense>
  );
}

async function FundingSection({ view }: { readonly view: ClientView }) {
  const loaded = await loadClientFunding(view.businessId, view.state === "loading");
  if (!loaded.ok) {
    return <ClientErrorPanel code={loaded.code} message={loaded.message} />;
  }
  return (
    <FundingClientView
      screen={loaded.value}
      linkAction={linkClientBankAction}
      fundAction={fundFromLinkedBankAction}
      today={bookDateOf()}
    />
  );
}
