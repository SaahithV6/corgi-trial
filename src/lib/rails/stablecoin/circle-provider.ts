/**
 * Circle as a second stablecoin provider, behind the same interface.
 *
 * ── WHAT THIS FILE IS ACTUALLY FOR ───────────────────────────────────────────
 *
 * "A rail is an adapter, not a schema" is a claim, and one provider cannot
 * demonstrate it. This is the second one. Everything below the provider
 * boundary is unchanged by its arrival: the same `postUsdcPayout`, the same
 * chart accounts, the same cents, the same dust rule, the same idempotency key
 * derived from the same on-chain transaction hash. What changed is a slug on
 * an outcome and two failure modes a mediated provider can have and a
 * self-signing one cannot.
 *
 * ── THE SHAPE THAT MAKES CIRCLE DIFFERENT, AND DANGEROUS ─────────────────────
 *
 * The direct path in ./adapter.ts knows the transaction hash BEFORE the money
 * can move, because it signs the bytes and the hash is keccak256 of those
 * bytes. Circle inverts this. `POST /v1/w3s/developer/transactions/transfer`
 * answers `{id, state: "INITIATED"}` — no hash, no chain, nothing to look up —
 * and the hash arrives later on a poll.
 *
 * So there is a window in which Circle has an id, we have an id, money may be
 * about to move, and there is no chain evidence of anything. Everything about
 * this file's control flow exists to make that window unpostable:
 *
 *   INITIATED / QUEUED / SENT   -> `acknowledged`, `txHash: null`. Not payable.
 *   terminal, no hash           -> `refused: provider_declined`. Nothing moved.
 *   terminal, hash              -> hand the hash to BASE SEPOLIA and ask.
 *
 * There is no branch in which a Circle state becomes a `confirmed` outcome.
 * The only constructor of `confirmed` in this package is `settleTransaction`,
 * which reads a receipt off a node, asserts `status: 0x1`, and re-checks that
 * the block is still canonical. Circle cannot reach the ledger except through
 * it. DECISIONS 011 and 030 wrote that rule for the direct path; Circle is the
 * provider the rule was really waiting for.
 *
 * ── AND THEN WE DO NOT BELIEVE THE RECEIPT EITHER ────────────────────────────
 *
 * A receipt with `status: 0x1` proves that SOME transaction succeeded. For the
 * direct path that is enough, because we built its calldata. For Circle it is
 * not: Circle built the calldata, and a successful transaction is not
 * necessarily OUR transfer. So after the receipt, `verifyTransferOnChain` pulls
 * the ERC-20 `Transfer` logs for that exact hash and requires one from our
 * wallet, to our recipient, for our exact minor units. A mismatch is
 * `unverified` and posts nothing.
 *
 * That is the trial's own non-negotiable applied where it actually bites:
 * "your payment provider's balance is their ledger, not yours". Circle's async
 * shape is precisely what tempts an implementation to take the provider's word,
 * because the provider's word arrives first and looks authoritative.
 */

import { findExistingTransfer, settleTransaction, DEFAULT_LOOKBACK_BLOCKS } from "./adapter";
import { CircleClient, CircleError, type FetchLike } from "./circle-client";
import { CIRCLE_BLOCKCHAIN, CIRCLE_CHAIN_ID, type CircleConfig } from "./circle-config";
import {
  CIRCLE_INITIATED_STATE,
  CIRCLE_SUCCESS_STATE,
  circleAmountToUnits,
  isTerminal,
  unitsToCircleAmount,
  type CircleTransaction,
  type CircleWallet,
} from "./circle-types";
import type { BaseRpc } from "./client";
import {
  CIRCLE_PROVIDER,
  formatUsdc,
  usdc,
  type PayoutOutcome,
  type PayoutRefusal,
  type ProviderHealth,
  type ProviderLiveness,
  type StablecoinPayoutInstruction,
  type StablecoinPayoutProvider,
} from "./types";

