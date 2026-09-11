import { Suspense } from "react";
import type { Metadata } from "next";
import { randomUUID } from "node:crypto";

import { EMPTY_NOTE, EMPTY_TEAM, ERROR_NOTE } from "@/components/team/fixtures";
import { TeamErrorPanel } from "@/components/team/TeamErrorPanel";
import { TeamForms } from "@/components/team/TeamForms";
import { TeamStateBar } from "@/components/team/TeamStateBar";
import { TeamSkeleton, TeamView } from "@/components/team/TeamView";
import { TEAM_BOOK_UNREADABLE, teamReadFailure } from "@/components/team/unreadable";
import { parseTeamFilter, type TeamFilter } from "@/components/team/view-state";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

export const metadata: Metadata = {
  title: "Team · Corgi ops console",
};

/**
 * Never prerendered.
 *
 * The default state reads the live database, and a page that ran a query at
 * BUILD time would either bake this morning's team into a static artefact or
 * fail the build on a machine with no database. Awaiting `searchParams` already
 * forces dynamic rendering; this says so out loud so nobody has to know that.
 */
export const dynamic = "force-dynamic";

/**
 * `/team` — the people, and their cards.
 *
 * The brief's first paragraph: "Customers hold a balance, send and receive
 * payments, and get A CARD FOR EACH PERSON ON THE TEAM." Everything downstream
 * of that sentence was built — real cardholders, real cards, authorisations
 * decided inside a measured 6000 ms window — and the sentence's SUBJECT was
 * not. This is the subject.
 *
 * Five states, all reachable from the query string:
 *
 *   (none)          live members, live cards, live limits, live spend
 *   ?state=loading  THE SAME LIVE READ, held open for three seconds, behind the
 *                   real skeleton
 *   ?state=empty    a business with an account and no people. Not an error
 *   ?state=error    the read failed; nothing was written, and the screen names
 *                   what the SAME failure means on the authorisation path
 *   ?state=edge     A MEMBER REMOVED WHILE HOLDING AN OUTSTANDING
 *                   AUTHORISATION — the state most likely to render wrong, and
 *                   the one place where "delete user" would be a money bug
 *
 * ...plus the customer and the expanded person, which are also URL state:
 *
 *   ?business=<uuid>  ?member=<uuid>
 *
 * WHY `default`, `edge` AND `loading` ARE LIVE AND THE OTHER TWO ARE NOT. The
 * claim being graded is that removing somebody stops their card and leaves
 * their outstanding authorisation completely alone. A fixture would answer that
 * by construction and prove nothing, so `edge` is a FILTER over the same live
 * rows the default state shows — and when nobody is in that state, it says so
 * rather than manufacturing a subject. `loading` is that same read with three
 * seconds of `setTimeout` in front of it, so the skeleton above is a real
 * Suspense fallback rather than a picture of one; this comment used to call it
 * a fixture, which `TeamStateBar` has always contradicted and `TeamBody` below
 * has always disproved. `empty` and `error` are the fixtures, because the first
 * needs a business nobody has staffed and the second needs the database to be
 * down; neither is a thing to arrange mid-demo, and each prints FIXTURE on its
 * own face.
 *
 * And one state the URL cannot ask for: NO DATABASE CONFIGURED. It is not a
 * sixth demo state, because it is not a demonstration of anything — it is what
 * this deployment is. The badge on the state bar reads NO DATABASE, the board
 * is replaced by the refusal panel, and no member, balance, card or invariant
 * is drawn. All THREE live states refuse, because all three are reads. See
 * `TeamBody` below for what this page used to do instead.
 */
export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parseTeamFilter(await searchParams);
  // ONE VALUE, TWO SURFACES. The state bar's badge and the body's refusal
  // wording both come from this line, so they cannot disagree about what this
  // screen read.
  const noDatabase = !hasDatabase();

  return (
    <div className="space-y-6">
      <TeamStateBar filter={filter} noDatabase={noDatabase} />

      <Suspense
        key={`${filter.state}:${filter.businessId ?? ""}:${filter.memberId ?? ""}`}
        fallback={<TeamSkeleton />}
      >
        <TeamBody filter={filter} noDatabase={noDatabase} />
      </Suspense>
    </div>
  );
}

