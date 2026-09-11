/**
 * The dashboard.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT IT IS TRYING TO SHOW, AND WHY THAT IS NOT "NOTHING HAPPENED"
 *
 * A chaos screen that shows four green ticks and a flat balance has proved
 * nothing: a system doing no work at all shows the same picture. So the panels
 * are ordered to tell the story in the order it happens —
 *
 *   1. THE BANNER        whose doing this is. Always first.
 *   2. THE CONTROLS      four switches, each with an off, each with a clock.
 *   3. THE INVARIANTS    fifteen views, all empty, WHILE the rest is happening.
 *                        This is the claim the screen exists to make.
 *   4. THE OUTBOX        what chaos withheld, duplicated, reordered, released
 *                        — and how many copies the inbox's own unique key
 *                        threw away without being asked to.
 *   5. THE INBOX         the parked rows, what they are waiting for, and the
 *                        button that drains them. This is the interesting
 *                        frame: the system holding a verified money event and
 *                        refusing to guess whose money to move.
 *   6. THE POSITION      available drops, ledger does not. The brief's own
 *                        first live-fire line.
 *   7. THE TIMELINE      who armed what, when, and when it ran out.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { Money } from '@/components/ui/Money';
import { isRetryable } from '@/components/ui/error-detail';
import { Badge, Note, Panel, TableScroll, TD_CLASS, TH_CLASS } from '@/components/ui/primitives';
import { RetryButton } from '@/components/ui/RetryButton';
import { formatTimestamp } from '@/lib/format/datetime';
import type { ErrorShape } from '@/lib/result';

import { ChaosBanner } from './ChaosBanner';
import { ChaosControls } from './ChaosControls';
import type { ChaosDataSource, ChaosRunView, ChaosView as View } from './data-contract';
import { CHAOS_STATE_UNREADABLE } from './unreadable';

/**
 * WHICH STATE THIS IS COMES FROM THE SOURCE, NOT FROM THE URL. It used to take
 * the parsed view as well and badge the header `LIVE LEDGER` whenever the URL
 * named a live state — which said "live" on a refusal, because the URL is a
 * request to read the book and not evidence that the book was read. The badge
 * now comes from `data.source`, which only a source that actually loaded can
 * set, and a failed load badges nothing at all.
 */
export async function ChaosView({ source }: { readonly source: ChaosDataSource }) {
  const result = await source.load();

  if (!result.ok) {
    // No badge on a refusal. CHAOS OFF above a read that never happened is the
    // reassurance this whole repair exists to withdraw, and `LIVE LEDGER` over
    // it would be claiming the ledger it failed to open.
    return (
      <div className="space-y-6">
        <Header live={null} asOf={null} on={null} />
        <ErrorPanel error={result.error} />
      </div>
    );
  }

  const data = result.value;
  const live = data.source === 'live';

  return (
    <div className="space-y-6">
      <Header live={live} asOf={data.asOf} on={data.chaos.on} />

      <ChaosBanner chaos={data.chaos} asOf={data.asOf} />

      {live ? null : (
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          These figures are a fixture, because a demo state other than <code>default</code> is
          selected — see the state bar above. A deployment with no database does not land here: it
          refuses, and says so. Nothing on this screen is a statement about a real book, and no
          control on it is armed.
        </p>
      )}

      <ChaosControls
        controls={data.chaos.controls}
        enabled={live}
        chaosOn={data.chaos.on}
        hasRun={data.latestRun !== null}
        runId={data.latestRun?.id ?? null}
        cardRegistered={data.latestRun?.cardRegistered ?? false}
      />

      <InvariantPanel data={data} />

      {data.latestRun === null ? (
        <Panel
          title="No episode has run yet"
          description="Arm whichever controls you want, then start an episode. The controls shape delivery; the episode is what gets delivered."
        >
          <div className="px-5 py-6">
            <p className="max-w-prose text-sm leading-relaxed text-muted">
              An episode is the brief&rsquo;s own fuel-pump pair: a{' '}
              <Money cents={5000n} /> authorisation and a <Money cents={7340n} /> clearing on one
              card, delivered through the same pipeline a real Lithic delivery goes through. What
              the four controls change is <strong>when</strong> those deliveries arrive,{' '}
              <strong>how many times</strong>, and <strong>in what order</strong> — never a byte of
              what is inside them.
            </p>
          </div>
        </Panel>
      ) : (
        <>
          <OutboxPanel run={data.latestRun} />
          <InboxPanel data={data} run={data.latestRun} />
        </>
      )}

      <PositionPanel data={data} />
      <TimelinePanel data={data} />
    </div>
  );
}

