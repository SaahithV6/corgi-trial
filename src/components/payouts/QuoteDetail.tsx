import {
  Badge,
  FieldLabel,
  MetaList,
  Note,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";

import type { QuoteView } from "./data-contract";
import { QuoteCountdown } from "./QuoteCountdown";
import { QuoteStateBadge, QUOTE_STATE_MEANING, RateEvidenceBadge } from "./labels";

/**
 * One quote, in full: the arithmetic, the countdown, the commitment and — for
 * a quote we are still on the hook for — what honouring it would cost today.
 *
 * ── SHOW THE ARITHMETIC, NOT THE ANSWER ─────────────────────────────────────
 *
 * Seven rows, every one with the sentence that explains it underneath. The two
 * a customer is normally not shown are here on purpose:
 *
 *   THE MID, with the literal characters the source printed and the date the
 *   source put on them, so the spread can be checked rather than believed.
 *
 *   THE SPREAD, as its own line. A provider quoting "no fees" is taking its
 *   margin inside the rate, where you cannot see it without knowing the mid.
 *   Printing both is the difference between a price and a disclosure.
 *
 * Every figure here is a string the server formatted from `bigint` cents and
 * integer-scaled rates. This component does no arithmetic at all.
 */
export function QuoteDetail({ quote }: { readonly quote: QuoteView }) {
  const live = quote.state === "open";

  return (
    <div className="space-y-6">
      <Panel
        id="quote-detail"
        title={`Quote ${quote.quoteRef}`}
        description={`${quote.businessName} → ${quote.beneficiaryRef}, over ${quote.rail.toUpperCase()}.`}
        actions={
          <div className="flex items-center gap-2">
            <RateEvidenceBadge evidence={quote.rate.evidence} />
            <QuoteStateBadge state={quote.state} />
          </div>
        }
      >
        <div className="space-y-5 px-5 py-4">
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            {QUOTE_STATE_MEANING[quote.state]}
          </p>

          {live ? (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <FieldLabel>This offer stands for</FieldLabel>
              <QuoteCountdown
                expiresAt={quote.expiresAt}
                initialSeconds={quote.expiresInSeconds}
                ttlSeconds={quote.ttlSeconds}
              />
              <span className="text-[11px] text-muted">
                expires {formatTimestamp(quote.expiresAt)}
              </span>
            </div>
          ) : null}

          <TableScroll>
            <table className="w-full min-w-[34rem] border-collapse">
              <caption className="sr-only">
                The arithmetic behind this quote: amount in, fee, rate, spread and the amount the
                beneficiary receives.
              </caption>
              <thead>
                <tr className="border-b border-border">
                  <th className={TH_CLASS} scope="col">
                    Line
                  </th>
                  <th className={`${TH_CLASS} text-right`} scope="col">
                    Figure
                  </th>
                </tr>
              </thead>
              <tbody>
                {quote.arithmetic.map((row) => (
                  <tr
                    key={row.label}
                    className={
                      row.emphasis === true
                        ? "border-t border-border-strong"
                        : "border-t border-border"
                    }
                  >
                    <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                      <span
                        className={row.emphasis === true ? "text-sm font-medium" : "text-sm"}
                      >
                        {row.label}
                      </span>
                      <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">
                        {row.note}
                      </p>
                    </th>
                    <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
                      <span
                        className={`money ${row.emphasis === true ? "text-sm font-medium" : "text-sm"}`}
                      >
                        {row.value}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>

          <MetaList
            items={[
              { label: "raised", value: formatTimestamp(quote.createdAt) },
              { label: "by", value: quote.createdByName },
              {
                label: "rate as of",
                value: `${quote.rate.rateDate}${
                  quote.rate.ageDays === null || quote.rate.ageDays === 0
                    ? ""
                    : ` · ${quote.rate.ageDays}d old`
                }`,
              },
              {
                label: "source said",
                value: (
                  <span className="money">
                    {quote.rate.literal}
                    {quote.rate.httpStatus === null ? "" : ` · HTTP ${quote.rate.httpStatus}`}
                  </span>
                ),
              },
              {
                label: "spread worth",
                value: <span className="money">{quote.spreadValueLabel}</span>,
              },
            ]}
          />
        </div>
      </Panel>

      {quote.acceptedAt === null ? null : (
        <Panel
          id="commitment"
          title="The commitment"
          description="What we agreed, when, and how long we are on the hook for it."
        >
          <div className="space-y-4 px-5 py-4">
            <MetaList
              items={[
                { label: "accepted", value: formatTimestamp(quote.acceptedAt) },
                { label: "by", value: quote.acceptedByName ?? "—" },
                {
                  label: "with",
                  value:
                    quote.acceptedWithSecondsToSpare === null
                      ? "—"
                      : `${quote.acceptedWithSecondsToSpare}s to spare`,
                },
                {
                  label: "reference",
                  value: quote.acceptanceReference ?? "none given",
                },
                {
                  label: "settle by",
                  value: quote.settleBy === null ? "—" : formatTimestamp(quote.settleBy),
                },
              ]}
            />

            <Note title="What we are committed to, and who eats the difference">
              <p>
                The beneficiary receives <span className="money">{quote.buyLabel}</span>. The
                customer pays <span className="money">{quote.sellLabel}</span>. Neither number
                moves again, whatever USD/{quote.buyCurrency} does between now and settlement.
              </p>
              <p className="mt-2">
                We hold that risk unhedged, so the difference is <strong>ours</strong> — a gain
                when the move goes our way and a loss when it does not. It is measured at
                settlement as <code>amount in − fee − what the delivery cost</code>,{" "}
                <code>fx_quote_settlement.variance_cents</code> records it, and at settlement it
                posts to <code>4300 FX quote settlement variance</code> — credited when the move
                goes our way, debited when it does not.
              </p>
            </Note>

            {quote.position === null ? null : (
              <Panel
                as="h3"
                title="Against the market, right now"
                description="Read from the rate source at page load. A read, not a check: nothing was written and nobody was billed."
                actions={<RateEvidenceBadge evidence={quote.position.evidence} />}
              >
                <div className="px-5 py-4">
                  <MetaList
                    items={[
                      {
                        label: "mid when quoted",
                        value: <span className="money">{quote.midRateLabel}</span>,
                      },
                      {
                        label: "mid now",
                        value: <span className="money">{quote.position.currentMidLabel}</span>,
                      },
                      {
                        label: "delivery would cost",
                        value: (
                          <span className="money">{quote.position.settlementCostLabel}</span>
                        ),
                      },
                      {
                        label: "our position",
                        value: (
                          <span
                            className={`money ${
                              quote.position.varianceIsLoss ? "money-negative" : "money-positive"
                            }`}
                          >
                            {quote.position.varianceLabel}
                          </span>
                        ),
                      },
                    ]}
                  />
                  <p className="mt-3 max-w-prose text-[11px] leading-relaxed text-muted">
                    {quote.position.varianceIsLoss
                      ? "The destination currency has strengthened since the quote. Honouring the commitment now costs more than the customer paid us, and the difference comes out of the house."
                      : "The move has gone our way. We keep the difference on top of the spread — which is the same arrangement, in the direction nobody complains about."}
                  </p>
                </div>
              </Panel>
            )}
          </div>
        </Panel>
      )}

      {quote.settledAt === null ? null : (
        <Panel
          id="settlement"
          title="Settlement"
          description="Written after a receipt came back, never after a broadcast."
        >
          <div className="px-5 py-4">
            <MetaList
              items={[
                { label: "settled", value: formatTimestamp(quote.settledAt) },
                {
                  label: "tx",
                  value: <span className="money">{quote.txHash ?? "—"}</span>,
                },
                {
                  label: "delivery cost",
                  value: <span className="money">{quote.settlementCostLabel ?? "—"}</span>,
                },
                {
                  label: "variance",
                  value: (
                    <span
                      className={`money ${
                        quote.varianceIsLoss === true ? "money-negative" : "money-positive"
                      }`}
                    >
                      {quote.varianceLabel ?? "—"}
                    </span>
                  ),
                },
              ]}
            />
            {quote.settlementEntryId === null ? (
              <p className="mt-3 max-w-prose text-[11px] leading-relaxed text-muted">
                The variance above is <strong>recorded but not posted</strong>: this settlement
                carries no <code>entry_id</code>, so there is no journal entry behind it. On a
                screen fixture that is expected. On a live row it is a break, and the figure above
                is a statement about a commitment rather than about the book.{" "}
                <Badge tone="quiet">unposted</Badge>
              </p>
            ) : (
              <p className="mt-3 max-w-prose text-[11px] leading-relaxed text-muted">
                Posted. The variance above is on the journal as{" "}
                <code>4300 FX quote settlement variance</code> — one signed account, credited when
                the move goes our way and debited when it does not, kept out of{" "}
                <code>4200</code> because a disclosed fee and an unhedged market loss are different
                facts. The USDC that left is credited to <code>1140</code> in whole cents and the
                sub-cent conversion residual to <code>2900</code>, which is why the entry balances
                to zero with nothing unowned. Entry{" "}
                <span className="money">{quote.settlementEntryId}</span>.{" "}
                <Badge tone="neutral">posted</Badge>
              </p>
            )}
          </div>
        </Panel>
      )}
    </div>
  );
}
