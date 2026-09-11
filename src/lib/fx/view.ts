/**
 * One quote, from the facts to the characters a screen renders.
 *
 * ── WHY THIS IS A MODULE AND NOT A FUNCTION INSIDE `screen.ts` ──────────────
 *
 * Two things build a `QuoteView`: the live source, which reads `v_fx_quote`,
 * and the fixtures that serve four of the screen's five demo states. If the
 * mapping lived in `screen.ts` — which is `server-only` — the fixtures would
 * have to hand-type every figure, and a fixture whose own arithmetic does not
 * add up teaches a viewer the wrong thing about the feature being
 * demonstrated. It is also exactly the sort of wrong that survives for months,
 * because nobody re-checks a mock.
 *
 * So the mapping is pure and lives here, both callers use it, and the demo
 * states are priced by the same four formulas as the live one.
 *
 * ── EVERY MONEY FIGURE LEAVES HERE AS A STRING ──────────────────────────────
 *
 * Money is `bigint` cents and rates are `bigint` scaled by 10^8, and neither
 * survives the trip to a browser as itself. The server formats; the browser
 * renders characters and multiplies nothing. See
 * `src/components/payouts/data-contract.ts`.
 */

import type { ArithmeticRow, QuoteView } from "@/components/payouts/data-contract";
import { formatUsd } from "@/lib/format/money";

import { costCents, formatBps, formatMinorUnits, formatRate } from "./quote";
import { rateAgeDays } from "./rate";
import type { QuoteState, RateEvidence } from "./types";

/**
 * Everything a view needs about one quote.
 *
 * Structurally satisfied by `QuoteRecord` in ./store.ts, deliberately without
 * importing it: that module is `server-only`, and a pure mapping that drags a
 * database handle into its type graph is a pure mapping in name only.
 */
export interface QuoteFacts {
  readonly quoteRef: string;
  readonly businessName: string;
  readonly beneficiaryRef: string;
  readonly destinationAddress: string | null;
  readonly rail: string;
  readonly state: QuoteState;

  readonly sellCents: bigint;
  readonly feeFlatCents: bigint;
  readonly feeBps: number;
  readonly feeCents: bigint;
  readonly netCents: bigint;

  readonly spreadBps: number;
  readonly midRateScaled: bigint;
  readonly customerRateScaled: bigint;
  readonly rateScale: bigint;

  readonly buyCurrency: string;
  readonly buyExponent: number;
  readonly buyMinor: bigint;

  readonly rateSource: string;
  readonly rateEvidence: RateEvidence;
  readonly rateLiteral: string;
  readonly rateDate: string;
  readonly rateHttpStatus: number | null;

  readonly createdAt: string;
  readonly createdByName: string;
  readonly expiresAt: string;
  readonly expiresInSeconds: bigint;
  readonly settlementWindowSeconds: number;

  readonly acceptedAt: string | null;
  readonly acceptedByName: string | null;
  readonly acceptanceReference: string | null;
  readonly acceptedWithSecondsToSpare: bigint | null;
  readonly settleBy: string | null;

  readonly settledAt: string | null;
  readonly txHash: string | null;
  readonly settlementMidRateScaled: bigint | null;
  readonly settlementCostCents: bigint | null;
  readonly varianceCents: bigint | null;
}

/** A signed USD figure with its sign shown. Deltas need the sign; totals do not. */
export function signedUsd(cents: bigint): string {
  return `${cents > 0n ? "+" : ""}${formatUsd(cents)}`;
}

/**
 * What our spread is worth on this quote, in US cents.
 *
 * The converted amount, less what the same delivery would have cost at the
 * MID. A basis-point number the customer has to apply themselves is not a
 * disclosure; a dollar figure is.
 */
export function spreadValueCents(facts: QuoteFacts): bigint {
  return (
    facts.netCents -
    costCents({
      buyMinor: facts.buyMinor,
      rateScaled: facts.midRateScaled,
      rateScale: facts.rateScale,
      buyExponent: facts.buyExponent,
    })
  );
}

/**
 * The breakdown, in the order a person reads it.
 *
 * Written as a list rather than as markup so the wording of every disclosure
 * lives in one place and can be read end to end. Two of these rows are ones a
 * customer is normally not shown:
 *
 *   THE MID, with the literal characters the source printed and the date the
 *   source put on them, so the spread can be checked rather than believed.
 *
 *   THE SPREAD, as its own line. A provider quoting "no fees" is taking its
 *   margin inside the rate, where nobody can see it without knowing the mid.
 */
