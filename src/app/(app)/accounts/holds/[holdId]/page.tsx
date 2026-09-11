import type { Metadata } from "next";
import Link from "next/link";

import { isErr } from "@/lib/result";
import { FOCUS_RING, Panel } from "@/components/ui/primitives";
import { ConsoleErrorPanel } from "@/components/accounts/ConsoleChrome";
import { HoldDetailView } from "@/components/accounts/HoldDetailView";
import { fixtureHoldDetail } from "@/components/accounts/fixtures";
import { HOLD_NO_DATABASE, unreadableHoldDetail } from "@/components/accounts/unreadable";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

export const metadata: Metadata = {
  title: "Hold · Corgi ops console",
};

/**
 * Never prerendered. `closed(E)` has a clock term, so the answer this page
 * gives depends on when it is asked.
 */
export const dynamic = "force-dynamic";

/**
 * `/accounts/holds/[holdId]` — the drill-down.
 *
 * The console's holds table shows A(E), C(E) and H(E) for every hold. This page
 * shows where those three numbers came from: the event set itself, one row per
 * member, with the fold recomputed at each step by calling the model.
 *
 * The route is a static segment ahead of the sibling `[accountId]` dynamic one,
 * so `/accounts/holds/<uuid>` reaches here and `/accounts/<uuid>` still reaches
 * the account screen.
 *
 * Fixture holds are checked FIRST and by exact id, so `?state=edge` can be
 * drilled into as well — an over-capture is the most interesting event set on
 * the screen and it would be perverse to make it the one you cannot open. A
 * real uuid never matches, so no live hold is ever intercepted.
 *
 * AND THAT FIXTURE BRANCH USED TO BE UNREACHABLE WITHOUT A DATABASE, which
 * defeated the design it is the first line of. `@/components/accounts/live-source`
 * was imported at the top of this file; it value-imports
 * `@/lib/ledger/balances` -> `@/lib/ledger/db` -> `@/lib/env`, which throws
 * `EnvironmentError` at module scope without `APP_DATABASE_URL`. So the module
 * never finished loading and the drawn hold — which wants no database and reads
 * no row — died for want of one. The live source is now reached by
 * `await import(...)`, below the two branches that do not need it.
 */
export default async function HoldPage({
  params,
}: {
  params: Promise<{ holdId: string }>;
}) {
  const { holdId } = await params;

  const fixture = fixtureHoldDetail(holdId);
  if (fixture !== null) return <HoldDetailView detail={fixture} />;

  const result = await loadDetail(holdId);
  if (isErr(result)) {
    return result.error.code === HOLD_NO_DATABASE.code ? (
      <ConsoleErrorPanel
        error={result.error}
        title="This hold could not be read"
        description="No database is configured for this deployment. No event set was read and H(E) was not folded."
      />
    ) : (
      <ConsoleErrorPanel error={result.error} />
    );
  }

  if (result.value === null) {
    return (
      <div className="space-y-6">
        <p className="text-xs text-muted">
          <Link
            href="/accounts"
            className={`underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
          >
            ← Back to the card &amp; hold console
          </Link>
        </p>
        <Panel
          title="No such hold"
          description="Nothing in this ledger has that id."
        >
          <p className="max-w-prose px-5 py-8 text-sm text-muted">
            &ldquo;No such hold&rdquo; is an answer, not a failure. A hold id
            that is not a uuid never reaches Postgres at all — it is refused
            here, so a mistyped URL renders this page rather than raising{" "}
            <span className="font-mono">22P02</span> from a cast.
          </p>
        </Panel>
      </div>
    );
  }

  return <HoldDetailView detail={result.value} />;
}

/**
 * The live read, behind the two branches that do not want one.
 *
 * `hasDatabase()` is asked BEFORE the import rather than after it, which is
 * the whole point: the import is what throws when the answer is no.
 */
async function loadDetail(holdId: string) {
  if (!hasDatabase()) return unreadableHoldDetail();
  const { loadHoldDetail } = await import("@/components/accounts/live-source");
  return await loadHoldDetail(holdId);
}
