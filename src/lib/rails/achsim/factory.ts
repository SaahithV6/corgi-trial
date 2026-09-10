/**
 * The ACH rail factory: which adapter is serving the ACH slot, and why.
 *
 * WHY THIS FILE LIVES UNDER achsim/ AND NOT ABOVE IT. Selection has to import
 * both adapters. Putting it here means the dependency runs simulator ->
 * live adapter and never the other way: `../increase/client.ts` has no import
 * path to this package at all, so no code running the live rail can reach the
 * simulator, accidentally or otherwise. The arrow points the safe way.
 *
 * THE RULE THIS FILE EXISTS FOR: if `INCREASE_API_KEY` is absent, the ACH slot
 * is served by the SIMULATOR, and that fact is stated — loudly, in the logs at
 * selection time, and in the health report — not inferred, not defaulted
 * quietly, and never omitted. A silent downgrade to a simulator is how a demo
 * ends up showing simulated money to a panel that thinks it is watching a bank.
 */

import { rootLogger, type Logger } from '../../log';
import { IncreaseAchRail, INCREASE_PROVIDER } from '../increase/client';
import { evidenceLabel, type PaymentRail, type RailSlotHealth } from '../types';
import { ACHSIM_PROVIDER_SLUG, AchSimEngine } from './engine';
import { AchSimRail, ACHSIM_CAPABILITIES } from './rail';
import { WebhookSigner } from './signing';

export type EnvBag = Readonly<Record<string, string | undefined>>;

/** Env vars the live adapter needs before it can do anything at all. */
export const LIVE_ACH_ENV = ['INCREASE_API_KEY'] as const;
/** Additionally needed before an inbound Increase webhook can be verified. */
export const LIVE_ACH_WEBHOOK_ENV = ['INCREASE_WEBHOOK_SECRET'] as const;

/** The simulator's own signing secret. Never the Increase one — see ./signing.ts. */
export const SIM_WEBHOOK_SECRET_ENV = 'ACH_SIM_WEBHOOK_SECRET';

/**
 * The fallback signing secret when `ACH_SIM_WEBHOOK_SECRET` is unset.
 *
 * A hard-coded default is normally a smell. Here it is correct and it is safe:
 * this key signs nothing but simulated traffic, an attacker forging a simulated
 * webhook gains the ability to insert an event labelled SIMULATED, and the
 * alternative — falling back to the live secret — is the one outcome this
 * package exists to prevent. It is deliberately unmistakable in a log or a
 * config dump.
 */
export const SIM_WEBHOOK_SECRET_DEFAULT = 'achsim-development-only-not-a-real-secret';

export interface AchRailSelection {
  readonly rail: PaymentRail;
  readonly health: RailSlotHealth;
  /** Present only when the simulator was selected, for the control API. */
  readonly engine: AchSimEngine | null;
}

export interface CreateAchRailOptions {
  readonly env?: EnvBag | undefined;
  readonly logger?: Pick<Logger, 'info' | 'warn'> | undefined;
  /**
   * Force a choice. Used by tests and by a demo that wants the simulator even
   * with a key present. Forcing 'live' with no key is refused: it would produce
   * a rail whose every call throws, which is a worse answer than the simulator.
   */
  readonly force?: 'live' | 'simulator' | undefined;
  /** Deliveries signed with wall-clock timestamps, for real HTTP round trips. */
  readonly signingTime?: 'virtual' | 'wall' | undefined;
  readonly seed?: string | number | undefined;
}

/**
 * Pick an ACH rail and say so.
 *
 * Three outcomes, and each one logs a line an operator can act on:
 *
 *   key present            -> live adapter, `info`
 *   key absent             -> simulator,    `warn` (never `info`: a slot that
 *                             is not live is not a normal condition)
 *   forced to simulator    -> simulator,    `warn`, with the reason recorded
 */