/** What a human sees. Never the slug on its own. */
export const CIRCLE_LABEL = "Circle Web3 Services, Base Sepolia";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Circle reaches a terminal state on Base Sepolia in seconds; this is slack. */
const DEFAULT_POLL_TIMEOUT_MS = 180_000;

export interface CircleProviderOptions {
  readonly config: CircleConfig;
  /** The same Base Sepolia client the direct path uses. Circle is verified with it. */
  readonly rpc: BaseRpc;
  /** Injected in tests. Constructed from `config` when absent. */
  readonly client?: CircleClient;
  readonly fetchImpl?: FetchLike;
  readonly onProgress?: (message: string) => void;
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
  readonly lookbackBlocks?: bigint;
  /**
   * Skip the already-sent chain scan. Same meaning and same danger as the
   * direct path's option of the same name: it removes the crash-window-3 guard.
   */
  readonly allowDuplicate?: boolean;
  /** Echoed onto the Circle transaction. Useful for a payout reference. */
  readonly refId?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function outcomeBase(instruction: StablecoinPayoutInstruction) {
  return {
    provider: CIRCLE_PROVIDER,
    evidence: "live",
    amount: usdc(instruction.amountUnits),
    from: instruction.fromAddress.toLowerCase(),
    to: instruction.toAddress.toLowerCase(),
  } as const;
}

function refuse(
  instruction: StablecoinPayoutInstruction,
  reason: PayoutRefusal,
  detail: string,
): PayoutOutcome {
  return { ...outcomeBase(instruction), kind: "refused", reason, detail, txHash: null };
}

// ---------------------------------------------------------------------------
// The verification that makes this ours rather than Circle's
// ---------------------------------------------------------------------------

export interface ChainEvidence {
  readonly matched: boolean;
  readonly detail: string;
}

/**
 * Does this transaction hash actually carry the transfer we instructed?
 *
 * Reads the ERC-20 `Transfer` logs the chain holds for `(token, from, to)` in
 * the block the receipt named, and requires one whose transaction hash is this
 * one and whose amount is our exact minor units. Nothing about Circle's
 * account of events is consulted.
 *
 * The narrow block window is deliberate: the receipt already told us which
 * block, so scanning further would only widen the chance of matching somebody
 * else's identical transfer.
 */
export async function verifyTransferOnChain(
  rpc: BaseRpc,
  instruction: StablecoinPayoutInstruction,
  txHash: string,
  blockNumber: bigint,
): Promise<ChainEvidence> {
  const logs = await rpc.transferLogs({
    token: instruction.tokenAddress,
    from: instruction.fromAddress,
    to: instruction.toAddress,
    fromBlock: blockNumber,
    toBlock: blockNumber,
  });
  const wanted = txHash.toLowerCase();
  const mine = logs.filter((log) => log.txHash.toLowerCase() === wanted);
  if (mine.length === 0) {
    return {
      matched: false,
      detail:
        `${txHash} mined in block ${blockNumber} with status 0x1, but it carries no ERC-20 Transfer of ` +
        `${instruction.tokenAddress} from ${instruction.fromAddress.toLowerCase()} to ${instruction.toAddress.toLowerCase()}. ` +
        `The provider named a transaction that is not this payout.`,
    };
  }
  const exact = mine.find((log) => log.amountUnits === instruction.amountUnits);
  if (exact === undefined) {
    return {
      matched: false,
      detail:
        `${txHash} transfers ${mine.map((l) => formatUsdc(l.amountUnits)).join(", ")} on this route, ` +
        `not the instructed ${formatUsdc(instruction.amountUnits)}.`,
    };
  }
  return {
    matched: true,
    detail: `Transfer log in block ${blockNumber} matches: ${formatUsdc(exact.amountUnits)} to ${instruction.toAddress.toLowerCase()}`,
  };
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export interface PollResult {
  readonly transaction: CircleTransaction;
  readonly terminal: boolean;
  readonly waitedMs: number;
  readonly polls: number;
}

/**
 * Poll until Circle reaches a terminal state, or until the clock runs out.
 *
 * `isTerminal` is consulted here and only here. A non-terminal state is never
 * interpreted, never rounded up, and never returned as anything but
 * `terminal: false`.
 */
export async function pollUntilTerminal(
  client: CircleClient,
  transactionId: string,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    onProgress?: (message: string) => void;
  } = {},
): Promise<PollResult> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const startedAt = Date.now();
  let polls = 0;
  let transaction = await client.getTransaction(transactionId);
  polls += 1;

