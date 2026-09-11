import { Suspense } from "react";
import type { Metadata } from "next";

import { ClientErrorPanel, ClientSkeleton } from "@/components/client/Chrome";
import { PotsClientView } from "@/components/client/pots/PotsClientView";
import { parseClientView, type ClientView } from "@/components/client/view-state";

import { loadClientPots } from "./source";

export const metadata: Metadata = {
  title: "Your pots · Corgi",
};

/**
 * Never prerendered. The read is live and a page that ran it at BUILD time
 * would bake this morning's balances into a static artefact, or fail the build
 * on a machine with no database.
 */
export const dynamic = "force-dynamic";

/**
 * `/client/pots` — the customer's half of the pots feature.
 *
 * ===========================================================================
 * WHY THIS ROUTE EXISTS
 * ===========================================================================
 *
 * The brief's stretch ladder asks for "sub-accounts or pots, with instant
 * internal transfers that are pure ledger moves". This build had the whole
 * feature at `/pots`, on the STAFF console: a member of bank staff could open
 * a pot on a customer's behalf and move that customer's money between pots,
 * and the customer whose money it was could do neither. Pots are a customer
 * feature. The operator needs to see them; the customer needs to use them.
 *
 * Nothing here reimplements the feature. `openPot()` and `movePotFunds()` in
 * `@/lib/pots/transfer` are the same two functions `/pots` calls, reached
 * through the library rather than through the other screen, so the lock, the
 * decision, the idempotency key and migration 0057's deferred trigger are one
 * implementation with two callers. `src/app/(app)/pots/**` is untouched.
 *
 * ===========================================================================
 * THE STATES
 * ===========================================================================
 *
 *   (none)          LIVE. This business's real pots and real balances.
 *   ?state=loading  the real skeleton, held open by a genuinely slow read
 *   ?state=error    LIVE, and honest: there is no fixture on this screen
 *   ?business=<id>  whose book — a predicate, never permission
 *
 * The other two states the sibling screens carry are deliberately absent
 * rather than faked. A customer with no pots is not a fixture here: it is the
 * ordinary first visit, it is what the page renders when the list is empty,
 * and it is one click away from stopping being true. Inventing a fixture for
 * a state the live read already produces would prove less than the live read
 * does.
 */
export default async function ClientPotsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseClientView(await searchParams);

  return (
    <Suspense
      key={`${view.state}:${view.businessId ?? ""}`}
      fallback={<ClientSkeleton rows={4} />}
    >
      <PotsSection view={view} />
    </Suspense>
  );
}

async function PotsSection({ view }: { readonly view: ClientView }) {
  const loaded = await loadClientPots(view.businessId, view.state === "loading");
  if (!loaded.ok) {
    return <ClientErrorPanel code={loaded.code} message={loaded.message} />;
  }
  return <PotsClientView screen={loaded.value} view={view} />;
}
