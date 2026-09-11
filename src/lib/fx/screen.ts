import "server-only";

/**
 * The payouts screen's data source, against the live database.
 *
 * The other side of `src/components/payouts/data-contract.ts`. Everything the
 * screen shows comes through here, and the screen imports nothing else from
 * this directory — the same seam `src/lib/payees/screen.ts` and
 * `src/lib/standing/screen.ts` maintain, for the same reason: a component that
 * can open a connection is a component that eventually does.
 *
 * ── WHAT RENDERING DOES AND DOES NOT DO ─────────────────────────────────────
 *
 * IT RAISES NOTHING AND COMMITS NOTHING. Re-rendering this page a hundred
 * times produces a hundred identical reads, zero quotes and zero acceptances.
 * Raising a quote is an operator action with an actor attached and an
 * append-only row at the end of it; a render is not one.
 *
 * IT DOES MAKE ONE OUTBOUND CALL, IN ONE CASE, AND THE DISTINCTION IS WORTH
 * BEING EXACT ABOUT. When a quote is in focus, accepted and unsettled, the
 * page asks the rate source what the mid is NOW, so it can show what honouring
 * that commitment would cost today. That is a read of a free, keyless, public
 * endpoint: it writes nothing, bills nothing and creates no record, which is
 * exactly why it is allowed here when the payee screen's provider checks are
 * not — those write a row and put a timestamp on a claim. And it is the single
 * most useful thing this screen can show: the customer's number has not moved,
 * and ours has.
 *
 * The book listing makes no such call. Nothing happens on the default view but
 * one query.
 */

import type {
  ArithmeticRow,
  PayoutsDataSource,
  PayoutsView,
  QuoteView,
  RateSourceView,
} from "@/components/payouts/data-contract";
import { formatUsd } from "@/lib/format/money";
import { sql, type Sql } from "@/lib/ledger/db";
import { fail, ok, type ErrorShape, type Result } from "@/lib/result";

import { commitmentPosition } from "./gate";
import { costCents, formatBps, formatMinorUnits, formatRate } from "./quote";
import { frankfurterUrl, observeRate, rateAgeDays } from "./rate";
import { loadBusinesses, loadQuotes, type QuoteRecord } from "./store";
import {
  CORRIDORS,
  DEFAULT_FEE_BPS,
  DEFAULT_FEE_FLAT_CENTS,
  DEFAULT_QUOTE_TTL_SECONDS,
  DEFAULT_SETTLEMENT_WINDOW_SECONDS,
  DEFAULT_SPREAD_BPS,
  type RateObservation,
} from "./types";

/** A signed USD figure with its sign shown. Deltas need the sign; totals do not. */
function signedUsd(cents: bigint): string {
  return `${cents > 0n ? "+" : ""}${formatUsd(cents)}`;
}

function rateView(quote: QuoteRecord, now: string): RateSourceView {
  return {
    source: quote.rateSource,
    evidence: quote.rateEvidence,
    literal: quote.rateLiteral,
    rateDate: quote.rateDate,
    ageDays: rateAgeDays(quote.rateDate, now),
    httpStatus: quote.rateHttpStatus,
    // The quote row does not carry the fallback reason — the reason belongs to
    // the moment of the fetch and is on the observation. What the screen needs
    // from a stored quote is the LABEL, which `evidence` is.
    fallbackReason: null,
  };
}

/**
 * The breakdown, in the order a person reads it.
 *
 * Built on the server because the browser must never multiply money, and
 * written as a list rather than a component so the wording of every
 * disclosure lives in one place and can be read end to end.
 */
