/**
 * The payouts screen without a database and without a rate source.
 *
 * Four of the five demo states are served from here, so they can be shown in
 * order in front of a panel without raising a quote, writing a row or making
 * an outbound call. Every figure is LABELLED AS A FIXTURE on the screen itself
 * — `source: "fixture"` drives a badge, a sentence, and disabled forms — and
 * nothing here is ever presented as a statement about a real quote.
 *
 * ── NOT ONE NUMBER BELOW IS TYPED BY HAND ───────────────────────────────────
 *
 * Every fixture states its TERMS — an amount, a rate literal, a corridor — and
 * the figures are produced by `priceQuote()` and `quoteView()`, the same
 * functions the live screen uses and the same four formulas the database
 * generates its commitments from.
 *
 * That is the whole reason this file is arranged this way. A fixture with
 * hand-typed money in it is a fixture whose arithmetic can be wrong, and
 * because it is a mock nobody re-checks it — so it stays wrong, and it teaches
 * every viewer the wrong thing about the feature being demonstrated. Here a
 * delivery amount that did not follow from the rate beside it is not
 * expressible.
 *
 * The rate literals are the real ones Frankfurter printed on 2026-09-10,
 * measured from the live endpoint. They are stale by construction and the
 * screen says so.
 */

import { formatUsd } from "@/lib/format/money";
import { costCents, formatRate, priceQuote, settlementVariance } from "@/lib/fx/quote";
import { RATE_SCALE, type QuoteState, type RateEvidence } from "@/lib/fx/types";
import { quoteView, signedUsd, type QuoteFacts } from "@/lib/fx/view";
import { err, ok, type Result } from "@/lib/result";

import type { PayoutsDataSource, PayoutsView, QuoteView } from "./data-contract";
import type { DemoState } from "./view-state";

/** A fixed instant, so two renders of a fixture are byte-identical. */
const AS_OF = "2026-09-10T18:20:00.000Z";

const FEE_FLAT = 100n;
const FEE_BPS = 25;
const SPREAD_BPS = 50;
const TTL_SECONDS = 120;
const WINDOW_SECONDS = 86_400;

function at(offsetSeconds: number): string {
  return new Date(Date.parse(AS_OF) + offsetSeconds * 1000).toISOString();
}

/** A rate literal to the scaled integer, by the same string surgery `rate.ts` uses. */
function scaled(literal: string): bigint {
  const [whole = "0", fraction = ""] = literal.split(".");
  return BigInt(`${whole}${fraction.padEnd(8, "0").slice(0, 8)}`);
}

type Terms = {
  readonly quoteRef: string;
  readonly businessName: string;
  readonly beneficiaryRef: string;
  readonly destinationAddress?: string | null;
  readonly sellCents: bigint;
  readonly currency: string;
  readonly literal: string;
  readonly evidence?: RateEvidence;
  readonly state: QuoteState;
  /** Seconds relative to AS_OF. Negative is in the past. */
  readonly createdOffset: number;
  readonly acceptedOffset?: number;
  readonly acceptanceReference?: string;
  readonly settledOffset?: number;
  readonly txHash?: string;
  /** The mid at settlement, for a settled quote. The whole point is that it differs. */
  readonly settlementLiteral?: string;
};

/**
 * Terms to a rendered view, through the real arithmetic.
 *
 * `priceQuote` produces the commitment exactly as the database's GENERATED
 * columns would, and `quoteView` formats it exactly as the live source does.
 * Nothing in between is a literal.
 */
