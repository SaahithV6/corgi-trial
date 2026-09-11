import Link from "next/link";

import { Money } from "@/components/ui/Money";
import { FOCUS_RING, MetaList, Note, Panel } from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";
import { ACTOR_KIND_DESCRIPTION, ACTOR_KIND_LABEL, type ActorAction } from "@/lib/audit/types";

/**
 * The drill-through: the underlying record, named.
 *
 * A timeline that cannot tell you where a line came from is a summary, and a
 * summary is not evidence. This panel prints the SOURCE TABLE and the PRIMARY
 * KEY of the row the line was projected from, so anyone with a psql prompt can
 * reproduce it — `SELECT * FROM <source> WHERE id = '<pk>'` — and the `detail`
 * object exactly as the projection built it.
 *
 * It links on to the screen that owns the subject where one exists. It does
 * NOT invent links: a subject with no screen prints its id and stops, because
 * a dead link in an audit trail is worse than no link.
 */
export function ActionDetailPanel({ action }: { readonly action: ActorAction }) {
  const [, pk = ""] = action.actionId.split(/:(.*)/s);

  return (
    <Panel
      title={action.summary}
      description={`Projected from one row of ${action.source}, which corgi_app holds no UPDATE or DELETE on.`}
      as="h3"
    >
      <div className="space-y-4 px-5 py-4">
        <MetaList
          items={[
            { label: "occurred", value: formatTimestamp(action.occurredAt) },
            { label: "recorded", value: formatTimestamp(action.recordedAt) },
            { label: "value date", value: action.valueDate ?? "—" },
            {
              label: "actor",
              value: `${ACTOR_KIND_LABEL[action.actorKind]} · ${action.actorLabel}`,
            },
            { label: "surface", value: action.surface },
            {
              label: "amount",
              value:
                action.amountCents === null ? "—" : <Money cents={action.amountCents} tone="neutral" />,
            },
          ]}
        />

        {action.timeAxesDiffer ? (
          <Note title="The two clocks disagree on this row">
            It happened at {formatTimestamp(action.occurredAt)} and this book learned at{" "}
            {formatTimestamp(action.recordedAt)}. Both are stored; neither is corrected into the
            other. That is the same bitemporal shape the ledger uses for a backdated correction —
            value date and booking time are different columns, here as there.
          </Note>
        ) : null}

        {action.actorKind !== "human" ? (
          <Note emphasis={action.actorKind === "agent" || action.actorKind === "unattributed"}
                title={`Not a person: ${ACTOR_KIND_LABEL[action.actorKind].toLowerCase()}`}>
            {ACTOR_KIND_DESCRIPTION[action.actorKind]}
          </Note>
        ) : null}

        <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-[10rem_1fr]">
          <dt className="text-muted">source table</dt>
          <dd className="font-mono text-[11px]">{action.source}</dd>
          <dt className="text-muted">primary key</dt>
          <dd className="font-mono text-[11px] break-all">{pk}</dd>
          <dt className="text-muted">subject</dt>
          <dd className="font-mono text-[11px] break-all">
            {action.subjectKind ?? "—"}
            {action.subjectId ? ` · ${action.subjectId}` : ""}
          </dd>
          <dt className="text-muted">journal entry</dt>
          <dd className="font-mono text-[11px] break-all">{action.entryId ?? "—"}</dd>
        </dl>

        {subjectHref(action) ? (
          <p className="text-xs">
            <Link href={subjectHref(action) as string} className={`underline ${FOCUS_RING} rounded`}>
              Open the screen that owns this record
            </Link>
          </p>
        ) : null}

        {action.detail ? (
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              detail, as projected
            </p>
            <pre className="max-h-72 overflow-auto rounded border border-border bg-surface-raised p-3 font-mono text-[11px] leading-relaxed">
              {JSON.stringify(action.detail, null, 2)}
            </pre>
            <p className="mt-1 max-w-prose text-[11px] text-muted">
              No card number, no full account number, no raw webhook body and no token appears
              here: the projection never selects those columns, so any reader of{" "}
              <code>v_actor_action</code> inherits the rule rather than re-implementing it.
            </p>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

/** Only for subjects that genuinely have a screen. Nothing is guessed. */
function subjectHref(action: ActorAction): string | null {
  if (action.subjectKind === "hold" && action.subjectId) {
    return `/accounts/holds/${action.subjectId}`;
  }
  if (action.subjectKind === "payment_instruction") return "/approvals";
  if (action.subjectKind === "dispute") return "/disputes";
  if (action.subjectKind === "recon_break") return "/breaks";
  if (action.subjectKind === "statement") return "/statements";
  return null;
}
