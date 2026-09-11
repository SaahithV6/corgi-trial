/**
 * The USDC slot, behind the rail contract.
 *
 * `StablecoinPayoutProvider` was already the right shape — two providers, one
 * ledger posting, an outcome union nobody can smuggle an acknowledgement
 * through — and this adapter does not replace it. It puts it behind the same
 * five-operation vocabulary as the other rails so that a health surface and a
 * settlement feed can hold all of them at once.
 *
 * ─── TWO OPERATIONS THIS RAIL GENUINELY DOES NOT HAVE ───────────────────────
 *
 * `observe`. Nobody calls us. There is no webhook, no signature to verify, no
 * out-of-order delivery to tolerate — the direct path polls `eth_getTransactionReceipt`
 * and the Circle path polls Circle and then reads the ERC-20 `Transfer` log off
 * the chain itself. A rail whose settlement arrives by us asking is a
 * different animal from one whose settlement arrives by being told, and the
 * contract can say so because `settle` is a separate operation from `observe`.
 * (Circle does offer subscription webhooks. This deployment does not use them,
 * has never received one, and the adapter says `supported: false` rather than
 * claiming a delivery path nothing has ever exercised.)
 *
 * `reverse`. A confirmed chain transfer is final. There is no return code, no
 * chargeback, no recall, and `RailCapabilities.supportsReturns` has said `false`
 * for this rail since it was written. `returnWindowDays: null` on a chain means
 * "the question does not apply", which is not the same as `0` — and it is why
 * USDC funds are spendable on confirmation while ACH funds are not.
 *
 * A `reverted` transaction is not a reversal: the transfer never happened, the
 * gas is gone, and no USDC moved. That is a failed origination, and it comes
 * back through `originate` as `failed`, not through a `reverse` this rail does
 * not have.
 */

import {
  makeRailProbe,
  type OriginatingRail,
  type RailIdentity,
  type RailOrigination,
  type RailOriginationStatus,
  type RailProbe,
  type RailSupport,
} from '../contract';
import {
  CIRCLE_PROVIDER,
  usdc,
  type PayoutOutcome,
  type ProviderLiveness,
  type StablecoinPayoutInstruction,
  type StablecoinPayoutProvider,
} from '../stablecoin/types';
import type { RailLiveness } from '../contract';

/**
 * `ProviderLiveness` is a four-word subset of `RailLiveness` and maps in
 * without loss. The mapping is written out rather than cast so that adding a
 * word to either union is a compile error here.
 */
function railLiveness(liveness: ProviderLiveness): RailLiveness {
  switch (liveness) {
    case 'live':
      return 'live';
    case 'unauthorised':
      return 'unauthorised';
    case 'unreachable':
      return 'unreachable';
    case 'not_configured':
      return 'not_configured';
  }
}

/**
 * `PayoutOutcome` -> `RailOriginationStatus`.
 *
 * The three `indeterminate` rows are the reason `RailOriginationStatus` exists
 * as its own union instead of reusing `RailTransferStatus`:
 *
 *   reorged     a receipt existed and its block stopped being canonical. The
 *               transfer may re-mine or may not.
 *   dropped     the node accepted the bytes and then stopped knowing about
 *               them. Another node may still have them.
 *   unverified  the provider named a transaction, the transaction is on chain,
 *               and it does not carry the transfer we instructed. Something
 *               happened; it was not our payment.
 *
 * All three have a transaction hash and no answer. Calling them `submitted`
 * would invite a retry that double-spends; calling them `failed` would invite a
 * re-book of money that may well have moved. `indeterminate` invites neither,
 * and `postUsdcPayout` accepts only `confirmed` regardless, so nothing here can
 * reach the ledger by being mapped optimistically.
 */
function originationStatus(outcome: PayoutOutcome): RailOriginationStatus {
  switch (outcome.kind) {
    case 'confirmed':
      return 'settled';
    case 'reverted':
      return 'failed';
    case 'unconfirmed':
    case 'acknowledged':
      return 'accepted';
    case 'reorged':
    case 'dropped':
    case 'unverified':
      return 'indeterminate';
    case 'refused':
      return 'refused';
  }
}

/**
 * The handle, whatever the provider called it.
 *
 * A transaction hash where there is one; Circle's own instruction id where
 * there is not yet; null only for a refusal that never signed anything, where
 * the honest answer is that there is nothing to look up.
 */
