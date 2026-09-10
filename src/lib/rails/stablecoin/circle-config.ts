/**
 * Circle's credentials, and the three ways this file refuses to pretend.
 *
 * ── 1. AN ABSENT KEY IS `not_configured`, NEVER A FALLBACK ───────────────────
 *
 * The direct-to-chain path in ./adapter.ts works. That makes it the obvious
 * thing to quietly do when `CIRCLE_API_KEY` is missing, and it is exactly the
 * wrong thing: the caller asked for Circle, the money would leave over a rail
 * they did not choose, and the ledger entry would name a provider they never
 * picked. So a missing credential produces a `not_configured` verdict that the
 * provider reports and the caller has to look at. Nothing falls back.
 *
 * ── 2. A PRESENT KEY IS NOT EVIDENCE OF ANYTHING ─────────────────────────────
 *
 * DECISIONS 011: liveness is earned by a round trip. This module answers
 * "is there a credential", which is a strictly weaker question than "does it
 * work", and it is named for the weaker one. `configured` never means live.
 * `circleProvider().health()` makes the call that does.
 *
 * ── 3. A LIVE-MODE KEY IS REFUSED, NOT USED ──────────────────────────────────
 *
 * "Live-mode API keys, real money, or real personal data" is an automatic fail
 * on the trial page, and Circle's Web3 Services API has exactly one base URL —
 * `https://api.circle.com` — with the key's own prefix selecting the
 * environment. There is no sandbox hostname to hide behind, so the guard has
 * to be here: a key that does not begin `TEST_API_KEY` is rejected as
 * unusable, with a detail that says why. Measured, not assumed: the sandbox
 * key in use begins `TEST_API_KEY:` and `api-sandbox.circle.com` — the Circle
 * MINT host — answers it with 401 "Invalid credentials", because it is a
 * different product.
 *
 * ── WHERE THE ENTITY SECRET LIVES ────────────────────────────────────────────
 *
 * In `.env`, which is gitignored and has never been committed. Circle's own
 * console warns "Never expose your Entity Secret in source control,
 * configuration files, or logs", and `.env` is a configuration file: this is a
 * work-trial testnet credential in a local dotfile, not a secrets manager, and
 * saying so is better than implying otherwise. It is read here, encrypted per
 * request in ./circle-client.ts, and never logged — `describeCircleConfig()`
 * exists so that operator output can describe the configuration without
 * printing any of it.
 */

/** Web3 Services has ONE host. The key prefix, not the hostname, picks testnet. */
export const CIRCLE_BASE_URL = "https://api.circle.com";

/** Circle's name for Base Sepolia in the developer-controlled wallet API. */
export const CIRCLE_BLOCKCHAIN = "BASE-SEPOLIA";

/** The EIP-155 chain id `CIRCLE_BLOCKCHAIN` must agree with. */
export const CIRCLE_CHAIN_ID = 84532n;

/** Sandbox keys carry this prefix. Anything else is refused; see the header. */
const TEST_KEY_PREFIX = "TEST_API_KEY";

/** 32 bytes, hex. Circle generates it; the console registers its ciphertext. */
const ENTITY_SECRET_RE = /^[0-9a-fA-F]{64}$/;

export interface CircleConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** 64 hex characters. Encrypted fresh for every mutating request. */
  readonly entitySecret: string;
  /** Optional: pins the wallet set. Absent means "discover or create one". */
  readonly walletSetId: string | null;
  /** Optional: pins the sending wallet. Absent means "discover the only one". */
  readonly walletId: string | null;
  /** Optional: Circle's own uuid for USDC on this chain. Resolved if absent. */
  readonly tokenId: string | null;
}

export type CircleConfigResult =
  | { readonly configured: true; readonly config: CircleConfig }
  | {
      readonly configured: false;
      /** Which variables would have to be set. Empty when the key is refused. */
      readonly missing: readonly string[];
      readonly detail: string;
    };

/** A `process.env`-shaped thing. Passed in so this is testable with no globals. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

function present(source: EnvSource, key: string): string | null {
  const raw = source[key];
  if (raw === undefined) return null;
  // A variable set to the empty string is not set. `.env` files are full of
  // `KEY=` lines waiting for a value, and treating one as a credential is the
  // blank-value half of the DECISIONS 011 bug.
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Read the Circle credentials. Never throws; the absence IS the answer.
 */
export function readCircleConfig(source: EnvSource = process.env): CircleConfigResult {
  const apiKey = present(source, "CIRCLE_API_KEY");
  const entitySecret = present(source, "CIRCLE_ENTITY_SECRET");

  const missing: string[] = [];
  if (apiKey === null) missing.push("CIRCLE_API_KEY");
  if (entitySecret === null) missing.push("CIRCLE_ENTITY_SECRET");
  if (apiKey === null || entitySecret === null) {
    return {
      configured: false,
      missing,
      detail: `Circle is not wired: ${missing.join(" and ")} absent. The direct-to-chain rail is NOT a substitute and is not being used.`,
    };
  }

  if (!apiKey.startsWith(`${TEST_KEY_PREFIX}:`)) {
    return {
      configured: false,
      missing: [],
      detail:
        `CIRCLE_API_KEY does not begin "${TEST_KEY_PREFIX}:". Web3 Services has one host and the key prefix selects the ` +
        `environment, so a non-test key here is a live-mode key — an automatic fail on this trial. Refusing to use it.`,
    };
  }

  if (!ENTITY_SECRET_RE.test(entitySecret)) {
    return {
      configured: false,
      missing: [],
      detail: `CIRCLE_ENTITY_SECRET must be 64 hex characters (32 bytes); got ${entitySecret.length} characters.`,
    };
  }

  return {
    configured: true,
    config: {
      baseUrl: present(source, "CIRCLE_BASE_URL") ?? CIRCLE_BASE_URL,
      apiKey,
      entitySecret,
      walletSetId: present(source, "CIRCLE_WALLET_SET_ID"),
      walletId: present(source, "CIRCLE_WALLET_ID"),
      tokenId: present(source, "CIRCLE_TOKEN_ID"),
    },
  };
}

/**
 * A one-line description of the configuration that contains no secret.
 *
 * For operator output and the health detail. The API key's prefix is the only
 * part that appears, because the prefix is the thing worth stating — it is
 * what proves the environment is testnet — and the rest is the credential.
 */
export function describeCircleConfig(result: CircleConfigResult): string {
  if (!result.configured) return result.detail;
  const { config } = result;
  return [
    `${TEST_KEY_PREFIX} (testnet)`,
    `entity secret registered`,
    `walletSet ${config.walletSetId ?? "discover"}`,
    `wallet ${config.walletId ?? "discover"}`,
    `token ${config.tokenId ?? "resolve from balances"}`,
  ].join(", ");
}
