import { Suspense } from "react";
import type { Metadata } from "next";

import { AuditSkeleton } from "@/components/audit/AuditSkeleton";
import { AuditStateBar } from "@/components/audit/AuditStateBar";
import { TimelineView } from "@/components/audit/TimelineView";
import type { AuditDataSource } from "@/components/audit/contract";
import {
  createFailingSource,
  createSlowFixtureSource,
} from "@/components/audit/fixtures";
import { createUnreadableAuditSource } from "@/components/audit/unreadable";
import { parseAuditFilter } from "@/components/audit/view-state";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

export const metadata: Metadata = {
  title: "Audit trail · Corgi ops console",
};

/**
 * Never prerendered. The default state reads the live book, and a page that
 * ran that query at BUILD time would bake one moment's trail into a static
 * artefact — which is the one thing an audit screen must never be.
 */
export const dynamic = "force-dynamic";

type AuditPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * `/audit` — who did what to this business, in order.
 *
 * ===========================================================================
 * WHAT THIS SCREEN IS FOR. The ledger answers "what happened to the money"
 * four different ways over. Nothing answered "who DID that": the facts existed
 * but were scattered across thirty-odd stores with four different ideas of
 * what an actor is, and there was no way to ask the first question a regulator
 * or an incident review asks.
 *
 * It is a PROJECTION, not a fifth store. `db/migrations/0035_audit.sql` reads
 * thirty-nine append-only tables into one ordered stream; nothing has to
 * remember to call it, so no surface can go missing by forgetting to. The one
 * failure mode a projection does have — a store that exists and is not read —
 * is checked against the catalog on every render and printed on the face of
 * the completeness panel.
 * ===========================================================================
 *
 * Five states, all reachable from the query string:
 *
 *   (none)          the whole trail for one business, LIVE from the book
 *   ?state=loading  the skeleton, held open by a deliberately slow read
 *   ?state=empty    LIVE: the quietest business filtered to agent actions,
 *                   which genuinely returns nothing — "0 of 9"
 *   ?state=error    the read failed; nothing moved, retry is live
 *   ?state=edge     LIVE: actions taken by an AUTONOMOUS AGENT
 *
 * ...plus the filters and the drill-through, which are also URL state:
 *
 *   ?business=<uuid>   whose timeline
 *   ?kind=agent        one kind of actor
 *   ?surface=payments  one product surface
 *   ?source=<table>    one underlying store
 *   ?scope=all         include actions that belong to the book, not a business
 *   ?page=2            older actions
 *   ?action=<id>       open one action's underlying record
 *
 * WHY THE EDGE STATE IS THE AGENT. It is the row a reviewer looks at hardest,
 * and the one most likely to render wrong — every other row on this screen is
 * a person, and a template that reads well for a person reads *reassuringly*
 * for a model. `docs/AGENT-LIMITS.md` is the written half of that boundary and
 * this is its observable half.
 */
export default async function AuditPage({ searchParams }: AuditPageProps) {
  const filter = parseAuditFilter(await searchParams);
  // ONE VALUE, TWO SURFACES. The state bar's badge and note, and which source
  // `TimelineView` reads through, both come from this line, so they cannot
  // disagree about what this screen read.
  const noDatabase = !hasDatabase();
  const source = await selectSource(filter.state, noDatabase);

  return (
    <div className="space-y-6">
      <AuditStateBar filter={filter} noDatabase={noDatabase} />

      <Suspense
        key={`${filter.state}:${filter.businessId ?? ""}:${filter.kind ?? ""}:${filter.surface ?? ""}:${filter.source ?? ""}:${filter.page}:${filter.selected ?? ""}:${filter.includeBookWide}`}
        fallback={<AuditSkeleton />}
      >
        <TimelineView source={source} filter={filter} />
      </Suspense>
    </div>
  );
}

/**
 * Live for `default`, `edge` and `empty`; fixture for `loading`; a throw for
 * `error`; and a REFUSAL for the three live states when no database is
 * configured.
 *
 * The live module is imported dynamically because importing it evaluates
 * `src/lib/env.ts`, which refuses to load without a full set of keys. That is
 * the right behaviour for the app and the wrong behaviour for a page that must
 * be able to render the words "no database configured" — so the import happens
 * only on the branch that has already established there is a database to read.
 *
 * WHAT THIS FUNCTION USED TO DO, AND WHY IT IS THE DEFECT THIS SCREEN CARRIED.
 * It asked `hasDatabase()` by importing `@/lib/audit/view`, which reaches
 * `@/lib/ledger/db` -> `@/lib/env` and throws `EnvironmentError` without
 * `APP_DATABASE_URL`. The guard was therefore unreachable in the one case it
 * was written for: the import above it only succeeds when a database IS
 * configured. Measured with the variable deleted, the render threw at
 * `src/lib/ledger/db.ts:18` and the operator got the framework's error page.
 *
 * If it HAD run, it returned `createFixtureSource()` for all three live states:
 * a named business, two actions, `business total 2`, `sources 0 reconciled` and
 * `dropped 0`, under the sentence "every action recorded against this business,
 * from every append-only store on the book". This screen's claim is
 * COMPLETENESS. Nought stores reconciled, drawn on a deployment that opened no
 * connection, is a clean bill from a projection that read nothing.
 *
 * `?state=empty` was the sharpest of the three. That state is live BECAUSE the
 * emptiness has to be real — a business filtered to agent actions that
 * genuinely returns nothing — and the fallback answered it with a fixture
 * holding two actions, under a state label reading "Empty".
 *
 * With no database the answer is now a REFUSAL, from
 * `@/components/audit/unreadable`, which `TimelineView` renders the same way it
 * renders a failed read: no business, no action, no completeness.
 */
async function selectSource(
  state: string,
  noDatabase: boolean,
): Promise<AuditDataSource> {
  // The two drawn states are checked FIRST, and stay drawn whether or not a
  // database is configured: they are demonstrations, and "no database" does not
  // make a drawing any more or less drawn. Checking them after the refusal
  // would announce a deliberately-thrown fixture failure as a configuration
  // problem, which is a different false claim in the other direction.
  if (state === "loading") return createSlowFixtureSource();
  if (state === "error") return createFailingSource();

  if (noDatabase) return createUnreadableAuditSource();

  const { loadTimeline } = await import("@/lib/audit/view");
  return { load: loadTimeline };
}
