/**
 * What the RPC client does when the node misbehaves.
 *
 * Every case below is a shape a REAL node produced, measured against Base
 * Sepolia on 2026-09-11 with the repo's own `BASE_SEPOLIA_RPC_URL`:
 *
 *   POST {"method":"eth_notARealMethod"}  ->  HTTP 403
 *       {"jsonrpc":"2.0","error":{"code":-32601,"message":"rpc method is unsupported"},"id":1}
 *
 *   POST "not json at all"                ->  HTTP 400
 *       {"jsonrpc":"2.0","error":{"code":-32700,"message":"parse error"},"id":null}
 *
 * Both carry the node's own sentence behind a NON-2xx status. That is the
 * whole point of this file: the client used to check `response.ok` first and
 * throw the body away, so both of these became the string "HTTP 403" / "HTTP
 * 400" and the node's `code` and `message` were lost.
 *
 * It is not a cosmetic loss. `sendUsdcPayout` recovers an already-broadcast
 * transaction by matching /already known/ against this message; a node that
 * reports "already known" behind a non-2xx would have been read as
 * `broadcast_rejected`, telling a customer their payout failed while the
 * transaction was live in the mempool.
 */
import { describe, expect, it } from "vitest";

import { BaseRpc, RpcError } from "./client";

/** A `fetch` that answers once, with exactly the bytes and status given. */
function respondWith(status: number, body: string, contentType = "application/json") {
  const calls: string[] = [];
  const fetchLike = async (_url: string, init: RequestInit): Promise<Response> => {
    calls.push(String(init.body));
    return new Response(body, { status, headers: { "content-type": contentType } });
  };
  return { fetchLike, calls };
}

function rpcFor(status: number, body: string, contentType?: string): BaseRpc {
  const { fetchLike } = respondWith(status, body, contentType);
  return new BaseRpc({ url: "https://rpc.example/invalid", fetchImpl: fetchLike });
}

/** Assert the call rejected with an RpcError and hand it back for inspection. */
async function rpcErrorFrom(work: Promise<unknown>): Promise<RpcError> {
  const error = await work.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RpcError);
  return error as RpcError;
}

describe("BaseRpc.call — the node's error survives a non-2xx status", () => {
  it("keeps message and code from a 403 that carries a JSON-RPC error (measured)", async () => {
    const rpc = rpcFor(
      403,
      '{"jsonrpc":"2.0","error":{"code":-32601,"message":"rpc method is unsupported"},"id":1}',
    );
    const err = await rpcErrorFrom(rpc.chainId());

    // The node's own sentence, at the front where a human and a substring
    // match both find it.
    expect(err.message).toContain("rpc method is unsupported");
    expect(err.message).toContain("code -32601");
    // The status is audit detail, kept but not in charge.
    expect(err.message).toContain("HTTP 403");
    expect(err.rpcCode).toBe(-32601);
    expect(err.httpStatus).toBe(403);
  });

  it("keeps a -32700 parse error behind a 400 (measured)", async () => {
    const rpc = rpcFor(400, '{"jsonrpc":"2.0","error":{"code":-32700,"message":"parse error"},"id":null}');
    const err = await rpcErrorFrom(rpc.blockNumber());

    expect(err.message).toContain("parse error");
    expect(err.rpcCode).toBe(-32700);
    expect(err.httpStatus).toBe(400);
  });

  it("lets the already-known recovery match through a non-2xx", async () => {
    // THE REGRESSION THIS FILE EXISTS FOR. adapter.ts step 10 tests
    // /already known|known transaction/i against `error.message`. Before the
    // fix this message was the literal string "eth_sendRawTransaction: HTTP
    // 503" and the match could not fire, so a re-broadcast of a transaction
    // the node already had was reported to the customer as a rejection.
    const rpc = rpcFor(503, '{"jsonrpc":"2.0","error":{"code":-32000,"message":"already known"},"id":1}');
    const err = await rpcErrorFrom(rpc.sendRawTransaction(new Uint8Array([0x02, 0x01])));

    expect(/already known|known transaction/i.test(err.message)).toBe(true);
  });

  it("still reports the status when a non-2xx carries no JSON-RPC error", async () => {
    const rpc = rpcFor(502, "<html><body>502 Bad Gateway</body></html>", "text/html");
    const err = await rpcErrorFrom(rpc.chainId());

    expect(err.message).toContain("HTTP 502");
    expect(err.message).toContain("no JSON-RPC error");
    // The bytes are kept for audit rather than discarded.
    expect(err.message).toContain("502 Bad Gateway");
    expect(err.httpStatus).toBe(502);
    expect(err.rpcCode).toBeNull();
  });
});

