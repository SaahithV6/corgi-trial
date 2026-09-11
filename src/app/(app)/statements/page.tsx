import { Suspense } from "react";
import type { Metadata } from "next";

import { StatementStateBar } from "@/components/statements/StatementStateBar";
import { StatementsSkeleton, StatementsView } from "@/components/statements/StatementsView";
import { createFixtureStatementsScreen } from "@/components/statements/screen-fixtures";
import { parseStatementFilter } from "@/components/statements/view-state";
import type { StatementsScreenSource } from "@/components/statements/data-contract";

export const metadata: Metadata = {
  title: "Statements · Corgi ops console",
};

/**
 * Never prerendered.
 *
 * The default state re-derives BOTH readings from the live ledger and checks a
 * hash. A page that ran that at BUILD time would either bake a stale
 * verification into a static artefact — the worst possible thing to bake, since
 * the whole claim is that it is checked NOW — or fail the build on a machine
 * with no database. Awaiting `searchParams` already forces dynamic rendering;
 * this says so out loud so nobody has to know that.
 */
export const dynamic = "force-dynamic";

type StatementsPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * `/statements` — one value date, read on both time axes.
 *
 * Five states, all reachable from the query string:
 *
 *   (none)          a value date read as believed and as corrected, LIVE
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    a day closed with no statement issued yet
 *   ?state=error    the statement query failed; retry is live
 *   ?state=edge     THE CORRECTED DAY ITSELF — the most recent value date this
 *                   book reversed and re-booked, resolved live
 *
 * ...plus the pickers, which are also URL state:
 *
 *   ?account=<uuid>   which customer's book
 *   ?day=YYYY-MM-DD   which value date — closed or not; see below
 *   ?v=<n>            which published version anchors the left-hand reading
 *   ?as=<anchor>      where the left-hand reading stands on the booking axis:
 *                     `published`, `close`, `before` or `now`
 *
 * WHY `?day=` IS NOT RESTRICTED TO CLOSED DAYS. Because the scenario the brief
 * describes does not wait for a close. A merchant reverses a settlement at
 * 14:00 and the corrected position exists at 14:01, on a day nobody has signed
 * off yet; the reversal carries the ORIGINAL value date and a strictly later
 * booking sequence, and both facts are answerable the moment it lands. A
 * screen that could only show that tomorrow would be a screen that cannot show
 * the thing it is for. So any value date renders, the left-hand anchor falls
 * back from "the published watermark" to "the close watermark" to "the
 * sequence before the correction landed", and the screen names which one it
 * used.
 *
 * WHY `default` AND `edge` ARE LIVE AND THE OTHER THREE ARE NOT. The claim
 * under test is "these two figures are derived from the journal at request
 * time and neither is stored", and a fixture would satisfy it by construction
 * and prove nothing. `edge` is live for a sharper reason still: the edge state
 * IS the corrected day, and a corrected day rendered from typed-in numbers is
 * the one thing on this screen that would be worth nothing. It falls back to
 * the fixture only when there is no database or no correction on the book —
 * and says `FIXTURE DATA` on its face when it does. `loading`, `empty` and
 * `error` stay fixtures because the writes behind this screen — closing a day,
 * issuing a document — are append-only and permanent. There is no undo to demo
 * with.
 *
 * The Suspense boundary is what makes the loading state honest: `StatementsView`
 * is an async server component, the fallback is the real skeleton, and
 * `?state=loading` slows the read rather than faking the render. The `key`
 * forces a fresh boundary per view so switching states, days or anchors
 * re-suspends instead of showing the previous document under a new heading —
 * which on a statements screen would be worse than a flicker.
 */
export default async function StatementsPage({ searchParams }: StatementsPageProps) {
  const filter = parseStatementFilter(await searchParams);
  const source = await selectSource(filter.state);

  return (
    <div className="space-y-6">
      <StatementStateBar filter={filter} />

      <Suspense
        key={`${filter.state}:${filter.accountId ?? ""}:${filter.businessDate ?? ""}:${filter.version ?? ""}:${filter.anchor ?? ""}`}
        fallback={<StatementsSkeleton />}
      >
        <StatementsView source={source} filter={filter} />
      </Suspense>
    </div>
  );
}

/**
 * Live for `default` and `edge`, fixture for the rest — and fixture for both of
 * those too when there is no database to read.
 *
 * The live module is imported dynamically because importing it evaluates
 * `src/lib/env.ts`, which refuses to load without a full set of keys. That is
 * the right behaviour for the app and the wrong behaviour for a page that must
 * be able to render the words "no database configured".
 */
async function selectSource(state: string): Promise<StatementsScreenSource> {
  if (state === "loading" || state === "empty" || state === "error") {
    return createFixtureStatementsScreen(state);
  }

  const { hasDatabase } = await import("./live-source");
  if (!hasDatabase()) {
    return createFixtureStatementsScreen(state === "edge" ? "edge" : "default");
  }

  const { loadStatementsScreen } = await import("./live-source");
  return { load: loadStatementsScreen };
}
