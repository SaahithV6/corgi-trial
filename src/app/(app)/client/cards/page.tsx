import { Suspense } from "react";
import type { Metadata } from "next";

import { CardsView } from "@/components/client/CardsView";
import { ClientErrorPanel, ClientNav, ClientSkeleton, ClientStateBar } from "@/components/client/Chrome";
import { parseClientView, type ClientView } from "@/components/client/view-state";

import { loadCards } from "../sources";

export const metadata: Metadata = {
  title: "Your cards · Corgi",
};

export const dynamic = "force-dynamic";

/**
 * `/client/cards` — the card for each person on the team.
 *
 * The brief's opening paragraph asks for "a card for each person on the team",
 * and its live-fire list asks what the customer sees when an authorisation is
 * declined. `/team` answers the first question for the bank; this answers both
 * for the cardholder, in their own words, with the decline reason read out of
 * the record rather than rewritten.
 *
 * Five states, all in the URL:
 *
 *   (none)          LIVE. Every card on this business, and every decision.
 *   ?state=loading  the real skeleton, held open by a genuinely slow read
 *   ?state=empty    FIXTURE. A team with no cards issued
 *   ?state=error    FIXTURE. The read failed; no card was affected
 *   ?state=edge     LIVE, filtered to the declines — each with the sentence it
 *                   was recorded with at the moment it was decided
 */
export default async function ClientCardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseClientView(await searchParams);

  return (
    <div className="space-y-6">
      <ClientNav current="/client/cards" view={view} />
      <ClientStateBar screen="/client/cards" view={view} />
      <Suspense
        key={`${view.state}:${view.businessId ?? ""}`}
        fallback={<ClientSkeleton rows={5} />}
      >
        <CardsSection view={view} />
      </Suspense>
    </div>
  );
}

async function CardsSection({ view }: { readonly view: ClientView }) {
  const loaded = await loadCards(view);
  if (!loaded.ok) {
    return <ClientErrorPanel code={loaded.code} message={loaded.message} />;
  }
  return (
    <CardsView screen={loaded.value} view={view} declinesOnly={view.state === "edge"} />
  );
}
