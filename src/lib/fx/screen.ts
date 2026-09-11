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
 * The row-to-view mapping is NOT here. It is `./view.ts`, pure, because the
 * fixtures that serve four of the five demo states have to use the same one —
 * a fixture whose own arithmetic does not add up teaches a viewer the wrong
 * thing about the feature being demonstrated.
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
  PayoutsDataSource,
  PayoutsView,
  QuoteView,
} from "@/components/payouts/data-contract";
import { formatUsd } from "@/lib/format/money";
import { sql, type Sql } from "@/lib/ledger/db";
import { fail, ok, type ErrorShape, type Result } from "@/lib/result";

import { commitmentPosition } from "./gate";
import { formatBps } from "./quote";
import { frankfurterUrl, observeRate } from "./rate";
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
import { quoteView, signedUsd } from "./view";

/**
 * Ask what the mid is now, for a commitment we are still on the hook for.
 *
 * `observeRate` never throws: a source that is down produces a labelled
 * simulated reading, and the screen prints the label. A payouts screen that
 * 500s because a free rate feed is having an afternoon would be a worse answer
 * than one that says, in words, that it could not reach the source.
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

        const rows = quotes.map((quote) => quoteView(quote, asOf));

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
