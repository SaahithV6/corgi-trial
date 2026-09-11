import Link from "next/link";

import { formatDate, formatTimestamp } from "@/lib/format/datetime";
import { formatUsd } from "@/lib/format/money";
import { Money } from "@/components/ui/Money";
import {
  Badge,
  FieldLabel,
  FOCUS_RING,
  Note,
  Panel,
  TableScroll,
  TD_CLASS,
  TH_CLASS,
} from "@/components/ui/primitives";

import type { HoldDetail, HoldEventRow } from "./contract";

/**
 * One hold, drilled into: the event SET, and the fold that produces `H(E)`.
 *
 * The point of this page is that `H` is not a number somebody stored. It is a
 * pure function of a set, and the set is right there. Every row of the table
 * below is a member of `E`; the three right-hand columns are `A`, `C` and `H`
 * recomputed over the prefix ending at that row by calling `holdState()` — the
 * same function `applyCardTransaction()` calls — so the screen cannot print
 * arithmetic the model would not.
 *
 * Two things are deliberately absent, and their absence is the argument:
 *
 *   THE PROVIDER'S STATUS. Lithic reports SETTLED while a partial hold is
 *   still outstanding (measured, DECISIONS 006). A release keyed off that field
 *   frees money that is still authorised, so the field is not read, not stored
 *   and not shown.
 *
 *   A PREVIOUS STATE. There is no state column and no transition table. Σ, ∃,
 *   max and one clock comparison over a set are all invariant under
 *   permutation, which is the whole of the out-of-order story: a settlement
 *   that beats its authorisation is not a case to handle, it is the same set
 *   assembled in a different order.
 */

const KIND_LABEL: Record<HoldEventRow["kind"], string> = {
  authorization: "authorisation",
  incremental_authorization: "incremental authorisation",
  authorization_reversal: "authorisation reversal",
  clearing: "clearing",
  force_post: "force post",
  refund: "refund",
  expiry: "expiry",
  close: "close",
  declined: "declined by the network",
};

/** Which term of the model each kind feeds. Shown per row, so nothing is implied. */
const KIND_TERM: Record<HoldEventRow["kind"], string> = {
  authorization: "+ A(E)",
  incremental_authorization: "+ A(E)",
  authorization_reversal: "− A(E)",
  clearing: "+ C(E)",
  force_post: "+ C(E)",
  refund: "neither — financial book only",
  expiry: "closes(E)",
  close: "closes(E)",
  // Feeds nothing, and saying so on the row is the point. A refusal used to be
  // indistinguishable from an approval at ingest, and the ledger withheld
  // $4,451.00 against authorisations the network had refused. This row is how a
  // customer sees that the attempt happened and that it is holding no money.
  declined: "neither — the network refused it, so it withholds nothing",
};

