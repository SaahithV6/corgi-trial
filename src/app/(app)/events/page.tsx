import { Suspense } from "react";
import type { Metadata } from "next";

import { EventsError, EventsScreen, EventsSkeleton } from "@/components/events/EventsView";
import { RegisterForm, type BusinessOption } from "@/components/events/RegisterForm";
import { createFixtureEventsSource, type FixtureState } from "@/components/events/fixtures";
import type { EventsDataSource } from "@/components/events/data-contract";
import { EVENT_TYPES } from "@/lib/events/envelope";

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

  const { source, businesses } = await select(state);

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
  if (!result.ok) return <EventsError code={result.error.code} message={result.error.message} />;

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
 * The live module is imported DYNAMICALLY because importing it evaluates
 * `src/lib/env.ts`, which refuses to load without a database URL. That is the
 * right behaviour for the app and the wrong behaviour for a page that must be
 * able to render the words "no database configured".
 */
async function select(
  state: string,
): Promise<{ source: EventsDataSource; businesses: readonly BusinessOption[] }> {
  if (FIXTURE_STATES.includes(state)) {
    return { source: createFixtureEventsSource(state as FixtureState), businesses: [] };
  }

  const live = await import("./live-source");
  if (!live.hasDatabase()) {
    return { source: createFixtureEventsSource("empty"), businesses: [] };
  }

  return { source: live.createLiveEventsSource(), businesses: await live.listBusinessOptions() };
}
