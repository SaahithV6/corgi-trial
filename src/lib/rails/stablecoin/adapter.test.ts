/**
 * The payout adapter, driven by a scripted JSON-RPC node.
 *
 * No network. `BaseRpc` takes a `fetchImpl`, so every one of these tests is a
 * transcript: the node says X, the adapter must do Y. What is being proven is
 * not that the happy path works — the happy path is proven by a transaction on
 * a public chain — but that the FAILURES behave, because those are the ones
 * that cannot be demonstrated on demand against a real network.
 *
 * The rule every assertion here enforces: an outcome, never an exception, and
 * the transaction hash is never lost. A revert, an out-of-gas, a dropped
 * transaction and a reorg all come back as values a caller can print, log and
 * act on.
 *
 * The key is the EIP-155 example key, which is published in the EIP itself and
 * holds nothing anywhere.
 */
import { describe, expect, it } from "vitest";

import { sendUsdcPayout } from "./adapter";
import { BaseRpc } from "./client";
import { fromHex } from "./hex";
import { keccak256 } from "./keccak";
import type { UsdcPayoutRequest } from "./types";

const KEY = fromHex("0x4646464646464646464646464646464646464646464646464646464646464646");
const SENDER = "0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f";
const TOKEN = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const RECIPIENT = "0x000000000000000000000000000000000000dead";
const BLOCK_HASH = "0x1111111111111111111111111111111111111111111111111111111111111111";

type Handler = (params: readonly unknown[]) => unknown;

/** A node that answers exactly what the transcript says and nothing else. */
function scripted(overrides: Record<string, Handler> = {}): {
  rpc: BaseRpc;
  broadcasts: string[];
  calls: string[];
} {
  const broadcasts: string[] = [];
  const calls: string[] = [];
  const defaults: Record<string, Handler> = {
    eth_chainId: () => "0x14a34",
    eth_blockNumber: () => "0x2c7d741",
    eth_getBalance: () => "0x5af3107a4000", // 1e14 wei
    eth_getTransactionCount: () => "0x0",
    eth_call: () => `0x${(20_000_000n).toString(16).padStart(64, "0")}`, // 20 USDC
    eth_estimateGas: () => "0xdcd0",
    eth_gasPrice: () => "0x5b8d80",
    eth_maxPriorityFeePerGas: () => "0xf4240",
    eth_getBlockByNumber: () => ({ baseFeePerGas: "0x51615", hash: BLOCK_HASH, timestamp: "0x6aa30d62" }),
    eth_getLogs: () => [],
    eth_sendRawTransaction: (params) => {
      const raw = String(params[0]);
      broadcasts.push(raw);
      return `0x${Buffer.from(keccak256(fromHex(raw))).toString("hex")}`;
    },
    eth_getTransactionByHash: () => ({ hash: "0x0" }),
    eth_getTransactionReceipt: () => ({
      status: "0x1",
      blockNumber: "0x2c7d741",
      blockHash: BLOCK_HASH,
      gasUsed: "0xaf2b",
      effectiveGasPrice: "0x5b8d80",
    }),
  };
  const handlers = { ...defaults, ...overrides };
  const rpc = new BaseRpc({
    url: "http://scripted.invalid",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] };
      calls.push(body.method);
      const handler = handlers[body.method];
      if (handler === undefined) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { message: `no transcript for ${body.method}` } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      let result: unknown;
      try {
        result = handler(body.params);
      } catch (error) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            error: { message: error instanceof Error ? error.message : String(error) },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { rpc, broadcasts, calls };
}

function request(overrides: Partial<UsdcPayoutRequest> = {}): UsdcPayoutRequest {
  return {
    tokenAddress: TOKEN,
    fromAddress: SENDER,
    toAddress: RECIPIENT,
    amountUnits: 500_000n,
    chainId: 84_532n,
    privateKey: KEY,
    confirmations: 1,
    receiptTimeoutMs: 0,
    ...overrides,
  };
}

