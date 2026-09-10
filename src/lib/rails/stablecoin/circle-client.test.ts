/**
 * The Circle client, driven by a transcript. No network.
 *
 * The interesting assertions are not "it can parse JSON". They are:
 *
 *   - the entity secret ciphertext is DIFFERENT on every request, and it
 *     decrypts back to the entity secret. Proved with a real RSA key pair
 *     generated in the test, so the encryption is exercised rather than
 *     mocked;
 *   - a mutating call carries a UUIDv4 idempotency key, in the body AND the
 *     header, and hands it back to the caller;
 *   - the transfer POST's response is carried through as `INITIATED` with a
 *     null hash and is not dressed up as anything else;
 *   - an HTTP status survives as a field, because the health probe has to tell
 *     401 apart from a network failure and DECISIONS 011 is about never
 *     collapsing those two.
 */
import { generateKeyPairSync, constants, privateDecrypt } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { CircleClient, CircleError } from "./circle-client";
import type { CircleConfig } from "./circle-config";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const ENTITY_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const config: CircleConfig = {
  baseUrl: "https://api.circle.example",
  apiKey: "TEST_API_KEY:key:secret",
  entitySecret: ENTITY_SECRET,
  walletSetId: null,
  walletId: null,
  tokenId: null,
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

type Route = (call: Call) => { status?: number; body: unknown };

function transcript(routes: Record<string, Route>): {
  calls: Call[];
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
} {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const call: Call = { url, method, headers, body };
    calls.push(call);
    const path = new URL(url).pathname;
    const route = routes[`${method} ${path}`];
    if (route === undefined) {
      return new Response(JSON.stringify({ code: 404, message: `no route for ${method} ${path}` }), { status: 404 });
    }
    const { status = 200, body: responseBody } = route(call);
    return new Response(JSON.stringify(responseBody), { status });
  };
  return { calls, fetchImpl };
}

const publicKeyRoute: Route = () => ({ body: { data: { publicKey } } });

let ctx: ReturnType<typeof transcript>;

function client(routes: Record<string, Route>): CircleClient {
  ctx = transcript({ "GET /v1/w3s/config/entity/publicKey": publicKeyRoute, ...routes });
  return new CircleClient({ config, fetchImpl: ctx.fetchImpl });
}

beforeEach(() => {
  ctx = transcript({});
});

describe("the entity secret", () => {
  it("encrypts to something that decrypts back to the secret", async () => {
    const c = client({});
    const ciphertext = await c.encryptEntitySecret();
    const plain = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(ciphertext, "base64"),
    );
    expect(plain.toString("hex")).toBe(ENTITY_SECRET);
  });

  it("produces a DIFFERENT ciphertext every time — Circle rejects a reused one", async () => {
    const c = client({});
    const first = await c.encryptEntitySecret();
    const second = await c.encryptEntitySecret();
    const third = await c.encryptEntitySecret();
    expect(new Set([first, second, third]).size).toBe(3);
  });

  it("caches the PUBLIC key, because a public key is not a secret", async () => {
    const c = client({});
    await c.encryptEntitySecret();
    await c.encryptEntitySecret();
    const fetches = ctx.calls.filter((call) => call.url.endsWith("/publicKey"));
    expect(fetches).toHaveLength(1);
  });

  it("refuses a publicKey response that is not a PEM", async () => {
    const c = client({ "GET /v1/w3s/config/entity/publicKey": () => ({ body: { data: { publicKey: "nope" } } }) });
    await expect(c.encryptEntitySecret()).rejects.toThrow(/not a PEM/);
  });
});

