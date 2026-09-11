import { Badge, MetaList, Note, Panel } from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";
import { isErr } from "@/lib/result";

import type { PayoutsDataSource } from "./data-contract";
import { PayoutErrorPanel } from "./PayoutErrorPanel";
import { PayoutSkeleton } from "./PayoutSkeleton";
import { QuoteDetail } from "./QuoteDetail";
import { AcceptQuoteForm, RequestQuoteForm, SendPayoutForm } from "./QuoteForms";
import { QuoteTable } from "./QuoteTable";
import type { PayoutFilter } from "./view-state";

export { PayoutSkeleton };

/**
 * The payouts screen.
 *
 * An async server component behind the page's Suspense boundary, so the
 * skeleton is a real fallback rather than a mock. It reads through
 * `PayoutsDataSource` and knows nothing about where the rows come from — live
 * query or fixture — except for the one thing it always shows: which of the
 * two it is looking at.
 *
 * IT RAISES NO QUOTE AND ACCEPTS NOTHING. Both are operator actions with an
 * actor attached and an append-only row at the end; a render is not one.
 */
export async function PayoutsView({
  source,
  filter,
}: {
  readonly source: PayoutsDataSource;
  readonly filter: PayoutFilter;
}) {
  const result = await source.load({
    ...(filter.quoteRef === null ? {} : { quoteRef: filter.quoteRef }),
    ...(filter.businessId === null ? {} : { businessId: filter.businessId }),
  });

  if (isErr(result)) {
    return (
      <div className="space-y-6">
        <Header />
        <PayoutErrorPanel error={result.error} />
      </div>
    );
  }

  const view = result.value;
  const fixture = view.source === "fixture";
  const focus = view.focus;

  const committed = view.rows.filter((r) => r.state === "accepted").length;
  const simulated = view.rows.filter((r) => r.rate.evidence === "simulated").length;

  return (
    <div className="space-y-6">
      <Header />

      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <MetaList
          items={[
            { label: "quotes", value: String(view.rows.length) },
            { label: "live commitments", value: String(committed) },
            { label: "priced off the fallback", value: String(simulated) },
            { label: "read", value: formatTimestamp(view.asOf) },
          ]}
        />
        <Badge tone={view.source === "live" ? "neutral" : "quiet"}>
          {view.source === "live" ? "LIVE DATABASE" : "FIXTURE DATA"}
        </Badge>
      </div>

      {fixture ? (
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          These rows are a fixture. Either a demo state other than <code>default</code> is
          selected, or no database is configured — see the state bar above. Nothing on this screen
          is a statement about a real quote, and the forms are disabled so a fixture cannot be
          mistaken for a commitment.
        </p>
      ) : null}

      {/*
        The claims this screen makes loudest are the two limitations, at the
        top, on every state. A cross-border payout screen misleads people in
        exactly two ways: by implying the rate is a price somebody will trade
        at, and by implying there is a partner at the far end who will hand
        over pesos. Neither is true here, and neither is buried.
      */}
      <Note title="What is real on this screen, and what is not">
        <p>
          <strong>The mid rate is live and the spread is ours.</strong> It comes from{" "}
          <code>{view.rateEndpoint}</code> — the European Central Bank&rsquo;s daily reference
          rates, republished, no key and no signup. That call is real and its status code is on
          every quote. It is <em>not</em> a dealable price: the ECB publishes once per working day
          and nobody will trade with you at the mid, so what the customer is offered is that live
          mid less a spread we set and print as its own line. When the source cannot be reached, a
          built-in fallback table answers, every quote it prices is marked{" "}
          <strong>SIMULATED</strong>, and it is never dressed up as a market rate.
        </p>
        <p className="mt-2">
          <strong>There is no off-ramp partner, and the last mile is not built.</strong> The USDC
          leg is real and confirms on Base Sepolia. The step after it — somebody in Mexico handing
          the beneficiary pesos — needs a licensed partner this build does not have. So the
          delivery amount on every quote is a <em>commitment</em>, priced and recorded honestly,
          and nothing on this screen claims a peso has ever moved.
        </p>
        <p className="mt-2">
          <strong>The ledger stays in USD cents throughout.</strong> A quote is not a second
          currency in the books: no journal line is written by anything on this page, the only
          non-USD number in the database is the delivery amount on the quote row, and it is never
          summed with a dollar.
        </p>
      </Note>

      <div className="grid gap-6 lg:grid-cols-2">
        <RequestQuoteForm
          businesses={view.businesses}
          corridors={view.corridors}
          terms={view.terms}
          disabled={fixture}
        />

        {focus === null ? (
          <Panel
            title="No quote in focus"
            description="Raise one on the left, or pick a reference from the book below."
          >
            <div className="px-5 py-4">
              <p className="max-w-prose text-xs leading-relaxed text-muted">
                An offer stands for {view.terms.ttlSeconds} seconds. Accepting it fixes the
                delivery amount for the next{" "}
                {Math.round(view.terms.settlementWindowSeconds / 3600)} hours, whatever the market
                does — and a payout with no accepted, unexpired quote behind it is refused by the
                gate with its own code.
              </p>
            </div>
          </Panel>
        ) : (
          <div className="space-y-6">
            {focus.state === "open" ? (
              <AcceptQuoteForm quote={focus} disabled={fixture} />
            ) : null}
            {focus.state === "accepted" ? (
              <SendPayoutForm quote={focus} disabled={fixture} />
            ) : null}
            {focus.state === "expired" ? (
              <Panel
                title="2 · Accept the rate"
                description="This offer has lapsed. Accepting it is refused by the database, not by a disabled button."
              >
                <div className="space-y-4 px-5 py-4">
                  <Note emphasis title="Too late — the rate you were looking at is gone">
                    <p>
                      {focus.quoteRef} expired at {formatTimestamp(focus.expiresAt)} without being
                      accepted. We committed to nothing and the customer lost nothing, which is
                      what an expiry is for.
                    </p>
                    <p className="mt-2">
                      An acceptance sent now does not get a polite client-side message — it
                      reaches the database and{" "}
                      <code>fx_quote_acceptance_guard()</code> raises, because the trigger reads
                      the quote&rsquo;s own <code>expires_at</code> against the transaction clock.
                      That is also what closes the race a pre-check cannot: between reading the
                      expiry and writing the row, an offer can lapse.
                    </p>
                    <p className="mt-2">
                      The expired quote stays on file forever — nothing here is edited or deleted
                      — and the remedy is one click. Request a new quote on the left.
                    </p>
                  </Note>
                  <AcceptQuoteForm quote={focus} disabled={fixture} />
                </div>
              </Panel>
            ) : null}
            {focus.state === "lapsed" || focus.state === "settled" ? (
              <Panel
                title={focus.state === "settled" ? "3 · Sent" : "The commitment lapsed"}
                description={
                  focus.state === "settled"
                    ? "This quote has funded its one payout. A second transfer needs a second quote."
                    : "Accepted, then not sent inside the settlement window the offer named."
                }
              >
                <div className="px-5 py-4">
                  <p className="max-w-prose text-xs leading-relaxed text-muted">
                    {focus.state === "settled"
                      ? "The gate refuses a second payout against this reference — quote_id is the primary key of the settlement table, so one accepted rate funds one transfer and the database is what enforces it."
                      : "We held the rate for the whole window we named and the payout did not arrive. The gate now refuses it with FX_QUOTE_COMMITMENT_LAPSED, which is a different fact from an expired offer and gets a different code for that reason."}
                  </p>
                </div>
              </Panel>
            ) : null}
          </div>
        )}
      </div>

      {focus === null ? null : <QuoteDetail quote={focus} />}

      <Panel
        title="The quote book"
        description="Append-only, newest first. Expired quotes stay here exactly as long as accepted ones — the state is derived from whether an acceptance row exists and when, never stored."
      >
        {view.rows.length === 0 ? (
          <div className="px-5 py-8">
            <p className="text-sm">No quote has been raised.</p>
            <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
              Nothing to show, and nothing wrong. A quote appears here the moment somebody asks
              for a price — accepted or not, taken or lapsed.
            </p>
          </div>
        ) : (
          <QuoteTable rows={view.rows} state={filter.state} selected={filter.quoteRef} />
        )}
      </Panel>
    </div>
  );
}

function Header() {
  return (
    <div>
      <h1 className="text-lg font-semibold tracking-tight">Cross-border payouts</h1>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
        A USD balance, a USDC rail, and a beneficiary who needs to be paid in something else. The
        customer agrees a price before any of it moves, and the rate they saw is the rate they
        get — which means somebody carries the market between those two moments. This screen shows
        who, and how much.
      </p>
    </div>
  );
}
