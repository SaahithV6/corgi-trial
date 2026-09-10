/**
 * The Circle provider, driven by two transcripts at once: a scripted Circle
 * API and a scripted Base Sepolia node. No network.
 *
 * ── WHAT THESE TESTS ARE FOR ─────────────────────────────────────────────────
 *
 * The happy path is proved by a transaction on a public chain — 0.10 USDC,
 * `0x251858a3…`, block 46,657,187, and a journal entry that names `circle.w3s`.
 * These tests exist for the cases that CANNOT be demonstrated on demand
 * against a real provider, and every one of them is a way for an
 * acknowledgement to be mistaken for a payment:
 *
 *   Circle says INITIATED and never moves        -> `acknowledged`, no post
 *   Circle says COMPLETE with no hash            -> `refused`, no post
 *   Circle names a hash that carries no transfer -> `unverified`, no post
 *   Circle names a hash for the wrong amount     -> `unverified`, no post
 *   Circle says FAILED but the chain shows it    -> `confirmed`. The chain wins.
 *
 * The load-bearing assertion in every one is `isConfirmed(outcome) === false`,
 * because `postUsdcPayout` takes a `ConfirmedPayout` and nothing else. If that
 * is false, the ledger is unreachable — not by convention, by the type.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { CircleClient } from "./circle-client";
import type { CircleConfig } from "./circle-config";
import { circleStablecoinProvider, unconfiguredCircleProvider, verifyTransferOnChain } from "./circle-provider";
import { BaseRpc } from "./client";
import { isConfirmed, type StablecoinPayoutInstruction } from "./types";

const { publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const WALLET_ID = "9a3524c0-728c-554f-8d26-a19c6ee66a4a";
const WALLET_ADDRESS = "0xeaa8ce10abcbce9d7f5257126c36a078c9951e1c";
const TOKEN = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const TOKEN_ID = "5797fbd6-3795-519d-84ca-ec4c5f80c3b1";
const RECIPIENT = "0x000000000000000000000000000000000000dead";
const TX_HASH = "0x251858a3d3daf45aa2a8e2bc970351580b33bfe97a7f18e951b207fb91d476fa";
const BLOCK_HASH = "0x002ecb5e611d35fb0d8756d63d04af49da0c487f57b01732846d36e786f711fe";
const BLOCK = 46_657_187n;

const config: CircleConfig = {
  baseUrl: "https://api.circle.example",
  apiKey: "TEST_API_KEY:key:secret",
  entitySecret: "0".repeat(64),
  walletSetId: null,
  walletId: WALLET_ID,
  tokenId: null,
};

function instruction(overrides: Partial<StablecoinPayoutInstruction> = {}): StablecoinPayoutInstruction {
  return {
    tokenAddress: TOKEN,
    fromAddress: WALLET_ADDRESS,
    toAddress: RECIPIENT,
    amountUnits: 100_000n,
    chainId: 84532n,
    confirmations: 1,
    receiptTimeoutMs: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The scripted Circle API
// ---------------------------------------------------------------------------

interface CircleScript {
  /** The states `GET /transactions/{id}` returns, in order. The last repeats. */
  states: readonly { state: string; txHash?: string | null; errorReason?: string }[];
  walletAddress?: string;
  transferStatus?: number;
  transferBody?: unknown;
}