describe("refusals — nothing is signed and nothing is broadcast", () => {
  it("refuses when the key does not derive the configured sender", async () => {
    const { rpc, broadcasts } = scripted();
    const outcome = await sendUsdcPayout(rpc, request({ fromAddress: RECIPIENT }));
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toBe("sender_key_mismatch");
    expect(outcome.txHash).toBeNull();
    expect(broadcasts).toHaveLength(0);
  });

  it("refuses when the node is on a different chain", async () => {
    const { rpc, broadcasts } = scripted({ eth_chainId: () => "0x1" });
    const outcome = await sendUsdcPayout(rpc, request());
    expect(outcome.kind === "refused" && outcome.reason).toBe("chain_id_mismatch");
    expect(broadcasts).toHaveLength(0);
  });

  it("refuses when the wallet does not hold the tokens", async () => {
    const { rpc, broadcasts } = scripted({ eth_call: () => `0x${(1n).toString(16).padStart(64, "0")}` });
    const outcome = await sendUsdcPayout(rpc, request());
    expect(outcome.kind === "refused" && outcome.reason).toBe("insufficient_usdc");
    expect(broadcasts).toHaveLength(0);
  });

  it("refuses while one of its own transactions is unmined — crash window 2", async () => {
    // pending is ahead of latest: something of ours is in the mempool. Sending
    // now would take the NEXT nonce and pay the same person twice.
    const { rpc, broadcasts } = scripted({
      eth_getTransactionCount: (params) => (params[1] === "pending" ? "0x1" : "0x0"),
      // latest > 0 means the log scan runs; it finds nothing.
      eth_getLogs: () => [],
    });
    const outcome = await sendUsdcPayout(rpc, request());
    expect(outcome.kind === "refused" && outcome.reason).toBe("transaction_in_flight");
    expect(broadcasts).toHaveLength(0);
  });

  it("refuses when the transfer would revert, rather than burning the gas", async () => {
    const { rpc, broadcasts } = scripted({
      eth_estimateGas: () => {
        throw new Error("execution reverted: ERC20: transfer amount exceeds balance");
      },
    });
    const outcome = await sendUsdcPayout(rpc, request());
    expect(outcome.kind === "refused" && outcome.reason).toBe("estimate_reverted");
    expect(broadcasts).toHaveLength(0);
  });

  it("refuses when the wallet cannot cover the worst-case gas it would authorise", async () => {
    const { rpc, broadcasts } = scripted({ eth_getBalance: () => "0x1" });
    const outcome = await sendUsdcPayout(rpc, request());
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toBe("insufficient_gas");
    // The detail has to be actionable: what it needs, and what it has.
    expect(outcome.detail).toMatch(/wei/);
    expect(broadcasts).toHaveLength(0);
  });
});

describe("the transaction hash is known before broadcast", () => {
  it("hands the caller the hash before eth_sendRawTransaction, and it matches the node's", async () => {
    const seen: string[] = [];
    const { rpc, broadcasts, calls } = scripted();
    const outcome = await sendUsdcPayout(rpc, request(), {
      onSigned: (hash) => {
        // Nothing has been broadcast at the moment this fires.
        expect(calls).not.toContain("eth_sendRawTransaction");
        seen.push(hash);
      },
    });
    expect(seen).toHaveLength(1);
    expect(outcome.kind).toBe("confirmed");
    if (outcome.kind !== "confirmed") throw new Error("unreachable");
    expect(outcome.txHash).toBe(seen[0]);
    expect(broadcasts).toHaveLength(1);
    // …and the hash really is keccak256 of the bytes that went over the wire.
    expect(`0x${Buffer.from(keccak256(fromHex(broadcasts[0] ?? ""))).toString("hex")}`).toBe(outcome.txHash);
  });

  it("throws only when the node names the transaction something else", async () => {
    // This cannot happen unless our keccak or RLP is wrong, and if it does the
    // idempotency key would name a transaction that does not exist. Loud.
    const { rpc } = scripted({ eth_sendRawTransaction: () => `0x${"ab".repeat(32)}` });
    await expect(sendUsdcPayout(rpc, request())).rejects.toThrow(/locally computed hash/);
  });
});

