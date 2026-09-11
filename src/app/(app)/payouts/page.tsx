import type { Metadata } from "next";
import { Suspense } from "react";

import { PayoutStateBar } from "@/components/payouts/PayoutStateBar";
import { PayoutsView, PayoutSkeleton } from "@/components/payouts/PayoutsView";
import { fixtureSource } from "@/components/payouts/fixtures";
import { parsePayoutFilter } from "@/components/payouts/view-state";
import { livePayoutsSource } from "@/lib/fx/screen";

export const metadata: Metadata = {
  title: "Cross-border payouts · Corgi ops console",
  description:
    "An FX quote the customer accepts before the money moves: a live mid rate, a spread shown as its own line, an expiry the database enforces, and a gate that refuses a payout without an accepted quote behind it.",
};

/**
 * Never prerendered.
 *
 * This one is not a preference. A quote's state is a comparison against
 * `now()` — an offer that stood two minutes ago has lapsed — so a build-time
 * render would put a countdown on the page that started running when the
 * deploy happened. A cached rate would be worse: it would show a price nobody
 * is being offered, on the screen whose entire job is to be exact about what
 * price is on the table.
 */
export const dynamic = "force-dynamic";

/**
 * `/payouts` — the price the customer agreed, before the money leaves.
 *
 * RENDERING RAISES NOTHING. Requesting a quote is an operator action: it has
 * an actor attached, it reads a rate source, and it writes two append-only
 * rows. Accepting one is a commitment. A page that quoted because somebody hit
 * reload would fill the book with offers nobody asked for and put a timestamp
 * on a price no customer ever saw — so the live source reads the book, and
 * both writes live behind forms.
 *
 * The one outbound call a render can make is the current mid for a quote in
 * focus that we are still on the hook for, so the screen can show what
 * honouring it would cost today. That is a read of a free, keyless endpoint:
 * it writes nothing and bills nobody. See `src/lib/fx/screen.ts`.
 */
export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parsePayoutFilter(await searchParams);
  const source = filter.state === "default" ? livePayoutsSource() : fixtureSource(filter.state);

  return (
    <div className="space-y-6">
      <PayoutStateBar filter={filter} />
      <Suspense fallback={<PayoutSkeleton />}>
        <PayoutsView source={source} filter={filter} />
      </Suspense>
    </div>
  );
}