function circleClient(script: CircleScript): { client: CircleClient; posts: string[] } {
  const posts: string[] = [];
  let polls = 0;
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    const method = init.method ?? "GET";
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status });

    if (path === "/v1/w3s/config/entity/publicKey") return json({ data: { publicKey } });

    if (path === `/v1/w3s/wallets/${WALLET_ID}`) {
      return json({
        data: {
          wallet: {
            id: WALLET_ID,
            address: script.walletAddress ?? WALLET_ADDRESS,
            blockchain: "BASE-SEPOLIA",
            state: "LIVE",
            accountType: "EOA",
            walletSetId: "9882bf06-4831-5bad-a1d4-606b80f944e0",
          },
        },
      });
    }

    if (path === `/v1/w3s/wallets/${WALLET_ID}/balances`) {
      return json({
        data: {
          tokenBalances: [
            {
              token: { id: TOKEN_ID, blockchain: "BASE-SEPOLIA", tokenAddress: TOKEN, symbol: "USDC", decimals: 6 },
              amount: "1.0",
            },
          ],
        },
      });
    }

    if (method === "POST" && path === "/v1/w3s/developer/transactions/transfer") {
      posts.push(String(init.body));
      if (script.transferStatus !== undefined) {
        return json(script.transferBody ?? { code: 1, message: "declined" }, script.transferStatus);
      }
      // Verbatim: an id and a state. No hash.
      return json({ data: { id: "a384de2e-ff91-5bc8-8c05-7f13112ba22b", state: "INITIATED" } }, 201);
    }

    if (path.startsWith("/v1/w3s/transactions/")) {
      const step = script.states[Math.min(polls, script.states.length - 1)];
      polls += 1;
      return json({
        data: {
          transaction: {
            id: "a384de2e-ff91-5bc8-8c05-7f13112ba22b",
            state: step?.state ?? "INITIATED",
            amounts: ["0.100000"],
            txHash: step?.txHash ?? null,
            ...(step?.errorReason === undefined ? {} : { errorReason: step.errorReason }),
          },
        },
      });
    }
    return json({ code: 404, message: path }, 404);
  };
  return { client: new CircleClient({ config, fetchImpl }), posts };
}

// ---------------------------------------------------------------------------
// The scripted node
// ---------------------------------------------------------------------------

type Handler = (params: readonly unknown[]) => unknown;

/** A Transfer log's `data` is the uint256 amount, ABI-encoded. */
function transferLog(amountUnits: bigint, txHash = TX_HASH): Record<string, unknown> {
  return {
    transactionHash: txHash,
    blockNumber: `0x${BLOCK.toString(16)}`,
    data: `0x${amountUnits.toString(16)}`,
  };
}

function node(overrides: Record<string, Handler> = {}): BaseRpc {
  const defaults: Record<string, Handler> = {
    eth_chainId: () => "0x14a34",
    eth_blockNumber: () => `0x${(BLOCK + 5n).toString(16)}`,
    // balanceOf -> 1.000000 USDC
    eth_call: () => `0x${(1_000_000n).toString(16).padStart(64, "0")}`,
    eth_getTransactionCount: () => "0x0",
    eth_getLogs: () => [],
    eth_getTransactionByHash: () => ({ hash: TX_HASH }),
    eth_getTransactionReceipt: () => ({
      status: "0x1",
      blockNumber: `0x${BLOCK.toString(16)}`,
      blockHash: BLOCK_HASH,
      gasUsed: "0xaf2b",
      effectiveGasPrice: "0x5b8d80",
    }),
    eth_getBlockByNumber: () => ({ hash: BLOCK_HASH, timestamp: "0x6aa4a466", baseFeePerGas: "0x51615" }),
  };
  const handlers = { ...defaults, ...overrides };
  const fetchImpl = async (_url: string, init: RequestInit): Promise<Response> => {
    const { method, params, id } = JSON.parse(String(init.body)) as {
      method: string;
      params: readonly unknown[];
      id: number;
    };
    const handler = handlers[method];
    if (handler === undefined) throw new Error(`unscripted RPC call: ${method}`);
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id, result: handler(params) })));
  };
  return new BaseRpc({ url: "https://node.example", fetchImpl });
}

function provider(script: CircleScript, rpc: BaseRpc = node()) {
  const { client, posts } = circleClient(script);
  return {
    posts,
    provider: circleStablecoinProvider({ config, rpc, client, pollIntervalMs: 1, pollTimeoutMs: 30 }),
  };
}

// ---------------------------------------------------------------------------