function build(terms: Terms): QuoteView {
  const mid = scaled(terms.literal);
  const priced = priceQuote({
    sellCents: terms.sellCents,
    buyCurrency: terms.currency,
    midRateScaled: mid,
    feeFlatCents: FEE_FLAT,
    feeBps: FEE_BPS,
    spreadBps: SPREAD_BPS,
  });

  const createdAt = at(terms.createdOffset);
  const expiresAt = at(terms.createdOffset + TTL_SECONDS);
  const acceptedAt = terms.acceptedOffset === undefined ? null : at(terms.acceptedOffset);
  const evidence = terms.evidence ?? "live";

  // What the delivery cost at the settlement mid, and the variance that
  // implies — computed by the same function the gate and the schema use, so a
  // settled fixture demonstrates the real identity
  // `amount in − fee − cost = variance` rather than asserting it.
  const settlement =
    terms.settlementLiteral === undefined ? null : scaled(terms.settlementLiteral);

  const settlementCostCents =
    settlement === null
      ? null
      : costCents({
          buyMinor: priced.buyMinor,
          rateScaled: settlement,
          rateScale: priced.rateScale,
          buyExponent: priced.corridor.exponent,
        });

  const facts: QuoteFacts = {
    quoteRef: terms.quoteRef,
    businessName: terms.businessName,
    beneficiaryRef: terms.beneficiaryRef,
    destinationAddress: terms.destinationAddress ?? null,
    rail: "usdc",
    state: terms.state,

    sellCents: priced.sellCents,
    feeFlatCents: FEE_FLAT,
    feeBps: FEE_BPS,
    feeCents: priced.feeCents,
    netCents: priced.netCents,

    spreadBps: SPREAD_BPS,
    midRateScaled: priced.midRateScaled,
    customerRateScaled: priced.customerRateScaled,
    rateScale: priced.rateScale,

    buyCurrency: priced.corridor.currency,
    buyExponent: priced.corridor.exponent,
    buyMinor: priced.buyMinor,

    rateSource: evidence === "live" ? "frankfurter.dev" : "fixed-table",
    rateEvidence: evidence,
    rateLiteral: terms.literal,
    rateDate: "2026-09-10",
    rateHttpStatus: evidence === "live" ? 200 : null,

    createdAt,
    createdByName: "ledger-poster",
    expiresAt,
    expiresInSeconds: BigInt(terms.createdOffset + TTL_SECONDS),
    settlementWindowSeconds: WINDOW_SECONDS,

    acceptedAt,
    acceptedByName: acceptedAt === null ? null : "ledger-poster",
    acceptanceReference: terms.acceptanceReference ?? null,
    acceptedWithSecondsToSpare:
      terms.acceptedOffset === undefined
        ? null
        : BigInt(terms.createdOffset + TTL_SECONDS - terms.acceptedOffset),
    settleBy: terms.acceptedOffset === undefined ? null : at(terms.acceptedOffset + WINDOW_SECONDS),

    settledAt: terms.settledOffset === undefined ? null : at(terms.settledOffset),
    txHash: terms.txHash ?? null,
    settlementMidRateScaled: settlement,
    settlementCostCents,
    varianceCents:
      settlementCostCents === null ? null : priced.sellCents - priced.feeCents - settlementCostCents,
  };

  return quoteView(facts, AS_OF);
}

/* -------------------------------------------------------------------------- */
/* The book                                                                   */
/* -------------------------------------------------------------------------- */

/** A live offer, mid-countdown. $1,000 to Mexico at the 2026-09-10 mid. */
const MEXICO_OPEN = build({
  quoteRef: "FXQ-7J4KP2WN",
  businessName: "Ridgeline Robotics, Inc.",
  beneficiaryRef: "Guadalajara parts supplier",
  destinationAddress: "0x000000000000000000000000000000000000dEaD",
  sellCents: 100_000n,
  currency: "MXN",
  literal: "16.9435",
  state: "open",
  createdOffset: -35,
});

/** Accepted an hour ago, unsettled. The commitment we are on the hook for. */
const MEXICO_ACCEPTED: QuoteView = {
  ...build({
    quoteRef: "FXQ-3MQ8TDVB",
    businessName: "Ridgeline Robotics, Inc.",
    beneficiaryRef: "Monterrey logistics",
    destinationAddress: "0x000000000000000000000000000000000000dEaD",
    sellCents: 100_000n,
    currency: "MXN",
    literal: "16.9435",
    state: "accepted",
    createdOffset: -4_000,
    acceptedOffset: -3_940,
    acceptanceReference: "INV-2291",
  }),
  // The one figure a fixture cannot derive from its own terms: what the market
  // is doing NOW. Computed below from a stated current mid, so it is still not
  // a hand-typed number.
  position: null,
};

/**
 * The peso has strengthened since that quote was accepted, so honouring it
 * costs more than the customer paid. Computed from the same ceiling division
 * the gate uses, not asserted.
 */
const MEXICO_POSITION: QuoteView = (() => {
  const currentMid = scaled("16.5012");
  const priced = priceQuote({
    sellCents: 100_000n,
    buyCurrency: "MXN",
    midRateScaled: scaled("16.9435"),
    feeFlatCents: FEE_FLAT,
    feeBps: FEE_BPS,
    spreadBps: SPREAD_BPS,
  });
  const variance = settlementVariance({
    sellCents: priced.sellCents,
    feeCents: priced.feeCents,
    buyMinor: priced.buyMinor,
    buyExponent: priced.corridor.exponent,
    quotedMidRateScaled: priced.midRateScaled,
    settlementMidRateScaled: currentMid,
    rateScale: priced.rateScale,
  });
  return {
    ...MEXICO_ACCEPTED,
    position: {
      currentMidLabel: formatRate(currentMid, RATE_SCALE, { minDecimals: 4 }),
      settlementCostLabel: formatUsd(variance.settlementCostCents),
      varianceLabel: signedUsd(variance.varianceCents),
      varianceIsLoss: variance.varianceCents < 0n,
      evidence: "live",
    },
  };
})();