export function HoldDetailView({ detail }: { readonly detail: HoldDetail }) {
  const { state } = detail;
  const remainder = state.authorisedCents - state.capturedCents;
  const overCaptured = state.capturedCents > state.authorisedCents;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs text-muted">
          <Link
            href="/accounts"
            className={`underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
          >
            ← Back to the card &amp; hold console
          </Link>
        </p>
        <h1 className="mt-2 text-lg font-semibold tracking-tight">
          {detail.descriptor}
        </h1>
        <p className="mt-0.5 text-sm text-muted">
          {detail.businessName} · hold on account{" "}
          <span className="font-mono text-xs">{detail.accountId}</span>
        </p>
      </header>

      <Panel
        title="Identity"
        description="A hold and its authorisation are created together and neither is ever updated. Every 'change' below was an INSERT that some unique index could have refused."
      >
        <dl className="grid gap-x-6 gap-y-3 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Hold id" value={detail.holdId} mono />
          <Fact label="External ref" value={detail.externalRef} mono />
          <Fact
            label="Provider transaction"
            value={detail.providerAuthId ?? "— no card authorisation behind this hold"}
            mono={detail.providerAuthId !== null}
          />
          <Fact label="Provider" value={detail.provider ?? "—"} />
          <Fact
            label="Origin"
            value={detail.origin ?? "—"}
            hint="How we first heard of it. Recorded for reporting; nothing branches on it — a clearing that beat its authorisation takes the identical arithmetic path."
          />
          <Fact label="Placed" value={formatTimestamp(detail.placedAt)} />
          <Fact
            label="First seen"
            value={detail.firstSeenAt === null ? "—" : formatTimestamp(detail.firstSeenAt)}
          />
          <Fact
            label="Expires"
            value={detail.expiresAt === null ? "—" : formatTimestamp(detail.expiresAt)}
            hint="The clock limb of closed(E). Seven days from the authorisation."
          />
          <Fact
            label="Closure row"
            value={
              detail.closureRow === null
                ? "none — this hold has never been released"
                : `${detail.closureRow.reason} · ${formatTimestamp(detail.closureRow.closedAt)}`
            }
            hint="PRIMARY KEY (hold_id), so release is exactly-once by construction rather than by a flag somebody could set twice."
          />
        </dl>
      </Panel>

      <Panel
        id="events"
        title={`The event set E — ${detail.events.length} member${detail.events.length === 1 ? "" : "s"}`}
        description="Every fact the network has told us about this authorisation. Deduplicated by the database on UNIQUE (auth_id, provider_event_id), so a redelivered webhook never enters E at all and H cannot move."
        actions={<Badge tone="quiet">append-only</Badge>}
      >
        {detail.events.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted">
            No card events. This hold has an identity and nothing has been heard
            about it yet, which is <span className="font-mono">A = 0</span> and{" "}
            open-with-nothing-held — not closed. The empty set is why{" "}
            <span className="font-mono">A ≤ 0</span> needs its non-empty guard.
          </p>
        ) : (
          <TableScroll>
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                Every card event in this authorisation&rsquo;s event set, with the
                running fold at each step
              </caption>
              <thead className="border-b border-border">
                <tr>
                  <th scope="col" className={TH_CLASS}>
                    Event
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Kind
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    Amount
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Value date
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    A(E) so far
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    C(E) so far
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    H so far
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {detail.events.map((event) => (
                  <tr key={event.providerEventId}>
                    <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                      <span className="font-mono text-xs break-all">
                        {event.providerEventId}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-muted">
                        received {formatTimestamp(event.receivedAt)}
                      </span>
                    </th>
                    <td className={TD_CLASS}>
                      <span>{KIND_LABEL[event.kind]}</span>
                      <span className="mt-0.5 block font-mono text-[11px] text-muted">
                        {KIND_TERM[event.kind]}
                      </span>
                      {event.isFinal ? (
                        <span className="mt-1 block">
                          <Badge
                            tone="neutral"
                            title="The network says no further capture is coming. One of the four limbs of closed(E)."
                          >
                            is_final
                          </Badge>
                        </span>
                      ) : null}
                    </td>
                    <td className={`${TD_CLASS} text-right`}>
                      <Money cents={event.amountCents} tone="neutral" />
                      <span className="mt-0.5 block text-[11px] text-muted">
                        magnitude
                      </span>
                    </td>
                    <td className={`${TD_CLASS} whitespace-nowrap text-xs`}>
                      {/* Midday UTC, not midnight. `formatDate` renders in
                          America/New_York, and midnight UTC is the previous
                          evening there — a value date is a business DAY, and
                          shifting it by a timezone turns Tuesday's fuel into
                          Monday's on the screen while the ledger still says
                          Tuesday. */}
                      {formatDate(`${event.valueDate}T12:00:00.000Z`)}
                    </td>
                    <td className={`${TD_CLASS} text-right`}>
                      <Money cents={event.runningAuthorisedCents} tone="neutral" />
                    </td>
                    <td className={`${TD_CLASS} text-right`}>
                      <Money cents={event.runningCapturedCents} tone="neutral" />
                    </td>
                    <td className={`${TD_CLASS} text-right font-medium`}>
                      <Money cents={event.runningHoldCents} tone="neutral" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}

        <p className="border-t border-border px-5 py-3 max-w-prose text-xs leading-relaxed text-muted">
          The amount column is a MAGNITUDE and is always ≥ 0 — the direction
          lives in the kind, exactly as the{" "}
          <span className="font-mono">card_auth_event</span> table stores it. The
          three right-hand columns are recomputed by calling the model on each
          prefix of the set, so the order of the rows changes every one of them
          and changes none of the totals below. That is the order-independence
          claim, visible rather than asserted.
        </p>
      </Panel>

      <Panel
        id="fold"
        title="The fold"
        description="H(E) is not stored anywhere. It is this arithmetic, over the set above, evaluated at the instant printed below."
        actions={
          <span className="font-mono text-[11px] text-muted">
            evaluated {formatTimestamp(detail.evaluatedAt)}
          </span>
        }
      >
        <div className="grid gap-px bg-border sm:grid-cols-3">
          <Term
            label="A(E) — authorised"
            cents={state.authorisedCents}
            note="Σ over {authorization, incremental_authorization} − Σ over {authorization_reversal}. May be negative: a reversal can arrive before its authorisation."
          />
          <Term
            label="C(E) — captured"
            cents={state.capturedCents}
            note="Σ over {clearing, force_post}. May exceed A(E) — fuel pumps and tips over-capture routinely."
          />
          <Term
            label="H(E) — held"
            cents={state.holdCents}
            note="0 if closed(E), else max(A(E) − C(E), 0). Never negative."
            emphasis
          />
        </div>

        <div className="border-t border-border px-5 py-4">
          <FieldLabel>closed(E)</FieldLabel>
          <ul className="mt-2 space-y-1 text-xs">
            <Limb
              fired={state.sawFinal}
              label="∃ e ∈ E : e.isFinal"
              detail="the network said no further capture is coming"
            />
            <Limb
              fired={state.sawClose}
              label="∃ e ∈ E : e.kind ∈ {close, expiry}"
              detail="the network closed or expired it"
            />
            <Limb
              fired={state.expired}
              label="now ≥ expiresAt"
              detail="the seven-day clock ran out"
            />
            <Limb
              fired={state.eventCount > 0 && state.authorisedCents <= 0n}
              label="E ≠ ∅ ∧ A(E) ≤ 0"
              detail="everything authorised has been reversed"
            />
          </ul>

          <p className="mt-3 font-mono text-xs">
            closed(E) ={" "}
            <span className={state.closed ? "text-text" : "text-muted"}>
              {state.closed ? "true" : "false"}
            </span>
            {"  ·  "}
            H(E) ={" "}
            {state.closed
              ? "0 (closed)"
              : `max(${formatUsd(state.authorisedCents, { symbol: false })} − ${formatUsd(
                  state.capturedCents,
                  { symbol: false },
                )}, 0) = ${formatUsd(state.holdCents, { symbol: false })}`}
          </p>

          {state.closed === state.terminallyClosed ? null : (
            <div className="mt-3">
              <Note title="Closed, but not terminally — no closure row may be written">
                <span className="font-mono">closed(E)</span> is true and{" "}
                <span className="font-mono">terminallyClosed</span> is false, so
                the machinery deliberately did not write a{" "}
                <span className="font-mono">hold_closure</span> row. This is the
                settlement-before-authorisation set: <span className="font-mono">A = 0</span>{" "}
                because nothing has authorised anything yet, not because
                everything was reversed. <span className="font-mono">hold_closure</span>{" "}
                is append-only with <span className="font-mono">PRIMARY KEY (hold_id)</span>,
                so a closure written on the strength of it could never be undone
                by the authorisation about to arrive — and availability reads
                that row, so the customer would spend money they no longer have.
              </Note>
            </div>
          )}

          {overCaptured ? (
            <div className="mt-3">
              <Note emphasis title="Over-capture">
                <span className="font-mono">A − C</span> is{" "}
                <Money cents={remainder} tone="neutral" />, which is negative, so{" "}
                <span className="font-mono">max(A − C, 0)</span> is{" "}
                <span className="font-mono">$0.00</span>. The excess of{" "}
                <Money cents={state.capturedCents - state.authorisedCents} tone="neutral" />{" "}
                was never held and therefore never protected. The hold is not
                wrong; the account is overdrawn, and the screen says so rather
                than clamping the available balance to zero.
              </Note>
            </div>
          ) : null}
        </div>

        <div className="border-t border-border px-5 py-4">
          <FieldLabel>The memo book&rsquo;s own answer</FieldLabel>
          <p className="mt-1 text-sm">
            <Money cents={detail.memoBalanceCents} />
            {detail.memoBalanceCents === state.holdCents ? (
              <span className="ml-2 text-xs text-muted">
                agrees with H(E) — the compare-and-append has nothing left to post
              </span>
            ) : (
              <span className="ml-2 text-xs text-muted">
                differs from H(E) by{" "}
                {formatUsd(state.holdCents - detail.memoBalanceCents, { signed: true })} —
                a release posting has not landed yet. Availability does not
                depend on it: it subtracts holds with no closure row, so the
                money is already free the moment the closure commits.
              </span>
            )}
          </p>
          <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
            This figure is the sum of journal lines hitting this hold&rsquo;s own
            9100 memo account. Summing every line of its entries would give zero
            always — the memo book is balanced by the same trigger as the
            financial book, so both legs are in that sum and they cancel.
          </p>
        </div>
      </Panel>
    </div>
  );
}

function Fact({
  label,
  value,
  mono = false,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly hint?: string;
}) {
  return (
    <div>
      <dt>
        <FieldLabel>{label}</FieldLabel>
      </dt>
      <dd className={`mt-1 text-sm break-all ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </dd>
      {hint === undefined ? null : (
        <dd className="mt-1 text-[11px] leading-relaxed text-muted">{hint}</dd>
      )}
    </div>
  );
}

function Term({
  label,
  cents,
  note,
  emphasis = false,
}: {
  readonly label: string;
  readonly cents: bigint;
  readonly note: string;
  readonly emphasis?: boolean;
}) {
  return (
    <div className="bg-surface px-5 py-4">
      <FieldLabel>{label}</FieldLabel>
      <p className="mt-1">
        <Money
          cents={cents}
          tone="neutral"
          className={emphasis ? "text-xl font-medium" : "text-xl"}
        />
      </p>
      <p className="mt-1.5 max-w-prose text-[11px] leading-relaxed text-muted">
        {note}
      </p>
    </div>
  );
}

function Limb({
  fired,
  label,
  detail,
}: {
  readonly fired: boolean;
  readonly label: string;
  readonly detail: string;
}) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      <span
        aria-hidden="true"
        className={`font-mono ${fired ? "text-text" : "text-muted"}`}
      >
        {fired ? "true " : "false"}
      </span>
      <span className="sr-only">{fired ? "true" : "false"}:</span>
      <span className="font-mono">{label}</span>
      <span className="text-muted">— {detail}</span>
    </li>
  );
}
