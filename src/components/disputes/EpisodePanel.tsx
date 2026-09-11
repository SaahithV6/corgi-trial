import { Money } from "@/components/ui/Money";
import {
  Badge,
  MetaList,
  Note,
  Panel,
  TableScroll,
  TD_CLASS,
  TH_CLASS,
} from "@/components/ui/primitives";

import type { EpisodeView } from "./data-contract";

/**
 * The edge case, expanded: a dispute LOST after provisional credit was granted.
 *
 * This panel exists to make two claims checkable rather than believable.
 *
 * 1. THE CLAWBACK IS A NEW EVENT, NOT A CORRECTION. Every entry is printed with
 *    its `entry_type`, its value date and its booking sequence. If the clawback
 *    were a correction it would be an `entry_type = 'reversal'` carrying the
 *    GRANT's value date — which would erase the credit from the statement of the
 *    day we wrote to the customer saying it was there. It is not, and the column
 *    proves it.
 *
 * 2. AVAILABLE BALANCE NEVER MOVED. Three rows, three booking watermarks,
 *    `ledger - holds` printed as a subtraction rather than as a conclusion. The
 *    ledger goes up and comes back; available is flat across all three. That
 *    flatness is why taking the money back could not overdraw a customer who did
 *    nothing wrong.
 */
