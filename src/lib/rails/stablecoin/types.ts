/**
 * The USDC payout rail's own vocabulary.
 *
 * This sits alongside `../types.ts` rather than inside it. That file is the
 * four-method `PaymentRail` interface every rail shares, and widening it for
 * one rail is how "an adapter rots back into a schema". A confirmed on-chain
 * transfer has facts no ACH transfer has — a block number, a gas receipt, a
 * reorg risk — so they live here, and `../types.ts` is left alone.
 *
 * ── THE OUTCOME UNION IS THE POINT OF THIS FILE ─────────────────────────────
 *
 * `sendUsdcPayout` returns a `PayoutOutcome`; it does not throw for anything a
 * chain can legitimately do to a transaction. A revert, an out-of-gas, a
 * dropped transaction and a reorg are all NORMAL, and every one of them has to
 * come back carrying the transaction hash, because the hash is the only handle
 * anyone has on the money afterwards. An exception that unwinds the stack with
 * the hash inside it is how a payout becomes unfindable.
 *
 * The one thing that is NOT in the union is a successful broadcast presented as
 * a completed payment. There is no `submitted` outcome that the ledger will
 * accept: `postUsdcPayout` takes a `confirmed` outcome and nothing else, so a
 * transaction that has not had `status: 0x1` read back off a receipt cannot
 * reach the journal at all. See DECISIONS 011 — the claim has to be earned by
 * a round trip, and "the node accepted my bytes" is not that round trip.
 */

import type { Money } from "../types";

/** The slug persisted on every ledger row the direct-to-chain path produces. */
export const USDC_PROVIDER = "base.usdc";

/**
 * The slug for the Circle-mediated path. See ./circle-provider.ts.
 *
 * Two providers now move USDC over the same rail, and the ledger entry has to
 * say which one did it — a reader must never have to guess which rail moved
 * the money. `postUsdcPayout` writes `outcome.provider` into the entry
 * description for exactly that reason.
 */
export const CIRCLE_PROVIDER = "circle.w3s";

/**
 * Every provider that can move USDC on this rail.
 *
 * This union is the whole "a rail is an adapter, not a schema" claim in one
 * line: adding Circle widened a provider slug and added an outcome for a
 * failure only a mediated provider can have. It did not add a table, a column,
 * a second `postUsdcPayout`, or a second idempotency key format.
 */
export type StablecoinProviderId = typeof USDC_PROVIDER | typeof CIRCLE_PROVIDER;

/** USDC is 6 decimals on every chain Circle issues it on. */
export const USDC_DECIMALS = 6;

/**
 * 1 USDC = 1,000,000 minor units = 100 cents, so one cent is 10,000 units.
 *
 * The ledger carries the USDC position in cents (chart account 1140: "carried
 * in cents at 1 USDC = 100 cents"), which loses the bottom four digits of a
 * uint256. Those digits are NOT truncated away — `splitUsdcUnits` hands them
 * back and the posting sends them to 2900. See ./ledger.ts.
 */
export const USDC_UNITS_PER_CENT = 10_000n;

/** A `Money` in USDC minor units. Never a number, never a float. */
export function usdc(units: bigint): Money {
  return { amount: units, currency: "USDC" };
}

/** Human rendering for a terminal. Presentation only — never fed back in. */
export function formatUsdc(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(USDC_DECIMALS, "0");
  return `${negative ? "-" : ""}${whole}.${frac} USDC`;
}

/**
 * Split minor units into whole cents and the sub-cent remainder.
 *
 * 1.234567 USDC is 123 cents and 4,567 units of dust. Both halves are returned
 * because the ledger needs both: the cents are the movement, the dust is the
 * residual that keeps the entry honest instead of silently disappearing.
 */
export function splitUsdcUnits(units: bigint): { readonly cents: bigint; readonly dustUnits: bigint } {
  if (units < 0n) throw new Error(`payout amounts are positive: ${units}`);
  return { cents: units / USDC_UNITS_PER_CENT, dustUnits: units % USDC_UNITS_PER_CENT };
}

// ---------------------------------------------------------------------------
// The instruction
// ---------------------------------------------------------------------------

/**
 * What to move, and where — with nothing in it about HOW.
 *
 * This is the half of the old `UsdcPayoutRequest` that is true of every
 * provider. The direct path needs a secp256k1 key; Circle needs an API key, a
 * wallet id and an entity secret. Neither credential appears here, because a
 * caller instructing a payout should not have to know which rail is wired —
 * that is the "adapter, not a schema" claim, and it only holds if the
 * instruction is provider-free. Credentials are closed over by the provider
 * factory instead. See ./circle-registry.ts.
 */
