/**
 * `/events` — the delivery log a customer can read.
 *
 * Modelled on the operator-facing delivery surfaces this console already has
 * (`v_webhook_dead_letter`, the chaos screen's invariant table), with one
 * difference that changes almost every design decision: THE AUDIENCE HERE IS
 * THE PERSON WHOSE SERVER IS BROKEN. An operator reading an inbound dead
 * letter wants to know what we must fix. A customer reading an outbound one
 * wants to know what THEY must fix, and every column exists to answer that
 * without a support conversation:
 *
 *   what we sent      event type, the ledger sequence, the byte count, and
 *                     the `webhook-id` we signed under — so they can grep
 *                     their own logs for the exact delivery.
 *   what came back    the HTTP status, the duration, and the first line of
 *                     their own response body. That excerpt is usually the
 *                     only thing that explains a 500 to the person who wrote
 *                     the server that emitted it.
 *   what is pending   attempts so far and the next attempt time, so "is it
 *                     coming back?" is a fact on the screen rather than a
 *                     question in an email.
 *   what dead-lettered  with the reason NAMING THE MISSING THING.
 *
 * And one column no other webhook dashboard prints: THE ADDRESS WE ACTUALLY
 * CONNECTED TO. It is here because the hardest outbound-webhook support
 * conversation is the one where the customer's endpoint is up, reachable from
 * their laptop, and refused by us — which happens when a DNS record starts
 * answering with an internal address. Printing the resolved IP turns that
 * from an argument into a fact, and it is also the audit trail that proves
 * this service has never connected to anything internal.
 */

import type { DeliveryState, DeliveryView, EndpointView, EventsView } from "./data-contract";
import {
  Badge,
  FieldLabel,
  MetaList,
  Note,
  Panel,
  TableScroll,
  TD_CLASS,
  TH_CLASS,
  type BadgeTone,
} from "@/components/ui/primitives";

/* -------------------------------------------------------------------------- */
/* Small pieces                                                               */
/* -------------------------------------------------------------------------- */

const STATE_TONE: Record<DeliveryState, BadgeTone> = {
  delivered: "positive",
  pending: "neutral",
  dead: "negative",
};

const STATE_TITLE: Record<DeliveryState, string> = {
  delivered: "The endpoint answered 2xx. At-least-once: it may have been delivered more than once.",
  pending: "Queued or waiting for its next attempt. A lease is a timeout, not a state.",
  dead: "The retry budget is spent. Nothing further is sent until a human requeues it.",
};