describe("INITIATED never reaches the ledger", () => {
  it("returns `acknowledged` — not confirmed, not a payment — when Circle never produces a hash", async () => {
    const { provider: circle } = provider({ states: [{ state: "INITIATED" }] });
    const outcome = await circle.send(instruction());

    expect(outcome.kind).toBe("acknowledged");
    if (outcome.kind !== "acknowledged") throw new Error("unreachable");
    expect(outcome.txHash).toBeNull();
    expect(outcome.state).toBe("INITIATED");
    expect(outcome.providerRef).toBe("a384de2e-ff91-5bc8-8c05-7f13112ba22b");
    // The whole point. `postUsdcPayout` cannot be called with this.
    expect(isConfirmed(outcome)).toBe(false);
  });

  it("does not treat QUEUED, SENT or PENDING_RISK_SCREENING as an ending either", async () => {
    for (const state of ["QUEUED", "SENT", "PENDING_RISK_SCREENING"]) {
      const { provider: circle } = provider({ states: [{ state }] });
      const outcome = await circle.send(instruction());
      expect(outcome.kind).toBe("acknowledged");
      expect(isConfirmed(outcome)).toBe(false);
    }
  });

  it("never asks the chain about a transaction it has no hash for", async () => {
    const calls: string[] = [];
    const rpc = node({
      eth_getTransactionReceipt: () => {
        calls.push("receipt");
        return null;
      },
    });
    const { provider: circle } = provider({ states: [{ state: "INITIATED" }] }, rpc);
    await circle.send(instruction());
    expect(calls).toEqual([]);
  });
});

describe("the terminal states with no hash", () => {
  it("refuses when Circle ends FAILED without ever reaching a chain", async () => {
    const { provider: circle } = provider({
      states: [{ state: "INITIATED" }, { state: "FAILED", errorReason: "INSUFFICIENT_FUNDS" }],
    });
    const outcome = await circle.send(instruction());
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toBe("provider_declined");
    expect(outcome.detail).toMatch(/FAILED/);
    expect(outcome.detail).toMatch(/INSUFFICIENT_FUNDS/);
    expect(outcome.txHash).toBeNull();
  });

  it("refuses on DENIED and on CANCELLED too", async () => {
    for (const state of ["DENIED", "CANCELLED"]) {
      const { provider: circle } = provider({ states: [{ state }] });
      const outcome = await circle.send(instruction());
      expect(outcome.kind === "refused" && outcome.reason).toBe("provider_declined");
    }
  });

  it("refuses when the transfer POST itself is rejected", async () => {
    const { provider: circle } = provider({
      states: [{ state: "INITIATED" }],
      transferStatus: 400,
      transferBody: { code: 156004, message: "Insufficient funds" },
    });
    const outcome = await circle.send(instruction());
    expect(outcome.kind === "refused" && outcome.reason).toBe("provider_declined");
  });
});