describe("createTransfer", () => {
  const TRANSFER = "POST /v1/w3s/developer/transactions/transfer";

  it("sends the amount as a decimal string and returns the ACKNOWLEDGEMENT unchanged", async () => {
    const c = client({
      [TRANSFER]: () => ({ status: 201, body: { data: { id: "a384de2e-ff91-5bc8-8c05-7f13112ba22b", state: "INITIATED" } } }),
    });
    const { result, idempotencyKey } = await c.createTransfer({
      walletId: "9a3524c0-728c-554f-8d26-a19c6ee66a4a",
      destinationAddress: "0x000000000000000000000000000000000000dead",
      amountUnits: 100_000n,
      tokenId: "5797fbd6-3795-519d-84ca-ec4c5f80c3b1",
    });

    expect(result.state).toBe("INITIATED");
    // The single most important assertion in this file: no hash comes back.
    expect(result.txHash).toBeNull();

    const post = ctx.calls.find((call) => call.url.includes("/transfer"));
    expect(post?.body?.["amounts"]).toEqual(["0.100000"]);
    expect(post?.body?.["feeLevel"]).toBe("MEDIUM");
    expect(post?.body?.["idempotencyKey"]).toBe(idempotencyKey);
    expect(post?.headers["Idempotency-Key"]).toBe(idempotencyKey);
    expect(idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("carries a fresh ciphertext, never the secret itself", async () => {
    const c = client({
      [TRANSFER]: () => ({ status: 201, body: { data: { id: "t1", state: "INITIATED" } } }),
    });
    await c.createTransfer({
      walletId: "w",
      destinationAddress: "0x000000000000000000000000000000000000dead",
      amountUnits: 100_000n,
      tokenId: "tok",
    });
    await c.createTransfer({
      walletId: "w",
      destinationAddress: "0x000000000000000000000000000000000000dead",
      amountUnits: 100_000n,
      tokenId: "tok",
    });
    const posts = ctx.calls.filter((call) => call.url.includes("/transfer"));
    const ciphertexts = posts.map((call) => String(call.body?.["entitySecretCiphertext"]));
    expect(ciphertexts).toHaveLength(2);
    expect(ciphertexts[0]).not.toBe(ciphertexts[1]);
    for (const ciphertext of ciphertexts) expect(ciphertext).not.toContain(ENTITY_SECRET);
    // And two separate idempotency keys, because these are two instructions.
    expect(posts[0]?.body?.["idempotencyKey"]).not.toBe(posts[1]?.body?.["idempotencyKey"]);
  });

  it("keeps the HTTP status on the error, so 401 and a dead network stay different", async () => {
    const c = client({
      [TRANSFER]: () => ({ status: 401, body: { code: 401, message: "Invalid credentials." } }),
    });
    await expect(
      c.createTransfer({ walletId: "w", destinationAddress: "0x0", amountUnits: 1n, tokenId: "t" }),
    ).rejects.toMatchObject({ name: "CircleError", status: 401, code: 401 });
  });

  it("reports a transport failure as status 0 — 'we do not know', not 'they said no'", async () => {
    const failing = async (): Promise<Response> => {
      throw new Error("ECONNRESET");
    };
    const c = new CircleClient({ config, fetchImpl: failing });
    const error = await c.ping().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CircleError);
    expect((error as CircleError).status).toBe(0);
  });
});

describe("reads", () => {
  it("filters wallets by blockchain in the query string", async () => {
    const c = client({
      "GET /v1/w3s/wallets": () => ({
        body: {
          data: {
            wallets: [
              {
                id: "9a3524c0-728c-554f-8d26-a19c6ee66a4a",
                address: "0xeaa8ce10abcbce9d7f5257126c36a078c9951e1c",
                blockchain: "BASE-SEPOLIA",
                state: "LIVE",
                accountType: "EOA",
                walletSetId: "9882bf06-4831-5bad-a1d4-606b80f944e0",
              },
            ],
          },
        },
      }),
    });
    const wallets = await c.listWallets({ blockchain: "BASE-SEPOLIA" });
    expect(wallets).toHaveLength(1);
    expect(ctx.calls.at(-1)?.url).toContain("blockchain=BASE-SEPOLIA");
  });

  it("returns an empty list for an account with no wallet sets, rather than throwing", async () => {
    const c = client({ "GET /v1/w3s/walletSets": () => ({ body: { data: { walletSets: [] } } }) });
    expect(await c.listWalletSets()).toEqual([]);
  });

  it("reads a transaction's hash once Circle has one", async () => {
    const c = client({
      "GET /v1/w3s/transactions/a384de2e-ff91-5bc8-8c05-7f13112ba22b": () => ({
        body: {
          data: {
            transaction: {
              id: "a384de2e-ff91-5bc8-8c05-7f13112ba22b",
              state: "CONFIRMED",
              amounts: ["0.1"],
              txHash: "0x251858a3d3daf45aa2a8e2bc970351580b33bfe97a7f18e951b207fb91d476fa",
            },
          },
        },
      }),
    });
    const tx = await c.getTransaction("a384de2e-ff91-5bc8-8c05-7f13112ba22b");
    expect(tx.txHash).toBe("0x251858a3d3daf45aa2a8e2bc970351580b33bfe97a7f18e951b207fb91d476fa");
  });

  it("sends the bearer token on every call and never a query-string credential", async () => {
    const c = client({ "GET /v1/w3s/walletSets": () => ({ body: { data: { walletSets: [] } } }) });
    await c.listWalletSets();
    for (const call of ctx.calls) {
      expect(call.headers["Authorization"]).toBe("Bearer TEST_API_KEY:key:secret");
      expect(call.url).not.toContain("TEST_API_KEY");
    }
  });
});
