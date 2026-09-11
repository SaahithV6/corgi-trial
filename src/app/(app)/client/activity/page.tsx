import { Suspense } from "react";
import type { Metadata } from "next";

import { ActivityView } from "@/components/client/ActivityView";
import { ClientErrorPanel, ClientNav, ClientSkeleton, ClientStateBar } from "@/components/client/Chrome";
import { parseClientView, type ClientView } from "@/components/client/view-state";

import { loadActivity } from "../sources";

export const metadata: Metadata = {
  title: "Your activity · Corgi",
};

export const dynamic = "force-dynamic";

/**
 * `/client/activity` — their transactions, in plain language.
 *
 * Five states, all in the URL:
 *
 *   (none)          LIVE. Every movement on this customer's current account.
 *   ?state=loading  the real skeleton, held open by a genuinely slow read
 *   ?state=empty    FIXTURE. A customer nobody has paid yet
 *   ?state=error    FIXTURE. The read failed; nothing moved
 *   ?state=edge     LIVE, filtered to the corrections — a settlement taken back,
 *                   shown beside the entry it reverses, both still on the record
 *
 * The edge state is a FILTER OVER THE LIVE ROWS, not a fixture and not a
 * different query: the same rows the default state shows, narrowed to the ones
 * that are the point. If this customer has never had a correction the screen
 * says so plainly rather than manufacturing one — a demo state that invents its
 * own subject proves nothing.
 */
export default async function ClientActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseClientView(await searchParams);

  return (
    <div className="space-y-6">
      <ClientNav current="/client/activity" view={view} />
      <ClientStateBar screen="/client/activity" view={view} />
      <Suspense
        key={`${view.state}:${view.businessId ?? ""}`}
        fallback={<ClientSkeleton rows={6} />}
      >
        <ActivitySection view={view} />
      </Suspense>
    </div>
  );
}

async function ActivitySection({ view }: { readonly view: ClientView }) {
  const loaded = await loadActivity(view);
  if (!loaded.ok) {
    return <ClientErrorPanel code={loaded.code} message={loaded.message} />;
  }
  return (
    <ActivityView
      screen={loaded.value}
      view={view}
      correctionsOnly={view.state === "edge"}
    />
  );
}