describe("the hash is verified against Base Sepolia, not taken on trust", () => {
  it("confirms when the receipt succeeds AND a matching Transfer log is on chain", async () => {
    const rpc = node({ eth_getLogs: () => [transferLog(100_000n)] });
    const { provider: circle } = provider(
      { states: [{ state: "INITIATED" }, { state: "CONFIRMED", txHash: TX_HASH }] },
      rpc,
    );
    const outcome = await circle.send(instruction());

    expect(outcome.kind).toBe("confirmed");
    if (outcome.kind !== "confirmed") throw new Error("unreachable");
    expect(outcome.provider).toBe("circle.w3s");
    expect(outcome.txHash).toBe(TX_HASH);
    expect(outcome.receipt.blockNumber).toBe(BLOCK);
    expect(isConfirmed(outcome)).toBe(true);
  });

  it("does NOT wait for COMPLETE — a hash at CONFIRMED is enough to go ask the chain", async () => {
    // Measured on the live sandbox: the USDC left the wallet while Circle was
    // still saying CONFIRMED, and it was still saying CONFIRMED three minutes
    // later. Waiting for COMPLETE waits for the provider's bookkeeping.
    const rpc = node({ eth_getLogs: () => [transferLog(100_000n)] });
    const { provider: circle } = provider({ states: [{ state: "CONFIRMED", txHash: TX_HASH }] }, rpc);
    expect((await circle.send(instruction())).kind).toBe("confirmed");
  });

  it("returns `unverified` when the named transaction carries no Transfer of ours", async () => {
    // status 0x1, so the receipt is happy. The chain simply has no such
    // transfer. Trusting the receipt alone would post a payment that did not
    // happen — the exact thing a mediated provider makes possible.
    const rpc = node({ eth_getLogs: () => [] });
    const { provider: circle } = provider({ states: [{ state: "COMPLETE", txHash: TX_HASH }] }, rpc);
    const outcome = await circle.send(instruction());

    expect(outcome.kind).toBe("unverified");
    if (outcome.kind !== "unverified") throw new Error("unreachable");
    expect(outcome.txHash).toBe(TX_HASH);
    expect(outcome.detail).toMatch(/no ERC-20 Transfer/);
    expect(isConfirmed(outcome)).toBe(false);
  });

  it("returns `unverified` when the transfer is for a different amount", async () => {
    const rpc = node({ eth_getLogs: () => [transferLog(90_000n)] });
    const { provider: circle } = provider({ states: [{ state: "COMPLETE", txHash: TX_HASH }] }, rpc);
    const outcome = await circle.send(instruction());
    expect(outcome.kind).toBe("unverified");
    if (outcome.kind !== "unverified") throw new Error("unreachable");
    expect(outcome.detail).toMatch(/not the instructed 0\.100000 USDC/);
  });

  it("returns `unverified` when the Transfer belongs to a different transaction in the same block", async () => {
    const other = "0x1111111111111111111111111111111111111111111111111111111111111111";
    const rpc = node({ eth_getLogs: () => [transferLog(100_000n, other)] });
    const { provider: circle } = provider({ states: [{ state: "COMPLETE", txHash: TX_HASH }] }, rpc);
    expect((await circle.send(instruction())).kind).toBe("unverified");
  });

  it("reports `reverted`, not confirmed, when the chain says the transaction failed", async () => {
    const rpc = node({
      eth_getLogs: () => [],
      eth_getTransactionReceipt: () => ({
        status: "0x0",
        blockNumber: `0x${BLOCK.toString(16)}`,
        blockHash: BLOCK_HASH,
        gasUsed: "0xaf2b",
        effectiveGasPrice: "0x5b8d80",
      }),
    });
    const { provider: circle } = provider({ states: [{ state: "COMPLETE", txHash: TX_HASH }] }, rpc);
    const outcome = await circle.send(instruction());
    expect(outcome.kind).toBe("reverted");
    expect(isConfirmed(outcome)).toBe(false);
  });

  it("BELIEVES THE CHAIN OVER CIRCLE: a FAILED transfer the chain actually made is a payout", async () => {
    // The money is gone whatever Circle's row says. Refusing to post here
    // would leave a real movement unrecorded, which is the mirror-image sin.
    const rpc = node({ eth_getLogs: () => [transferLog(100_000n)] });
    const { provider: circle } = provider({ states: [{ state: "FAILED", txHash: TX_HASH }] }, rpc);
    const outcome = await circle.send(instruction());
    expect(outcome.kind).toBe("confirmed");
    expect(outcome.provider).toBe("circle.w3s");
  });
});

describe("what it refuses before instructing anything", () => {
  it("refuses when the Circle wallet is not the address the caller named", async () => {
    const { provider: circle, posts } = provider({
      states: [{ state: "INITIATED" }],
      walletAddress: "0x1111111111111111111111111111111111111111",
    });
    const outcome = await circle.send(instruction());
    expect(outcome.kind === "refused" && outcome.reason).toBe("sender_key_mismatch");
    expect(posts).toHaveLength(0);
  });

  it("refuses on a chain id the node does not agree with", async () => {
    const rpc = node({ eth_chainId: () => "0x1" });
    const { provider: circle, posts } = provider({ states: [{ state: "INITIATED" }] }, rpc);
    const outcome = await circle.send(instruction());
    expect(outcome.kind === "refused" && outcome.reason).toBe("chain_id_mismatch");
    expect(posts).toHaveLength(0);
  });

  it("refuses an instruction for a chain this provider does not transfer on", async () => {
    const { provider: circle } = provider({ states: [{ state: "INITIATED" }] });
    const outcome = await circle.send(instruction({ chainId: 1n }));
    expect(outcome.kind === "refused" && outcome.reason).toBe("chain_id_mismatch");
  });

  it("checks the balance on the CHAIN, not through Circle's balance endpoint", async () => {
    // Circle's transcript says the wallet holds 1.0 USDC. The chain says it
    // holds 0.01. The chain wins, and nothing is instructed.
    const rpc = node({ eth_call: () => `0x${(10_000n).toString(16).padStart(64, "0")}` });
    const { provider: circle, posts } = provider({ states: [{ state: "INITIATED" }] }, rpc);
    const outcome = await circle.send(instruction());
    expect(outcome.kind === "refused" && outcome.reason).toBe("insufficient_usdc");
    if (outcome.kind !== "refused") throw new Error("unreachable");
    expect(outcome.detail).toMatch(/chain says/);
    expect(posts).toHaveLength(0);
  });

  it("recovers a transfer already on chain and instructs NOTHING — crash window 3", async () => {
    const rpc = node({
      eth_getTransactionCount: () => "0x1",
      eth_getLogs: () => [transferLog(100_000n)],
    });
    const { provider: circle, posts } = provider({ states: [{ state: "INITIATED" }] }, rpc);
    const outcome = await circle.send(instruction());

    expect(outcome.kind).toBe("confirmed");
    if (outcome.kind !== "confirmed") throw new Error("unreachable");
    expect(outcome.recovered).toBe(true);
    expect(outcome.provider).toBe("circle.w3s");
    expect(posts).toHaveLength(0);
  });
});

