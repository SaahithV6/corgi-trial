import { ROLE_LABEL, readRole } from "@/components/app-shell/role";
import { Badge, MetaList, Note } from "@/components/ui/primitives";
import { currentActor } from "@/lib/approvals/session";
import { createLiveApprovalsSource } from "@/lib/approvals/screen";
import { formatTimestamp } from "@/lib/format/datetime";
import { isErr } from "@/lib/result";

import { ApprovalsSkeleton } from "./ApprovalsSkeleton";
import { ErrorPanel } from "./ErrorPanel";
import { PolicyPanel } from "./PolicyPanel";
import { QueueList } from "./QueueList";
import type { ActorView, ApprovalsDataSource } from "./data-contract";
import { createFixtureSource } from "./fixtures";
import type { ApprovalsView as View } from "./demo-state";

export { ApprovalsSkeleton };

/**
 * The approvals screen.
 *
 * An async server component behind the page's Suspense boundary. It resolves
 * WHO THIS SESSION IS on the server — never from anything the browser sent
 * beyond the role cookie, and even that is resolved by predicate against the
 * actor table — then reads the queue through `ApprovalsDataSource` and knows
 * nothing about where the rows came from.
 *
 * `default` is the live database. The other four states are fixtures, so the
 * error and edge cases can be shown on demand without breaking anything.
 */
export async function ApprovalsView({ view }: { readonly view: View }) {
  const role = await readRole();
  const live = view.state === "default";

  // Identity is resolved even in fixture states: the edge state's row is
  // initiated by whoever is signed in, which is what makes it a true statement
  // about the person reading the screen rather than a picture of one.
  const session = await currentActor();
  const actor: ActorView | null =
    session === null
      ? null
      : {
          id: session.id,
          displayName: session.displayName,
          kind: session.kind,
          canApprove: session.canApprove,
        };

  const source: ApprovalsDataSource = live
    ? createLiveApprovalsSource()
    : createFixtureSource(view.state);

  const result = await source.getQueue(actor);

  if (isErr(result)) {
    return (
      <div className="space-y-6">
        <Header role={role} actor={actor} live={live} asOf={null} />
        <ErrorPanel error={result.error} />
      </div>
    );
  }

  const snapshot = result.value;

  return (
    <div className="space-y-6">
      <Header role={role} actor={actor} live={live} asOf={snapshot.asOf} />

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

function Header({
  role,
  actor,
  live,
  asOf,
}: {
  readonly role: "staff" | "approver";
  readonly actor: ActorView | null;
  readonly live: boolean;
  readonly asOf: string | null;
}) {
  return (
    <header>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Approvals</h1>
        <Badge tone={live ? "positive" : "quiet"}>{live ? "LIVE" : "FIXTURE"}</Badge>
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
