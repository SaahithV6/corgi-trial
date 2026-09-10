/**
 * Circle Web3 Services over `fetch`, and the two things it is careful about.
 *
 * ── 1. THE ENTITY SECRET CIPHERTEXT IS FRESH EVERY REQUEST ───────────────────
 *
 * Circle authorises a developer-controlled wallet action with an
 * `entitySecretCiphertext`: the 32-byte entity secret, RSA-OAEP-SHA256
 * encrypted against an entity public key Circle publishes at
 * `GET /v1/w3s/config/entity/publicKey`. Circle rejects a REUSED ciphertext,
 * which is a good design — a replayed ciphertext would be a replayed
 * authorisation — and it means the ciphertext cannot be computed once and
 * cached. OAEP is randomised, so encrypting the same secret twice produces two
 * different ciphertexts, and `encryptEntitySecret()` is called inside every
 * mutating method rather than at construction.
 *
 * The PUBLIC key is cached, because it is a public key and fetching it on
 * every call is a round trip that proves nothing. The SECRET is never logged,
 * never returned, and never put in an error message.
 *
 * ── 2. IDEMPOTENCY IS A UUIDv4 THE CALLER CAN SEE ────────────────────────────
 *
 * Every mutating call carries one, in the body where Circle documents it and
 * in the `Idempotency-Key` header, and every method returns it alongside the
 * result. It is the operator's handle on a request whose response was lost,
 * and it is the reason a retried transfer is one transfer.
 *
 * It is NOT the ledger's idempotency key. That one is derived from the on-chain
 * transaction hash and is shared with the direct-to-chain path — see
 * `payoutIdempotencyKey` in ./types.ts — which is what makes it impossible for
 * two providers to book the same movement twice.
 *
 * ── ONE BASE URL ─────────────────────────────────────────────────────────────
 *
 * Measured, with the real key: `https://api.circle.com` answers 200 on
 * `/v1/w3s/*`; `https://api-sandbox.circle.com` answers 401 "Invalid
 * credentials" on the same paths, because that host is Circle Mint, a
 * different product. `/v1/configuration` answers 403 on this key for the same
 * reason. The environment is selected by the key's `TEST_API_KEY:` prefix,
 * which ./circle-config.ts insists on.
 *
 * `server-only` is deliberately NOT imported — same reason as ./client.ts:
 * this has to be constructible under vitest's node environment.
 */

import { constants, publicEncrypt, randomUUID } from "node:crypto";

import { CIRCLE_BASE_URL, CIRCLE_BLOCKCHAIN, type CircleConfig } from "./circle-config";
import {
  circleData,
  parseTokenBalance,
  parseTransaction,
  parseWallet,
  parseWalletSet,
  unitsToCircleAmount,
  type CircleTokenBalance,
  type CircleTransaction,
  type CircleWallet,
  type CircleWalletSet,
} from "./circle-types";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A Circle API failure, carrying the HTTP status and Circle's own error body.
 *
 * The status is a field rather than a substring of the message because the
 * health probe has to distinguish 401 (`unauthorised` — the key is wrong) from
 * a network failure (`unreachable` — we do not know), and DECISIONS 011 is
 * about never collapsing those two.
 */
export class CircleError extends Error {
  override readonly name = "CircleError";
  readonly status: number;
  readonly code: number | null;
  readonly path: string;
  /** Circle's error body, untouched, for audit. */
  readonly raw: unknown;
  constructor(message: string, path: string, status: number, code: number | null, raw: unknown) {
    super(message);
    this.path = path;
    this.status = status;
    this.code = code;
    this.raw = raw;
  }
}

export interface CircleClientOptions {
  readonly config: CircleConfig;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  /** Injected in tests so a UUID is not a moving target. */
  readonly newIdempotencyKey?: () => string;
}

