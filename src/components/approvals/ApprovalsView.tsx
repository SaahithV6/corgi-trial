import { ROLE_LABEL, readRole, type Role } from "@/components/app-shell/role";
import { Badge, MetaList, Note } from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";
import { isErr } from "@/lib/result";

import { ApprovalsSkeleton } from "./ApprovalsSkeleton";
import { ErrorPanel } from "./ErrorPanel";
import { PolicyPanel } from "./PolicyPanel";
import { QueueList } from "./QueueList";
import type { ActorSource, ActorView, ApprovalsDataSource } from "./data-contract";
import type { SourceClaim } from "./demo-state";

export { ApprovalsSkeleton };

/** The refusal wording, for the cause that is not a failed read. */
const NO_DATABASE_TITLE = "The approvals queue was not read";
const NO_DATABASE_DESCRIPTION =
  "No database is configured for this deployment, so nothing below was read: not the queue, not the policy table, not the actor this session would be acting as. Nothing was approved, rejected or released either — but that is true of every state of this screen, and it is not the reassurance here. The reassurance you are not getting is that anyone has looked at what is waiting.";

/**
 * The approvals screen.
 *
 * An async server component behind the page's Suspense boundary. It reads the
 * queue through `ApprovalsDataSource` and this session's identity through
 * `ActorSource`, and knows nothing about where either came from — which is the
 * point. Both seams are chosen in `page.tsx`, where the live implementations
 * are reached only through `await import(...)` on the branch that has
 * established there is a database to read.
 *
 * IT USED TO CHOOSE THEM ITSELF, and that is the defect this screen carried.
 * `createLiveApprovalsSource` and `currentActor` were static imports here, so
 * the page module reached `@/lib/ledger/db` -> `@/lib/env` before it reached
 * its own first line and threw without `APP_DATABASE_URL`. The four fixture
 * states went down with it, having asked for no database at all.
 *
 * IT TAKES NO `view`. Which demo state is showing is already folded into
 * `claim`, and a component that could read `view.state` could disagree with the
 * claim it was handed — which is the exact shape of the two-badge defect this
 * repair exists to close.
 *
 * ONE COMPONENT DRAWS BOTH OUTCOMES. The refusal is a failed `Result` from a
 * source, not a second rendering path, so there is no branch on which this
 * screen could be drawn from nothing.
 */
export async function ApprovalsView({
  claim,
  source,
  actorSource,
}: {
  readonly claim: SourceClaim;
  readonly source: ApprovalsDataSource;
  readonly actorSource: ActorSource;
}) {
  const role = await readRole();
  const live = claim === "LIVE";
  const refusing = claim === "NO DATABASE";

  // Identity is resolved even in fixture states: the edge state's row is
  // initiated by whoever is signed in, which is what makes it a true statement
  // about the person reading the screen rather than a picture of one.
  const actor: ActorView | null = await actorSource.current();

  const result = await source.getQueue(actor);

  if (isErr(result)) {
    return (
      <div className="space-y-6">
        <Header role={role} actor={actor} claim={claim} asOf={null} />
        {refusing ? (
          <ErrorPanel
            error={result.error}
            title={NO_DATABASE_TITLE}
            description={NO_DATABASE_DESCRIPTION}
            offerExit={false}
          />
        ) : (
          <ErrorPanel error={result.error} />
        )}
      </div>
    );
  }

  const snapshot = result.value;

  return (
    <div className="space-y-6">
      <Header role={role} actor={actor} claim={claim} asOf={snapshot.asOf} />

      <Note title="Maker-checker on money out, and where it is actually enforced">
        <p>
          The initiator of a payment can never approve it. That is not a rule this screen applies:
          it is a trigger on <code className="font-mono">payment_instruction_event</code> that
          raises SQLSTATE 42501 when an <code className="font-mono">approved</code> row&rsquo;s
          actor is the instruction&rsquo;s <code className="font-mono">requested_by</code>. An
          automated actor cannot approve either, and that one is stronger still — the{" "}
          <code className="font-mono">actor</code> table CHECKs{" "}
          <code className="font-mono">NOT (kind &lt;&gt; &lsquo;human&rsquo; AND can_approve)</code>
          , so an approving agent has no row shape at all.
        </p>
        <p className="mt-2">
          Where you see a disabled button below, the screen is telling you in advance what the
          database would do. It is not the check. Every decision is sent to Postgres and refused
          there.
        </p>
      </Note>

      <QueueList items={snapshot.queue} asOf={snapshot.asOf} live={live} />

      <PolicyPanel policies={snapshot.policies} />

      <p className="max-w-prose text-xs leading-relaxed text-muted">
        {role === "approver"
          ? "Acting as Approver: you may record decisions on payments other people raised, and on none that you raised yourself. Releasing posts to the journal with an idempotency key derived from the instruction id, so pressing it twice posts once."
          : "Acting as Staff: you can read the whole queue and prepare money movement, and you can approve nothing — can_approve is false on this actor, and the database refuses an approved event from it. Switch to Approver to work the queue."}
      </p>
    </div>
  );
}

/**
 * The board's heading.
 *
 * THE BADGE IS DROPPED WHEN THE CLAIM IS "NO DATABASE", and that is not
 * tidiness. One screen makes one claim about its data source. On a deployment
 * with nothing to read, the claim is carried by the demo-state bar above, whose
 * badge reads NO DATABASE; a second badge here would be the board saying
 * something about rows it does not have, and both are derived from the same
 * `sourceClaim()` call in `page.tsx` so they cannot drift apart.
 */
function Header({
  role,
  actor,
  claim,
  asOf,
}: {
  // `Role`, not the two operator roles spelled out. A customer never reaches
  // this screen — src/middleware.ts answers 403 OPERATOR_ONLY before it renders
  // — so narrowing here would be a second, weaker copy of that decision living
  // in a prop type, and the two would drift.
  readonly role: Role;
  readonly actor: ActorView | null;
  readonly claim: SourceClaim;
  readonly asOf: string | null;
}) {
  return (
    <header>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Approvals</h1>
        {claim === "NO DATABASE" ? null : (
          <Badge tone={claim === "LIVE" ? "positive" : "quiet"}>{claim}</Badge>
        )}
      </div>
      <p className="mt-0.5 text-sm text-muted">
        Money out, requested and checked by two different people. §16 of the ledger design.
      </p>
      <div className="mt-3">
        <MetaList
          items={[
            { label: "Acting as", value: ROLE_LABEL[role] },
            {
              label: "Actor",
              value:
                actor === null ? (
                  <span className="text-negative">unresolved</span>
                ) : (
                  <>
                    {actor.displayName}
                    <span className="ml-2 text-muted">
                      {actor.canApprove ? "can approve" : "cannot approve"}
                    </span>
                  </>
                ),
            },
            ...(asOf === null ? [] : [{ label: "As of", value: formatTimestamp(asOf) }]),
          ]}
        />
      </div>
    </header>
  );
}
