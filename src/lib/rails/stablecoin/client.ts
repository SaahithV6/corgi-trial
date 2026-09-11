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
  /** The JSON-RPC error code (-32601, -32000, …) when the node sent one. */
  readonly rpcCode: number | null;
  /** The HTTP status the node answered with, when there was a response at all. */
  readonly httpStatus: number | null;
  constructor(
    message: string,
    method: string,
    raw: unknown,
    meta: { rpcCode?: number | null; httpStatus?: number | null } = {},
  ) {
    super(message);
    this.method = method;
    this.raw = raw;
    this.rpcCode = meta.rpcCode ?? null;
    this.httpStatus = meta.httpStatus ?? null;
  }
}

/** The shape of a JSON-RPC envelope, as far as we are willing to trust it. */
interface RpcEnvelope {
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/**
 * Parse a response body as a JSON-RPC envelope, or return `null`.
 *
 * `null` means "this is not JSON-RPC" — a proxy's HTML error page, a truncated
 * payload, an empty body. It never throws: a body that will not parse is an
 * outcome to be named by the caller, not an exception from a different class
 * (a bare `SyntaxError` from `response.json()`) escaping a function whose
 * whole contract is that its failures are `RpcError`s.
 */
function parseRpcEnvelope(text: string | null): RpcEnvelope | null {
  if (text === null || text.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not a swallow: the absence of an envelope IS the return value, and every
    // caller below turns it into a named RpcError carrying the raw bytes.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as RpcEnvelope;
}

/** A short, log-safe look at a body that was not JSON-RPC. */
function bodyPreview(text: string | null): string {
  if (text === null) return "<unreadable>";
  const collapsed = text.replace(/\s+/gu, " ").trim();
  if (collapsed === "") return "<empty>";
  return collapsed.length > 120 ? `${collapsed.slice(0, 120)}…` : collapsed;
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
    // Read the bytes ONCE, then classify. The order matters and is measured.
    //
    // A node does not owe us a 2xx to have something to say. Against real Base
    // Sepolia (2026-09-11): an unsupported method answers **HTTP 403** with
    // `{"error":{"code":-32601,"message":"rpc method is unsupported"}}`, and a
    // malformed request answers **HTTP 400** with `{"code":-32700,"message":
    // "parse error"}`. Checking `response.ok` first collapsed both to the
    // string `"eth_x: HTTP 403"` and threw the node's own sentence away.
    //
    // That is not cosmetic. `sendUsdcPayout` recovers an already-broadcast
    // transaction by matching /already known/ against exactly this message
    // (see adapter.ts, step 10). A node that reports "already known" behind a
    // non-2xx — which the measurement above proves is a thing nodes do — used
    // to come back as `broadcast_rejected`, telling the customer their payout
    // failed while their transaction sat in the mempool, and inviting a human
    // to send it a second time. Parse first, classify second.
    const text = await response.text().catch(() => null);
    const body = parseRpcEnvelope(text);

    if (body?.error !== undefined && body.error !== null) {
      const nodeMessage =
        typeof body.error.message === "string" && body.error.message !== ""
          ? body.error.message
          : JSON.stringify(body.error);
      const rpcCode = typeof body.error.code === "number" ? body.error.code : null;
      const codePart = rpcCode === null ? "" : ` (code ${rpcCode})`;
      // The HTTP status is audit detail, appended; the node's own sentence
      // stays at the front where both a human and a substring match find it.
      const statusPart = response.ok ? "" : ` [HTTP ${response.status}]`;
      throw new RpcError(`${method}: ${nodeMessage}${codePart}${statusPart}`, method, body.error, {
        rpcCode,
        httpStatus: response.status,
      });
    }

    if (!response.ok) {
      throw new RpcError(
        `${method}: HTTP ${response.status} with no JSON-RPC error (${bodyPreview(text)})`,
        method,
        text,
        { httpStatus: response.status },
      );
    }

    if (body === null) {
      // A 200 carrying something that is not a JSON-RPC envelope: a proxy's
      // HTML error page, a truncated payload, an empty body. Previously this
      // escaped as a bare SyntaxError from `response.json()` — a different
      // error class than every caller catches, so a named refusal became an
      // unhandled 500.
      throw new RpcError(
        `${method}: HTTP ${response.status} body is not a JSON-RPC envelope (${bodyPreview(text)})`,
        method,
        text,
        { httpStatus: response.status },
      );
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
    // An EMPTY array is an answer: "no such transfer in this range." A
    // NON-array is not an answer at all, and the two must never collapse.
    //
    // `findExistingTransfer` (adapter.ts) is the crash-window duplicate-payment
    // guard: it asks this question to find out whether a payout we may have
    // already broadcast is on chain. Returning `[]` for a node that answered
    // `null`, an object, or a string told that guard "this payout has never
    // been sent" — on no evidence — and the adapter went on to broadcast. A
    // malformed `eth_getLogs` was a licence to pay twice.
    //
    // Refusing here costs us a failed payout attempt. Guessing cost the
    // customer a second payment. Fail closed.
    if (!Array.isArray(logs)) {
      throw new RpcError(
        `eth_getLogs did not return an array (got ${logs === null ? "null" : typeof logs}); ` +
          `refusing to read that as "no transfer found"`,
        "eth_getLogs",
        logs,
      );
    }
    return logs.map((log) => ({
      txHash: String(log["transactionHash"]).toLowerCase(),
      blockNumber: quantity(log["blockNumber"], "log.blockNumber"),
      amountUnits: quantity(log["data"], "log.data"),
    }));
  }
}