export interface CircleTransferRequest {
  readonly walletId: string;
  readonly destinationAddress: string;
  /** Minor units. Converted to Circle's decimal string exactly once, here. */
  readonly amountUnits: bigint;
  readonly tokenId: string;
  /** Circle's own fee tier. `MEDIUM` unless an operator says otherwise. */
  readonly feeLevel?: "LOW" | "MEDIUM" | "HIGH";
  /** Free text Circle echoes back on the transaction. */
  readonly refId?: string;
}

/** What a mutating call returns: the result, plus the key that made it safe. */
export interface Idempotent<T> {
  readonly idempotencyKey: string;
  readonly result: T;
}

export class CircleClient {
  readonly #config: CircleConfig;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #newKey: () => string;
  #entityPublicKey: string | null = null;

  constructor(options: CircleClientOptions) {
    this.#config = options.config;
    this.#fetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#newKey = options.newIdempotencyKey ?? randomUUID;
  }

  get baseUrl(): string {
    return this.#config.baseUrl || CIRCLE_BASE_URL;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  async #request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#config.apiKey}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;

    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      // Network, DNS, timeout. Status 0 means "we do not know", which is a
      // different fact from "the provider said no" and is kept different.
      throw new CircleError(
        `${method} ${path}: ${error instanceof Error ? error.message : String(error)}`,
        path,
        0,
        null,
        error,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      parsed = text;
    }

    if (!response.ok) {
      const envelope =
        typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const code = typeof envelope["code"] === "number" ? envelope["code"] : null;
      const message = typeof envelope["message"] === "string" ? envelope["message"] : text.slice(0, 300);
      throw new CircleError(
        `${method} ${path}: HTTP ${response.status}${message ? ` — ${message}` : ""}`,
        path,
        response.status,
        code,
        parsed,
      );
    }
    return parsed;
  }

  // -------------------------------------------------------------------------
  // The entity secret
  // -------------------------------------------------------------------------

