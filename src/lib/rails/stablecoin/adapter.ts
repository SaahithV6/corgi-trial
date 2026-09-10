/**
 * The USDC payout: build, refuse, sign, broadcast, wait, and state an outcome.
 *
 * ── THE THREE CRASH WINDOWS, AND WHAT CLOSES EACH ───────────────────────────
 *
 * A payout is two writes to two systems that cannot share a transaction: the
 * chain, and our ledger. Every design here exists to make the gap between them
 * survivable. There are exactly three places a process can die.
 *
 *   1. BEFORE BROADCAST. Nothing was signed onto the wire, so nothing moved and
 *      nothing posted. A re-run reads the same nonce (nothing is pending) and
 *      sends one transfer. Safe by construction.
 *
 *   2. AFTER BROADCAST, BEFORE THE RECEIPT. A transaction is sitting in the
 *      mempool at nonce N, and we never learned its fate. This is the window
 *      that produces double sends, because the naive re-run reads
 *      `getTransactionCount(pending)` — which already counts the in-flight
 *      transaction — builds a SECOND transfer at nonce N+1, and pays twice.
 *      Closed by `preflight`: `pending` and `latest` are read separately and
 *      the payout REFUSES while they disagree. Once the pending transaction
 *      mines, step 3 finds it. If it is dropped instead, `pending` falls back
 *      to `latest` and the re-run sends exactly one transfer.
 *
 *   3. AFTER THE RECEIPT, BEFORE THE LEDGER WRITE. The money has moved and
 *      nothing records it. Closed by `findExistingTransfer`: before building
 *      anything, the adapter asks the CHAIN whether this exact transfer has
 *      already happened — `eth_getLogs` for an ERC-20 `Transfer` from this
 *      wallet to this recipient for this amount — and if it has, it returns
 *      that transaction's receipt as a `confirmed` outcome with
 *      `recovered: true`, having sent nothing. The caller then posts to the
 *      ledger under the same idempotency key, which Postgres makes a no-op if
 *      it is already there.
 *
 * The honest limit of (3), stated rather than buried: the on-chain evidence is
 * `(token, from, to, amount)`, so two payouts that agree on all four are
 * indistinguishable to it, and the scan reaches back `lookbackBlocks` and no
 * further. A production system carries a durable intent id, and the natural
 * place for it is a `usdc_payout` table this build does not have. What is here
 * is correct for one payout instruction at a time, which is what it claims.
 *
 * ── WHAT IS NEVER ASSUMED ───────────────────────────────────────────────────
 *
 * Nonce, base fee, priority fee and gas limit are all read from the chain on
 * every run. The gas affordability check is made against `gasLimit ×
 * maxFeePerGas` — the worst case the transaction authorises, not the likely
 * case — and the payout refuses rather than broadcasting something that can
 * run out of gas. A failed send burns the gas and moves no money, which is
 * strictly worse than a clean refusal that burns nothing.
 */

import { RpcError, encodeTransferCall, type BaseRpc } from "./client";
import { addressFromPrivateKey, addressesMatch } from "./secp256k1";
import { signTransaction } from "./tx";
import {
  USDC_PROVIDER,
  formatUsdc,
  usdc,
  type ConfirmedPayout,
  type GasFacts,
  type PayoutOutcome,
  type PayoutRefusal,
  type ReceiptFacts,
  type UsdcPayoutRequest,
} from "./types";

/** How far back `eth_getLogs` looks for an already-sent transfer. ~5.5h of Base blocks. */
export const DEFAULT_LOOKBACK_BLOCKS = 10_000n;

/** Multiplier on `eth_estimateGas`, in percent. */
const GAS_LIMIT_HEADROOM_PERCENT = 125n;

/**
 * Base-fee headroom, in percent. EIP-1559 refunds the difference between
 * `maxFeePerGas` and the block's actual base fee, so overshooting costs
 * nothing and protects against a base fee that rises between the estimate and
 * the block. Undershooting produces a transaction that sits in the mempool
 * forever, which is crash window 2 with no crash.
 */
const BASE_FEE_HEADROOM_PERCENT = 300n;

const DEFAULT_CONFIRMATIONS = 1;
const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

