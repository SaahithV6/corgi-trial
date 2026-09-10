/**
 * The USDC payout rail.
 *
 * `./adapter.ts` is the money path; `./ledger.ts` is the posting. They are
 * separate on purpose — the adapter has no database handle and the ledger
 * module has no network — so the transaction can be sent and settled in one
 * process and posted in another, which is what makes the crash-recovery story
 * in ./adapter.ts's header true rather than aspirational.
 */

export { BaseRpc, RpcError, encodeTransferCall, ERC20_TRANSFER_TOPIC } from "./client";
export {
  DEFAULT_LOOKBACK_BLOCKS,
  confirmedOrNull,
  findExistingTransfer,
  sendUsdcPayout,
  settleTransaction,
  type PayoutHooks,
  type PayoutOptions,
} from "./adapter";
export { blockValueDate, payoutAllocation, type PayoutAllocation } from "./allocation";
export { postUsdcPayout, type PostedLine, type UsdcPayoutPosting, type UsdcPayoutPostingInput } from "./ledger";
export { signTransaction, signingHash, type Eip1559Fields, type SignedTransaction } from "./tx";
export { addressFromPrivateKey, parsePrivateKey, publicKey, sign, SigningError } from "./secp256k1";
export { keccak256, keccak256Utf8 } from "./keccak";
export {
  USDC_DECIMALS,
  USDC_PROVIDER,
  USDC_UNITS_PER_CENT,
  formatUsdc,
  isConfirmed,
  payoutIdempotencyKey,
  splitUsdcUnits,
  usdc,
  type ConfirmedPayout,
  type GasFacts,
  type PayoutOutcome,
  type PayoutRefusal,
  type ReceiptFacts,
  type UsdcPayoutRequest,
} from "./types";