  /** Circle's RSA public key, PEM. Cached: it is public and it is stable. */
  async entityPublicKey(): Promise<string> {
    if (this.#entityPublicKey !== null) return this.#entityPublicKey;
    const data = circleData(
      await this.#request("GET", "/v1/w3s/config/entity/publicKey"),
      "entityPublicKey",
    );
    const pem = data["publicKey"];
    if (typeof pem !== "string" || !pem.includes("BEGIN PUBLIC KEY")) {
      throw new CircleError("entity publicKey is not a PEM", "/v1/w3s/config/entity/publicKey", 200, null, data);
    }
    this.#entityPublicKey = pem;
    return pem;
  }

  /**
   * A fresh `entitySecretCiphertext`.
   *
   * RSA-OAEP with SHA-256, which is what Circle's own SDK does and what its
   * public key is published for. OAEP seeds randomly, so two calls with the
   * same secret produce two different ciphertexts — which is exactly the
   * property Circle's replay rejection depends on.
   */
  async encryptEntitySecret(): Promise<string> {
    const pem = await this.entityPublicKey();
    const cipher = publicEncrypt(
      { key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(this.#config.entitySecret, "hex"),
    );
    return cipher.toString("base64");
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** The cheapest authenticated read Circle offers. Used by the health probe. */
  async ping(): Promise<void> {
    await this.#request("GET", "/v1/w3s/config/entity/publicKey");
  }

  async listWalletSets(): Promise<readonly CircleWalletSet[]> {
    const data = circleData(await this.#request("GET", "/v1/w3s/walletSets"), "walletSets");
    const sets = data["walletSets"];
    return Array.isArray(sets) ? sets.map((s) => parseWalletSet({ walletSet: s })) : [];
  }

  async listWallets(filter: { blockchain?: string; walletSetId?: string } = {}): Promise<readonly CircleWallet[]> {
    const query = new URLSearchParams();
    if (filter.blockchain !== undefined) query.set("blockchain", filter.blockchain);
    if (filter.walletSetId !== undefined) query.set("walletSetId", filter.walletSetId);
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    const data = circleData(await this.#request("GET", `/v1/w3s/wallets${suffix}`), "wallets");
    const wallets = data["wallets"];
    return Array.isArray(wallets) ? wallets.map(parseWallet) : [];
  }

  async getWallet(walletId: string): Promise<CircleWallet> {
    const data = circleData(await this.#request("GET", `/v1/w3s/wallets/${walletId}`), "wallet");
    return parseWallet(data["wallet"] ?? data);
  }

  /**
   * Circle's view of what the wallet holds.
   *
   * Used to resolve Circle's `tokenId` for USDC and for NOTHING ELSE. It is
   * never the balance the ledger reconciles against: "your payment provider's
   * balance is their ledger, not yours". See ./circle-recon.ts, which diffs
   * account 1140 against the chain.
   */
  async walletBalances(walletId: string): Promise<readonly CircleTokenBalance[]> {
    const data = circleData(
      await this.#request("GET", `/v1/w3s/wallets/${walletId}/balances`),
      "balances",
    );
    const balances = data["tokenBalances"];
    return Array.isArray(balances) ? balances.map(parseTokenBalance) : [];
  }

  /**
   * One transaction, by Circle's id. This is where `txHash` eventually shows up.
   */
  async getTransaction(transactionId: string): Promise<CircleTransaction> {
    const data = circleData(
      await this.#request("GET", `/v1/w3s/transactions/${transactionId}`),
      "transaction",
    );
    return parseTransaction(data);
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async createWalletSet(name: string): Promise<Idempotent<CircleWalletSet>> {
    const idempotencyKey = this.#newKey();
    const data = circleData(
      await this.#request(
        "POST",
        "/v1/w3s/developer/walletSets",
        {
          idempotencyKey,
          entitySecretCiphertext: await this.encryptEntitySecret(),
          name,
        },
        idempotencyKey,
      ),
      "createWalletSet",
    );
    return { idempotencyKey, result: parseWalletSet(data) };
  }

  async createWallets(args: {
    walletSetId: string;
    blockchains?: readonly string[];
    accountType?: "EOA" | "SCA";
    count?: number;
  }): Promise<Idempotent<readonly CircleWallet[]>> {
    const idempotencyKey = this.#newKey();
    const data = circleData(
      await this.#request(
        "POST",
        "/v1/w3s/developer/wallets",
        {
          idempotencyKey,
          entitySecretCiphertext: await this.encryptEntitySecret(),
          walletSetId: args.walletSetId,
          blockchains: args.blockchains ?? [CIRCLE_BLOCKCHAIN],
          accountType: args.accountType ?? "EOA",
          count: args.count ?? 1,
        },
        idempotencyKey,
      ),
      "createWallets",
    );
    const wallets = data["wallets"];
    return {
      idempotencyKey,
      result: Array.isArray(wallets) ? wallets.map(parseWallet) : [],
    };
  }

  /**
   * Instruct the transfer.
   *
   * Returns whatever Circle returns, which in practice is `{id, state:
   * "INITIATED"}` and NO transaction hash. Nothing in this method pretends
   * otherwise, and nothing downstream is allowed to treat what it returns as a
   * payment. See ./circle-provider.ts.
   */
  async createTransfer(request: CircleTransferRequest): Promise<Idempotent<CircleTransaction>> {
    const idempotencyKey = this.#newKey();
    const body: Record<string, unknown> = {
      idempotencyKey,
      entitySecretCiphertext: await this.encryptEntitySecret(),
      walletId: request.walletId,
      destinationAddress: request.destinationAddress,
      amounts: [unitsToCircleAmount(request.amountUnits)],
      tokenId: request.tokenId,
      feeLevel: request.feeLevel ?? "MEDIUM",
    };
    if (request.refId !== undefined) body["refId"] = request.refId;

    const data = circleData(
      await this.#request("POST", "/v1/w3s/developer/transactions/transfer", body, idempotencyKey),
      "createTransfer",
    );
    return { idempotencyKey, result: parseTransaction(data) };
  }
}