function Header({
  live,
  asOf,
  on,
}: {
  // `null` on both means "this render read nothing, so it badges nothing".
  // CHAOS OFF and LIVE LEDGER are each an answer to a question somebody opens
  // this screen to settle, and a refusal has neither answer to give.
  readonly live: boolean | null;
  readonly asOf: string | null;
  readonly on: boolean | null;
}) {
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Chaos mode</h1>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          Four switches that perturb the <strong>delivery</strong> of card webhooks this deployment
          originates itself — their availability, timing, multiplicity and order — and a dashboard
          showing the ledger absorbing it. Chaos never touches the book.
        </p>
      </div>
      <div className="flex items-center gap-3">
        {on === null ? null : (
          <Badge tone={on ? 'negative' : 'quiet'}>{on ? 'CHAOS ARMED' : 'CHAOS OFF'}</Badge>
        )}
        {live === null ? null : (
          <Badge tone={live ? 'neutral' : 'quiet'}>{live ? 'LIVE LEDGER' : 'FIXTURE DATA'}</Badge>
        )}
        {asOf === null ? null : (
          <span className="text-[11px] text-muted">as at {formatTimestamp(asOf)}</span>
        )}
      </div>
    </header>
  );
}

/**
 * The refusal.
 *
 * TWO CAUSES, ONE PANEL, DIFFERENT WORDS. A read that failed and a deployment
 * with no database configured both arrive here, and both refuse identically —
 * no switch, no countdown, no invariant verdict, no control to press. They
 * differ in their code, in the note under the heading, and in whether a retry
 * is offered. The retry control is dropped when the failure says it is not
 * retryable, because a button offering to re-run a read that cannot succeed
 * sits next to the words "retryable: no" and contradicts them.
 */
function ErrorPanel({ error }: { readonly error: ErrorShape }) {
  const retryable = isRetryable(error);
  const noDatabase = error.code === CHAOS_STATE_UNREADABLE.code;

  return (
    <section className="rounded-lg border border-negative/40 bg-surface">
      <header className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-sm font-semibold tracking-tight text-negative">
            {noDatabase ? 'The chaos screen was not read' : 'The chaos screen could not be read'}
          </h2>
          {noDatabase ? <Badge tone="negative">NO DATABASE</Badge> : null}
        </div>
      </header>
      <div className="space-y-4 px-5 py-5">
        <dl className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">Code</dt>
          <dd className="font-mono text-xs">{error.code}</dd>
          <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            What happened
          </dt>
          <dd className="max-w-prose text-sm leading-relaxed">{error.message}</dd>
          <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            Retryable
          </dt>
          <dd className="font-mono text-xs">{retryable ? 'yes' : 'no'}</dd>
        </dl>
        {noDatabase ? (
          <Note title="Nothing was armed, and nothing here says nothing is armed">
            This screen <strong>read nothing</strong>. A read cannot arm a chaos control and cannot
            release a withheld delivery, so whatever state chaos was in before this page loaded, it
            is still in — but this page did not find out what that state is. If a control is armed
            somewhere, it is still on its own expiry clock and this screen is not showing the
            countdown.
          </Note>
        ) : (
          <Note title="Nothing was armed and nothing was delivered">
            This screen failed on a <strong>read</strong>. A read cannot arm a chaos control and
            cannot release a withheld delivery, so whatever state chaos was in before this page
            loaded, it is still in — and every armed control is still on its own expiry clock.
          </Note>
        )}
        {retryable ? <RetryButton /> : null}
      </div>
    </section>
  );
}

/**
 * The invariants.
 *
 * The same fifteen views `scripts/dbcheck.mjs` asserts, read at the same
 * instant as everything else on this page. An unreadable view is rendered as a
 * FAILURE, never as a pass — a guard that reports healthy when it cannot see is
 * the exact pattern this repository keeps finding in its own guards.
 */
