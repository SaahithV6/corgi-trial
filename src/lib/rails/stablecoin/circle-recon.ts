/**
 * Reconciling account 1140 against the CHAIN, not against Circle.
 *
 * ── THE NON-NEGOTIABLE THIS FILE EXISTS FOR ──────────────────────────────────
 *
 * "Your payment provider's balance is their ledger, not yours."
 *
 * Circle publishes `GET /v1/w3s/wallets/{id}/balances` and it is a genuinely
 * useful number — ./circle-client.ts calls it, once, to resolve Circle's uuid
 * for the USDC contract. It is never the figure the ledger is diffed against.
 * Reconciling our books to a provider's API is reconciling their bookkeeping
 * to their bookkeeping: if Circle's balance and Circle's transaction list
 * disagree with the chain, both sides of that comparison move together and the
 * break never appears.
 *
 * So the counter-balance is `eth_call balanceOf` on Base Sepolia, against the
 * same wallet address, read with the same `BaseRpc` the direct path uses. Two
 * providers, one source of truth, and the truth is the one neither of them
 * controls.
 *
 * ── THE UNIT PROBLEM, AND WHY THE BREAK IS REPORTED IN BOTH ──────────────────
 *
 * The wallet holds a uint256 of 6-decimal minor units. Account 1140 is carried
 * in cents at 1 USDC = 100 cents, which is four decimal digits coarser (see
 * ./types.ts and ./allocation.ts). A comparison has to pick a side, and
 * rounding the chain figure down to cents would hide a real sub-cent drift
 * behind a rounding rule.
 *
 * So the chain figure is split by the SAME `splitUsdcUnits` the posting uses,
 * the whole cents are compared, and the sub-cent remainder is reported
 * separately as `chainDustUnits` rather than being folded in. A break of 0
 * cents with non-zero dust is not an error — it is the residual that account
 * 2900 already carries, and it is shown rather than smoothed away.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
 *
 * It does not write anything. `src/lib/recon/` owns break rows and the breaks
 * screen; this is the arithmetic and the chain read, kept pure so that it can
 * be unit-tested with no database and no network, and so that the number a
 * reconciliation reports can be checked line by line.
 *
 * It also inherits the gap `docs/STABLECOIN.md` already states: the opening
 * USDC balance arrived from a faucet and was never booked, so the expected
 * difference is exactly that un-booked opening balance and nothing else. The
 * report carries `openingUnbookedCents` so the caller can say so explicitly
 * instead of the number looking like a mystery.
 */

import type { BaseRpc } from "./client";
import { formatUsdc, splitUsdcUnits, type StablecoinProviderId } from "./types";

export interface UsdcWalletReconciliationInput {
  /** The wallet the ledger's 1140 is supposed to describe. */
  readonly walletAddress: string;
  /** Which rail is custodying it. `circle.w3s` when Circle holds the keys. */
  readonly provider: StablecoinProviderId;
  /** `balanceOf`, read off the chain. Minor units. */
  readonly chainUnits: bigint;
  /**
   * The ledger's balance on 1140, in cents, as a POSITIVE asset figure.
   *
   * 1140 is an asset account, so a wallet holding tokens is a debit balance.
   * Callers reading a credit-normal signed balance must flip the sign before
   * getting here; doing it inside would hide which convention was assumed.
   */
  readonly ledgerCents: bigint;
  /**
   * Cents that reached the wallet without a journal entry — the faucet-funded
   * opening balance. Zero unless the caller knows of one.
   */
  readonly openingUnbookedCents?: bigint;
}

export interface UsdcWalletReconciliation {
  readonly walletAddress: string;
  readonly provider: StablecoinProviderId;
  readonly chainUnits: bigint;
  readonly chainCents: bigint;
  /** The part of the chain balance below the ledger's resolution. */
  readonly chainDustUnits: bigint;
  readonly ledgerCents: bigint;
  readonly openingUnbookedCents: bigint;
  /** chainCents − ledgerCents − openingUnbookedCents. Zero is reconciled. */
  readonly breakCents: bigint;
  readonly reconciled: boolean;
  /** One sentence, safe to put on a screen or in a log. */
  readonly summary: string;
}

/**
 * Diff the chain against the ledger. Pure: no network, no database, no clock.
 */
export function reconcileUsdcWallet(
  input: UsdcWalletReconciliationInput,
): UsdcWalletReconciliation {
  const { cents: chainCents, dustUnits } = splitUsdcUnits(input.chainUnits);
  const opening = input.openingUnbookedCents ?? 0n;
  const breakCents = chainCents - input.ledgerCents - opening;
  const address = input.walletAddress.toLowerCase();

  const summary =
    breakCents === 0n
      ? `1140 reconciles to ${address} on chain: ${formatUsdc(input.chainUnits)} = ${chainCents} cents` +
        `${opening === 0n ? "" : ` after ${opening} cents of un-booked opening balance`}` +
        `${dustUnits === 0n ? "" : `, plus ${dustUnits}/10000 of a cent below ledger resolution`}`
      : `1140 BREAK on ${address}: chain ${chainCents} cents, ledger ${input.ledgerCents} cents` +
        `${opening === 0n ? "" : `, ${opening} cents un-booked opening`}` +
        ` — ${breakCents > 0n ? `${breakCents} cents on chain with no journal entry` : `${-breakCents} cents booked that the chain does not hold`}`;

  return {
    walletAddress: address,
    provider: input.provider,
    chainUnits: input.chainUnits,
    chainCents,
    chainDustUnits: dustUnits,
    ledgerCents: input.ledgerCents,
    openingUnbookedCents: opening,
    breakCents,
    reconciled: breakCents === 0n,
    summary,
  };
}

/**
 * The one network call: what the chain says the wallet holds.
 *
 * Separated from the arithmetic so the arithmetic stays testable, and named
 * for its source so nobody wires a provider API in here by mistake.
 */
export function readWalletUnitsFromChain(
  rpc: BaseRpc,
  tokenAddress: string,
  walletAddress: string,
): Promise<bigint> {
  return rpc.erc20BalanceOf(tokenAddress, walletAddress);
}
