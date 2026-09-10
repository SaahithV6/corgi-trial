/**
 * A Base Sepolia JSON-RPC client, in `fetch` and nothing else.
 *
 * Deliberately narrow: eleven methods, each one required by the payout path.
 * There is no generic "call any contract" surface, because the moment there is
 * one somebody uses it for money and the ABI encoding stops being reviewable.
 *
 * Everything numeric comes back as `bigint`. The RPC speaks minimal hex
 * quantities and `quantity()` is the only door they come through, so a node
 * that returns `null`, `"0"` or a decimal string produces a named error at the
 * boundary instead of a `NaN` four frames later.
 *
 * `server-only` is deliberately NOT imported — same reason as
 * `../increase/client.ts`: this module has to be constructible under vitest's
 * node environment and from an operator script.
 */

import { concatBytes, fromHex, normalizeAddress, padWord, quantity, toHex, toMinimalBytes, toQuantity } from "./hex";
import { keccak256Utf8 } from "./keccak";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class RpcError extends Error {
  override readonly name = "RpcError";
  readonly method: string;
  /** The provider's own error object, untouched, for audit. */
  readonly raw: unknown;
  constructor(message: string, method: string, raw: unknown) {
    super(message);
    this.method = method;
    this.raw = raw;
  }
}

/** `transfer(address,uint256)` — 0xa9059cbb. Derived, never pasted. */
export const ERC20_TRANSFER_SELECTOR = keccak256Utf8("transfer(address,uint256)").subarray(0, 4);
/** `balanceOf(address)` — 0x70a08231. */
export const ERC20_BALANCE_OF_SELECTOR = keccak256Utf8("balanceOf(address)").subarray(0, 4);
/** `Transfer(address,address,uint256)` — topic0 of the ERC-20 log. */
export const ERC20_TRANSFER_TOPIC = toHex(keccak256Utf8("Transfer(address,address,uint256)"));

/** ABI calldata for an ERC-20 transfer. 4 + 32 + 32 = 68 bytes, always. */
export function encodeTransferCall(to: string, amountUnits: bigint): Uint8Array {
  if (amountUnits <= 0n) throw new Error(`refusing to encode a non-positive transfer: ${amountUnits}`);
  return concatBytes(
    ERC20_TRANSFER_SELECTOR,
    padWord(fromHex(normalizeAddress(to, "recipient"))),
    padWord(toMinimalBytes(amountUnits)),
  );
}

/** A 32-byte topic for an address, for `eth_getLogs`. */
export function addressTopic(address: string): string {
  return toHex(padWord(fromHex(normalizeAddress(address))));
}

export interface TransactionReceipt {
  readonly status: bigint;
  readonly blockNumber: bigint;
  readonly blockHash: string;
  readonly gasUsed: bigint;
  readonly effectiveGasPrice: bigint;
  readonly raw: unknown;
}

export interface TransferLog {
  readonly txHash: string;
  readonly blockNumber: bigint;
  readonly amountUnits: bigint;
}

export interface BaseRpcOptions {
  readonly url: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

export class BaseRpc {
  readonly #url: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  #id = 0;

