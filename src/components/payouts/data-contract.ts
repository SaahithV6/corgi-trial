/**
 * The payouts screen's data contract.
 *
 * The same seam `src/components/payees/data-contract.ts` keeps, and the same
 * rules: nothing under `src/components/payouts/**` opens a connection, imports
 * `postgres`, or reaches into `src/lib/fx/*` for anything but these types.
 * `src/lib/fx/screen.ts` implements this against the live database and
 * `./fixtures.ts` implements it without one.
 *
 * ── ONE SHAPE NOTE THAT IS THE WHOLE POINT ──────────────────────────────────
 *
 * EVERY MONEY AND RATE FIGURE BELOW IS A PRE-FORMATTED STRING, not a number.
 * That is not laziness about types; it is the rule the arithmetic depends on.
 * Money is `bigint` cents and rates are `bigint` scaled by 10^8, and neither
 * survives the trip to a browser as itself — `JSON.stringify` refuses a
 * bigint, and the obvious workaround turns it into a `number`, which is a
 * float, which is the one thing this system does not allow money to be. So the
 * server does the arithmetic and the formatting, and the browser renders
 * characters.
 *
 * The exceptions are deliberate and are not money: `expiresAt` and the other
 * instants are ISO strings because a countdown has to tick, and
 * `expiresInSeconds` is a plain integer for the same reason. Seconds are not
 * cents.
 */

import type { ErrorShape, Result } from "@/lib/result";

export type Instant = string;

/** What the rate source is, and whether anybody actually answered. */
export type RateSourceView = {
  /** e.g. `frankfurter.dev`. Matched on, not decorative. */
  readonly source: string;
  readonly evidence: "live" | "simulated";
  /** The literal characters the source printed for this pair, e.g. `16.9435`. */
  readonly literal: string;
  /** The SOURCE's own date for the rate. Not when we asked. */
  readonly rateDate: string;
  /** Whole days between the rate's date and when the page was read. */
  readonly ageDays: number | null;
  readonly httpStatus: number | null;
  /** Why this reading is simulated, when it is. `null` for a live one. */
  readonly fallbackReason: string | null;
};

/** One line of the arithmetic panel. The screen renders these in order. */
export type ArithmeticRow = {
  readonly label: string;
  readonly value: string;
  /** The sentence under the figure. Never decoration — it is the disclosure. */
  readonly note: string;
  /** Draw a rule above this row: it is a subtotal or the result. */
  readonly emphasis?: boolean;
};

export type QuoteStateView = "open" | "expired" | "accepted" | "lapsed" | "settled";

export type QuoteView = {
  readonly quoteRef: string;
  readonly businessName: string;
  readonly beneficiaryRef: string;
  readonly destinationAddress: string | null;
  readonly rail: string;

  readonly state: QuoteStateView;

  /** Amount in, fee, net, rate, amount out — every figure, as characters. */
  readonly sellLabel: string;
  readonly feeLabel: string;
  readonly netLabel: string;
  readonly midRateLabel: string;
  readonly customerRateLabel: string;
  readonly spreadLabel: string;
  readonly spreadValueLabel: string;
  readonly buyLabel: string;
  readonly buyCurrency: string;

  /** The full breakdown, in the order a person reads it. */
  readonly arithmetic: readonly ArithmeticRow[];

  readonly rate: RateSourceView;

  readonly createdAt: Instant;
  readonly createdByName: string;
  readonly expiresAt: Instant;
  /** Signed. Negative once the offer has lapsed, which the screen shows rather than hides. */
  readonly expiresInSeconds: number;
  readonly ttlSeconds: number;

  readonly acceptedAt: Instant | null;
  readonly acceptedByName: string | null;
  readonly acceptanceReference: string | null;
  readonly acceptedWithSecondsToSpare: number | null;
  readonly settleBy: Instant | null;
  readonly settlementWindowSeconds: number;

  readonly settledAt: Instant | null;
  readonly txHash: string | null;
  readonly settlementCostLabel: string | null;
  /** Signed, with its sign shown: what the market move cost us, or handed us. */
  readonly varianceLabel: string | null;
  readonly varianceIsLoss: boolean | null;

  /**
   * What honouring this commitment would cost at the rate as it stands now,
   * for a quote that is accepted and unsettled. `null` when there is no
   * current rate to compare against, which is a real state and not an error.
   */
  readonly position: {
    readonly currentMidLabel: string;
    readonly settlementCostLabel: string;
    readonly varianceLabel: string;
    readonly varianceIsLoss: boolean;
    readonly evidence: "live" | "simulated";
  } | null;
};

export type BusinessOptionView = {
  readonly businessId: string;
  readonly legalName: string;
};

export type CorridorOptionView = {
  readonly currency: string;
  readonly name: string;
  readonly destination: string;
  readonly exponent: number;
};

export type PayoutsView = {
  readonly asOf: Instant;
  readonly source: "live" | "fixture";
  /** The exact call the live source is reached by. Printed on the screen. */
  readonly rateEndpoint: string;
  readonly businesses: readonly BusinessOptionView[];
  readonly corridors: readonly CorridorOptionView[];
  /** The quote named in `?quote=`, when there is one. */
  readonly focus: QuoteView | null;
  readonly rows: readonly QuoteView[];
  /** The standard terms an offer is raised under, as characters. */
  readonly terms: {
    readonly feeFlatLabel: string;
    readonly feeBpsLabel: string;
    readonly spreadBpsLabel: string;
    readonly ttlSeconds: number;
    readonly settlementWindowSeconds: number;
  };
};

export interface PayoutsDataSource {
  load(filter?: {
    readonly businessId?: string | undefined;
    readonly quoteRef?: string | undefined;
  }): Promise<Result<PayoutsView, ErrorShape>>;
}