function arithmeticRows(quote: QuoteRecord): readonly ArithmeticRow[] {
  const delivery = formatMinorUnits(quote.buyMinor, quote.buyExponent, quote.buyCurrency);
  const midLabel = formatRate(quote.midRateScaled, quote.rateScale, { minDecimals: 4 });
  const customerLabel = formatRate(quote.customerRateScaled, quote.rateScale, { minDecimals: 4 });

  return [
    {
      label: "Amount in",
      value: formatUsd(quote.sellCents),
      note: "What leaves the customer's account. This figure is the commitment on our side of the trade and it does not move afterwards.",
    },
    {
      label: "Fee",
      value: `− ${formatUsd(quote.feeCents)}`,
      note: `${formatUsd(quote.feeFlatCents)} flat plus ${formatBps(quote.feeBps)} of the amount, rounded up to the cent. Rounding a fee up is in our favour, by at most one cent.`,
    },
    {
      label: "Converted",
      value: formatUsd(quote.netCents),
      emphasis: true,
      note: "What is actually exchanged, after our fee. Everything below is computed from this number and not from the amount in.",
    },
    {
      label: `Mid rate USD/${quote.buyCurrency}`,
      value: midLabel,
      note:
        quote.rateEvidence === "live"
          ? `Measured. ${quote.rateSource} printed “${quote.rateLiteral}” for ${quote.rateDate}${quote.rateHttpStatus === null ? "" : `, HTTP ${quote.rateHttpStatus}`}. A daily reference rate, not a dealable price — nobody trades at the mid.`
          : `SIMULATED. This came from the built-in fallback table, recorded on ${quote.rateDate}, because the live source could not be reached. It is not a market rate.`,
    },
    {
      label: "Our spread",
      value: `− ${formatBps(quote.spreadBps)}`,
      note: "Taken off the mid, rounded down. This is the charge that normally hides inside an FX rate; it is shown here as its own line, with the mid it was taken from printed above it.",
    },
    {
      label: "Your rate",
      value: customerLabel,
      emphasis: true,
      note: `The rate the customer is offered, and the rate they get if they accept — even if the market has moved by the time it settles. ${formatUsd(quote.netCents)} × ${customerLabel} is what follows.`,
    },
    {
      label: "Beneficiary receives",
      value: delivery,
      emphasis: true,
      note: `Rounded down to the ${quote.buyCurrency} minor unit: a fraction of one cannot be delivered by anybody, and rounding up would commit us to money we did not buy. THIS is the number the customer is committed to.`,
    },
  ];
}

function toView(quote: QuoteRecord, now: string): QuoteView {
  const ttlSeconds = Math.max(
    0,
    Math.round((Date.parse(quote.expiresAt) - Date.parse(quote.createdAt)) / 1000),
  );

  return {
    quoteRef: quote.quoteRef,
    businessName: quote.businessName,
    beneficiaryRef: quote.beneficiaryRef,
    destinationAddress: quote.destinationAddress,
    rail: quote.rail,
    state: quote.state,

    sellLabel: formatUsd(quote.sellCents),
    feeLabel: formatUsd(quote.feeCents),
    netLabel: formatUsd(quote.netCents),
    midRateLabel: formatRate(quote.midRateScaled, quote.rateScale, { minDecimals: 4 }),
    customerRateLabel: formatRate(quote.customerRateScaled, quote.rateScale, { minDecimals: 4 }),
    spreadLabel: formatBps(quote.spreadBps),
    // What our spread is worth on THIS quote, in dollars: the converted
    // amount less what the delivery would have cost at the mid. A basis-point
    // number the customer has to apply themselves is not a disclosure.
    spreadValueLabel: formatUsd(
      quote.netCents -
        costCents({
          buyMinor: quote.buyMinor,
          rateScaled: quote.midRateScaled,
          rateScale: quote.rateScale,
          buyExponent: quote.buyExponent,
        }),
    ),
    buyLabel: formatMinorUnits(quote.buyMinor, quote.buyExponent, quote.buyCurrency),
    buyCurrency: quote.buyCurrency,

    arithmetic: arithmeticRows(quote),
    rate: rateView(quote, now),

    createdAt: quote.createdAt,
    createdByName: quote.createdByName,
    expiresAt: quote.expiresAt,
    expiresInSeconds: Number(quote.expiresInSeconds),
    ttlSeconds,

    acceptedAt: quote.acceptedAt,
    acceptedByName: quote.acceptedByName,
    acceptanceReference: quote.acceptanceReference,
    acceptedWithSecondsToSpare:
      quote.acceptedWithSecondsToSpare === null ? null : Number(quote.acceptedWithSecondsToSpare),
    settleBy: quote.settleBy,
    settlementWindowSeconds: quote.settlementWindowSeconds,

    settledAt: quote.settledAt,
    txHash: quote.txHash,
    settlementCostLabel:
      quote.settlementCostCents === null ? null : formatUsd(quote.settlementCostCents),
    varianceLabel: quote.varianceCents === null ? null : signedUsd(quote.varianceCents),
    varianceIsLoss: quote.varianceCents === null ? null : quote.varianceCents < 0n,

    // Filled in by the caller for the focus quote only. A list of twenty rows
    // must not make twenty outbound calls.
    position: null,
  };
}

