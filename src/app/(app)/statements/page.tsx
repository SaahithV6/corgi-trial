import { Suspense } from "react";
import type { Metadata } from "next";

import { systemClock } from "@/lib/timetravel/clock";
import {
  AS_KNOWN_AT_PARAM,
  AS_OF_PARAM,
  parseTimeTravelParams,
  withTimeTravel,
} from "@/lib/timetravel/params";
import { RefusalPanel } from "@/components/timetravel/Refusal";

import { StatementTimeTravel } from "./time-travel";
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
 *
 * ===========================================================================
 * TIME TRAVEL, AND WHY IT SPLITS IN TWO HERE
 * ===========================================================================
 *
 * `?asOf=` is honoured COMPLETELY and invisibly: it is mapped onto this
 * screen's own `?day=` filter, because they are the same axis under two names.
 * The whole screen — both readings, the corrections, the hashes, the versions —
 * then renders that value date.
 *
 * `?asKnownAt=` is honoured in its OWN panel, above the document, and is
 * deliberately not folded into `?as=`. That control has four positions and
 * each is a watermark with a NAME a reader can check — the watermark a
 * document was issued against, the watermark a day was frozen at. An arbitrary
 * instant is not one of those four, and `BelievedAnchor` is a closed type in
 * `src/components/statements/data-contract.ts`, which belongs to another
 * worker. Squeezing an instant into it would mean either mislabelling the
 * left-hand column or snapping the reader's instant to the nearest anchor and
 * answering a different question. Both are false labels.
 *
 * WITH NEITHER PARAMETER PRESENT THIS PAGE IS UNCHANGED. The parse reports
 * `absent`, the panel does not render, no extra query is issued, and the
 * filter is the one `parseStatementFilter` produced from the URL as before.
 */
export default async function StatementsPage({ searchParams }: StatementsPageProps) {
  const resolved = await searchParams;

  // ONE CLOCK, TAKEN ONCE, AT THE TOP.
  const parsed = parseTimeTravelParams(resolved, systemClock.now());

  const basePath = statementsBasePath(resolved);
  const liveHref = withTimeTravel(basePath, { asOf: null, asKnownAt: null });

  // Refused before a connection is opened, and it replaces the screen rather
  // than sitting above a document that silently answers a different question.
  if (!parsed.ok) {
    return (
      <div className="space-y-6">
        <RefusalPanel refusals={parsed.refusals} liveHref={liveHref} />
      </div>
    );
  }

  // `asOf` IS the value axis this screen already has. Mapped onto `?day=`
  // rather than handled separately, so the document below renders the day the
  // URL asked for — the whole screen honours the value axis, not a panel.
  const forFilter =
    parsed.request.asOfValueDate === null
      ? resolved
      : { ...resolved, day: parsed.request.asOfValueDate };

  const filter = parseStatementFilter(forFilter);
  const source = await selectSource(filter.state);
  const travelling = !parsed.request.absent;

  return (
    <div className="space-y-6">
      <StatementStateBar filter={filter} />

      {travelling ? (
        <Suspense fallback={null}>
          <StatementTimeTravel
            request={parsed.request}
            accountId={filter.accountId}
            basePath={basePath}
            liveHref={liveHref}
          />
        </Suspense>
      ) : null}

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

/** This route with its own query state, as the base every time link builds on. */
function statementsBasePath(
  params: Record<string, string | string[] | undefined>,
): string {
  const out = new URLSearchParams();
  for (const key of ["state", "account", "v", "as", AS_OF_PARAM, AS_KNOWN_AT_PARAM]) {
    const raw = params[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value !== undefined && value !== "") out.set(key, value);
  }
  const query = out.toString();
  return query === "" ? "/statements" : `/statements?${query}`;
}
