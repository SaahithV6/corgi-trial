import { Money } from "@/components/ui/Money";
import { Badge, FieldLabel, Panel, type BadgeTone } from "@/components/ui/primitives";
import { STATE_DESCRIPTION, STATE_LABEL } from "@/lib/approvals/state";
import type { PaymentState } from "@/lib/approvals/types";
import { formatAge, formatDate, formatTimestamp } from "@/lib/format/datetime";

import { DecisionForm } from "./DecisionForm";
import type { EventView, QueueItem } from "./data-contract";

/**
 * The pending queue.
 *
 * Every row answers, in this order, the five questions an approver actually
 * asks: how much, to whom, who asked, under which rule, and what has already
 * been decided. Nothing is behind a click except the event stream, and the
 * event stream is one `<details>` rather than a modal because an audit trail
 * that requires a round trip does not get read.
 */

/**
 * How many pending instructions the live read asks for.
 *
 * It is `limit: 50` in `createLiveApprovalsSource` (src/lib/approvals/screen.ts),
 * which is not this screen's module to change. It is repeated here so the panel
 * can say out loud that the count above the rows is a PAGE SIZE and not a total
 * — the header used to read "50 awaiting decisions" while 573 payments were
 * pending, which is the same sentence with the wrong noun.
 */
const QUEUE_PAGE_SIZE = 50;

const STATE_TONE: Record<PaymentState, BadgeTone> = {
  requested: "neutral",
  approved: "positive",
  released: "positive",
  settled: "positive",
  rejected: "negative",
  cancelled: "quiet",
  returned: "negative",
  failed: "negative",
};

const EVENT_TONE: Record<string, BadgeTone> = {
  requested: "quiet",
  approved: "positive",
  rejected: "negative",
  released: "neutral",
  settled: "positive",
  returned: "negative",
  failed: "negative",
  cancelled: "quiet",
};

function ApprovalCounter({ item }: { readonly item: QueueItem }) {
  if (!item.aboveThreshold) {
    return (
      <span className="text-xs text-muted">
        Below the {item.policy.version} threshold (
        <Money cents={item.policy.thresholdCents} tone="neutral" />) — no approval required.
        The same release path runs, with a required count of zero.
      </span>
    );
  }
  const satisfied = item.approvalsHeld >= item.approvalsRequired;
  return (
    <span className={`text-xs ${satisfied ? "text-text" : "text-muted"}`}>
      <span className="money font-medium">
        {item.approvalsHeld} of {item.approvalsRequired}
      </span>{" "}
      approval{item.approvalsRequired === 1 ? "" : "s"} held — distinct humans, none of them{" "}
      {item.initiatorName}.
    </span>
  );
}

function EventRow({ event, asOf }: { readonly event: EventView; readonly asOf: string }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-border px-4 py-2.5 text-xs">
      <Badge tone={EVENT_TONE[event.kind] ?? "quiet"}>{event.kind}</Badge>
      <span className="text-text">{event.actorName}</span>
      {event.actorKind === "human" ? null : (
        <Badge tone="quiet" title="Not a human actor. It can never hold approval rights.">
          {event.actorKind}
        </Badge>
      )}
      <span className="text-muted">{formatTimestamp(event.occurredAt)}</span>
      <span className="text-muted">· {formatAge(event.occurredAt, asOf)}</span>
      {event.citedHash === null ? null : (
        <span
          className={`font-mono text-[11px] ${event.citesCurrentHash ? "text-muted" : "text-negative"}`}
          title={
            event.citesCurrentHash
              ? "This approval cites the payment's current content hash, so it applies."
              : "This approval cites a DIFFERENT payment's hash. It does not apply to this one and cannot release it."
          }
        >
          cites {event.citedHash.slice(0, 12)}…{event.citesCurrentHash ? "" : " ✗ stale"}
        </span>
      )}
      {event.entryId === null ? null : (
        <span
          className="font-mono text-[11px] break-all text-muted"
          title="The journal entry this event posted. It is on the paying account's Activity table under this timestamp."
        >
          entry {event.entryId}
        </span>
      )}
      {event.reason === null ? null : (
        <span className="w-full max-w-prose text-muted">“{event.reason}”</span>
      )}
    </li>
  );
}

