/**
 * Which of the two USDC providers moves the money, and how a reader finds out.
 *
 * ── WHY THIS FILE IS NAMED FOR THE NEWCOMER ──────────────────────────────────
 *
 * The direct path predates the interface. Putting the selection in
 * ./adapter.ts would make the older provider import the newer one, and the
 * newer one already imports `settleTransaction` from the older one — a cycle,
 * to hold a two-branch `if`. So the registry lives beside the provider whose
 * arrival created the need for it, and ./adapter.ts stays a module about
 * signing transactions.
 *
 * ── SELECTION IS EXPLICIT, AND IT NEVER FALLS BACK ───────────────────────────
 *
 * `STABLECOIN_PROVIDER` is `direct` unless it says `circle`. It is not
 * inferred from which credentials happen to be present, and asking for Circle
 * when Circle is not configured does NOT quietly get you the direct path — it
 * gets you a provider that reports `not_configured` and refuses. A silent
 * fallback would move real testnet money over a rail nobody chose and then
 * write that rail's name into an append-only ledger, where it cannot be
 * corrected by editing.
 *
 * ── AND IT IS VISIBLE WHEREVER THE MONEY IS ──────────────────────────────────
 *
 *   ledger entry description   "… — circle.w3s block 47… , gas … wei"
 *   outcome                    `outcome.provider`
 *   health                     `stablecoinProviderHealth()`, one row each
 *   operator output            `describeSelection()`
 *
 * A reader must never have to guess which rail moved the money, so the slug is
 * on the journal entry itself rather than only in a log line that scrolls away.
 */

import { directStablecoinProvider, type PayoutOptions } from "./adapter";
import { CircleClient, type FetchLike } from "./circle-client";
import { readCircleConfig, type CircleConfigResult, type EnvSource } from "./circle-config";
import {
  CIRCLE_LABEL,
  circleStablecoinProvider,
  unconfiguredCircleProvider,
} from "./circle-provider";
import type { BaseRpc } from "./client";
import { parsePrivateKey } from "./secp256k1";
import {
  CIRCLE_PROVIDER,
  USDC_PROVIDER,
  type ProviderHealth,
  type StablecoinPayoutProvider,
  type StablecoinProviderId,
} from "./types";

/** The env var that picks a rail. Absent or unrecognised means `direct`. */
export const PROVIDER_ENV_KEY = "STABLECOIN_PROVIDER";

export const DIRECT_LABEL = "Base Sepolia, signed here";

export function providerLabel(id: StablecoinProviderId): string {
  return id === CIRCLE_PROVIDER ? CIRCLE_LABEL : DIRECT_LABEL;
}

export interface RegistryOptions {
  readonly rpc: BaseRpc;
  /** Defaults to `process.env`. Passed in so this is testable with no globals. */
  readonly env?: EnvSource;
  /** Injected in tests, and shared by both providers when given. */
  readonly fetchImpl?: FetchLike;
  readonly onProgress?: (message: string) => void;
  /** Passed to the direct path only. */
  readonly payoutOptions?: PayoutOptions;
  readonly refId?: string;
}

export interface Selection {
  readonly provider: StablecoinPayoutProvider;
  /** What was asked for — which is not always what is usable. */
  readonly requested: StablecoinProviderId;
  /** Why this provider and not the other. Printed by operators. */
  readonly reason: string;
}

/** The Circle provider, wired or honestly inert. Never a fallback to direct. */
export function circleProvider(options: RegistryOptions): {
  provider: StablecoinPayoutProvider;
  config: CircleConfigResult;
} {
  const config = readCircleConfig(options.env ?? process.env);
  if (!config.configured) {
    return { provider: unconfiguredCircleProvider(config.detail), config };
  }
  return {
    provider: circleStablecoinProvider({
      config: config.config,
      rpc: options.rpc,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      ...(options.refId === undefined ? {} : { refId: options.refId }),
    }),
    config,
  };
}

/**
 * The direct-to-chain provider.
 *
 * The key is parsed here and held only for the life of the returned provider,
 * which is the same discipline ./secp256k1.ts asks for: read from the
 * environment at call time, never in module scope.
 */
export function directProvider(options: RegistryOptions & { privateKeyHex?: string }): StablecoinPayoutProvider {
  const source = options.env ?? process.env;
  const hex = options.privateKeyHex ?? source["USDC_SENDER_PRIVATE_KEY"];
  if (hex === undefined || hex.trim().length === 0) {
    throw new Error("USDC_SENDER_PRIVATE_KEY is not set; the direct-to-chain rail cannot sign");
  }
  return directStablecoinProvider(options.rpc, parsePrivateKey(hex.trim()), options.payoutOptions ?? {});
}

/**
 * Pick a rail. Explicit, and it says why.
 *
 * The Circle branch does not check whether Circle works — that is `health()`'s
 * job and it takes a round trip. It checks only whether a credential exists,
 * and hands back a provider that reports `not_configured` when one does not.
 * The caller then sees a refusal instead of a payout, which is the outcome
 * they should see.
 */
export function selectStablecoinProvider(options: RegistryOptions): Selection {
  const source = options.env ?? process.env;
  const requested = (source[PROVIDER_ENV_KEY] ?? "").trim().toLowerCase();

  if (requested === "circle") {
    const { provider, config } = circleProvider(options);
    return {
      provider,
      requested: CIRCLE_PROVIDER,
      reason: config.configured
        ? `${PROVIDER_ENV_KEY}=circle and a TEST_API_KEY credential is present`
        : `${PROVIDER_ENV_KEY}=circle but ${config.detail}`,
    };
  }

  return {
    provider: directProvider(options),
    requested: USDC_PROVIDER,
    reason:
      requested.length === 0
        ? `${PROVIDER_ENV_KEY} is unset; the direct-to-chain rail is the default`
        : `${PROVIDER_ENV_KEY}=${requested} is not a provider; the direct-to-chain rail is the default`,
  };
}

/** One line an operator can print without leaking anything. */
export function describeSelection(selection: Selection): string {
  return `${selection.provider.id} — ${selection.provider.label} (${selection.reason})`;
}

/**
 * Health for BOTH rails, for a surface that reports integrations.
 *
 * Both are probed, not just the selected one, because "which rail could move
 * money right now" and "which rail is configured to" are different questions
 * and an operator mid-incident needs both. The direct rail is reported as
 * `not_configured` rather than throwing when its key is absent, so one missing
 * variable cannot take the whole surface down.
 */
export async function stablecoinProviderHealth(
  options: RegistryOptions,
): Promise<readonly ProviderHealth[]> {
  const circle = circleProvider(options).provider;
  let direct: Promise<ProviderHealth>;
  try {
    direct = directProvider(options).health();
  } catch (error) {
    direct = Promise.resolve({
      provider: USDC_PROVIDER,
      label: DIRECT_LABEL,
      liveness: "not_configured",
      detail: error instanceof Error ? error.message : String(error),
      ms: 0,
    });
  }
  return Promise.all([direct, circle.health()]);
}

export { CircleClient };