export function EpisodePanel({ episode }: { readonly episode: EpisodeView }) {
  const financial = episode.entries.filter((e) => e.book === "financial");
  const memo = episode.entries.filter((e) => e.book === "memo");

  return (
    <div className="space-y-6">
      <Panel
        id="episode"
        title={`Edge — ${episode.caseRef}: lost after provisional credit was granted`}
        description="The money went out to the customer on one day and came back on another. Two entries, two value dates, neither of them a reversal."
        actions={
          episode.noReversals ? (
            <Badge tone="positive">no reversal entry — new events, not a correction</Badge>
          ) : (
            <Badge tone="negative">a reversal is present</Badge>
          )
        }
      >
        <div className="space-y-4 px-5 py-4">
          <MetaList
            items={[
              { label: "customer", value: episode.legalName },
              { label: "claimed", value: <Money cents={episode.amountCents} /> },
              { label: "reason", value: episode.reason.replaceAll("_", " ") },
              {
                label: "network code",
                value: (
                  <span className="money">
                    {episode.network} {episode.networkCode}
                  </span>
                ),
              },
              { label: "status", value: <span className="money">{episode.status}</span> },
            ]}
          />

          <div className="rounded border border-border px-4 py-3">
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              the charge under dispute
            </p>
            <p className="mt-1 text-sm">{episode.disputedDescription}</p>
            <p className="mt-1 text-[11px] text-muted">
              entry <span className="money">{episode.disputedEntryId}</span> · value date{" "}
              <span className="money">{episode.disputedValueDate}</span>
            </p>
          </div>
        </div>
      </Panel>

      {/* ---- the balances ------------------------------------------------ */}
      <Panel
        title="The customer's balance across the whole episode"
        description="Each row is sums over journal_line at a booking watermark (booking_seq <= N). Nothing here is stored; both subtractions are printed so they can be checked by eye. The first three columns are the WHOLE ACCOUNT and move for every reason the account moves; the last three are this case's own contribution to them, and they are where the claim lives."
      >
        <TableScroll>
          <table className="w-full border-collapse text-sm">
            <thead className="border-b border-border">
              <tr>
                <th className={TH_CLASS}>step</th>
                <th className={`${TH_CLASS} text-right`}>booking seq</th>
                <th className={`${TH_CLASS} text-right`}>ledger</th>
                <th className={`${TH_CLASS} text-right`}>− holds</th>
                <th className={`${TH_CLASS} text-right`}>= available</th>
                <th className={`${TH_CLASS} text-right`}>this case: ledger</th>
                <th className={`${TH_CLASS} text-right`}>− holds</th>
                <th className={`${TH_CLASS} text-right`}>= available</th>
              </tr>
            </thead>
            <tbody>
              {episode.balances.map((b) => (
                <tr key={b.bookingSeq} className="border-b border-border last:border-0">
                  <td className={TD_CLASS}>{b.label}</td>
                  <td className={`${TD_CLASS} text-right money`}>{b.bookingSeq}</td>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={b.ledgerCents} />
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={b.holdsCents} />
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={b.availableCents} />
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={b.caseLedgerCents} />
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={b.caseHoldsCents} />
                  </td>
                  <td className={`${TD_CLASS} text-right font-semibold`}>
                    <Money cents={b.caseAvailableCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>

        <div className="px-5 pb-4">
          <Note title="Read the last column down">
            <p>
              This case&rsquo;s ledger contribution rises by the credit and falls
              again by the clawback, because both of those are real money on real
              days and the customer&rsquo;s statement has to show each of them.
              Its contribution to <em>available</em> is nought on every row,
              because the hold withheld exactly what the credit added, from the
              moment it was granted until the case closed.
            </p>
            <p className="mt-2">
              <strong>Why the last three columns exist, and not just the first
              three.</strong> The account-wide columns are what the customer sees,
              so they are shown — but they are the whole account, and everything
              else that happened to this business in between lands in them. On a
              quiet book they read flat and it is tempting to publish that as the
              proof; on a busy one they do not. Measured here on 2026-09-11: an
              unrelated card authorisation for $225.00 released between the grant
              and the clawback, and the account-wide available column moved by
              exactly that, under a caption claiming it had not moved at all. A
              number that can be perturbed by something else is not evidence about
              this case, so the invariant is stated over this case&rsquo;s own
              journal lines, which nothing else on the book can touch.
            </p>
            <p className="mt-2">
              That nought is the reason the clawback is safe. A provisional credit
              that inflated available balance would let the customer spend money
              we may have to take back, and taking it back would overdraw somebody
              who did nothing wrong. This is a US <em>business</em> account, so
              Regulation E&rsquo;s &ldquo;full use of the funds&rdquo; rule does
              not apply and the availability decision is ours to make; we make it
              in the customer&rsquo;s favour on the day the case resolves, not
              before.
            </p>
          </Note>
        </div>
      </Panel>

      {/* ---- the entries -------------------------------------------------- */}
      <Panel
        title="Every entry this case posted"
        description="Financial first, then the memo book. Each one went through postEntry() — two lines, in cents, append-only, never an edit."
      >
        <div className="space-y-4 px-5 py-4">
          {[...financial, ...memo].map((entry) => (
            <div key={entry.entryId} className="rounded border border-border">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-2">
                <div>
                  <p className="text-sm font-medium">{entry.description}</p>
                  <p className="mt-1 text-[11px] text-muted">
                    entry <span className="money">{entry.entryId}</span>
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={entry.book === "memo" ? "quiet" : "neutral"}>{entry.book}</Badge>
                  <Badge tone={entry.entryType === "reversal" ? "negative" : "quiet"}>
                    {entry.entryType}
                  </Badge>
                </div>
              </div>

              <div className="px-4 py-2">
                <MetaList
                  items={[
                    { label: "value date", value: <span className="money">{entry.valueDate}</span> },
                    {
                      label: "booking seq",
                      value: <span className="money">{entry.bookingSeq}</span>,
                    },
                    {
                      label: "idempotency key",
                      value: <span className="money">{entry.idempotencyKey}</span>,
                    },
                  ]}
                />
              </div>

              <TableScroll>
                <table className="w-full border-collapse text-sm">
                  <thead className="border-y border-border">
                    <tr>
                      <th className={TH_CLASS}>#</th>
                      <th className={TH_CLASS}>account</th>
                      <th className={`${TH_CLASS} text-right`}>amount (signed)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.lines.map((line) => (
                      <tr key={line.ordinal} className="border-b border-border last:border-0">
                        <td className={`${TD_CLASS} money`}>{line.ordinal}</td>
                        <td className={TD_CLASS}>
                          <span className="money">{line.accountCode}</span>{" "}
                          <span className="text-muted">{line.accountName}</span>
                        </td>
                        <td className={`${TD_CLASS} text-right`}>
                          <Money cents={line.amountCents} tone="direction" signed />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
            </div>
          ))}

          <Note title="Why a debit is positive here">
            <p>
              Lines are stored debit-positive and credit-negative, in one signed
              column, so &ldquo;the entry balances&rdquo; is{" "}
              <span className="money">SUM(amount_cents) = 0</span>. A customer
              deposit account is a liability of the bank, so the{" "}
              <span className="money">negative</span> line on{" "}
              <span className="money">2100</span> is the customer gaining money
              and the <span className="money">positive</span> one is the customer
              losing it. The grant and the clawback are the same two accounts with
              the signs the other way up — and they are still two separate
              entries, on two separate days.
            </p>
          </Note>
        </div>
      </Panel>

      {/* ---- the lifecycle ------------------------------------------------ */}
      <Panel
        title="The lifecycle, as it was actually written"
        description="One row per dispute_event. Illegal orderings are refused by a trigger in 0019_disputes.sql, not by the code that calls it."
      >
        <TableScroll>
          <table className="w-full border-collapse text-sm">
            <thead className="border-b border-border">
              <tr>
                <th className={TH_CLASS}>event</th>
                <th className={TH_CLASS}>who</th>
                <th className={TH_CLASS}>value date</th>
                <th className={TH_CLASS}>entry</th>
                <th className={TH_CLASS}>detail</th>
              </tr>
            </thead>
            <tbody>
              {episode.events.map((e, index) => (
                <tr
                  key={`${e.kind}-${e.occurredAt}-${String(index)}`}
                  className="border-b border-border last:border-0 align-top"
                >
                  <td className={`${TD_CLASS} money`}>{e.kind}</td>
                  <td className={TD_CLASS}>
                    {e.actorName}
                    <span className="ml-1 text-[11px] text-muted">({e.actorKind})</span>
                  </td>
                  <td className={`${TD_CLASS} money`}>{e.valueDate}</td>
                  <td className={`${TD_CLASS} money text-[11px]`}>{e.entryId ?? "—"}</td>
                  <td className={`${TD_CLASS} max-w-md text-[11px] text-muted`}>
                    {e.detail ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Panel>
    </div>
  );
}
