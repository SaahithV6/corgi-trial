import { Suspense } from "react";
import type { Metadata } from "next";

import { Badge, FOCUS_RING, Note } from "@/components/ui/primitives";
import Link from "next/link";
import { systemClock } from "@/lib/timetravel/clock";
import {
  AS_KNOWN_AT_PARAM,
  AS_OF_PARAM,
  parseTimeTravelParams,
  withTimeTravel,
} from "@/lib/timetravel/params";
import { AccountSkeleton, AccountView } from "@/components/account/AccountView";
import { DemoStateBar } from "@/components/account/DemoStateBar";
import { parseDemoView } from "@/components/account/demo-state";
import { getAccountDataSource, isLiveView } from "@/components/account/fixtures";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

export const metadata: Metadata = {
  title: "Account · Corgi ops console",
};

/**
 * Never prerendered. Every figure on this page is a fold taken at request
 * time against the live journal.
 */
export const dynamic = "force-dynamic";

type AccountPageProps = {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * `/accounts/[accountId]` — the account screen.
 *
 * The bare URL is the LIVE ledger: balances, holds and postings are read from
 * the journal through `src/lib/ledger/queries.ts`, folded as of one instant
 * and one booking watermark. Everything else is a fixture, on purpose:
 *
 *   (none)          live — the real account, read at request time
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    opened, nothing booked
 *   ?state=error    the balance query failed; retry is live
 *   ?state=edge     available is negative after an over-capture
 *   ?auth=pending   lands a $50.00 fuel-pump authorisation, as a fixture
 *
 * ...and one state the URL cannot ask for: NO DATABASE CONFIGURED. It is not a
 * sixth demo state, because it is not a demonstration of anything — it is what
 * this deployment is. The badge reads NO DATABASE, the panel below names the
 * condition, and no balance, hold or posting is drawn. It used to arrive here
 * as `LEDGER_READ_FAILED` with `retryable: true` — the code for a query that
 * did not come back, over a case where no query was ever issued — under the
 * words "Retrying is safe." beside a live Retry button. See
 * `src/components/account/unreadable.ts`.
 *
 * THIS SCREEN DOES NOT TIME TRAVEL, and says so when asked to. It reads
 * through `AccountDataSource`, whose live implementation
 * (`src/components/account/live-data-source.ts`) takes its own snapshot
 * internally and exposes no seam to inject one — and that module belongs to
 * another worker on this build. Rather than render a control that does
 * nothing, or worse, render travelled-looking figures that are not, the page
 * states the limitation and points at `/transactions`, which honours both axes
 * for the same account. A screen that ignored the parameter while showing a
 * time-travel control would be a lie.
 *
 * Which one is on screen is stated rather than implied. A console that shows
 * seeded demo money in the same chrome as a customer's real balance, with
 * nothing to tell them apart, is one screenshot away from a very bad meeting.
 *
 * The Suspense boundary is what makes the loading state honest: `AccountView`
 * is an async server component, the fallback is the real skeleton, and
 * `?state=loading` slows the read rather than faking the render. The `key`
 * forces a fresh boundary per state so switching states re-suspends instead of
 * showing the previous state's data under a new heading.
 */
export default async function AccountPage({
  params,
  searchParams,
}: AccountPageProps) {
  const { accountId } = await params;
  const resolved = await searchParams;
  const view = parseDemoView(resolved);
  // ONE VALUE, TWO SURFACES. The badge below and the source `AccountView` reads
  // through both come from these two lines, so they cannot disagree about what
  // this screen read. `isLiveView` already worked that way for the badge and
  // the fixture switch; `noDatabase` is the question it could not ask.
  const noDatabase = !hasDatabase();
  const live = isLiveView(view) && !noDatabase;
  const source = getAccountDataSource(view, noDatabase);

  // Parsed only to detect that a point was ASKED FOR. With neither parameter
  // present this is `absent`, nothing extra renders, and the page is exactly
  // the page it was before.
  const parsed = parseTimeTravelParams(resolved, systemClock.now());
  const asked = !parsed.ok || !parsed.request.absent;

  return (
    <div className="space-y-6">
      {asked ? <NotTravelledHere accountId={accountId} resolved={resolved} /> : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {noDatabase ? (
          <Badge
            tone="negative"
            title="No APP_DATABASE_URL is set for this deployment. Nothing on this screen was read from the journal."
          >
            NO DATABASE
          </Badge>
        ) : live ? (
          <Badge tone="positive" title="Read from the journal at request time.">
            live ledger
          </Badge>
        ) : (
          <Badge
            tone="quiet"
            title="Demo data. Nothing on this view was read from the database."
          >
            fixture
          </Badge>
        )}
        <p className="max-w-prose text-xs text-muted">
          {noDatabase
            ? "No database is configured for this deployment, so no balance was folded and no hold or posting was read for this account. The panel below says so; it is not this account's balances."
            : live
              ? "Every figure below is a fold over journal lines, taken as of one instant and one booking watermark. No balance is stored anywhere in this schema."
              : "Demo data behind the same interface the live ledger implements. The query string is the only thing that selects it, and nothing here was written to the database."}
        </p>
      </div>

      <DemoStateBar accountId={accountId} view={view} />

      <Suspense
        key={`${view.state}:${String(view.authPending)}`}
        fallback={<AccountSkeleton />}
      >
        <AccountView accountId={accountId} view={view} source={source} />
      </Suspense>
    </div>
  );
}

/**
 * The honest label, rendered only when a point was actually asked for.
 *
 * It names the module, the reason, and the screen that DOES answer — because
 * "this does not work here" without a destination is a dead end, and the
 * destination exists.
 */
function NotTravelledHere({
  accountId,
  resolved,
}: {
  readonly accountId: string;
  readonly resolved: Record<string, string | string[] | undefined>;
}) {
  const first = (key: string): string | null => {
    const raw = resolved[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value === undefined || value === "" ? null : value;
  };

  const href = withTimeTravel(`/transactions?account=${accountId}`, {
    asOf: first(AS_OF_PARAM),
    asKnownAt: first(AS_KNOWN_AT_PARAM),
  });

  return (
    <Note emphasis title="This screen does not time travel — the figures below are as at now">
      <p>
        <span className="font-mono text-text">?{AS_OF_PARAM}</span> and{" "}
        <span className="font-mono text-text">?{AS_KNOWN_AT_PARAM}</span> are
        ignored here. This page reads through{" "}
        <span className="font-mono">AccountDataSource</span>, whose live
        implementation takes its own snapshot internally and exposes no seam to
        inject one; that module is owned by another worker on this build. Every
        balance, hold and posting below is the live one.
      </p>
      <p className="mt-1.5">
        <Link href={href} className={`underline underline-offset-4 ${FOCUS_RING}`}>
          Open this account at that point on /transactions
        </Link>{" "}
        — same account, both axes honoured, with the acts that changed the
        answer itemised.
      </p>
    </Note>
  );
}
