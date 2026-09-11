import type { Metadata } from "next";
import { Suspense } from "react";

import { PayeeBookView, PayeeSkeleton } from "@/components/payees/PayeeBookView";
import { PayeeStateBar } from "@/components/payees/PayeeStateBar";
import { fixtureSource } from "@/components/payees/fixtures";
import { parsePayeeFilter } from "@/components/payees/view-state";
import { loadBusinessOptions } from "@/lib/payees/store";
import { livePayeeSource } from "@/lib/payees/screen";

export const metadata: Metadata = {
  title: "Payees · Corgi ops console",
  description:
    "The payee book: routing-number arithmetic, what the directory said, and who signed for a name that did not match.",
};

/**
 * Never prerendered.
 *
 * Freshness here is derived from when a check ran, not stamped at build time,
 * and a payee verified six months ago is a different fact from one verified
 * today. Baking either into a build artefact would put a deploy-time answer on
 * a page that is read as current.
 */
export const dynamic = "force-dynamic";

/**
 * Which businesses a payee may be added to.
 *
 * READ HERE AND NOT IN THE COMPONENT, because nothing under
 * `src/components/payees/**` opens a connection — the same seam the data
 * contract keeps for the book itself. It is also the switch that turns the
 * operator actions on: the list is only fetched for the live state, and an
 * empty list is what makes `PayeeBookView` render read-only.
 *
 * FAILURE IS EMPTY, NOT A THROW. A database that cannot answer this question
 * is one that cannot accept a payee either, so the honest page is the book
 * without an add form rather than an error boundary over the whole screen —
 * and the book's own read has its own error state, which is the one that
 * should be seen.
 */
async function addableBusinesses() {
  try {
    return await loadBusinessOptions();
  } catch {
    return [];
  }
}

/**
 * `/payees` — destination validation before the money leaves.
 *
 * RENDERING RUNS NO CHECKS. Running one is an operator action: it has an actor
 * attached and an append-only row at the end of it. A page that called Increase
 * and Plaid because somebody hit reload would be both a bill and a lie about
 * when the check happened — so the live source reads the book, and the check
 * itself lives behind a form.
 *
 * THE FORMS ARE ON THE LIVE STATE ONLY. Four of the five demo states are
 * fixtures, and a fixture that could be written to would be neither a fixture
 * nor a book. The add, re-check and signature actions all resolve their own
 * actor on the server and write against the live database, so they are
 * rendered only where the ids around them are real.
 */
export default async function PayeesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parsePayeeFilter(await searchParams);
  const live = filter.state === "default";
  const source = live ? livePayeeSource() : fixtureSource(filter.state);
  const businesses = live ? await addableBusinesses() : [];

  return (
    <div className="space-y-6">
      <PayeeStateBar filter={filter} />
      <Suspense fallback={<PayeeSkeleton />}>
        <PayeeBookView source={source} filter={filter} businesses={businesses} />
      </Suspense>
    </div>
  );
}