function when(value: string | null): string {
  if (value === null) return "—";
  // ISO, trimmed to the second. A financial console shows an instant, not
  // "3 minutes ago" — relative time is unreadable in a support thread.
  return value.replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function StatusCell({ row }: { readonly row: DeliveryView }) {
  if (row.lastStatus === null && row.lastError === null) {
    return <span className="text-muted">not attempted yet</span>;
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        {row.lastStatus === null ? (
          <Badge tone="negative" title="No HTTP response: refused by policy, DNS, TLS, or a timeout.">
            no response
          </Badge>
        ) : (
          <Badge tone={row.lastStatus >= 200 && row.lastStatus < 300 ? "positive" : "negative"}>
            HTTP {row.lastStatus}
          </Badge>
        )}
        {row.lastDurationMs === null ? null : (
          <span className="text-[11px] text-muted">{row.lastDurationMs} ms</span>
        )}
      </div>
      {row.lastResponseExcerpt === null ? null : (
        <p className="max-w-md truncate font-mono text-[11px] text-muted" title={row.lastResponseExcerpt}>
          {row.lastResponseExcerpt}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                  */
/* -------------------------------------------------------------------------- */

function EndpointsPanel({ endpoints }: { readonly endpoints: readonly EndpointView[] }) {
  return (
    <Panel
      id="endpoints"
      title="Endpoints"
      description="Destinations a business has registered. Each has its own signing secret, shown once at creation and never again."
    >
      {endpoints.length === 0 ? (
        <div className="px-5 py-8 text-sm text-muted">
          <p>No endpoints registered.</p>
          <p className="mt-2 max-w-prose text-xs">
            Register one below. The URL must be <code>https</code> on port 443 and must resolve to a public
            address — loopback, private ranges and link-local are refused, with the reason printed rather than
            a generic failure.
          </p>
        </div>
      ) : (
        <TableScroll>
          <table className="w-full border-collapse">
            <thead className="border-b border-border">
              <tr>
                <th className={TH_CLASS}>Endpoint</th>
                <th className={TH_CLASS}>Business</th>
                <th className={TH_CLASS}>Subscribed to</th>
                <th className={TH_CLASS}>Secret</th>
                <th className={TH_CLASS}>Deliveries</th>
              </tr>
            </thead>
            <tbody>
              {endpoints.map((ep) => (
                <tr key={ep.id} className="border-b border-border last:border-0">
                  <td className={TD_CLASS}>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs break-all">{ep.url}</span>
                      {ep.status === "disabled" ? <Badge tone="quiet">disabled</Badge> : null}
                    </div>
                    <p className="mt-0.5 text-xs text-muted">{ep.description}</p>
                  </td>
                  <td className={TD_CLASS}>
                    <span className="text-xs">{ep.businessName}</span>
                  </td>
                  <td className={TD_CLASS}>
                    {ep.eventTypes.length === 0 ? (
                      <span className="text-xs text-muted">every event type</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {ep.eventTypes.map((t) => (
                          <Badge key={t}>{t}</Badge>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className={TD_CLASS}>
                    {/* Versions only. There is no field on this screen's data
                        contract that could hold key material. */}
                    <span className="text-xs text-muted">
                      {ep.secretVersions.length === 0
                        ? "none live"
                        : `v${ep.secretVersions.join(", v")} live`}
                    </span>
                  </td>
                  <td className={TD_CLASS}>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      <Badge tone="positive">{ep.delivered} delivered</Badge>
                      {ep.pending > 0 ? <Badge tone="neutral">{ep.pending} pending</Badge> : null}
                      {ep.dead > 0 ? <Badge tone="negative">{ep.dead} dead</Badge> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* The delivery log                                                           */
/* -------------------------------------------------------------------------- */

function DeliveryLogPanel({ deliveries }: { readonly deliveries: readonly DeliveryView[] }) {
  return (
    <Panel
      id="log"
      title="Delivery log"
      description="Every delivery: what we sent, what came back, what is waiting, and what gave up. Newest first."
    >
      {deliveries.length === 0 ? (
        <div className="px-5 py-8 text-sm text-muted">
          <p>Nothing has been queued yet.</p>
          <p className="mt-2 max-w-prose text-xs">
            Events are generated from the ledger by a cursor over <code>journal_entry.booking_seq</code>, after
            the money has been posted. Nothing on the posting path waits for this queue.
          </p>
        </div>
      ) : (
        <TableScroll>
          <table className="w-full border-collapse">
            <thead className="border-b border-border">
              <tr>
                <th className={TH_CLASS}>State</th>
                <th className={TH_CLASS}>Event</th>
                <th className={TH_CLASS}>Seq</th>
                <th className={TH_CLASS}>Destination</th>
                <th className={TH_CLASS}>Response</th>
                <th className={TH_CLASS}>Connected to</th>
                <th className={TH_CLASS}>Attempts</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((row) => (
                <tr key={row.deliveryId} className="border-b border-border last:border-0 align-top">
                  <td className={TD_CLASS}>
                    <Badge tone={STATE_TONE[row.state]} title={STATE_TITLE[row.state]}>
                      {row.state}
                    </Badge>
                  </td>
                  <td className={TD_CLASS}>
                    <div className="font-medium text-xs">{row.eventType}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-muted" title="webhook-id — the customer's deduplication key">
                      {row.eventId}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted">
                      value date {row.valueDate} · learned {when(row.occurredAt)} · {row.bodyBytes} bytes
                    </div>
                  </td>
                  <td className={TD_CLASS}>
                    <span className="money text-xs" title="journal_entry.booking_seq — the ledger's total order">
                      {row.sequence}
                    </span>
                  </td>
                  <td className={TD_CLASS}>
                    <span className="font-mono text-[11px] break-all">{row.url}</span>
                  </td>
                  <td className={TD_CLASS}>
                    <StatusCell row={row} />
                    {row.deadReason === null ? null : (
                      <p className="mt-1 max-w-md text-[11px] text-negative">{row.deadReason}</p>
                    )}
                  </td>
                  <td className={TD_CLASS}>
                    {row.lastResolvedIp === null ? (
                      <span
                        className="text-[11px] text-muted"
                        title="No connection was made. Either it was refused before a packet was sent, or the name would not resolve."
                      >
                        never connected
                      </span>
                    ) : (
                      <span className="font-mono text-[11px]">{row.lastResolvedIp}</span>
                    )}
                  </td>
                  <td className={TD_CLASS}>
                    <div className="text-xs">{row.attempts}</div>
                    {row.state === "pending" ? (
                      <div className="mt-0.5 text-[11px] text-muted">next {when(row.nextAttemptAt)}</div>
                    ) : null}
                    {row.state === "delivered" ? (
                      <div className="mt-0.5 text-[11px] text-muted">at {when(row.deliveredAt)}</div>
                    ) : null}
                    {row.state === "dead" ? (
                      <div className="mt-0.5 text-[11px] text-muted">gave up {when(row.deadAt)}</div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* The screen                                                                 */
/* -------------------------------------------------------------------------- */

export function EventsScreen({ view, children }: { readonly view: EventsView; readonly children?: React.ReactNode }) {
  const behind = BigInt(view.queue.ledgerHead) - BigInt(view.queue.cursor);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Outbound events</h1>
          <Badge tone={view.source === "live" ? "positive" : "quiet"}>
            {view.source === "live" ? "LIVE" : "FIXTURE"}
          </Badge>
        </div>
        <p className="max-w-prose text-xs text-muted">
          Events this bank sends to its customers. Every provider integrated here pushes events to us; this is
          the only place we push events to anyone.
        </p>
        <MetaList
          items={[
            { label: "delivered", value: view.queue.delivered },
            { label: "pending", value: view.queue.pending },
            { label: "due now", value: view.queue.dueNow },
            { label: "dead", value: view.queue.dead },
            {
              label: "generator",
              value: (
                <span className="money" title="outbound_cursor.last_sequence vs MAX(journal_entry.booking_seq)">
                  seq {view.queue.cursor} of {view.queue.ledgerHead}
                  {behind > 0n ? ` (${behind.toString()} behind)` : ""}
                </span>
              ),
            },
          ]}
        />
      </header>

      <Note title="Ordering is not guaranteed, and we say so in the payload">
        <p>
          Deliveries are <strong>at-least-once and unordered</strong>. We retry, we fan out to more than one
          endpoint, and more than one worker drains the queue — any one of those reorders arrival relative to
          what happened. Every body carries{" "}
          <code>sequence</code>, which is <code>journal_entry.booking_seq</code>, this ledger&apos;s own total
          order and the same integer <code>/api/v1/transactions</code> publishes. Sort on it; do not trust
          arrival. Deduplicate on the event <code>id</code>, which is also the <code>webhook-id</code> header
          and is stable across every retry.
        </p>
        <p className="mt-2">
          The body is a <strong>pointer</strong>. <code>data</code> is a snapshot at emit time;{" "}
          <code>links</code> names the API resources that hold current truth. Reading the object back is how a
          customer becomes immune to both ordering and duplication, which is the same answer this system&apos;s
          own Plaid consumer uses.
        </p>
      </Note>

      {children}

      <EndpointsPanel endpoints={view.endpoints} />
      <DeliveryLogPanel deliveries={view.deliveries} />

      <Panel title="What this cannot do" as="h2">
        <div className="space-y-3 px-5 py-4 text-xs leading-relaxed text-muted">
          <p>
            <strong className="text-text">It cannot touch the ledger.</strong> Events are generated by a cursor
            that walks <code>journal_entry.booking_seq</code> <em>after</em> the posting has committed. No
            money transaction contains a delivery row, no foreign key points from the money schema into these
            tables, and nothing on the posting path imports this module. A customer&apos;s dead endpoint costs
            eight attempts of a background worker and nothing else; their payments settle on a code path that
            has never heard of it.
          </p>
          <p>
            <strong className="text-text">It cannot be pointed inward.</strong> A URL is refused unless it is
            https on port 443, carries no userinfo, and resolves — every address, not just the first — to
            ordinary global unicast. The connection is pinned to the address that was checked, so DNS cannot
            change its mind in between, and a redirect is never followed because a redirect is a second URL
            chosen after the checks ran.
          </p>
          <p>
            <strong className="text-text">It cannot show you a secret twice.</strong> Signing secrets live in
            their own table so that no endpoint read can return one, and the value is displayed exactly once,
            at creation. Lost one? Rotate it — both versions sign until you retire the old one.
          </p>
        </div>
      </Panel>
    </div>
  );
}

export function EventsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        <div className="h-5 w-48 animate-pulse rounded bg-surface-raised" />
        <div className="h-3 w-96 animate-pulse rounded bg-surface-raised" />
      </div>
      <Panel title="Endpoints">
        <div className="space-y-2 px-5 py-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-surface-raised" />
          ))}
        </div>
      </Panel>
      <Panel title="Delivery log">
        <div className="space-y-2 px-5 py-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-8 animate-pulse rounded bg-surface-raised" />
          ))}
        </div>
      </Panel>
      <span className="sr-only">Loading the outbound delivery log.</span>
    </div>
  );
}

export function EventsError({ code, message }: { readonly code: string; readonly message: string }) {
  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold tracking-tight">Outbound events</h1>
      <Note emphasis title={`Could not load the delivery log (${code})`}>
        <p>{message}</p>
        <p className="mt-2">
          <FieldLabel>Nothing was lost</FieldLabel>{" "}
          Every queued delivery is a durable row with its own retry schedule. This is a read failing, not a
          queue draining — the next drain picks up exactly where it left off.
        </p>
      </Note>
    </div>
  );
}