export interface StablecoinPayoutInstruction {
  /** ERC-20 contract. Base Sepolia USDC on this deployment. */
  readonly tokenAddress: string;
  /** The wallet the money leaves. Checked against the provider's own idea of it. */
  readonly fromAddress: string;
  readonly toAddress: string;
  /** Minor units. 0.50 USDC is 500000n. */
  readonly amountUnits: bigint;
  /** EIP-155 chain id, read from configuration and re-checked against the node. */
  readonly chainId: bigint;
  /** How many blocks must sit on top of the receipt before we believe it. */
  readonly confirmations?: number;
  /** Wall-clock ceiling on waiting for a receipt, milliseconds. */
  readonly receiptTimeoutMs?: number;
}

/** The direct-to-chain instruction: the shared fields, plus the signing key. */
export interface UsdcPayoutRequest extends StablecoinPayoutInstruction {
  /** 32 bytes of secp256k1 key material. Held only for the duration of a call. */
  readonly privateKey: Uint8Array;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** Why we declined to broadcast. Nothing was signed onto the wire. */
export type PayoutRefusal =
  /** The private key does not derive the address we were told to send from. */
  | "sender_key_mismatch"
  /** The node's chain id is not the one configured. Wrong network. */
  | "chain_id_mismatch"
  /** The wallet does not hold the tokens. */
  | "insufficient_usdc"
  /** The wallet cannot pay for the gas the estimate demands. */
  | "insufficient_gas"
  /**
   * `eth_getTransactionCount(pending)` is ahead of `latest`: this wallet has a
   * transaction in the mempool. Broadcasting now would take the NEXT nonce and
   * send a second payout. See ./adapter.ts.
   */
  | "transaction_in_flight"
  /** `eth_estimateGas` reverted. The transfer would fail and burn the gas. */
  | "estimate_reverted"
  /** The node refused the raw transaction. Signed, never accepted. */
  | "broadcast_rejected"
  /**
   * The provider has no credential. Reported, never worked around.
   *
   * A mediated provider can be absent in a way the direct path cannot: the key
   * is simply not set. This is the outcome then — NOT a silent fall back to
   * the direct path, which would move money over a rail the caller did not
   * choose and label it in the ledger as one it did not pick.
   */
  | "provider_not_configured"
  /**
   * The provider took the instruction and then refused it: a Circle transfer
   * that ends FAILED, CANCELLED or DENIED without ever producing a hash.
   * Nothing reached a chain, so there is nothing to find and nothing to post.
   */
  | "provider_declined";

export interface GasFacts {
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  /** gasLimit × maxFeePerGas: the worst case the wallet must be able to cover. */
  readonly maxCostWei: bigint;
}

export interface ReceiptFacts {
  readonly blockNumber: bigint;
  readonly blockHash: string;
  /** Unix seconds, from the block header. The ledger's value date comes from this. */
  readonly blockTimestamp: bigint;
  readonly gasUsed: bigint;
  readonly effectiveGasPriceWei: bigint;
  /** gasUsed × effectiveGasPrice. What the transfer actually cost to send. */
  readonly gasCostWei: bigint;
}

interface OutcomeBase {
  /** Which rail moved it. Written into the ledger entry description. */
  readonly provider: StablecoinProviderId;
  /** Always 'live': this adapter has no simulator and never fabricates one. */
  readonly evidence: "live";
  readonly amount: Money;
  readonly from: string;
  readonly to: string;
}

export type PayoutOutcome =
  /** Receipt read back, `status: 0x1`, and the block still canonical. */
  | (OutcomeBase & {
      readonly kind: "confirmed";
      readonly txHash: string;
      readonly nonce: bigint;
      readonly gas: GasFacts;
      readonly receipt: ReceiptFacts;
      /** True when this run found the transfer already on chain and sent nothing. */
      readonly recovered: boolean;
    })
  /** Mined and FAILED. `status: 0x0`. The gas is gone; no USDC moved. */
  | (OutcomeBase & {
      readonly kind: "reverted";
      readonly txHash: string;
      readonly receipt: ReceiptFacts;
    })
  /**
   * A receipt existed and then the block that carried it stopped being
   * canonical. The transfer may re-mine or may not; nothing may be posted.
   */
  | (OutcomeBase & {
      readonly kind: "reorged";
      readonly txHash: string;
      readonly detail: string;
    })
  /** Broadcast accepted, still in the mempool when the timeout expired. */
  | (OutcomeBase & {
      readonly kind: "unconfirmed";
      readonly txHash: string;
      readonly waitedMs: number;
    })
  /** Broadcast accepted, then the node stopped knowing about it. */
  | (OutcomeBase & { readonly kind: "dropped"; readonly txHash: string })
  /**
   * ── CIRCLE'S `INITIATED`, AND THE ONLY PLACE IT IS ALLOWED TO EXIST ──────
   *
   * The provider has taken the instruction and there is still no chain
   * evidence of any kind — no hash, no receipt, nothing to look up. Circle's
   * transfer POST returns exactly this: `{id, state: "INITIATED"}`.
   *
   * It is in the union so that it can be RETURNED, printed and retried rather
   * than smuggled out as an exception or, far worse, rounded up to success.
   * It is not `confirmed`, so `postUsdcPayout` will not take it: the ledger
   * accepts a receipt read off a chain and nothing else. `txHash` is `null`
   * and not optional, because the honest answer to "what is the hash" here is
   * the word null, and a field that can be forgotten gets forgotten.
   *
   * This is the direct path's `unconfirmed` for a rail where the identifier is
   * assigned by someone else and arrives late.
   */
  | (OutcomeBase & {
      readonly kind: "acknowledged";
      /** The provider's own id for the instruction. Not a transaction hash. */
      readonly providerRef: string;
      /** The provider's last reported state, verbatim. e.g. `INITIATED`. */
      readonly state: string;
      readonly waitedMs: number;
      readonly txHash: null;
    })
  /**
   * ── THE OUTCOME A SECOND PROVIDER MADE NECESSARY ─────────────────────────
   *
   * The provider named a transaction, that transaction is on chain, and it
   * does NOT carry the ERC-20 `Transfer` we instructed — wrong token, wrong
   * recipient, wrong amount, or no transfer at all.
   *
   * The direct path cannot reach this state: it builds the calldata itself, so
   * `status: 0x1` on a transaction it signed IS the transfer. A mediated
   * provider builds the calldata for us and then tells us a hash, and the only
   * thing that makes "Circle says it sent your money" into "our money moved"
   * is reading the log off the chain ourselves. Reporting `confirmed` on the
   * provider's word would be booking their ledger as ours.
   *
   * Nothing may post. The hash survives, because it is the only handle anyone
   * has on whatever DID happen.
   */
  | (OutcomeBase & {
      readonly kind: "unverified";
      readonly txHash: string;
      readonly detail: string;
    })
  /** Nothing was broadcast. `txHash` is null because no bytes were ever signed onto the wire. */
  | (OutcomeBase & {
      readonly kind: "refused";
      readonly reason: PayoutRefusal;
      readonly detail: string;
      /** Present when the refusal happened AFTER signing (broadcast_rejected). */
      readonly txHash: string | null;
    });

/** The only outcome the ledger will accept. */
export type ConfirmedPayout = Extract<PayoutOutcome, { kind: "confirmed" }>;

export function isConfirmed(outcome: PayoutOutcome): outcome is ConfirmedPayout {
  return outcome.kind === "confirmed";
}

/**
 * The idempotency key, and the reason the hash is computed before broadcast.
 *
 * `journal_entry.idempotency_key` is UNIQUE, so this string is what makes a
 * second posting of the same transfer a no-op decided by Postgres rather than
 * by a code path somebody has to remember to write.
 */
export function payoutIdempotencyKey(txHash: string): string {
  return `usdc:payout:${txHash}`;
}

// ---------------------------------------------------------------------------
// The interface two providers implement
// ---------------------------------------------------------------------------

/**
 * Liveness, in the vocabulary DECISIONS 011 fixed on.
 *
 * Deliberately the same four words `src/lib/integrations/probe.ts` uses, so a
 * reader who has seen one surface has seen both. `live` is earned by a round
 * trip and by nothing else; a present API key is not evidence of anything.
 */
export type ProviderLiveness = "live" | "unauthorised" | "unreachable" | "not_configured";

export interface ProviderHealth {
  readonly provider: StablecoinProviderId;
  /** What a human should see. Never a slug on its own. */
  readonly label: string;
  readonly liveness: ProviderLiveness;
  /** Why. Always populated, including on `live`. */
  readonly detail: string;
  readonly ms: number;
}

/**
 * THE INTERFACE. Two implementations, one ledger posting.
 *
 * `send` returns a `PayoutOutcome`, which means a provider cannot report a
 * payout as done in any way except the one `postUsdcPayout` accepts — a
 * `confirmed` outcome carrying a transaction hash read back off the chain.
 * Circle's `INITIATED` has no representation here at all, which is the point:
 * an acknowledgement is not a value this interface can return.
 *
 * The instruction carries no credential (see `StablecoinPayoutInstruction`);
 * each factory closes over its own. That is what makes the two swappable.
 */
export interface StablecoinPayoutProvider {
  readonly id: StablecoinProviderId;
  /** Human-readable, for the health surface and for operator output. */
  readonly label: string;
  /** The cheapest honest answer to "could this rail move money right now?". */
  health(): Promise<ProviderHealth>;
  /** Never throws for anything a chain or a provider can legitimately do. */
  send(instruction: StablecoinPayoutInstruction): Promise<PayoutOutcome>;
}