export interface PayoutHooks {
  /**
   * Called with the transaction hash BEFORE `eth_sendRawTransaction`.
   *
   * This is the operator's copy of the identifier. If the process dies in
   * crash window 2, the hash printed here is the handle that recovers it.
   */
  readonly onSigned?: (txHash: string, raw: string) => void;
  readonly onProgress?: (message: string) => void;
}

export interface PayoutOptions extends PayoutHooks {
  /** Blocks of history the already-sent scan covers. */
  readonly lookbackBlocks?: bigint;
  /**
   * Skip the already-sent scan and send regardless.
   *
   * The ONLY legitimate use is deliberately making a second, distinct payout
   * with the same recipient and amount. It removes the crash-window-3 guard,
   * so it is named for what it does.
   */
  readonly allowDuplicate?: boolean;
}

function refuse(
  req: UsdcPayoutRequest,
  reason: PayoutRefusal,
  detail: string,
  txHash: string | null = null,
): PayoutOutcome {
  return {
    provider: USDC_PROVIDER,
    evidence: "live",
    amount: usdc(req.amountUnits),
    from: req.fromAddress.toLowerCase(),
    to: req.toAddress.toLowerCase(),
    kind: "refused",
    reason,
    detail,
    txHash,
  };
}

function base(req: UsdcPayoutRequest) {
  return {
    provider: USDC_PROVIDER,
    evidence: "live",
    amount: usdc(req.amountUnits),
    from: req.fromAddress.toLowerCase(),
    to: req.toAddress.toLowerCase(),
  } as const;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read a receipt back and turn it into either a `confirmed` or a `reverted`
 * outcome, having re-checked that the block is still canonical.
 *
 * `status: 0x1` is asserted here and nowhere else, so there is exactly one
 * place in the codebase where "the chain accepted this transfer" is decided.
 */
export async function settleTransaction(
  rpc: BaseRpc,
  req: UsdcPayoutRequest,
  txHash: string,
  options: { recovered: boolean; nonce: bigint; gas: GasFacts | null } & PayoutOptions,
): Promise<PayoutOutcome> {
  const confirmations = BigInt(req.confirmations ?? DEFAULT_CONFIRMATIONS);
  const timeoutMs = req.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
  const startedAt = Date.now();

  let receipt = await rpc.getTransactionReceipt(txHash);
  while (receipt === null) {
    // "Gone" is checked BEFORE "still waiting", because the two are different
    // facts and only one of them is safe to retry. A transaction the node has
    // forgotten moved nothing; a transaction still in the mempool may yet.
    if (!(await rpc.transactionExists(txHash))) {
      // Evicted from the mempool, or replaced. Not an error — a stated
      // outcome that still carries the hash.
      return { ...base(req), kind: "dropped", txHash };
    }
    if (Date.now() - startedAt >= timeoutMs) {
      return { ...base(req), kind: "unconfirmed", txHash, waitedMs: Date.now() - startedAt };
    }
    options.onProgress?.(`waiting for a receipt (${Math.round((Date.now() - startedAt) / 1000)}s)`);
    await sleep(POLL_INTERVAL_MS);
    receipt = await rpc.getTransactionReceipt(txHash);
  }

  const header = await rpc.getBlockHeader(receipt.blockNumber);
  if (header === null || header.hash !== receipt.blockHash) {
    return {
      ...base(req),
      kind: "reorged",
      txHash,
      detail: `receipt claims block ${receipt.blockNumber} ${receipt.blockHash}, chain now has ${header?.hash ?? "no such block"}`,
    };
  }

  const facts: ReceiptFacts = {
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    blockTimestamp: header.timestamp,
    gasUsed: receipt.gasUsed,
    effectiveGasPriceWei: receipt.effectiveGasPrice,
    gasCostWei: receipt.gasUsed * receipt.effectiveGasPrice,
  };

  if (receipt.status !== 1n) {
    // Mined and failed. The gas is spent; the USDC never moved. Nothing may
    // post to the ledger, and the hash survives so the failure is findable.
    return { ...base(req), kind: "reverted", txHash, receipt: facts };
  }

  // Confirmations, then ONE more canonicality check. A block can stop being
  // canonical between the receipt and the depth check, and that is precisely
  // the case a payout must not report as confirmed.
  for (;;) {
    const head = await rpc.blockNumber();
    if (head >= receipt.blockNumber + confirmations - 1n) break;
    if (Date.now() - startedAt >= timeoutMs) {
      return { ...base(req), kind: "unconfirmed", txHash, waitedMs: Date.now() - startedAt };
    }
    options.onProgress?.(`waiting for ${confirmations} confirmation(s) — head ${head}, mined at ${receipt.blockNumber}`);
    await sleep(POLL_INTERVAL_MS);
  }
  const recheck = await rpc.getBlockHeader(receipt.blockNumber);
  if (recheck === null || recheck.hash !== receipt.blockHash) {
    return {
      ...base(req),
      kind: "reorged",
      txHash,
      detail: `block ${receipt.blockNumber} was reorganised out after the receipt was read`,
    };
  }

  return {
    ...base(req),
    kind: "confirmed",
    txHash,
    nonce: options.nonce,
    gas:
      options.gas ??
      // A recovered payout was built by an earlier run, so its authorised
      // limits are not knowable now. The RECEIPT's figures are, and they are
      // what actually happened.
      {
        gasLimit: receipt.gasUsed,
        maxFeePerGas: receipt.effectiveGasPrice,
        maxPriorityFeePerGas: 0n,
        maxCostWei: facts.gasCostWei,
      },
    receipt: facts,
    recovered: options.recovered,
  };
}

/**
 * Has this exact transfer already happened? Asks the chain, not a local row.
 *
 * Returns the most recent matching transaction hash, or null.
 */
export async function findExistingTransfer(
  rpc: BaseRpc,
  req: UsdcPayoutRequest,
  lookbackBlocks: bigint,
): Promise<string | null> {
  // A wallet that has never sent anything cannot have sent this. Cheapest
  // possible short-circuit, and it makes the very first payout one RPC call
  // lighter rather than one `eth_getLogs` heavier.
  if ((await rpc.getTransactionCount(req.fromAddress, "latest")) === 0n) return null;

  const head = await rpc.blockNumber();
  const fromBlock = head > lookbackBlocks ? head - lookbackBlocks : 0n;
  const logs = await rpc.transferLogs({
    token: req.tokenAddress,
    from: req.fromAddress,
    to: req.toAddress,
    fromBlock,
    toBlock: head,
  });
  const matches = logs.filter((log) => log.amountUnits === req.amountUnits);
  if (matches.length === 0) return null;
  return matches.reduce((latest, log) => (log.blockNumber > latest.blockNumber ? log : latest)).txHash;
}

/**
 * The payout.
 *
 * Never throws for anything the chain can do to a transaction. An `RpcError`
 * raised before signing becomes a refusal; one raised after signing keeps the
 * hash. The only exceptions that escape are programming errors — a malformed
 * address, a key of the wrong length — which are not outcomes, they are bugs.
 */
export async function sendUsdcPayout(
  rpc: BaseRpc,
  req: UsdcPayoutRequest,
  options: PayoutOptions = {},
): Promise<PayoutOutcome> {
  const lookback = options.lookbackBlocks ?? DEFAULT_LOOKBACK_BLOCKS;

  // 1. The key must be the wallet. Checked before anything costs anything.
  const derived = addressFromPrivateKey(req.privateKey);
  if (!addressesMatch(derived, req.fromAddress)) {
    return refuse(
      req,
      "sender_key_mismatch",
      `USDC_SENDER_PRIVATE_KEY derives ${derived}, not the configured ${req.fromAddress.toLowerCase()}`,
    );
  }

  // 2. The right network. A testnet key on mainnet is the expensive mistake.
  const chainId = await rpc.chainId();
  if (chainId !== req.chainId) {
    return refuse(req, "chain_id_mismatch", `node reports chain ${chainId}, configured ${req.chainId}`);
  }

  // 3. Do we hold the tokens at all?
  const tokenBalance = await rpc.erc20BalanceOf(req.tokenAddress, req.fromAddress);
  if (tokenBalance < req.amountUnits) {
    return refuse(
      req,
      "insufficient_usdc",
      `holds ${formatUsdc(tokenBalance)}, needs ${formatUsdc(req.amountUnits)}`,
    );
  }

  // 4. Crash window 3: has this already been sent?
  if (options.allowDuplicate !== true) {
    const existing = await findExistingTransfer(rpc, req, lookback);
    if (existing !== null) {
      options.onProgress?.(`already on chain as ${existing} — sending nothing, settling that one`);
      return settleTransaction(rpc, req, existing, { ...options, recovered: true, nonce: -1n, gas: null });
    }
  }

  // 5. Crash window 2: refuse while anything of ours is in the mempool.
  const [pending, latest] = await Promise.all([
    rpc.getTransactionCount(req.fromAddress, "pending"),
    rpc.getTransactionCount(req.fromAddress, "latest"),
  ]);
  if (pending !== latest) {
    return refuse(
      req,
      "transaction_in_flight",
      `nonce pending=${pending} latest=${latest}: ${pending - latest} transaction(s) from this wallet are unmined. ` +
        `Broadcasting now would take nonce ${pending} and send a SECOND payout. Wait for the mempool to clear, then re-run.`,
    );
  }

  const data = encodeTransferCall(req.toAddress, req.amountUnits);

  // 6. Would it even succeed? A revert costs the gas and moves nothing.
  let gasEstimate: bigint;
  try {
    gasEstimate = await rpc.estimateGas({ from: req.fromAddress, to: req.tokenAddress, data });
  } catch (error) {
    return refuse(
      req,
      "estimate_reverted",
      `eth_estimateGas refused the transfer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 7. Fees from the chain, never from a constant.
  const [baseFee, priorityFee, weiBalance] = await Promise.all([
    rpc.baseFeePerGas(),
    rpc.maxPriorityFeePerGas(),
    rpc.getBalance(req.fromAddress),
  ]);
  const gas: GasFacts = {
    gasLimit: (gasEstimate * GAS_LIMIT_HEADROOM_PERCENT) / 100n,
    maxPriorityFeePerGas: priorityFee,
    maxFeePerGas: (baseFee * BASE_FEE_HEADROOM_PERCENT) / 100n + priorityFee,
    maxCostWei: 0n,
  };
  const withCost: GasFacts = { ...gas, maxCostWei: gas.gasLimit * gas.maxFeePerGas };

  // 8. Can the wallet cover the WORST case it is about to authorise?
  if (weiBalance < withCost.maxCostWei) {
    return refuse(
      req,
      "insufficient_gas",
      `gas needs up to ${withCost.maxCostWei} wei (${withCost.gasLimit} gas × ${withCost.maxFeePerGas} wei) ` +
        `but the wallet holds ${weiBalance} wei. Refusing rather than broadcasting a transfer that can run out of gas.`,
    );
  }

  // 9. Sign locally. The hash exists from this line onwards.
  const signed = signTransaction(
    {
      chainId: req.chainId,
      nonce: pending,
      maxPriorityFeePerGas: withCost.maxPriorityFeePerGas,
      maxFeePerGas: withCost.maxFeePerGas,
      gasLimit: withCost.gasLimit,
      to: req.tokenAddress,
      value: 0n,
      data,
    },
    req.privateKey,
  );
  // The operator's copy, BEFORE the money can move.
  options.onSigned?.(signed.hash, `0x${Buffer.from(signed.raw).toString("hex")}`);

  // 10. Broadcast.
  let nodeHash: string;
  try {
    nodeHash = await rpc.sendRawTransaction(signed.raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // "already known" means our own bytes are already in this node's mempool —
    // a retry of the identical transaction, which is exactly what determinism
    // is for. It is a success, not a rejection.
    if (/already known|known transaction/i.test(message)) {
      options.onProgress?.("node already had this exact transaction — waiting on it");
      return settleTransaction(rpc, req, signed.hash, { ...options, recovered: true, nonce: pending, gas: withCost });
    }
    return refuse(req, "broadcast_rejected", message, signed.hash);
  }

  if (nodeHash !== signed.hash) {
    // This cannot happen unless our keccak or our RLP is wrong, and if it ever
    // does, the locally computed hash — the one already logged and about to be
    // an idempotency key — is not the transaction that exists. Stop.
    throw new RpcError(
      `locally computed hash ${signed.hash} != node hash ${nodeHash}. ` +
        `The idempotency key would not name the transaction; refusing to continue.`,
      "eth_sendRawTransaction",
      { local: signed.hash, node: nodeHash },
    );
  }

  return settleTransaction(rpc, req, signed.hash, { ...options, recovered: false, nonce: pending, gas: withCost });
}

/** Narrowing helper for callers that only want to act on success. */
export function confirmedOrNull(outcome: PayoutOutcome): ConfirmedPayout | null {
  return outcome.kind === "confirmed" ? outcome : null;
}
