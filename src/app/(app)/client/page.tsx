import { Suspense } from "react";
import type { Metadata } from "next";

import { BalanceView } from "@/components/client/BalanceView";
import { ClientErrorPanel, ClientNav, ClientSkeleton, ClientStateBar } from "@/components/client/Chrome";
import { parseClientView, type ClientView } from "@/components/client/view-state";

import { loadBalance } from "./sources";

export const metadata: Metadata = {
  title: "Your balance · Corgi",
};

/**
 * Never prerendered. This reads one customer's live balance and the role
 * cookie. A bank must never serve a cached page that was rendered for somebody
 * else's books.
 */
export const dynamic = "force-dynamic";

/**
 * `/client` — the balance, for the person whose money it is.
 *
 * The brief's first sentence is "Customers hold a balance, send and receive
 * payments, and get a card for each person on the team", and its third is
 * "Users need to see their balance". Nineteen screens in this build show a
 * balance; all nineteen show it to the bank. This is the one that shows it to
 * the customer, and the difference is not cosmetic — the operator's version
 * lists every business on the book in one table, so a customer reading it would
 * be reading everybody else's money to find their own.
 *
 * Five states, all in the URL:
 *
 *   (none)          LIVE. This business's real balance and real holds.
 *   ?state=loading  the real skeleton, held open by a genuinely slow read
 *   ?state=empty    FIXTURE. An account just opened: the identity still holds
 *   ?state=error    FIXTURE. The read failed; nothing moved, retry is live
 *   ?state=edge     LIVE. A business whose available balance is NEGATIVE while
 *                   its ledger balance is positive — uncleared credits, real on
 *                   this book, correct, and never clamped at zero
 *
 * ...plus the subject, which is also URL state:
 *
 *   ?business=<uuid>
 *
 * The `key` on the Suspense boundary carries both, so switching state or
 * customer re-suspends instead of showing the previous customer's figures under
 * a new name. On a screen scoped to one business that is not a polish detail:
 * a stale render here is a tenancy bug you can photograph.
 */
export default async function ClientBalancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseClientView(await searchParams);

  return (
    <div className="space-y-6">
      <ClientNav current="/client" view={view} />
      <ClientStateBar screen="/client" view={view} />
      <Suspense
        key={`${view.state}:${view.businessId ?? ""}`}
        fallback={<ClientSkeleton />}
      >
        <BalanceSection view={view} />
      </Suspense>
    </div>
  );
}

async function BalanceSection({ view }: { readonly view: ClientView }) {
  const loaded = await loadBalance(view);
  if (!loaded.ok) {
    return <ClientErrorPanel code={loaded.code} message={loaded.message} />;
  }
  return <BalanceView screen={loaded.value} view={view} />;
}
