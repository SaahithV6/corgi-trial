import { Suspense } from "react";
import type { Metadata } from "next";

import { EventsError, EventsScreen, EventsSkeleton } from "@/components/events/EventsView";
import { RegisterForm, type BusinessOption } from "@/components/events/RegisterForm";
import { createFixtureEventsSource, type FixtureState } from "@/components/events/fixtures";
import { createUnreadableEventsSource } from "@/components/events/unreadable";
import type { EventsDataSource } from "@/components/events/data-contract";
import { EVENT_TYPES } from "@/lib/events/envelope";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

export const metadata: Metadata = {
  title: "Outbound events · Corgi ops console",
};

/**
 * Never cached, never prerendered.
 *
 * A delivery log whose "pending" count is a minute old is a delivery log that
 * has told somebody their webhook is stuck when it arrived thirty seconds ago.
 * Awaiting `searchParams` already forces dynamic rendering; this says so.
 */
export const dynamic = "force-dynamic";

/**
 * `/events` — outbound webhooks: the events this bank sends to its customers.
 *
 * Five states, all reachable from the query string, which is the house pattern
 * (`/breaks`, `/chaos`):
 *
 *   (none)          LIVE from the database
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    no endpoints registered, nothing queued
 *   ?state=error    the read failed; nothing was sent and nothing was lost
 *   ?state=edge     a dead letter whose reason is the one nobody expects —
 *                   the endpoint's DNS started answering with a private
 *                   address, so no packet was ever sent. See `fixtures.ts`
 *                   for why that is the edge worth rendering rather than a
 *                   500 from the customer's server.
 *
 * WHY `default` IS LIVE. The claim this screen makes — that real events were
 * signed and delivered to a real endpoint — is only worth anything if the rows
 * are real. A fixture would answer the question by construction. When there is
 * no database at all it falls back to the empty fixture and the badge on its
 * face reads FIXTURE.
 *
 * NOT IN THE NAV. `src/components/app-shell/NavLinks.tsx` is owned by another
 * worker for the duration of this build and was not edited, so this screen is
 * reached by URL. That is a one-line change for whoever owns that file.
 */
export default async function EventsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params["state"];
  const state = typeof raw === "string" ? raw : "default";

  // ONE VALUE. Which source this screen reads through, and therefore every
  // badge and counter below, comes from this line.
  const { source, businesses } = await select(state, !hasDatabase());

  return (
    <Suspense key={state} fallback={<EventsSkeleton />}>
      <Body source={source} businesses={businesses} />
    </Suspense>
  );
}

async function Body({
  source,
  businesses,
}: {
  readonly source: EventsDataSource;
  readonly businesses: readonly BusinessOption[];
}) {
  const result = await source.load();
  if (!result.ok)
    return (
      <EventsError
        code={result.error.code}
        message={result.error.message}
        details={result.error.details}
      />
    );

  return (
    <EventsScreen view={result.value}>
      {businesses.length === 0 ? null : (
        <RegisterForm businesses={businesses} eventTypes={EVENT_TYPES} />
      )}
    </EventsScreen>
  );
}

const FIXTURE_STATES: readonly string[] = ["loading", "empty", "error", "edge"];

/**
 * Live for the default state, fixture for the four demo states — and a REFUSAL
 * for the default state when there is no database to read.
 *
 * The live module is imported DYNAMICALLY because importing it evaluates
 * `src/lib/env.ts`, which refuses to load without a database URL. That is the
 * right behaviour for the app and the wrong behaviour for a page that must be
 * able to render the words "no database configured" — so the import happens
 * only on the branch that has already established there is a database to read.
 *
 * WHAT THIS FUNCTION USED TO DO, AND WHY IT IS THE DEFECT THIS SCREEN CARRIED.
 * It asked `live.hasDatabase()` on the line AFTER
 * `const live = await import("./live-source")`, and that module's
 * `import { sql } from "@/lib/ledger/db"` throws `EnvironmentError` without
 * `APP_DATABASE_URL`. The guard was unreachable in the one case it was written
 * for: the import above it only succeeds when a database IS configured.
 * Measured with the variable deleted, the render threw at
 * `src/lib/ledger/db.ts:18` and the operator got the framework's error page.
 *
 * If it HAD run, it returned `createFixtureEventsSource("empty")`: the delivery
 * counters and the queue cursor, all reading nought. On a delivery log that is
 * not a blank screen, it is the answer to the only question this screen is
 * opened to settle — is anything stuck — given by a deployment that had opened
 * no connection. The customer whose webhooks are not arriving would have read
 * "0 pending, 0 dead" and gone back to their own logs.
 *
 * With no database the answer is now a REFUSAL, from
 * `@/components/events/unreadable`, which `EventsError` renders the same way it
 * renders a failed read: no counter, no endpoint, no register form. The form is
 * withheld for its own reason as well as the shared one — it writes, and it
 * cannot write to a book nothing can see.
 */
async function select(
  state: string,
  noDatabase: boolean,
): Promise<{ source: EventsDataSource; businesses: readonly BusinessOption[] }> {
  if (FIXTURE_STATES.includes(state)) {
    // A demo state stays a fixture whether or not a database is configured:
    // those four are drawn on purpose, and "no database" does not make a
    // drawing any more or less drawn.
    return { source: createFixtureEventsSource(state as FixtureState), businesses: [] };
  }

  if (noDatabase) return { source: createUnreadableEventsSource(), businesses: [] };

  const live = await import("./live-source");
  return { source: live.createLiveEventsSource(), businesses: await live.listBusinessOptions() };
}
