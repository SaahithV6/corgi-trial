import type { Metadata } from "next";
import { Suspense } from "react";

import { PayeeBookView, PayeeSkeleton } from "@/components/payees/PayeeBookView";
import { PayeeStateBar } from "@/components/payees/PayeeStateBar";
import { fixtureSource } from "@/components/payees/fixtures";
import { parsePayeeFilter } from "@/components/payees/view-state";
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
 * `/payees` — destination validation before the money leaves.
 *
 * RENDERING RUNS NO CHECKS. Running one is an operator action: it has an actor
 * attached and an append-only row at the end of it. A page that called Increase
 * and Plaid because somebody hit reload would be both a bill and a lie about
 * when the check happened — so the live source reads the book, and the check
 * itself lives behind a form.
 */
export default async function PayeesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parsePayeeFilter(await searchParams);
  const source = filter.state === "default" ? livePayeeSource() : fixtureSource(filter.state);

  return (
    <div className="space-y-6">
      <PayeeStateBar filter={filter} />
      <Suspense fallback={<PayeeSkeleton />}>
        <PayeeBookView source={source} filter={filter} />
      </Suspense>
    </div>
  );
}
