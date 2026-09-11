import "server-only";

/**
 * The predicate the payout path calls. One function, one question:
 *
 *   MAY THIS USDC LEAVE?
 *
 * ── WHERE THIS GOES ─────────────────────────────────────────────────────────
 *
 * `scripts/payout-usdc.mjs`, immediately before `sendUsdcPayout` — the one
 * line is quoted in docs/FX.md §5 and in the report that accompanied this
 * work. It is deliberately NOT called from inside
 * `src/lib/rails/stablecoin/adapter.ts`: that module is owned elsewhere, it
 * holds no database handle by design (the whole crash-recovery story in its
 * header depends on the adapter and the ledger being separable), and a rail
 * adapter that cannot send without a Postgres round trip is a rail adapter
 * that stops working when Postgres does.
 *
 * The gate belongs one level up, at the orchestration point that already
 * holds both. That is also where `postUsdcPayout()` is called, so the gate and
 * the posting see the same connection and the same transaction.
 *
 * ── WHAT IT REFUSES, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────
 *
 * IT REFUSES:
 *
 *   1. A PAYOUT WITH NO QUOTE. `FX_QUOTE_REQUIRED`. A cross-border payout
 *      moves a customer's money into a currency they cannot see the price of;
 *      doing that without a price they agreed to is the thing this feature
 *      exists to stop.
 *
 *   2. A QUOTE NOBODY ACCEPTED. `FX_QUOTE_NOT_ACCEPTED` — the headline code,
 *      and the answer to "a payout without an accepted, unexpired quote must
 *      be refused". An offer that lapsed unaccepted lands here too, because
 *      from the payout's point of view they are the same fact: no commitment
 *      was ever made.
 *
 *   3. A COMMITMENT THAT HAS RUN OUT. `FX_QUOTE_COMMITMENT_LAPSED`. Accepted,
 *      honoured for the whole window the offer named, and not sent in time.
 *      A different fact from (2) with a different explanation owed to the
 *      customer, which is why it is a different code.
 *
 *   4. A QUOTE ALREADY SPENT. `FX_QUOTE_ALREADY_SETTLED`. One accepted rate
 *      funds one transfer. The database enforces this too — `quote_id` is the
 *      PRIMARY KEY of `fx_quote_settlement` — but the gate catches it before
 *      anything is signed onto a chain, which is the only place catching it
 *      is free.
 *
 *   5. A PAYOUT THAT IS NOT THE ONE QUOTED. `FX_QUOTE_MISMATCH`: more USDC
 *      than the customer authorised, or a different recipient than the quote
 *      names. See the two notes on those checks below — both are narrower
 *      than they could be, on purpose.
 *
 * IT DOES NOT REFUSE:
 *
 *   * A DOMESTIC PAYOUT. This gate is for the cross-border path. A USDC
 *      transfer that is not a currency conversion — moving a customer's own
 *      dollars to their own wallet — has no FX risk, no commitment and
 *      nothing to quote, and requiring one would be ceremony. The caller
 *      decides which payouts are cross-border; the gate does not guess.
 *
 * ── IT FAILS CLOSED, UNLIKE THE PAYEE GATE ──────────────────────────────────
 *
 * `gatePaymentOnPayee()` returns `null` — proceed — when it cannot reach the
 * database, and that is right for it: it is an additional check in front of
 * controls that do hold, and a destination-validation service that can stop
 * every payment by falling over is the bigger risk.
 *
 * THIS GATE TAKES THE OPPOSITE POSITION AND THE ASYMMETRY IS DELIBERATE. It is
 * not an additional check — it IS the control. "The customer agreed a price"
 * has no second enforcement point anywhere in the system, so a gate that
 * proceeds when it cannot read is a gate that sends unpriced money into
 * another currency whenever Postgres hiccups. An outage here stops payouts,
 * which is an outage somebody notices and fixes; failing open produces a
 * commitment nobody made, which nobody notices until the customer does.
 */

import { sql, type Sql } from "@/lib/ledger/db";
import { USDC_UNITS_PER_CENT } from "@/lib/rails/stablecoin/types";

import { costCents } from "./quote";
import { loadQuoteByRef, type QuoteRecord } from "./store";
import { formatMinorUnits, formatRate } from "./quote";
import type { FxRefusal } from "./types";

