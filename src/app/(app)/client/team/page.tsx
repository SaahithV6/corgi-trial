import { Suspense } from "react";
import type { Metadata } from "next";

import { ClientErrorPanel, ClientSkeleton } from "@/components/client/Chrome";
import { TeamClientView } from "@/components/client/team/TeamClientView";
import { parseClientView, type ClientView } from "@/components/client/view-state";

import { loadClientTeam } from "./source";

export const metadata: Metadata = {
  title: "Your team · Corgi",
};

/**
 * Never prerendered. The read is live, and a page that ran it at BUILD time
 * would bake this morning's team into a static artefact — or fail the build on
 * a machine with no database.
 */
export const dynamic = "force-dynamic";

/**
 * `/client/team` — the customer's half of the team feature.
 *
 * ===========================================================================
 * WHY THIS ROUTE EXISTS
 * ===========================================================================
 *
 * The brief's first sentence: "Customers hold a balance, send and receive
 * payments, and get a card for each person on the team." The first two clauses
 * were already the customer's, at `/client` and `/client/pay`. The third was
 * not: adding a person and issuing them a card lived only on the staff console
 * at `/team`, so a business owner had to ring the bank to give their new
 * warehouse manager a fuel card. The operator needs to SEE the team; the
 * customer needs to run it.
 *
 * Nothing here reimplements the feature. `addMember()`, `setMemberTerms()`,
 * `endMembership()`, `reinstateMember()` and `issueCardToMember()` in
 * `@/lib/team/**` are the same functions `/team` calls, reached through the
 * library rather than through the other screen — so the append-only versioning,
 * the SECURITY DEFINER authorship gate, the issuer-before-the-fact ordering on
 * a removal, `applyDefaultControls()` on issuance and the refusals in 0062 and
 * 0064 are one implementation with two callers.
 * `src/app/(app)/team/**`, `src/components/team/**` and `src/lib/team/**` are
 * untouched.
 *
 * ===========================================================================
 * THE STATES
 * ===========================================================================
 *
 *   (none)          LIVE. This business's real team, real cards, real limits.
 *   ?state=loading  the real skeleton, held open by a genuinely slow READ
 *   ?business=<id>  whose team — a predicate, never permission
 *
 * There is no `empty` fixture and no `error` fixture, deliberately. A business
 * with nobody on the team is the ordinary first state of this screen and the
 * live read already produces it; a business with no administrator is a real
 * state this screen renders and explains. Inventing a fixture for a state the
 * live read already reaches would prove less than the live read does.
 */
export default async function ClientTeamPage({
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
      <TeamSection view={view} />
    </Suspense>
  );
}

async function TeamSection({ view }: { readonly view: ClientView }) {
  const loaded = await loadClientTeam(view.businessId, view.state === "loading");
  if (!loaded.ok) {
    return <ClientErrorPanel code={loaded.code} message={loaded.message} />;
  }
  return <TeamClientView screen={loaded.value} href="/client/team" />;
}