describe("verifyTransferOnChain on its own", () => {
  it("matches on the exact hash and the exact minor units", async () => {
    const rpc = node({ eth_getLogs: () => [transferLog(100_000n)] });
    const evidence = await verifyTransferOnChain(rpc, instruction(), TX_HASH, BLOCK);
    expect(evidence.matched).toBe(true);
    expect(evidence.detail).toMatch(/0\.100000 USDC/);
  });

  it("is case-insensitive about the hash, because explorers and APIs disagree", async () => {
    const rpc = node({ eth_getLogs: () => [transferLog(100_000n, TX_HASH.toUpperCase().replace("0X", "0x"))] });
    expect((await verifyTransferOnChain(rpc, instruction(), TX_HASH, BLOCK)).matched).toBe(true);
  });
});

describe("degrading honestly when there is no credential", () => {
  it("reports not_configured and refuses, and makes no HTTP call at all", async () => {
    const circle = unconfiguredCircleProvider("CIRCLE_API_KEY absent");

    const health = await circle.health();
    expect(health.liveness).toBe("not_configured");
    expect(health.provider).toBe("circle.w3s");

    const outcome = await circle.send(instruction());
    expect(outcome.kind === "refused" && outcome.reason).toBe("provider_not_configured");
    expect(outcome.provider).toBe("circle.w3s");
    // Not the direct rail's slug. It did not quietly hand the payout over.
    expect(outcome.provider).not.toBe("base.usdc");
    expect(isConfirmed(outcome)).toBe(false);
  });
});

describe("health", () => {
  it("is live on an authenticated round trip that also finds a wallet", async () => {
    const { provider: circle } = provider({ states: [{ state: "INITIATED" }] });
    const health = await circle.health();
    expect(health.liveness).toBe("live");
    expect(health.detail).toContain(WALLET_ADDRESS);
  });

  it("is `unauthorised` on a 401 and `unreachable` on a dead network — never the same word", async () => {
    const unauthorised = circleStablecoinProvider({
      config,
      rpc: node(),
      client: new CircleClient({
        config,
        fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ code: 401, message: "Invalid credentials." }), { status: 401 })),
      }),
    });
    expect((await unauthorised.health()).liveness).toBe("unauthorised");

    const dead = circleStablecoinProvider({
      config,
      rpc: node(),
      client: new CircleClient({
        config,
        fetchImpl: () => Promise.reject(new Error("ENOTFOUND")),
      }),
    });
    expect((await dead.health()).liveness).toBe("unreachable");
  });

  it("is not `live` when the credential works but no wallet can pay", async () => {
    const client = new CircleClient({
      config: { ...config, walletId: null },
      fetchImpl: (url) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              new URL(url).pathname === "/v1/w3s/config/entity/publicKey"
                ? { data: { publicKey } }
                : { data: { wallets: [] } },
            ),
          ),
        ),
    });
    const circle = circleStablecoinProvider({ config: { ...config, walletId: null }, rpc: node(), client });
    const health = await circle.health();
    expect(health.liveness).not.toBe("live");
    expect(health.detail).toMatch(/no sending wallet/);
  });
});