function InvariantPanel({ data }: { readonly data: View }) {
  const violated = data.invariants.filter((i) => i.rows > 0);
  const unreadable = data.invariants.filter((i) => i.error !== null);

  return (
    <Panel
      title="Invariants, measured now"
      description="The same views scripts/dbcheck.mjs asserts. Each MUST return zero rows. This is the claim the whole screen exists to make: they hold while chaos runs."
      actions={
        <Badge tone={data.invariantsHold ? 'positive' : 'negative'}>
          {data.invariantsHold
            ? `ALL ${String(data.invariants.length)} HOLD`
            : `${String(violated.length + unreadable.length)} NOT SATISFIED`}
        </Badge>
      }
    >
      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Invariant views and the rows each returned</caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH_CLASS}>
                View
              </th>
              <th scope="col" className={TH_CLASS}>
                Claim
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Rows
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.invariants.map((inv) => (
              <tr key={inv.view}>
                <td className={`${TD_CLASS} font-mono text-xs`}>{inv.view}</td>
                <td className={`${TD_CLASS} text-muted`}>
                  {inv.error === null ? inv.claim : `could not be read: ${inv.error}`}
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  {inv.error !== null ? (
                    <Badge tone="negative">UNREADABLE</Badge>
                  ) : inv.rows === 0 ? (
                    <Badge tone="positive">0</Badge>
                  ) : (
                    <Badge tone="negative">{String(inv.rows)}</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      <div className="border-t border-border px-5 py-4">
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          Trial balance across every financial line in the database:{' '}
          <Money cents={BigInt(data.trialBalanceCents)} />. Double entry balances or it does not;
          there is no third answer.
        </p>
      </div>
    </Panel>
  );
}

/** What chaos did to delivery, and what the inbox's own unique key did back. */
function OutboxPanel({ run }: { readonly run: ChaosRunView }) {
  return (
    <Panel
      title="The outbox — what chaos did to delivery"
      description={run.summary}
      actions={<Badge tone="quiet">{`episode ${run.id.slice(0, 8)}`}</Badge>}
    >
      <div className="grid grid-cols-2 gap-px overflow-hidden border-b border-border bg-border sm:grid-cols-4">
        <Tile label="Withheld" value={String(run.totals.withheld)} hint="sitting in our outbox" />
        <Tile label="Accepted" value={String(run.totals.accepted)} hint="new facts in the inbox" />
        <Tile
          label="Suppressed"
          value={String(run.totals.suppressedReplays)}
          hint="duplicates Postgres refused"
        />
        <Tile label="Refused" value={String(run.totals.refused)} hint="rejected or dead on arrival" />
      </div>

      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Every delivery chaos planned for this episode</caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH_CLASS}>
                #
              </th>
              <th scope="col" className={TH_CLASS}>
                Step
              </th>
              <th scope="col" className={TH_CLASS}>
                Webhook id
              </th>
              <th scope="col" className={TH_CLASS}>
                Planned
              </th>
              <th scope="col" className={TH_CLASS}>
                Released
              </th>
              <th scope="col" className={TH_CLASS}>
                Outcome
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {run.deliveries.map((d) => (
              <tr key={`${String(d.seq)}-${String(d.copyIndex)}`}>
                <td className={`${TD_CLASS} font-mono text-xs`}>
                  {d.seq}
                  {d.copyIndex > 0 ? (
                    <span className="text-muted">{` copy ${String(d.copyIndex)}`}</span>
                  ) : null}
                </td>
                <td className={TD_CLASS}>{d.step}</td>
                <td className={`${TD_CLASS} font-mono text-xs`}>{d.webhookId}</td>
                <td className={`${TD_CLASS} text-xs text-muted`}>{formatTimestamp(d.plannedAt)}</td>
                <td className={`${TD_CLASS} text-xs text-muted`}>
                  {d.releasedAt === null ? '—' : formatTimestamp(d.releasedAt)}
                </td>
                <td className={TD_CLASS}>
                  <OutcomeBadge outcome={d.outcome} />
                  {d.detail === null ? null : (
                    <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">
                      {d.detail}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>

      {run.totals.suppressedReplays > 0 ? (
        <div className="border-t border-border px-5 py-4">
          <Note title="The duplicates were absorbed by the inbox, not by chaos">
            Every copy carried the <strong>same</strong> <code className="font-mono">webhook-id</code>{' '}
            and the same bytes, so{' '}
            <code className="font-mono">
              webhook_inbox UNIQUE (provider, provider_event_id)
            </code>{' '}
            refused the second and every one after it. Chaos did not look the id up first, did not
            check for a duplicate, and has no code path that could have produced this result. Twice
            is one, and Postgres is what decided so.
          </Note>
        </div>
      ) : null}
    </Panel>
  );
}

function OutcomeBadge({ outcome }: { readonly outcome: string }) {
  if (outcome === 'withheld') return <Badge tone="negative">WITHHELD</Badge>;
  if (outcome === 'accepted') return <Badge tone="positive">ACCEPTED</Badge>;
  if (outcome === 'replay') return <Badge tone="neutral">SUPPRESSED REPLAY</Badge>;
  return <Badge tone="negative">{outcome.toUpperCase()}</Badge>;
}

/**
 * The parked rows — the interesting frame.
 *
 * A park is not an error and not a drop. It is the system holding a verified
 * money event and refusing to post it because it does not know whose money to
 * move. The copy here says that in those words, because "7 parked" on its own
 * reads like a backlog rather than like a refusal.
 */
function InboxPanel({ data, run }: { readonly data: View; readonly run: ChaosRunView }) {
  const parkedHere = run.inbox.filter((r) => r.state === 'parked');

  return (
    <Panel
      title="The webhook inbox — what the system did with them"
      description="Chaos originated these deliveries; from the moment they were verified they are ordinary webhook rows and nothing downstream knows chaos exists."
      actions={
        <div className="flex items-center gap-2">
          <Badge tone={data.inbox.parked > 0 ? 'neutral' : 'quiet'}>
            {`${String(data.inbox.parked)} parked`}
          </Badge>
          <Badge tone={data.inbox.dead > 0 ? 'negative' : 'quiet'}>
            {`${String(data.inbox.dead)} dead-lettered`}
          </Badge>
        </div>
      }
    >
      {parkedHere.length > 0 ? (
        <div className="border-b border-border px-5 py-4">
          <Note emphasis title="This is the mechanism, not a failure">
            {parkedHere.length === 1
              ? 'One delivery from this episode is parked. '
              : `${String(parkedHere.length)} deliveries from this episode are parked. `}
            They are verified, durable, and <strong>not posted</strong> — because the card they
            name is not registered to a customer, and the system{' '}
            <strong>refuses to guess whose money to move</strong>. Nothing has been dropped and
            nothing has been invented. Register the card and the same events — never re-delivered,
            never re-signed — post against the customer they always belonged to.
          </Note>
        </div>
      ) : null}

      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">The inbox rows this episode produced</caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH_CLASS}>
                Provider event id
              </th>
              <th scope="col" className={TH_CLASS}>
                State
              </th>
              <th scope="col" className={TH_CLASS}>
                Waiting for
              </th>
              <th scope="col" className={TH_CLASS}>
                Received
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {run.inbox.length === 0 ? (
              <tr>
                <td className={`${TD_CLASS} text-muted`} colSpan={4}>
                  No delivery from this episode has reached the inbox. With{' '}
                  <code className="font-mono">webhooks_off</code> armed that is the expected state:
                  the deliveries exist and are waiting in our outbox.
                </td>
              </tr>
            ) : (
              run.inbox.map((row) => (
                <tr key={row.providerEventId}>
                  <td className={`${TD_CLASS} font-mono text-xs`}>{row.providerEventId}</td>
                  <td className={TD_CLASS}>
                    <Badge
                      tone={
                        row.state === 'done'
                          ? 'positive'
                          : row.state === 'dead'
                            ? 'negative'
                            : 'neutral'
                      }
                    >
                      {row.state.toUpperCase()}
                    </Badge>
                  </td>
                  <td className={`${TD_CLASS} text-xs text-muted`}>
                    {row.parkedOnKind === null ? (
                      '—'
                    ) : (
                      <>
                        <span className="font-mono">
                          {row.parkedOnKind}:{row.parkedOnRef ?? ''}
                        </span>
                        {row.parkedReason === null ? null : (
                          <p className="mt-1 max-w-prose leading-relaxed">{row.parkedReason}</p>
                        )}
                      </>
                    )}
                  </td>
                  <td className={`${TD_CLASS} text-xs text-muted`}>
                    {formatTimestamp(row.receivedAt)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </TableScroll>

      {data.parked.length > 0 ? (
        <div className="border-t border-border px-5 py-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            Everything parked on this deployment, by what it is waiting for
          </p>
          <ul className="mt-2 space-y-1">
            {data.parked.map((p) => (
              <li key={`${p.kind}:${p.ref ?? ''}`} className="text-xs text-muted">
                <span className="font-mono">{p.kind}</span> — {p.count}{' '}
                {p.count === 1 ? 'delivery' : 'deliveries'}
                {p.reason === null ? null : <span className="text-muted">{` · ${p.reason}`}</span>}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}

/** Available drops, ledger balance does not. The brief's own first line. */
function PositionPanel({ data }: { readonly data: View }) {
  if (data.position === null) {
    return (
      <Panel
        title="The customer's position"
        description="No customer is selected. Start an episode and the business it targets appears here."
      >
        <div className="px-5 py-6">
          <p className="max-w-prose text-sm text-muted">
            Nothing to show until an episode names a customer.
          </p>
        </div>
      </Panel>
    );
  }

  const p = data.position;
  return (
    <Panel
      title="The customer's position"
      description="Derived from the journal, never stored. A card authorisation moves available and leaves ledger balance alone — that asymmetry is the whole point of the hold model."
      actions={<Badge tone="quiet">{p.businessName ?? p.businessId.slice(0, 8)}</Badge>}
    >
      <div className="grid grid-cols-1 gap-px overflow-hidden bg-border sm:grid-cols-3">
        <MoneyTile
          label="Ledger balance"
          cents={p.ledgerCents}
          hint="what has actually settled"
        />
        <MoneyTile
          label="Available"
          cents={p.availableCents}
          hint="ledger minus active holds"
        />
        <MoneyTile label="Held" cents={p.holdsCents} hint="authorised, not yet settled" />
      </div>
    </Panel>
  );
}

function TimelinePanel({ data }: { readonly data: View }) {
  return (
    <Panel
      title="Chaos audit trail"
      description="Every arm, disarm, expiry, episode and release, in order. The answer to the only question that matters after a demo: was it on, and who turned it on."
    >
      {data.timeline.length === 0 ? (
        <div className="px-5 py-6">
          <p className="text-sm text-muted">Chaos has never been armed on this deployment.</p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {data.timeline.map((entry) => (
            <li key={`${entry.at}-${entry.kind}-${entry.detail}`} className="px-5 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-sm">{entry.detail}</span>
                <span className="text-[11px] text-muted">{formatTimestamp(entry.at)}</span>
              </div>
              <p className="mt-0.5 text-[11px] text-muted">
                <span className="font-mono">{entry.kind}</span> · {entry.actor}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Tile({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
}) {
  return (
    <div className="bg-surface px-5 py-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 text-[11px] text-muted">{hint}</p>
    </div>
  );
}

function MoneyTile({
  label,
  cents,
  hint,
}: {
  readonly label: string;
  readonly cents: string;
  readonly hint: string;
}) {
  return (
    <div className="bg-surface px-5 py-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tracking-tight">
        <Money cents={BigInt(cents)} />
      </p>
      <p className="mt-0.5 text-[11px] text-muted">{hint}</p>
    </div>
  );
}

export function ChaosSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className="animate-pulse space-y-6">
      <span className="sr-only">Loading the chaos dashboard</span>
      <Bar className="h-6 w-48" />
      <Bar className="h-24 w-full" />
      <Bar className="h-40 w-full" />
      <Bar className="h-64 w-full" />
    </div>
  );
}

function Bar({ className }: { readonly className: string }) {
  return <span className={`block rounded bg-border ${className}`} />;
}