  while (!isTerminal(transaction.state)) {
    if (Date.now() - startedAt >= timeoutMs) {
      return { transaction, terminal: false, waitedMs: Date.now() - startedAt, polls };
    }
    options.onProgress?.(
      `circle ${transactionId} is ${transaction.state}` +
        `${transaction.txHash === null ? " — no txHash yet" : ` — txHash ${transaction.txHash}`} ` +
        `(${Math.round((Date.now() - startedAt) / 1000)}s)`,
    );
    await sleep(intervalMs);
    transaction = await client.getTransaction(transactionId);
    polls += 1;
  }
  return { transaction, terminal: true, waitedMs: Date.now() - startedAt, polls };
}

// ---------------------------------------------------------------------------
// Wallet and token resolution
// ---------------------------------------------------------------------------

/**
 * The Base Sepolia wallet money leaves from.
 *
 * `CIRCLE_WALLET_ID` pins it when set. When it is not, exactly one
 * BASE-SEPOLIA wallet is acceptable and anything else is an error — picking
 * "the first" out of several would make which account paid depend on Circle's
 * list ordering, which is not a thing to decide a payment on.
 *
 * This never CREATES a wallet. Provisioning is a deliberate act with its own
 * function, below, so that a payout call can never quietly mint an account.
 */
export async function resolveCircleWallet(
  client: CircleClient,
  config: CircleConfig,
): Promise<CircleWallet> {
  if (config.walletId !== null) return client.getWallet(config.walletId);
  const filter =
    config.walletSetId === null
      ? { blockchain: CIRCLE_BLOCKCHAIN }
      : { blockchain: CIRCLE_BLOCKCHAIN, walletSetId: config.walletSetId };
  const wallets = await client.listWallets(filter);
  if (wallets.length === 1 && wallets[0] !== undefined) return wallets[0];
  throw new Error(
    wallets.length === 0
      ? `no ${CIRCLE_BLOCKCHAIN} wallet exists on this Circle account. Provision one with provisionCircleWallet(), then set CIRCLE_WALLET_ID.`
      : `${wallets.length} ${CIRCLE_BLOCKCHAIN} wallets exist; set CIRCLE_WALLET_ID to say which one pays.`,
  );
}

/**
 * Circle's uuid for the USDC contract this instruction names.
 *
 * Resolved from the wallet's own balances and matched on CONTRACT ADDRESS, not
 * on the symbol — "USDC" is a string anybody can put on a token, and the
 * address is the thing the ledger's account 1140 is denominated in.
 */
export async function resolveCircleTokenId(
  client: CircleClient,
  config: CircleConfig,
  walletId: string,
  tokenAddress: string,
): Promise<string> {
  if (config.tokenId !== null) return config.tokenId;
  const balances = await client.walletBalances(walletId);
  const wanted = tokenAddress.toLowerCase();
  const match = balances.find((b) => b.tokenAddress?.toLowerCase() === wanted);
  if (match === undefined) {
    throw new Error(
      `Circle wallet ${walletId} reports no balance for token ${wanted}; ` +
        `holds [${balances.map((b) => `${b.symbol ?? "?"}=${b.amount}`).join(", ") || "nothing"}]. ` +
        `Set CIRCLE_TOKEN_ID to instruct a transfer anyway.`,
    );
  }
  return match.tokenId;
}