/** Exactly the facts the gate needs about the payout being attempted. */
export interface PayoutQuoteContext {
  /** The quote this payout claims to settle. `null` is itself a refusal. */
  readonly quoteRef: string | null | undefined;
  /** USDC minor units about to leave the wallet. 0.50 USDC is 500000n. */
  readonly amountUnits: bigint;
  /** The recipient the transfer will name. Checked when the quote carries one. */
  readonly toAddress?: string | null;
  /** Whose money it is. Checked when supplied. */
  readonly businessId?: string | null;
}

function refuse(code: FxRefusal["code"], message: string): FxRefusal {
  return { code, message };
}

/** A dollar figure for a refusal message. Integer arithmetic, no `toFixed`. */
function usd(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${whole}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/**
 * Refuse a payout that has no accepted, unexpired quote behind it.
 *
 * `null` means proceed. Anything else is a refusal with a code the caller can
 * branch on and a message an operator can act on.
 *
 * NEVER THROWS for a database problem — it refuses instead, with
 * `FX_QUOTE_NOT_FOUND` and the reason. See the header for why this direction
 * and not the other.
 */
export async function requireAcceptedQuote(
  context: PayoutQuoteContext,
  conn: Sql = sql,
): Promise<FxRefusal | null> {
  const ref = context.quoteRef?.trim();
  if (ref === undefined || ref.length === 0) {
    return refuse(
      "FX_QUOTE_REQUIRED",
      "This payout names no FX quote. A cross-border payout moves a customer's money into a " +
        "currency whose price they cannot see, so it does not leave without a quote they " +
        "accepted first. Raise one on /payouts and pass its reference.",
    );
  }

  let quote: QuoteRecord | null;
  try {
    quote = await loadQuoteByRef(ref, conn);
  } catch (cause) {
    return refuse(
      "FX_QUOTE_NOT_FOUND",
      `The quote book could not be read, so whether ${ref} was accepted is unknown — and an ` +
        "unknown answer is a refusal here, not a pass. Nothing was signed and nothing moved. " +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }

  if (quote === null) {
    return refuse(
      "FX_QUOTE_NOT_FOUND",
      `There is no quote ${ref}. Nothing was signed and nothing moved.`,
    );
  }

  // ---- the state, which is derived and not a column ------------------------
  switch (quote.state) {
    case "open":
      return refuse(
        "FX_QUOTE_NOT_ACCEPTED",
        `Quote ${quote.quoteRef} is still an open offer — nobody has accepted it, so there is ` +
          "no commitment for this payout to settle against. It expires at " +
          `${quote.expiresAt}.`,
      );
    case "expired":
      return refuse(
        "FX_QUOTE_NOT_ACCEPTED",
        `Quote ${quote.quoteRef} expired at ${quote.expiresAt} without being accepted. No ` +
          "commitment was ever made, so nothing was lost — but nothing was agreed either. " +
          "Request a new quote.",
      );
    case "lapsed":
      return refuse(
        "FX_QUOTE_COMMITMENT_LAPSED",
        `Quote ${quote.quoteRef} was accepted at ${quote.acceptedAt ?? "an unknown time"} and ` +
          `its ${quote.settlementWindowSeconds}-second settlement window closed at ` +
          `${quote.settleBy ?? "an unknown time"}. We held the rate for the whole window the ` +
          "offer named; past it the commitment lapses and the payout needs a fresh quote.",
      );
    case "settled":
      return refuse(
        "FX_QUOTE_ALREADY_SETTLED",
        `Quote ${quote.quoteRef} already funded a payout${
          quote.txHash === null ? "" : ` (${quote.txHash})`
        }. One accepted rate settles one transfer; a second transfer needs a second quote.`,
      );
    case "accepted":
      break;
  }

  // ---- whose money ---------------------------------------------------------
  if (
    context.businessId !== undefined &&
    context.businessId !== null &&
    context.businessId !== quote.businessId
  ) {
    return refuse(
      "FX_QUOTE_MISMATCH",
      `Quote ${quote.quoteRef} belongs to ${quote.businessName}, not to the customer this ` +
        "payout debits. A commitment is made to one customer and cannot be spent by another.",
    );
  }

  // ---- the recipient -------------------------------------------------------
  //
  // Only when the quote names one. A quote raised before the off-ramp wallet
  // was known is a legitimate quote — the price is agreed, the plumbing is
  // arranged afterwards — and refusing it would force a re-quote at a worse
  // rate for a reason that has nothing to do with the price.
  if (quote.destinationAddress !== null) {
    const intended = quote.destinationAddress.toLowerCase();
    const actual = (context.toAddress ?? "").toLowerCase();
    if (actual !== intended) {
      return refuse(
        "FX_QUOTE_MISMATCH",
        `Quote ${quote.quoteRef} names ${quote.destinationAddress} as the destination and this ` +
          `payout would send to ${context.toAddress ?? "no address"}. The commitment is to pay ` +
          "a particular beneficiary; it is not a bearer instrument.",
      );
    }
  }

  // ---- the amount ----------------------------------------------------------
  //
  // THE CEILING IS THE CUSTOMER'S PRICE, NOT THE QUOTE'S NET.
  //
  // What actually leaves the wallet is decided at SETTLEMENT by the market —
  // that is the entire point of a commitment, and pinning the payout to the
  // net at quote time would defeat it. So the gate does not require an exact
  // figure. It requires that no more USDC leaves than the customer paid us.
  //
  // If honouring the commitment costs more than `sell_cents`, the excess is
  // OUR money, not theirs, and funding it is a decision a human makes about
  // the house's own position — not something a payout gate waves through on a
  // rate move. The refusal says so and gives the number.
  const ceilingUnits = quote.sellCents * USDC_UNITS_PER_CENT;
  if (context.amountUnits > ceilingUnits) {
    return refuse(
      "FX_QUOTE_MISMATCH",
      `This payout would send ${context.amountUnits} USDC units, more than the ` +
        `${usd(quote.sellCents)} the customer committed under ${quote.quoteRef}. Honouring the ` +
        `commitment of ${formatMinorUnits(quote.buyMinor, quote.buyExponent, quote.buyCurrency)} ` +
        "now costs more than they paid, and the difference is the house's money. That is a " +
        "decision for a person, not for this gate.",
    );
  }
  if (context.amountUnits <= 0n) {
    return refuse(
      "FX_QUOTE_MISMATCH",
      `A payout of ${context.amountUnits} units settles nothing. Quote ${quote.quoteRef} ` +
        "commits us to " +
        `${formatMinorUnits(quote.buyMinor, quote.buyExponent, quote.buyCurrency)}.`,
    );
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* What the commitment costs today                                            */
/* -------------------------------------------------------------------------- */

/**
 * What honouring an accepted commitment would cost right now, and who is up.
 *
 * Separate from the gate because it is a different question with a different
 * failure mode: the gate must answer from the database alone and must answer
 * even when the rate source is down, while this needs a current rate and is
 * allowed to be unavailable. Bolting a live HTTP call into the payout gate
 * would make a free FX feed a dependency of every transfer.
 *
 * Used by the screen to show what the accepted quote is worth against the
 * market as it stands, which is the most honest thing a commitment screen can
 * show: the customer's number has not moved, and ours has.
 */
export interface CommitmentPosition {
  readonly settlementCostCents: bigint;
  /** Signed. Positive we are up on the commitment, negative we are down. */
  readonly varianceCents: bigint;
  readonly quotedMidLabel: string;
  readonly currentMidLabel: string;
}

export function commitmentPosition(
  quote: QuoteRecord,
  currentMidRateScaled: bigint,
  currentRateScale: bigint,
): CommitmentPosition {
  const cost = costCents({
    buyMinor: quote.buyMinor,
    rateScaled: currentMidRateScaled,
    rateScale: currentRateScale,
    buyExponent: quote.buyExponent,
  });
  return {
    settlementCostCents: cost,
    varianceCents: quote.sellCents - quote.feeCents - cost,
    quotedMidLabel: formatRate(quote.midRateScaled, quote.rateScale, { minDecimals: 4 }),
    currentMidLabel: formatRate(currentMidRateScaled, currentRateScale, { minDecimals: 4 }),
  };
}