describe("BaseRpc.call — a 200 that is not a JSON-RPC envelope", () => {
  it("names an HTML error page instead of throwing a bare SyntaxError", async () => {
    // A proxy or load balancer in front of the node answering 200 with its own
    // page. `await response.json()` threw a SyntaxError here — a different
    // error class than every caller catches, so a named refusal became a 500.
    const rpc = rpcFor(200, "<!doctype html><title>Origin unreachable</title>", "text/html");
    const err = await rpcErrorFrom(rpc.chainId());

    expect(err.name).toBe("RpcError");
    expect(err.message).toContain("not a JSON-RPC envelope");
    expect(err.message).toContain("Origin unreachable");
  });

  it("names a truncated payload", async () => {
    const rpc = rpcFor(200, '{"jsonrpc":"2.0","result":"0x14a3');
    const err = await rpcErrorFrom(rpc.chainId());

    expect(err.name).toBe("RpcError");
    expect(err.message).toContain("not a JSON-RPC envelope");
  });

  it("names an empty body", async () => {
    const rpc = rpcFor(200, "");
    const err = await rpcErrorFrom(rpc.chainId());

    expect(err.name).toBe("RpcError");
    expect(err.message).toContain("<empty>");
  });

  it("names a JSON array, which is valid JSON but not an envelope", async () => {
    const rpc = rpcFor(200, "[1,2,3]");
    const err = await rpcErrorFrom(rpc.chainId());

    expect(err.name).toBe("RpcError");
    expect(err.message).toContain("not a JSON-RPC envelope");
  });
});

describe("BaseRpc.call — the happy path still works", () => {
  it("returns the result of a well-formed 200", async () => {
    const rpc = rpcFor(200, '{"jsonrpc":"2.0","id":1,"result":"0x14a34"}');
    await expect(rpc.chainId()).resolves.toBe(84532n);
  });

  it("a 200 with neither result nor error reaches the quantity door, not a crash", async () => {
    // An unexpected-but-parseable shape. `quantity()` is the named boundary
    // for this, and it must be what fires — not a TypeError four frames later.
    const rpc = rpcFor(200, '{"jsonrpc":"2.0","id":1}');
    await expect(rpc.chainId()).rejects.toThrow(/eth_chainId/u);
  });
});

describe("BaseRpc.transferLogs — an empty answer is not a missing answer", () => {
  const range = {
    token: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    fromBlock: 1n,
    toBlock: 2n,
  };

  it("returns [] for a genuinely empty result", async () => {
    const rpc = rpcFor(200, '{"jsonrpc":"2.0","id":1,"result":[]}');
    await expect(rpc.transferLogs(range)).resolves.toEqual([]);
  });

  it("REFUSES a null result instead of reading it as 'no transfer found'", async () => {
    // The duplicate-payment guard. `findExistingTransfer` asks this question to
    // learn whether a payout we may already have broadcast is on chain. `[]`
    // here means "safe to send" — so a node that answers `null` must not be
    // allowed to mean the same thing.
    const rpc = rpcFor(200, '{"jsonrpc":"2.0","id":1,"result":null}');
    const err = await rpcErrorFrom(rpc.transferLogs(range));

    expect(err.name).toBe("RpcError");
    expect(err.method).toBe("eth_getLogs");
    expect(err.message).toContain("did not return an array");
  });

  it("REFUSES an object result", async () => {
    const rpc = rpcFor(200, '{"jsonrpc":"2.0","id":1,"result":{"unexpected":"shape"}}');
    const err = await rpcErrorFrom(rpc.transferLogs(range));

    expect(err.name).toBe("RpcError");
    expect(err.message).toContain("did not return an array");
  });

  it("REFUSES a missing result key", async () => {
    const rpc = rpcFor(200, '{"jsonrpc":"2.0","id":1}');
    const err = await rpcErrorFrom(rpc.transferLogs(range));

    expect(err.name).toBe("RpcError");
    expect(err.message).toContain("did not return an array");
  });
});

describe("BaseRpc.call — transport failure", () => {
  it("wraps an unreachable host as an RpcError naming the method", async () => {
    const fetchLike = async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    };
    const rpc = new BaseRpc({ url: "https://rpc.example/invalid", fetchImpl: fetchLike });
    const err = await rpcErrorFrom(rpc.chainId());

    expect(err.name).toBe("RpcError");
    expect(err.method).toBe("eth_chainId");
    expect(err.message).toContain("fetch failed");
  });
});