describe("failure is an outcome, and it keeps the hash", () => {
  it("reports a mined-and-failed transaction as reverted", async () => {
    const { rpc } = scripted({
      eth_getTransactionReceipt: () => ({
        status: "0x0",
        blockNumber: "0x2c7d741",
        blockHash: BLOCK_HASH,
        gasUsed: "0xaf2b",
        effectiveGasPrice: "0x5b8d80",
      }),
    });
    const outcome = await sendUsdcPayout(rpc, request());
    expect(outcome.kind).toBe("reverted");
    if (outcome.kind !== "reverted") throw new Error("unreachable");
    expect(outcome.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    // The gas really was spent, and the number is carried out for the operator.
    expect(outcome.receipt.gasCostWei).toBe(0xaf2bn * 0x5b8d80n);
  });

  it("reports a transaction the node has forgotten as dropped", async () => {
    const { rpc } = scripted({
      eth_getTransactionReceipt: () => null,
      eth_getTransactionByHash: () => null,
    });
    const outcome = await sendUsdcPayout(rpc, request());
    expect(outcome.kind).toBe("dropped");
    if (outcome.kind !== "dropped") throw new Error("unreachable");
    expect(outcome.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("does not call a PRECONFIRMATION a reorg — it waits, then confirms", async () => {
    // Base Sepolia serves a receipt with an all-zero blockHash at the tip: the
    // node saying "I have this and it is not in a block yet". The canonicality
    // check compares header.hash against receipt.blockHash, and a zero hash can
    // never match a real block — so the adapter used to conclude the block had
    // been reorganised out.
    //
    // It then correctly refused to post, which meant 1.98 USDC left the wallet
    // with the ledger unaware and recovery needing a second command. Refusing
    // was right; calling it a reorg was not. A reorg means "mined, then
    // un-mined" — a real and alarming fact — and this is the ordinary case
    // that resolves by waiting. Reporting the second as the first spends an
    // operator's attention on nothing and hides the one time it is true.
    let calls = 0;
    const { rpc } = scripted({
      eth_getTransactionReceipt: () => {
        calls += 1;
        // First read: a preconfirmation. Second: the real thing.
        return calls === 1
          ? {
              status: "0x1",
              blockNumber: "0x2c7d741",
              blockHash: `0x${"0".repeat(64)}`,
              gasUsed: "0xaf2b",
              effectiveGasPrice: "0x5b8d80",
            }
          : {
              status: "0x1",
              blockNumber: "0x2c7d741",
              blockHash: BLOCK_HASH,
              gasUsed: "0xaf2b",
              effectiveGasPrice: "0x5b8d80",
            };
      },
    });
    // The shared `request()` sets receiptTimeoutMs: 0 so most cases resolve in
    // one pass. This one MUST be allowed to poll — waiting is the behaviour
    // under test — so it gets a real budget, one poll interval plus slack.
    const outcome = await sendUsdcPayout(rpc, request({ receiptTimeoutMs: 5_000 }));
    expect(outcome.kind).toBe("confirmed");
    // It really did have to wait: a single read would have been the bug, and
    // `unconfirmed` here would mean it never re-read at all.
    expect(calls).toBeGreaterThan(1);
  });

  it("reports a receipt whose block is no longer canonical as reorged", async () => {
    const { rpc } = scripted({
      eth_getBlockByNumber: (params) =>
        params[0] === "pending"
          ? { baseFeePerGas: "0x51615" }
          : { hash: "0x2222222222222222222222222222222222222222222222222222222222222222", timestamp: "0x6aa30d62" },
    });
    const outcome = await sendUsdcPayout(rpc, request());
    expect(outcome.kind).toBe("reorged");
    if (outcome.kind !== "reorged") throw new Error("unreachable");
    expect(outcome.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(outcome.detail).toMatch(/reorg|no such block|chain now/i);
  });

  it("reports a transaction still in the mempool as unconfirmed, with the hash to resume from", async () => {
    const { rpc } = scripted({ eth_getTransactionReceipt: () => null });
    const outcome = await sendUsdcPayout(rpc, request({ receiptTimeoutMs: 0 }));
    expect(outcome.kind).toBe("unconfirmed");
    if (outcome.kind !== "unconfirmed") throw new Error("unreachable");
    expect(outcome.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("crash window 3 — the money moved, the ledger did not", () => {
  it("finds the transfer on chain and settles it without sending anything", async () => {
    const PRIOR = `0x${"cd".repeat(32)}`;
    const { rpc, broadcasts } = scripted({
      eth_getTransactionCount: () => "0x1",
      eth_getLogs: () => [
        {
          transactionHash: PRIOR,
          blockNumber: "0x2c7d741",
          data: `0x${(500_000n).toString(16).padStart(64, "0")}`,
        },
      ],
    });
    const outcome = await sendUsdcPayout(rpc, request());
    expect(outcome.kind).toBe("confirmed");
    if (outcome.kind !== "confirmed") throw new Error("unreachable");
    expect(outcome.txHash).toBe(PRIOR);
    expect(outcome.recovered).toBe(true);
    expect(broadcasts).toHaveLength(0);
  });

  it("ignores a prior transfer for a different amount", async () => {
    const { rpc, broadcasts } = scripted({
      eth_getTransactionCount: () => "0x1",
      eth_getLogs: () => [
        {
          transactionHash: `0x${"cd".repeat(32)}`,
          blockNumber: "0x2c7d741",
          data: `0x${(250_000n).toString(16).padStart(64, "0")}`,
        },
      ],
    });
    const outcome = await sendUsdcPayout(rpc, request());
    expect(outcome.kind).toBe("confirmed");
    expect(broadcasts).toHaveLength(1);
  });

  it("sends anyway when the operator asks for a deliberate duplicate", async () => {
    const { rpc, broadcasts } = scripted({
      eth_getTransactionCount: () => "0x1",
      eth_getLogs: () => [
        {
          transactionHash: `0x${"cd".repeat(32)}`,
          blockNumber: "0x2c7d741",
          data: `0x${(500_000n).toString(16).padStart(64, "0")}`,
        },
      ],
    });
    const outcome = await sendUsdcPayout(rpc, request(), { allowDuplicate: true });
    expect(outcome.kind).toBe("confirmed");
    expect(broadcasts).toHaveLength(1);
  });
});