function originationRef(outcome: PayoutOutcome): string | null {
  switch (outcome.kind) {
    case 'acknowledged':
      return outcome.providerRef;
    case 'refused':
      return outcome.txHash;
    case 'confirmed':
    case 'reverted':
    case 'reorged':
    case 'unconfirmed':
    case 'dropped':
    case 'unverified':
      return outcome.txHash;
  }
}

/**
 * When it happened.
 *
 * A confirmed payout is dated by the BLOCK, never by our clock: the block
 * timestamp is what the ledger's value date is derived from, and a wall-clock
 * reading here would let a value date drift from the chain it is supposed to
 * describe. Everything else has no chain time to read, so it is dated now —
 * and none of those outcomes may be posted anyway.
 */
function originationAt(outcome: PayoutOutcome): string {
  if (outcome.kind === 'confirmed') {
    return new Date(Number(outcome.receipt.blockTimestamp) * 1000).toISOString();
  }
  return new Date().toISOString();
}

function supportFor(provider: StablecoinPayoutProvider): RailSupport {
  const mediated = provider.id === CIRCLE_PROVIDER;
  return {
    originate: {
      supported: true,
      proof: 'measured',
      evidence: mediated
        ? 'Circle Web3 Services on Base Sepolia. The transfer POST is measured, and the hash it names is verified against the ERC-20 Transfer log on chain before anything is called confirmed.'
        : 'EIP-1559 transaction signed here and broadcast to Base Sepolia; receipt read back with status 0x1 and the block re-checked for canonicality.',
    },
    observe: {
      supported: false,
      reason:
        'Nobody calls us. There is no webhook on this rail in this deployment — settlement is read off the chain by asking, not by being told.',
    },
    settle: {
      supported: true,
      proof: 'measured',
      evidence:
        'Settlement is the receipt, read back before `confirmed` is returned. It arrives through originate(), not through a delivery — see settlementFromOrigination.',
    },
    reverse: {
      supported: false,
      reason:
        'A confirmed chain transfer is final: no return code, no chargeback, no recall. supportsReturns has been false and returnWindowDays null for this rail since it was written. A reverted transaction is a failed origination, not a reversal.',
    },
    probe: {
      supported: true,
      proof: 'measured',
      evidence: mediated
        ? 'Circle’s own health call, or an honest not_configured when no TEST_API_KEY is present.'
        : 'Base Sepolia RPC round trip.',
    },
  };
}

/**
 * Wrap either stablecoin provider — direct-signing or Circle.
 *
 * Both, and nothing chooses between them here: `selectStablecoinProvider` in
 * ../stablecoin/circle-registry.ts already owns that decision and refuses to
 * fall back, and re-deciding it in an adapter is how two modules come to
 * disagree about which rail moved the money.
 */
export function stablecoinRailAdapter(
  provider: StablecoinPayoutProvider,
): OriginatingRail<StablecoinPayoutInstruction> {
  const identity: RailIdentity = {
    slot: 'usdc',
    provider: provider.id,
    title: provider.label,
    // This rail has no simulator and never fabricates one. `OutcomeBase.evidence`
    // is the literal 'live' in ../stablecoin/types.ts for the same reason.
    evidence: 'live',
    environment: 'sandbox',
  };

  return {
    identity,
    supports: supportFor(provider),

    async originate(instruction: StablecoinPayoutInstruction): Promise<RailOrigination> {
      const outcome = await provider.send(instruction);
      return {
        slot: 'usdc',
        provider: outcome.provider,
        evidence: outcome.evidence,
        ref: originationRef(outcome),
        // From the OUTCOME, not the instruction: what moved is what the chain
        // says moved, and on a refusal the two are the same number only by
        // coincidence.
        amount: outcome.amount.currency === 'USDC' ? outcome.amount : usdc(outcome.amount.amount),
        status: originationStatus(outcome),
        at: originationAt(outcome),
        raw: outcome,
      };
    },

    async probe(): Promise<RailProbe> {
      const health = await provider.health();
      return makeRailProbe(identity, {
        liveness: railLiveness(health.liveness),
        detail: health.detail,
        ms: health.ms,
      });
    },
  };
}