export function createAchRail(opts: CreateAchRailOptions = {}): AchRailSelection {
  const env = opts.env ?? process.env;
  const log = opts.logger ?? rootLogger;

  const missingEnv = [...LIVE_ACH_ENV, ...LIVE_ACH_WEBHOOK_ENV].filter(
    (key) => readEnv(env, key) === undefined,
  );
  const hasApiKey = readEnv(env, 'INCREASE_API_KEY') !== undefined;

  if (opts.force === 'live' && !hasApiKey) {
    // Asked for live, no key. Refuse rather than hand back a rail that throws
    // on first use: the caller is entitled to a straight answer now.
    throw new Error(
      'createAchRail({ force: "live" }) but INCREASE_API_KEY is not set. Set the key, or let the factory select the simulator.',
    );
  }

  const useSimulator = opts.force === 'simulator' || (opts.force !== 'live' && !hasApiKey);

  if (!useSimulator) {
    const rail = new IncreaseAchRail({});
    const health: RailSlotHealth = {
      slot: 'ach',
      provider: INCREASE_PROVIDER,
      selected: 'live_adapter',
      evidence: 'live',
      environment: rail.capabilities.environment,
      label: evidenceLabel('live'),
      missingEnv,
      reason:
        missingEnv.length === 0
          ? 'INCREASE_API_KEY and INCREASE_WEBHOOK_SECRET are present; the ACH slot talks to Increase.'
          : `INCREASE_API_KEY is present so the live adapter is selected, but ${missingEnv.join(', ')} is missing — outbound calls work, inbound webhooks cannot be verified.`,
    };
    log.info('rails.ach.selected', {
      provider: health.provider,
      selected: health.selected,
      label: health.label,
      environment: health.environment,
      missingEnv,
    });
    return { rail, health, engine: null };
  }

  const secret = readEnv(env, SIM_WEBHOOK_SECRET_ENV) ?? SIM_WEBHOOK_SECRET_DEFAULT;
  const engine = new AchSimEngine({
    signer: new WebhookSigner({ secret, liveSecret: readEnv(env, 'INCREASE_WEBHOOK_SECRET') }),
    seed: opts.seed ?? 'achsim',
    signingTime: opts.signingTime,
  });
  const rail = new AchSimRail({ engine });

  const reason =
    opts.force === 'simulator'
      ? 'The ACH slot was explicitly forced to the SIMULATOR. Nothing it produces is evidence of a real bank transfer.'
      : 'INCREASE_API_KEY is not set, so the ACH slot is served by the SIMULATOR. Nothing it produces is evidence of a real bank transfer.';

  const health: RailSlotHealth = {
    slot: 'ach',
    provider: ACHSIM_PROVIDER_SLUG,
    selected: 'simulator',
    evidence: ACHSIM_CAPABILITIES.evidence,
    environment: 'simulator',
    label: evidenceLabel(ACHSIM_CAPABILITIES.evidence),
    missingEnv,
    reason,
  };

  // `warn`, not `info`. This line is the one an operator needs to see when they
  // are wondering why the demo settled in four seconds.
  log.warn('rails.ach.simulator_selected', {
    provider: health.provider,
    selected: health.selected,
    label: health.label,
    missingEnv,
    reason,
  });

  return { rail, health, engine };
}

/**
 * The health view on its own, with no rail constructed.
 *
 * Pure: reads env, touches no network, allocates no client. Shaped like
 * `IntegrationReport` in `src/lib/webhooks/route-handler.ts` so `/api/health`
 * can render rail slots and webhook integrations side by side. Never returns a
 * value; only env var NAMES, because a health endpoint is public.
 */
export function achRailHealth(env: EnvBag = process.env): RailSlotHealth {
  const missingEnv = [...LIVE_ACH_ENV, ...LIVE_ACH_WEBHOOK_ENV].filter(
    (key) => readEnv(env, key) === undefined,
  );
  const hasApiKey = readEnv(env, 'INCREASE_API_KEY') !== undefined;
  if (hasApiKey) {
    return {
      slot: 'ach',
      provider: INCREASE_PROVIDER,
      selected: 'live_adapter',
      evidence: 'live',
      environment:
        (readEnv(env, 'INCREASE_BASE_URL') ?? '').includes('api.increase.com') ? 'production' : 'sandbox',
      label: 'LIVE',
      missingEnv,
      reason: 'INCREASE_API_KEY is present; the ACH slot talks to Increase.',
    };
  }
  return {
    slot: 'ach',
    provider: ACHSIM_PROVIDER_SLUG,
    selected: 'simulator',
    evidence: 'simulated',
    environment: 'simulator',
    label: 'SIMULATED',
    missingEnv,
    reason:
      'INCREASE_API_KEY is not set, so the ACH slot is served by the SIMULATOR. Nothing it produces is evidence of a real bank transfer.',
  };
}

/** Trimmed, or undefined. An empty string is a missing value, not a value. */
function readEnv(env: EnvBag, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}