/** Accepted, sent, confirmed. The variance is recorded and NOT posted. */
const PHILIPPINES_SETTLED = build({
  quoteRef: "FXQ-9WXB5NH2",
  businessName: "Kettle & Crumb Bakery LLC",
  beneficiaryRef: "Manila contractor",
  destinationAddress: "0x000000000000000000000000000000000000dEaD",
  sellCents: 250_000n,
  currency: "PHP",
  literal: "62.576",
  state: "settled",
  createdOffset: -90_000,
  acceptedOffset: -89_950,
  acceptanceReference: "PO-4417",
  settledOffset: -86_100,
  txHash: "0x4f1c9a2e6d3b81570ac4e9f2b6d84a1c33e7052f9b6d1a48c07e35f9a2b4c6d81",
  // The peso weakened between acceptance and settlement, so this one went our
  // way. The screen says so, in those words.
  settlementLiteral: "62.8900",
});

/** The rate source was down when this was priced, and every figure says so. */
const INDIA_LAPSED = build({
  quoteRef: "FXQ-5TKR0NJY",
  businessName: "Silverline Freight Co.",
  beneficiaryRef: "Bengaluru software vendor",
  destinationAddress: null,
  sellCents: 75_000n,
  currency: "INR",
  literal: "95.44",
  evidence: "simulated",
  state: "lapsed",
  createdOffset: -180_000,
  acceptedOffset: -179_940,
  acceptanceReference: "sub-2026-09",
});

/**
 * THE EDGE STATE. An offer the customer came back to too late.
 *
 * Deliberately an ordinary quote — the rate was live, the arithmetic is right,
 * nothing about it is malformed. The only thing wrong with it is the clock,
 * which is exactly the case a quote screen has to handle well.
 */
const EXPIRED = build({
  quoteRef: "FXQ-2HPV6ZC4",
  businessName: "Ridgeline Robotics, Inc.",
  beneficiaryRef: "Guadalajara parts supplier",
  destinationAddress: "0x000000000000000000000000000000000000dEaD",
  sellCents: 100_000n,
  currency: "MXN",
  literal: "16.9435",
  state: "expired",
  createdOffset: -420,
});

const FULL_BOOK: readonly QuoteView[] = [
  MEXICO_OPEN,
  MEXICO_POSITION,
  EXPIRED,
  PHILIPPINES_SETTLED,
  INDIA_LAPSED,
];

function view(over: Partial<PayoutsView> = {}): PayoutsView {
  return {
    asOf: AS_OF,
    source: "fixture",
    rateEndpoint: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=MXN,PHP,INR,BRL,JPY",
    businesses: [
      { businessId: "e274546d-6bdd-5266-b0fb-cc839a7811f9", legalName: "Ridgeline Robotics, Inc." },
      { businessId: "1151e7b5-b75b-5f58-bdbf-68cd714178ce", legalName: "Kettle & Crumb Bakery LLC" },
      { businessId: "3593cbbb-cd74-5078-ab3c-c4c546910f95", legalName: "Silverline Freight Co." },
    ],
    corridors: [
      { currency: "MXN", name: "Mexican peso", destination: "Mexico", exponent: 2 },
      { currency: "PHP", name: "Philippine peso", destination: "the Philippines", exponent: 2 },
      { currency: "INR", name: "Indian rupee", destination: "India", exponent: 2 },
      { currency: "BRL", name: "Brazilian real", destination: "Brazil", exponent: 2 },
      { currency: "JPY", name: "Japanese yen", destination: "Japan", exponent: 0 },
    ],
    focus: MEXICO_OPEN,
    rows: FULL_BOOK,
    terms: {
      feeFlatLabel: "$1.00",
      feeBpsLabel: "0.25%",
      spreadBpsLabel: "0.50%",
      ttlSeconds: TTL_SECONDS,
      settlementWindowSeconds: WINDOW_SECONDS,
    },
    ...over,
  };
}

export function fixtureSource(state: DemoState): PayoutsDataSource {
  return {
    load: async (filter = {}): Promise<Result<PayoutsView>> => {
      const pick = (fallback: QuoteView | null) =>
        filter.quoteRef === undefined
          ? fallback
          : (FULL_BOOK.find((r) => r.quoteRef === filter.quoteRef) ?? fallback);

      switch (state) {
        case "loading":
          await new Promise((resolve) => setTimeout(resolve, 1_200));
          return ok(view({ focus: pick(MEXICO_OPEN) }));
        case "empty":
          return ok(view({ rows: [], focus: null }));
        case "error":
          return err({
            code: "FX_QUOTE_BOOK_UNAVAILABLE",
            message:
              "The quote book could not be read. No rate was fetched, no quote was raised and " +
              "nothing was committed — this screen only reads.",
          });
        case "edge":
          // One quote, expired, in focus. The screen's whole expiry story is
          // in front of the viewer with nothing else competing for attention.
          return ok(view({ rows: [EXPIRED], focus: EXPIRED }));
        case "default":
          return ok(view({ focus: pick(MEXICO_OPEN) }));
      }
    },
  };
}

export const FIXTURE_QUOTES = FULL_BOOK;
export const FIXTURE_EXPIRED = EXPIRED;
export const FIXTURE_SETTLED = PHILIPPINES_SETTLED;