/**
 * Create a wallet set and a wallet. A one-time operator action, not a payout step.
 *
 * Separate from `send` on purpose: an adapter that provisions accounts as a
 * side effect of moving money is one restart away from owning several.
 */
export async function provisionCircleWallet(
  client: CircleClient,
  options: { walletSetName?: string; accountType?: "EOA" | "SCA" } = {},
): Promise<{ walletSetId: string; wallet: CircleWallet }> {
  const created = await client.createWalletSet(options.walletSetName ?? "corgi-trial payouts");
  const wallets = await client.createWallets({
    walletSetId: created.result.id,
    blockchains: [CIRCLE_BLOCKCHAIN],
    accountType: options.accountType ?? "EOA",
    count: 1,
  });
  const wallet = wallets.result[0];
  if (wallet === undefined) throw new Error("Circle created a wallet set but returned no wallet");
  return { walletSetId: created.result.id, wallet };
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

function livenessFor(error: unknown): { liveness: ProviderLiveness; detail: string } {
  if (error instanceof CircleError) {
    // 0 is "we never got an answer". Never collapsed into `unauthorised`:
    // one is a wrong key, the other is a bad afternoon. DECISIONS 011.
    if (error.status === 0) return { liveness: "unreachable", detail: error.message };
    if (error.status === 401 || error.status === 403) {
      return { liveness: "unauthorised", detail: error.message };
    }
    return { liveness: "unreachable", detail: error.message };
  }
  return { liveness: "unreachable", detail: error instanceof Error ? error.message : String(error) };
}

/**
 * A provider that exists, answers, and cannot move money.
 *
 * This is what "degrades honestly" means concretely. When `CIRCLE_API_KEY` is
 * absent the caller still gets a `StablecoinPayoutProvider` — health reports
 * `not_configured` with the reason, and `send` refuses with
 * `provider_not_configured`. It does not throw at construction, it does not
 * report `live`, and above all it does not silently hand the payout to the
 * direct-to-chain path: that would move money over a rail nobody selected and
 * write a provider slug into the ledger that the operator did not choose.
 */
export function unconfiguredCircleProvider(detail: string): StablecoinPayoutProvider {
  return {
    id: CIRCLE_PROVIDER,
    label: CIRCLE_LABEL,
    health(): Promise<ProviderHealth> {
      return Promise.resolve({
        provider: CIRCLE_PROVIDER,
        label: CIRCLE_LABEL,
        liveness: "not_configured",
        detail,
        ms: 0,
      });
    },
    send(instruction: StablecoinPayoutInstruction): Promise<PayoutOutcome> {
      return Promise.resolve(refuse(instruction, "provider_not_configured", detail));
    },
  };
}

/** The wired provider. `config` has already been validated by ./circle-config.ts. */
export function circleStablecoinProvider(options: CircleProviderOptions): StablecoinPayoutProvider {
  const { config, rpc } = options;
  const client =
    options.client ??
    new CircleClient({
      config,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  const progress = options.onProgress;
  const lookback = options.lookbackBlocks ?? DEFAULT_LOOKBACK_BLOCKS;

  async function health(): Promise<ProviderHealth> {
    const started = Date.now();
    const report = (liveness: ProviderLiveness, detail: string): ProviderHealth => ({
      provider: CIRCLE_PROVIDER,
      label: CIRCLE_LABEL,
      liveness,
      detail,
      ms: Date.now() - started,
    });
    try {
      // A real authenticated round trip, not the presence of a string.
      await client.ping();
    } catch (error) {
      const { liveness, detail } = livenessFor(error);
      return report(liveness, detail);
    }
    try {
      const wallet = await resolveCircleWallet(client, config);
      return report(
        "live",
        `entity key retrieved; wallet ${wallet.id} (${wallet.address}) on ${wallet.blockchain}, state ${wallet.state}`,
      );
    } catch (error) {
      // Authenticated, but not yet able to pay: a credential that works and a
      // rail that cannot move money are different facts and neither is `live`.
      return report(
        "unauthorised",
        `credential works but no sending wallet: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function send(instruction: StablecoinPayoutInstruction): Promise<PayoutOutcome> {
    // 1. The right network, twice: Circle's blockchain name and the node's own
    //    chain id have to agree with what the caller asked for.
    if (instruction.chainId !== CIRCLE_CHAIN_ID) {
      return refuse(
        instruction,
        "chain_id_mismatch",
        `this provider transfers on ${CIRCLE_BLOCKCHAIN} (chain ${CIRCLE_CHAIN_ID}); the instruction says chain ${instruction.chainId}`,
      );
    }
    let nodeChainId: bigint;
    try {
      nodeChainId = await rpc.chainId();
    } catch (error) {
      return refuse(
        instruction,
        "chain_id_mismatch",
        `cannot reach Base Sepolia to verify anything Circle does: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (nodeChainId !== instruction.chainId) {
      return refuse(instruction, "chain_id_mismatch", `node reports chain ${nodeChainId}, configured ${instruction.chainId}`);
    }

    // 2. Which Circle wallet pays, and is it the address the caller named?
    let wallet: CircleWallet;
    try {
      wallet = await resolveCircleWallet(client, config);
    } catch (error) {
      return refuse(
        instruction,
        "provider_not_configured",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (wallet.address.toLowerCase() !== instruction.fromAddress.toLowerCase()) {
      return refuse(
        instruction,
        "sender_key_mismatch",
        `Circle wallet ${wallet.id} is ${wallet.address.toLowerCase()}, not the instructed ${instruction.fromAddress.toLowerCase()}`,
      );
    }

    // 3. Does the wallet hold the tokens? Asked of the CHAIN, not of Circle.
    //    Circle's own balance endpoint is their ledger; account 1140 is ours.
    let onChainBalance: bigint;
    try {
      onChainBalance = await rpc.erc20BalanceOf(instruction.tokenAddress, wallet.address);
    } catch (error) {
      return refuse(
        instruction,
        "insufficient_usdc",
        `could not read the wallet's on-chain balance: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (onChainBalance < instruction.amountUnits) {
      return refuse(
        instruction,
        "insufficient_usdc",
        `chain says ${wallet.address.toLowerCase()} holds ${formatUsdc(onChainBalance)}, needs ${formatUsdc(instruction.amountUnits)}`,
      );
    }

    // 4. Crash window 3, unchanged from the direct path: has this exact
    //    transfer already happened? The chain is asked, not a local row and
    //    not Circle's transaction list.
    if (options.allowDuplicate !== true) {
      const existing = await findExistingTransfer(rpc, instruction, lookback);
      if (existing !== null) {
        progress?.(`already on chain as ${existing} — instructing nothing, settling that one`);
        return settleAndVerify(instruction, existing, true);
      }
    }

    // 5. Circle's uuid for this contract.
    let tokenId: string;
    try {
      tokenId = await resolveCircleTokenId(client, config, wallet.id, instruction.tokenAddress);
    } catch (error) {
      return refuse(
        instruction,
        "provider_not_configured",
        error instanceof Error ? error.message : String(error),
      );
    }

    // 6. Instruct. This returns an ACKNOWLEDGEMENT and nothing more.
    let accepted;
    try {
      accepted = await client.createTransfer({
        walletId: wallet.id,
        destinationAddress: instruction.toAddress,
        amountUnits: instruction.amountUnits,
        tokenId,
        ...(options.refId === undefined ? {} : { refId: options.refId }),
      });
    } catch (error) {
      if (error instanceof CircleError) {
        return refuse(instruction, "provider_declined", error.message);
      }
      throw error;
    }
    progress?.(
      `circle accepted ${unitsToCircleAmount(instruction.amountUnits)} USDC as transaction ${accepted.result.id} ` +
        `(state ${accepted.result.state}, idempotency key ${accepted.idempotencyKey}) — this is an acknowledgement, not a payment`,
    );

    // 7. Poll to a terminal state. `INITIATED` is not one.
    const polled = await pollUntilTerminal(client, accepted.result.id, {
      ...(options.pollIntervalMs === undefined ? {} : { intervalMs: options.pollIntervalMs }),
      ...(options.pollTimeoutMs === undefined ? {} : { timeoutMs: options.pollTimeoutMs }),
      ...(progress === undefined ? {} : { onProgress: progress }),
    });
    const tx = polled.transaction;

    // 8. Cross-check what Circle says it did against what we asked for. This is
    //    cheap and catches an amount or destination Circle reinterpreted.
    const stated = tx.amounts[0];
    if (stated !== undefined) {
      let statedUnits: bigint | null = null;
      try {
        statedUnits = circleAmountToUnits(stated);
      } catch {
        statedUnits = null;
      }
      if (statedUnits !== null && statedUnits !== instruction.amountUnits) {
        progress?.(
          `circle reports ${stated} USDC where ${unitsToCircleAmount(instruction.amountUnits)} was instructed — the chain decides`,
        );
      }
    }

    if (!polled.terminal) {
      // The clock ran out. If Circle has produced a hash we hand it back as an
      // `unconfirmed` outcome, which the ledger cannot take: the hash is a
      // handle for a later settle, not a claim that anything is done.
      if (tx.txHash !== null) {
        return {
          ...outcomeBase(instruction),
          kind: "unconfirmed",
          txHash: tx.txHash.toLowerCase(),
          waitedMs: polled.waitedMs,
        };
      }
      return {
        ...outcomeBase(instruction),
        kind: "acknowledged",
        providerRef: tx.id,
        state: tx.state,
        waitedMs: polled.waitedMs,
        txHash: null,
      };
    }

    if (tx.txHash === null) {
      // Terminal with no hash: FAILED, CANCELLED or DENIED before anything
      // reached a chain. Nothing to verify and nothing to post.
      return refuse(
        instruction,
        "provider_declined",
        `circle transaction ${tx.id} ended ${tx.state}` +
          `${tx.errorReason === null ? "" : ` (${tx.errorReason})`}` +
          `${tx.errorDetails === null ? "" : `: ${tx.errorDetails}`} with no transaction hash`,
      );
    }

    if (tx.state !== CIRCLE_SUCCESS_STATE) {
      progress?.(
        `circle transaction ${tx.id} ended ${tx.state} but named ${tx.txHash} — asking the chain rather than taking either word for it`,
      );
    }
    return settleAndVerify(instruction, tx.txHash.toLowerCase(), false);
  }

  /**
   * The only route from Circle to a `confirmed` outcome, and it goes through
   * the chain twice: once for the receipt, once for the Transfer log.
   */
  async function settleAndVerify(
    instruction: StablecoinPayoutInstruction,
    txHash: string,
    recovered: boolean,
  ): Promise<PayoutOutcome> {
    const settled = await settleTransaction(rpc, instruction, txHash, {
      recovered,
      // Circle chose and used the nonce; we never saw it. -1 is the same
      // sentinel the direct path uses for a transfer it recovered rather than
      // built, and it means "not knowable from here", not "zero".
      nonce: -1n,
      gas: null,
      provider: CIRCLE_PROVIDER,
      ...(progress === undefined ? {} : { onProgress: progress }),
    });
    if (settled.kind !== "confirmed") return settled;

    const evidence = await verifyTransferOnChain(rpc, instruction, txHash, settled.receipt.blockNumber);
    if (!evidence.matched) {
      return { ...outcomeBase(instruction), kind: "unverified", txHash, detail: evidence.detail };
    }
    progress?.(`verified against Base Sepolia ourselves — ${evidence.detail}`);
    return settled;
  }

  return { id: CIRCLE_PROVIDER, label: CIRCLE_LABEL, health, send };
}

/** Re-exported so a caller can name the state it must never post on. */
export { CIRCLE_INITIATED_STATE };
