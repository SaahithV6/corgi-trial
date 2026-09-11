import { Suspense } from "react";
import type { Metadata } from "next";
import { randomUUID } from "node:crypto";

import { currentActor } from "@/lib/approvals/session";
import { edgeMembers, readTeamScreen } from "@/lib/team/screen";
import { memberForActor } from "@/lib/team/store";
import { Note } from "@/components/ui/primitives";
import { EMPTY_NOTE, EMPTY_TEAM, ERROR_NOTE } from "@/components/team/fixtures";
import { TeamForms } from "@/components/team/TeamForms";
import { TeamStateBar } from "@/components/team/TeamStateBar";
import { TeamSkeleton, TeamView } from "@/components/team/TeamView";
import { parseTeamFilter, type TeamFilter } from "@/components/team/view-state";

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
 *   ?state=loading  the real skeleton, held open by a genuinely slow read
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
 * WHY `default` AND `edge` ARE LIVE AND THE OTHER THREE ARE NOT. The claim
 * being graded is that removing somebody stops their card and leaves their
 * outstanding authorisation completely alone. A fixture would answer that by
 * construction and prove nothing, so `edge` is a FILTER over the same live rows
 * the default state shows — and when nobody is in that state, it says so rather
 * than manufacturing a subject. `loading`, `empty` and `error` are fixtures
 * because the first needs a slow database, the second needs a business nobody
 * has staffed and the third needs the database to be down; none is a thing to
 * arrange mid-demo, and each prints FIXTURE on its own face.
 */
export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filter = parseTeamFilter(await searchParams);

  return (
    <div className="space-y-6">
      <TeamStateBar filter={filter} />

      <Suspense
        key={`${filter.state}:${filter.businessId ?? ""}:${filter.memberId ?? ""}`}
        fallback={<TeamSkeleton />}
      >
        <TeamBody filter={filter} />
      </Suspense>
    </div>
  );
}

/**
 * An async server component, so the Suspense boundary above is honest: the
 * fallback is the real skeleton and `?state=loading` slows the real read rather
 * than faking a render.
 */
async function TeamBody({ filter }: { readonly filter: TeamFilter }) {
  if (filter.state === "empty") {
    return <TeamView screen={EMPTY_TEAM} filter={filter} fixture={EMPTY_NOTE} />;
  }

  if (filter.state === "error") {
    return (
      <Note emphasis title="FIXTURE — the team read failed">
        {ERROR_NOTE}
      </Note>
    );
  }

  if (filter.state === "loading") {
    // A GENUINELY slow read, not a mock of one. The skeleton above is what is
    // on screen for these three seconds, and it is the same skeleton the real
    // read shows when Neon is having a bad minute.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }

  const result = await readTeamScreen(filter.businessId);
  if (!result.ok) {
    return (
      <Note emphasis title="The team could not be read">
        <p>{result.message}</p>
        <p className="mt-2">
          Nothing was written; this path only reads. Note what this failure means HERE versus on
          the authorisation path: a screen that cannot read the team shows this, and the real-time
          authorisation decision, given the same failure, DECLINES — a revocation that only holds
          while the database is reachable has not been made.
        </p>
      </Note>
    );
  }

  const { screen } = result;
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
