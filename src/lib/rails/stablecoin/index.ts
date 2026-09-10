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
  directStablecoinProvider,
  findExistingTransfer,
  sendUsdcPayout,
  settleTransaction,
  type PayoutHooks,
  type PayoutOptions,
} from "./adapter";

// ── The second provider ────────────────────────────────────────────────────
// Circle, behind the identical interface. Nothing below the provider boundary
// changed to accommodate it: same postUsdcPayout, same accounts, same cents,
// same idempotency key derived from the same on-chain transaction hash.
export {
  CIRCLE_BASE_URL,
  CIRCLE_BLOCKCHAIN,
  CIRCLE_CHAIN_ID,
  describeCircleConfig,
  readCircleConfig,
  type CircleConfig,
  type CircleConfigResult,
  type EnvSource,
} from "./circle-config";
export {
  CircleClient,
  CircleError,
  type CircleClientOptions,
  type CircleTransferRequest,
  type Idempotent,
} from "./circle-client";
export {
  CIRCLE_INITIATED_STATE,
  CIRCLE_SUCCESS_STATE,
  CIRCLE_TERMINAL_STATES,
  circleAmountToUnits,
  isTerminal,
  unitsToCircleAmount,
  type CircleTerminalState,
  type CircleTokenBalance,
  type CircleTransaction,
  type CircleWallet,
  type CircleWalletSet,
} from "./circle-types";
export {
  CIRCLE_LABEL,
  circleStablecoinProvider,
  pollUntilTerminal,
  provisionCircleWallet,
  resolveCircleTokenId,
  resolveCircleWallet,
  unconfiguredCircleProvider,
  verifyTransferOnChain,
  type ChainEvidence,
  type CircleProviderOptions,
  type PollResult,
} from "./circle-provider";
export {
  DIRECT_LABEL,
  PROVIDER_ENV_KEY,
  circleProvider,
  describeSelection,
  directProvider,
  providerLabel,
  selectStablecoinProvider,
  stablecoinProviderHealth,
  type RegistryOptions,
  type Selection,
} from "./circle-registry";
export {
  readWalletUnitsFromChain,
  reconcileUsdcWallet,
  type UsdcWalletReconciliation,
  type UsdcWalletReconciliationInput,
} from "./circle-recon";
export { blockValueDate, payoutAllocation, type PayoutAllocation } from "./allocation";
export { postUsdcPayout, type PostedLine, type UsdcPayoutPosting, type UsdcPayoutPostingInput } from "./ledger";
export { signTransaction, signingHash, type Eip1559Fields, type SignedTransaction } from "./tx";
export { addressFromPrivateKey, parsePrivateKey, publicKey, sign, SigningError } from "./secp256k1";
export { keccak256, keccak256Utf8 } from "./keccak";
export {
  CIRCLE_PROVIDER,
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
  type ProviderHealth,
  type ProviderLiveness,
  type ReceiptFacts,
  type StablecoinPayoutInstruction,
  type StablecoinPayoutProvider,
  type StablecoinProviderId,
  type UsdcPayoutRequest,
} from "./types";