export function arithmeticRows(facts: QuoteFacts): readonly ArithmeticRow[] {
  const delivery = formatMinorUnits(facts.buyMinor, facts.buyExponent, facts.buyCurrency);
  const midLabel = formatRate(facts.midRateScaled, facts.rateScale, { minDecimals: 4 });
  const customerLabel = formatRate(facts.customerRateScaled, facts.rateScale, { minDecimals: 4 });

  return [
    {
      label: "Amount in",
      value: formatUsd(facts.sellCents),
      note: "What leaves the customer's account. This figure is the commitment on our side of the trade and it does not move afterwards.",
    },
    {
      label: "Fee",
      value: `− ${formatUsd(facts.feeCents)}`,
      note: `${formatUsd(facts.feeFlatCents)} flat plus ${formatBps(facts.feeBps)} of the amount, rounded up to the cent. Rounding a fee up is in our favour, by at most one cent.`,
    },
    {
      label: "Converted",
      value: formatUsd(facts.netCents),
      emphasis: true,
      note: "What is actually exchanged, after our fee. Everything below is computed from this number and not from the amount in.",
    },
    {
      label: `Mid rate USD/${facts.buyCurrency}`,
      value: midLabel,
      note:
        facts.rateEvidence === "live"
          ? `Measured. ${facts.rateSource} printed “${facts.rateLiteral}” for ${facts.rateDate}${facts.rateHttpStatus === null ? "" : `, HTTP ${facts.rateHttpStatus}`}. A daily reference rate, not a dealable price — nobody trades at the mid.`
          : `SIMULATED. This came from the built-in fallback table, recorded on ${facts.rateDate}, because the live source could not be reached. It is not a market rate.`,
    },
    {
      label: "Our spread",
      value: `− ${formatBps(facts.spreadBps)}`,
      note: "Taken off the mid, rounded down. This is the charge that normally hides inside an FX rate; it is shown here as its own line, with the mid it was taken from printed above it.",
    },
    {
      label: "Your rate",
      value: customerLabel,
      emphasis: true,
      note: `The rate the customer is offered, and the rate they get if they accept — even if the market has moved by the time it settles. ${formatUsd(facts.netCents)} × ${customerLabel} is what follows.`,
    },
    {
      label: "Beneficiary receives",
      value: delivery,
      emphasis: true,
      note: `Rounded down to the ${facts.buyCurrency} minor unit: a fraction of one cannot be delivered by anybody, and rounding up would commit us to money we did not buy. THIS is the number the customer is committed to.`,
    },
  ];
}

/**
 * The whole view, from the facts.
 *
 * `now` is passed rather than read, so a render is a pure function of its
 * inputs and a fixture is byte-reproducible — the same rule
 * `src/lib/format/datetime.ts` states for ages.
 *
 * `position` is left null here and filled in by the live source for the
 * focused quote only: it needs a current rate, and a list of twenty rows must
 * not make twenty outbound calls.
 */
export function quoteView(facts: QuoteFacts, now: string): QuoteView {
  const ttlSeconds = Math.max(
    0,
    Math.round((Date.parse(facts.expiresAt) - Date.parse(facts.createdAt)) / 1000),
  );

  return {
    quoteRef: facts.quoteRef,
    businessName: facts.businessName,
    beneficiaryRef: facts.beneficiaryRef,
    destinationAddress: facts.destinationAddress,
    rail: facts.rail,
    state: facts.state,

    sellLabel: formatUsd(facts.sellCents),
    feeLabel: formatUsd(facts.feeCents),
    netLabel: formatUsd(facts.netCents),
    midRateLabel: formatRate(facts.midRateScaled, facts.rateScale, { minDecimals: 4 }),
    customerRateLabel: formatRate(facts.customerRateScaled, facts.rateScale, { minDecimals: 4 }),
    spreadLabel: formatBps(facts.spreadBps),
    spreadValueLabel: formatUsd(spreadValueCents(facts)),
    buyLabel: formatMinorUnits(facts.buyMinor, facts.buyExponent, facts.buyCurrency),
    buyCurrency: facts.buyCurrency,

    arithmetic: arithmeticRows(facts),
    rate: {
      source: facts.rateSource,
      evidence: facts.rateEvidence,
      literal: facts.rateLiteral,
      rateDate: facts.rateDate,
      ageDays: rateAgeDays(facts.rateDate, now),
      httpStatus: facts.rateHttpStatus,
      // A stored quote does not carry the fallback reason: the reason belongs
      // to the moment of the fetch and lives on the observation. What the
      // screen needs from a quote is the LABEL, which `evidence` is.
      fallbackReason: null,
    },

    createdAt: facts.createdAt,
    createdByName: facts.createdByName,
    expiresAt: facts.expiresAt,
    expiresInSeconds: Number(facts.expiresInSeconds),
    ttlSeconds,

    acceptedAt: facts.acceptedAt,
    acceptedByName: facts.acceptedByName,
    acceptanceReference: facts.acceptanceReference,
    acceptedWithSecondsToSpare:
      facts.acceptedWithSecondsToSpare === null ? null : Number(facts.acceptedWithSecondsToSpare),
    settleBy: facts.settleBy,
    settlementWindowSeconds: facts.settlementWindowSeconds,

    settledAt: facts.settledAt,
    txHash: facts.txHash,
    settlementCostLabel:
      facts.settlementCostCents === null ? null : formatUsd(facts.settlementCostCents),
    varianceLabel: facts.varianceCents === null ? null : signedUsd(facts.varianceCents),
    varianceIsLoss: facts.varianceCents === null ? null : facts.varianceCents < 0n,

    position: null,
  };
}