  constructor(options: BaseRpcOptions) {
    this.#url = options.url;
    this.#fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async call(method: string, params: readonly unknown[]): Promise<unknown> {
    this.#id += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.#id, method, params }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new RpcError(
        `${method}: ${error instanceof Error ? error.message : String(error)}`,
        method,
        error,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new RpcError(`${method}: HTTP ${response.status}`, method, await response.text().catch(() => null));
    }
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) {
      throw new RpcError(`${method}: ${body.error.message ?? JSON.stringify(body.error)}`, method, body.error);
    }
    return body.result;
  }

  async chainId(): Promise<bigint> {
    return quantity(await this.call("eth_chainId", []), "eth_chainId");
  }

  async blockNumber(): Promise<bigint> {
    return quantity(await this.call("eth_blockNumber", []), "eth_blockNumber");
  }

  /** Native balance in wei — the gas budget. */
  async getBalance(address: string): Promise<bigint> {
    return quantity(await this.call("eth_getBalance", [normalizeAddress(address), "latest"]), "eth_getBalance");
  }

  /**
   * `pending` counts the mempool, `latest` counts only mined transactions.
   * The payout path reads BOTH and refuses when they disagree; see ./adapter.ts.
   */
  async getTransactionCount(address: string, block: "latest" | "pending"): Promise<bigint> {
    return quantity(
      await this.call("eth_getTransactionCount", [normalizeAddress(address), block]),
      `eth_getTransactionCount(${block})`,
    );
  }

  /**
   * Priority fee, from the node's own estimate where it has one.
   *
   * `eth_maxPriorityFeePerGas` is not universal. Where it is missing this falls
   * back to `eth_gasPrice`, which every node implements — never to a constant,
   * because a hard-coded tip is a transaction that either overpays forever or
   * silently stops being mined the first time the network gets busy.
   */
  async maxPriorityFeePerGas(): Promise<bigint> {
    try {
      return quantity(await this.call("eth_maxPriorityFeePerGas", []), "eth_maxPriorityFeePerGas");
    } catch {
      return quantity(await this.call("eth_gasPrice", []), "eth_gasPrice");
    }
  }

  async gasPrice(): Promise<bigint> {
    return quantity(await this.call("eth_gasPrice", []), "eth_gasPrice");
  }

  /** The pending block's base fee, which is what EIP-1559 charges against. */
  async baseFeePerGas(): Promise<bigint> {
    const block = (await this.call("eth_getBlockByNumber", ["pending", false])) as
      | { baseFeePerGas?: unknown }
      | null;
    if (block === null || block.baseFeePerGas === undefined) {
      // Pre-1559 or a node that will not serve the pending block. gasPrice
      // already includes the base fee, so it is a safe upper bound.
      return this.gasPrice();
    }
    return quantity(block.baseFeePerGas, "baseFeePerGas");
  }

  async estimateGas(tx: {
    from: string;
    to: string;
    data: Uint8Array;
    value?: bigint;
  }): Promise<bigint> {
    return quantity(
      await this.call("eth_estimateGas", [
        {
          from: normalizeAddress(tx.from),
          to: normalizeAddress(tx.to),
          data: toHex(tx.data),
          value: toQuantity(tx.value ?? 0n),
        },
      ]),
      "eth_estimateGas",
    );
  }

  /** ERC-20 `balanceOf`, via `eth_call`. */
  async erc20BalanceOf(token: string, owner: string): Promise<bigint> {
    const data = concatBytes(ERC20_BALANCE_OF_SELECTOR, padWord(fromHex(normalizeAddress(owner))));
    return quantity(
      await this.call("eth_call", [{ to: normalizeAddress(token), data: toHex(data) }, "latest"]),
      "eth_call balanceOf",
    );
  }

  /** Returns the node's hash for the transaction. Compared against ours. */
  async sendRawTransaction(raw: Uint8Array): Promise<string> {
    const result = await this.call("eth_sendRawTransaction", [toHex(raw)]);
    if (typeof result !== "string") {
      throw new RpcError("eth_sendRawTransaction returned no hash", "eth_sendRawTransaction", result);
    }
    return result.toLowerCase();
  }

  /** `null` while the transaction is still in the mempool. */
  async getTransactionReceipt(txHash: string): Promise<TransactionReceipt | null> {
    const raw = (await this.call("eth_getTransactionReceipt", [txHash])) as Record<string, unknown> | null;
    if (raw === null || raw === undefined) return null;
    return {
      status: quantity(raw["status"], "receipt.status"),
      blockNumber: quantity(raw["blockNumber"], "receipt.blockNumber"),
      blockHash: String(raw["blockHash"]).toLowerCase(),
      gasUsed: quantity(raw["gasUsed"], "receipt.gasUsed"),
      effectiveGasPrice: quantity(raw["effectiveGasPrice"], "receipt.effectiveGasPrice"),
      raw,
    };
  }

  /** `null` when the node has never seen it, or has forgotten it (dropped). */
  async transactionExists(txHash: string): Promise<boolean> {
    const raw = await this.call("eth_getTransactionByHash", [txHash]);
    return raw !== null && raw !== undefined;
  }

  /** Block header facts. `hash` is what a reorg check compares against. */
  async getBlockHeader(blockNumber: bigint): Promise<{ hash: string; timestamp: bigint } | null> {
    const raw = (await this.call("eth_getBlockByNumber", [toQuantity(blockNumber), false])) as
      | Record<string, unknown>
      | null;
    if (raw === null || raw === undefined) return null;
    return { hash: String(raw["hash"]).toLowerCase(), timestamp: quantity(raw["timestamp"], "block.timestamp") };
  }

  /**
   * ERC-20 `Transfer` logs from one address to one address.
   *
   * This is how a re-run discovers that a previous run already moved the money
   * — the chain is the record, not a row we wrote before crashing.
   */
  async transferLogs(args: {
    token: string;
    from: string;
    to: string;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly TransferLog[]> {
    const logs = (await this.call("eth_getLogs", [
      {
        address: normalizeAddress(args.token),
        fromBlock: toQuantity(args.fromBlock),
        toBlock: toQuantity(args.toBlock),
        topics: [ERC20_TRANSFER_TOPIC, addressTopic(args.from), addressTopic(args.to)],
      },
    ])) as readonly Record<string, unknown>[] | null;
    if (!Array.isArray(logs)) return [];
    return logs.map((log) => ({
      txHash: String(log["transactionHash"]).toLowerCase(),
      blockNumber: quantity(log["blockNumber"], "log.blockNumber"),
      amountUnits: quantity(log["data"], "log.data"),
    }));
  }
}
