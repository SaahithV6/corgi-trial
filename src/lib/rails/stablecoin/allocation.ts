/**
 * The two pure decisions a USDC posting rests on: how minor units become
 * balanced integer-cent lines, and which business day a block belongs to.
 *
 * Separate from ./ledger.ts because that module imports the database handle,
 * which reads and validates the whole environment at import time. This
 * arithmetic has to be testable in CI, which holds no credentials by design.
 */

import { BANKING_TIME_ZONE } from "@/lib/format/datetime";
import { splitUsdcUnits } from "./types";

/**
 * How one payout's minor units become balanced integer-cent lines.
 *
 * USDC has six decimals and chart account 1140 is carried in cents, so four
 * digits sit below the ledger's resolution. They are not truncated: the
 * customer is debited the rounded-UP cent, the wallet is credited the whole
 * cents it actually parted with, and the one-cent difference is credited to
 * 2900 — a real journal line, so the entry still sums to zero and the fraction
 * is a visible, ageable balance rather than a rounding error nobody can find.
 * 0.50 USDC has no dust and produces two lines; 1.234567 USDC produces three.
 */
export interface PayoutAllocation {
  /** Debit to the customer's deposit account. */
  readonly depositDebitCents: bigint;
  /** Credit to 1140, the USDC omnibus wallet. */
  readonly walletCreditCents: bigint;
  /** Credit to 2900. Zero when the amount is a whole number of cents. */
  readonly residualCreditCents: bigint;
  /** The sub-cent remainder, in USDC minor units out of 10,000 per cent. */
  readonly dustUnits: bigint;
}

export function payoutAllocation(units: bigint): PayoutAllocation {
  const { cents, dustUnits } = splitUsdcUnits(units);
  const residual = dustUnits > 0n ? 1n : 0n;
  return {
    depositDebitCents: cents + residual,
    walletCreditCents: cents,
    residualCreditCents: residual,
    dustUnits,
  };
}

const bookDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: BANKING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The value date, from the BLOCK's own timestamp.
 *
 * Not `Date.now()`, and not the moment the receipt was read. The money moved
 * when the block was mined; if this process is restarted tomorrow and recovers
 * yesterday's transfer, the entry must still land on yesterday. The book day
 * is America/New_York, so a block at 02:00 UTC belongs to the previous
 * business day and a UTC-derived date would be wrong every night.
 */
export function blockValueDate(blockTimestampSeconds: bigint): string {
  return bookDateFormat.format(new Date(Number(blockTimestampSeconds) * 1000));
}