function QueueCard({
  item,
  asOf,
  live,
}: {
  readonly item: QueueItem;
  readonly asOf: string;
  readonly live: boolean;
}) {
  const selfInitiated = item.gate.code === "self_initiated";

  return (
    <li
      className={`rounded-lg border bg-surface ${
        selfInitiated ? "border-negative/40" : "border-border"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3 px-5 py-4">
        <div>
          <div className="flex flex-wrap items-baseline gap-3">
            <Money cents={item.amountCents} tone="neutral" className="text-2xl font-semibold" />
            <Badge tone="quiet">{item.currency}</Badge>
            <Badge tone="neutral">{item.rail}</Badge>
            <Badge tone={STATE_TONE[item.state]} title={STATE_DESCRIPTION[item.state]}>
              {STATE_LABEL[item.state]}
            </Badge>
          </div>
          <p className="mt-1.5 text-sm">{item.destination}</p>
          <p className="mt-0.5 text-xs text-muted">
            from {item.accountName}
            {item.businessName === null ? null : ` · ${item.businessName}`} · value date{" "}
            {formatDate(item.valueDate)}
          </p>
          {/* The id an operator has to quote to ask anybody anything about this
              payment: it is the instruction's primary key, it is what the
              release entry's idempotency key is built from
              (`payment:release:<id>`), and until it is printed the only way to
              name this row is to describe it. */}
          <p className="mt-0.5 font-mono text-[11px] break-all text-muted">
            payment {item.id}
          </p>
        </div>

        <dl className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-[auto_auto]">
          <dt>
            <FieldLabel>Initiator</FieldLabel>
          </dt>
          <dd className="flex items-center gap-2">
            {item.initiatorName}
            {item.initiatorKind === "human" ? null : (
              <Badge
                tone="quiet"
                title="Raised by an automated actor. It lands in this queue like anyone else's and can never approve itself — actor_only_humans_approve makes that unrepresentable."
              >
                {item.initiatorKind}
              </Badge>
            )}
            {selfInitiated ? <Badge tone="negative">that is you</Badge> : null}
          </dd>

          <dt>
            <FieldLabel>Raised</FieldLabel>
          </dt>
          <dd className="text-muted">
            {formatTimestamp(item.requestedAt)} · {formatAge(item.requestedAt, asOf)}
          </dd>

          <dt>
            <FieldLabel>Policy version</FieldLabel>
          </dt>
          <dd>
            <span className="font-mono">{item.policy.version}</span>
            <span className="ml-2 text-muted">
              threshold <Money cents={item.policy.thresholdCents} tone="neutral" />,{" "}
              {item.policy.requiredApprovals} approval
              {item.policy.requiredApprovals === 1 ? "" : "s"}
            </span>
          </dd>
        </dl>
      </div>

      <div className="border-t border-border px-5 py-3">
        <ApprovalCounter item={item} />
        <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">
          {item.policy.note}
        </p>
      </div>

      <div className="border-t border-border px-5 py-4">
        <DecisionForm
          instructionId={item.id}
          contentHash={item.contentHash}
          gate={item.gate}
          releaseGate={item.releaseGate}
          amountCents={item.amountCents}
          destination={item.destination}
          live={live}
        />
      </div>

      <details className="border-t border-border">
        <summary className="cursor-pointer px-5 py-2.5 text-xs text-muted hover:text-text">
          Lifecycle — {item.events.length} event{item.events.length === 1 ? "" : "s"}, append-only
        </summary>
        <ul className="mb-2">
          {item.events.map((event) => (
            <EventRow key={event.id} event={event} asOf={asOf} />
          ))}
        </ul>
        <p className="border-t border-border px-5 py-2.5 font-mono text-[11px] break-all text-muted">
          content hash {item.contentHash}
        </p>
        <p className="max-w-prose px-5 pb-3 text-[11px] leading-relaxed text-muted">
          An approval must cite that hash. It is sha256 over this payment&rsquo;s account, rail,
          amount, destination and value date — so if any of them were different, this would be a
          different instruction with a different hash, and an approval given for the old one would
          not apply.
        </p>
      </details>
    </li>
  );
}

/** The empty state: not an error, and it says so. */
function EmptyQueue() {
  return (
    <div className="px-5 py-10 text-center">
      <p className="text-sm font-medium">Nothing is awaiting a decision.</p>
      <p className="mx-auto mt-1.5 max-w-prose text-xs leading-relaxed text-muted">
        An empty queue is the normal state of a payments desk, not a failure. Instructions arrive
        here from the console and from the MCP write tool; both land in this one queue, under the
        same policy version, and neither can approve its own.
      </p>
    </div>
  );
}

export function QueueList({
  items,
  asOf,
  live,
}: {
  readonly items: readonly QueueItem[];
  readonly asOf: string;
  readonly live: boolean;
}) {
  return (
    <Panel
      id="queue"
      title="Pending queue"
      description="Payments raised and not yet released. Ordered newest first; state is folded from the event stream, never read from a status column."
      actions={
        <span className="text-xs text-muted">
          {items.length} shown
        </span>
      }
    >
      {items.length === 0 ? (
        <EmptyQueue />
      ) : (
        <>
          <p className="max-w-prose border-b border-border px-5 py-2.5 text-[11px] leading-relaxed text-muted">
            {items.length} row{items.length === 1 ? "" : "s"} shown, not{" "}
            {items.length === 1 ? "one payment" : `${items.length} payments`} awaiting a decision.
            The read takes the newest {QUEUE_PAGE_SIZE} pending instructions on the whole book and
            stops, so where this count is exactly {QUEUE_PAGE_SIZE} there are older pending
            payments below the cut and this screen does not say how many. A payment also LEAVES
            this queue the moment it is released or rejected: after that its lifecycle is on the
            paying account&rsquo;s Activity table, under the journal entry the release event names.
          </p>
          <ul className="space-y-4 px-5 py-5">
            {items.map((item) => (
              <QueueCard key={item.id} item={item} asOf={asOf} live={live} />
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