/**
 * Ask what the mid is now, for a commitment we are still on the hook for.
 *
 * `observeRate` never throws: a source that is down produces a labelled
 * simulated reading, and the screen prints the label. A payouts screen that
 * 500s because a free rate feed is having an afternoon would be a worse
 * answer than one that says, in words, that it could not reach the source.
 */
async function withPosition(view: QuoteView, quote: QuoteRecord): Promise<QuoteView> {
  if (quote.state !== "accepted") return view;

  let observed: RateObservation;
  try {
    observed = await observeRate(quote.buyCurrency);
  } catch {
    return view;
  }

  const position = commitmentPosition(quote, observed.rateScaled, observed.rateScale);
  return {
    ...view,
    position: {
      currentMidLabel: position.currentMidLabel,
      settlementCostLabel: formatUsd(position.settlementCostCents),
      varianceLabel: signedUsd(position.varianceCents),
      varianceIsLoss: position.varianceCents < 0n,
      evidence: observed.evidence,
    },
  };
}

/** The live source. Failure is a value; the screen renders the error state. */
export function livePayoutsSource(conn: Sql = sql): PayoutsDataSource {
  return {
    load: async (filter = {}): Promise<Result<PayoutsView, ErrorShape>> => {
      const asOf = new Date().toISOString();
      try {
        const [quotes, businesses] = await Promise.all([
          loadQuotes(
            {
              ...(filter.businessId === undefined ? {} : { businessId: filter.businessId }),
              limit: 25,
            },
            conn,
          ),
          loadBusinesses(conn),
        ]);

        const rows = quotes.map((quote) => toView(quote, asOf));

        const focusIndex =
          filter.quoteRef === undefined
            ? -1
            : quotes.findIndex((q) => q.quoteRef === filter.quoteRef);
        const focusQuote = focusIndex >= 0 ? quotes[focusIndex] : undefined;
        const focusView = focusIndex >= 0 ? rows[focusIndex] : undefined;

        const focus =
          focusQuote === undefined || focusView === undefined
            ? null
            : await withPosition(focusView, focusQuote);

        return ok({
          asOf,
          source: "live",
          rateEndpoint: frankfurterUrl(),
          businesses: businesses.map((b) => ({
            businessId: b.businessId,
            legalName: b.legalName,
          })),
          corridors: CORRIDORS.map((c) => ({
            currency: c.currency,
            name: c.name,
            destination: c.destination,
            exponent: c.exponent,
          })),
          focus,
          rows,
          terms: {
            feeFlatLabel: formatUsd(DEFAULT_FEE_FLAT_CENTS),
            feeBpsLabel: formatBps(DEFAULT_FEE_BPS),
            spreadBpsLabel: formatBps(DEFAULT_SPREAD_BPS),
            ttlSeconds: DEFAULT_QUOTE_TTL_SECONDS,
            settlementWindowSeconds: DEFAULT_SETTLEMENT_WINDOW_SECONDS,
          },
        });
      } catch (error) {
        return fail(
          "FX_QUOTE_BOOK_UNAVAILABLE",
          "The quote book could not be read. No quote was raised, nothing was committed and " +
            "nothing was written — this screen only reads.",
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
    },
  };
}