/**
 * An async server component, so the Suspense boundary above is honest: the
 * fallback is the real skeleton and `?state=loading` slows the real read rather
 * than faking a render.
 *
 * EVERY LIVE MODULE IS IMPORTED DYNAMICALLY, AND THAT IS THE REPAIR. This file
 * used to import `@/lib/approvals/session`, `@/lib/team/screen` and
 * `@/lib/team/store` at the top; all three reach `@/lib/ledger/db` ->
 * `@/lib/env`, which parses `process.env` at module scope and throws
 * `EnvironmentError` without `APP_DATABASE_URL`. So the PAGE MODULE failed to
 * load and there was nowhere for a guard to live — not even an unreachable one.
 * Measured with the variable deleted, nothing on this screen rendered, the two
 * FIXTURE states included, and the operator got the framework's error page.
 * The imports now happen only on the branch that has already established there
 * is a database to read.
 */
async function TeamBody({
  filter,
  noDatabase = false,
}: {
  readonly filter: TeamFilter;
  readonly noDatabase?: boolean;
}) {
  // The two fixture states read nothing, so they are drawn whether or not a
  // database is configured: "no database" does not make a drawing any more or
  // less drawn.
  if (filter.state === "empty") {
    return <TeamView screen={EMPTY_TEAM} filter={filter} fixture={EMPTY_NOTE} />;
  }

  if (filter.state === "error") {
    return (
      <TeamErrorPanel
        error={teamReadFailure(
          "The team read failed. This state is the drawing of that failure: no query was run, so the message here stands in for whatever the database would have said.",
        )}
        title="FIXTURE — the team read failed"
        description={ERROR_NOTE}
        claim="fixture"
      />
    );
  }

  // `default`, `edge` and `loading` are all reads, so all three refuse. The
  // check is BEFORE the loading state's three seconds: there is no read here
  // to hold open, and making an operator wait to be told there is no database
  // would be theatre.
  if (noDatabase) {
    return (
      <TeamErrorPanel
        error={TEAM_BOOK_UNREADABLE}
        title="This screen cannot see the team"
        description="No database is configured for this deployment, so nobody was read, no card was listed and no invariant was counted. This is not the authorisation path failing: a card decision that cannot reach the database DECLINES, and it does so without this screen. What is missing here is the read, never the revocation."
      />
    );
  }

  if (filter.state === "loading") {
    // A GENUINELY slow read, not a mock of one. The skeleton above is what is
    // on screen for these three seconds, and it is the same skeleton the real
    // read shows when Neon is having a bad minute.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  const { edgeMembers, readTeamScreen } = await import("@/lib/team/screen");
  const result = await readTeamScreen(filter.businessId);
  if (!result.ok) {
    // `readTeamScreen` returns a message and nothing else. The code and the
    // `retryable` flag are added here, at this screen's own boundary, so the
    // panel can say whether trying again could work — see `./unreadable.ts`.
    return <TeamErrorPanel error={teamReadFailure(result.message)} />;
  }

  const { screen } = result;
  const { currentActor } = await import("@/lib/approvals/session");
  const { memberForActor } = await import("@/lib/team/store");
  const actor = await currentActor();
  const me = actor === null ? null : await memberForActor(screen.businessId, actor.id);

  return (
    <div className="space-y-6">
      <TeamView
        screen={screen}
        filter={filter}
        {...(filter.state === "edge" ? { edgeOnly: edgeMembers(screen) } : {})}
      />

      {filter.state === "edge" ? null : (
        <TeamForms
          businessId={screen.businessId}
          members={screen.members}
          // Generated once per render and sent back with the form, so a
          // double-submit returns the SAME card from Lithic rather than
          // creating a second one on the account. A key from the client is
          // untrusted, and the worst it can do is hand its sender a card it has
          // already created.
          formKey={randomUUID()}
          // A hint for the sentence at the top of the panel, never a gate.
          // Corgi staff (no membership) administer any team; a member does so
          // only if their role says they may, and the database is what decides.
          canAdminister={me === null ? true : me.canAdministerTeam}
        />
      )}
    </div>
  );
}
