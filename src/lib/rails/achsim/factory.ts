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
 *
 * ─── SELECTION IS BY PRESENCE. LIVENESS NEVER IS. ───────────────────────────
 *
 * Those are two questions and this file used to answer them with one variable.
 * `INCREASE_API_KEY !== undefined` is the correct and complete input to "which
 * adapter is wired up"; it is not evidence of anything at all about "does that
 * adapter work". Until 2026-09-11 both `createAchRail()` and `achRailHealth()`
 * read a non-empty string and published `label: 'LIVE'`, with no round trip,
 * on a slot whose live adapter had never been run against the provider. That
 * is liveness by presence — the failure `src/lib/integrations/probe.ts` and
 * DECISIONS 011 exist to kill, surviving inside the factory.
 *
 * So the two answers are now two fields, and neither can be mistaken for the
 * other:
 *
 *   selected  'live_adapter' | 'simulator'   from configuration. Unchanged.
 *   liveness   RailLiveness                  from a round trip, or `unprobed`.
 *
 * The synchronous functions here stay synchronous and pure, and therefore
 * report `unprobed` for a configured-but-unproven Increase: a function that
 * touches no network is not entitled to a verdict about a network.
 * `probeAchRailHealth()` is the async sibling that makes the call and earns
 * one. `label` is computed by `railProbeLabel` in both, so LIVE requires a
 * real provider AND a successful round trip and cannot be written by hand.
 *
 * The extra import of `../adapters/ach` keeps the arrow pointing the safe way:
 * that module already depends on `../achsim/rail` and on `../increase/client`,
 * and `../increase/client.ts` still has no import path back into this package.
 */

import { rootLogger, type Logger } from '../../log';
import { achSimAdapter, increaseAchAdapter } from '../adapters/ach';
import { railProbeLabel, type RailLiveness, type RailProbeOptions } from '../contract';
import { IncreaseAchRail, INCREASE_PROVIDER } from '../increase/client';
import type { PaymentRail, RailSlotHealth } from '../types';
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
      // Selection is not proof. This constructor makes no network call — it
      // could not, it is synchronous — so it has nothing to say about whether
      // Increase will answer, and `unprobed` is that sentence in one word.
      liveness: 'unprobed',
      environment: rail.capabilities.environment,
      label: railProbeLabel('live', 'unprobed'),
      missingEnv,
      reason:
        missingEnv.length === 0
          ? 'INCREASE_API_KEY and INCREASE_WEBHOOK_SECRET are present, so the ACH slot is wired to the Increase adapter — but nothing here has called Increase. Credential present, NOT probed: run probeAchRailHealth() for a verdict.'
          : `INCREASE_API_KEY is present so the live adapter is selected, but ${missingEnv.join(', ')} is missing — inbound webhooks cannot be verified. Nothing here has called Increase either: credential present, NOT probed.`,
    };
    log.info('rails.ach.selected', {
      provider: health.provider,
      selected: health.selected,
      liveness: health.liveness,
      label: health.label,
      environment: health.environment,
      missingEnv,
    });
    return { rail, health, engine: null };
  }

  const engine = simEngine(env, { seed: opts.seed, signingTime: opts.signingTime });
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
    // The one place `live` is honestly claimed without a network call, for the
    // one reason that permits it: the simulator is IN THIS PROCESS, so if this
    // line is executing it is running. `evidence` is `simulated`, so
    // `railProbeLabel` still returns SIMULATED and always will — exactly the
    // pair of words `achSimAdapter().probe()` reports.
    liveness: 'live',
    environment: 'simulator',
    label: railProbeLabel(ACHSIM_CAPABILITIES.evidence, 'live'),
    missingEnv,
    reason,
  };

  // `warn`, not `info`. This line is the one an operator needs to see when they
  // are wondering why the demo settled in four seconds.
  log.warn('rails.ach.simulator_selected', {
    provider: health.provider,
    selected: health.selected,
    liveness: health.liveness,
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
 *
 * BECAUSE IT TOUCHES NO NETWORK, IT CANNOT REPORT LIVE. It used to. With
 * `INCREASE_API_KEY` set to any non-empty string — a placeholder pasted out of
 * `.env.example` would do — it returned `label: 'LIVE'` and the sentence
 * "the ACH slot talks to Increase", present tense, about a conversation that
 * had never happened. The most it can honestly say is which adapter is wired
 * up and that nobody has tested it, which is `liveness: 'unprobed'` and a
 * SIMULATED label. Use `probeAchRailHealth()` when you want the other answer;
 * it costs one HTTP round trip, which is exactly what the word LIVE costs.
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
      liveness: 'unprobed',
      environment:
        (readEnv(env, 'INCREASE_BASE_URL') ?? '').includes('api.increase.com') ? 'production' : 'sandbox',
      label: railProbeLabel('live', 'unprobed'),
      missingEnv,
      reason:
        'INCREASE_API_KEY is present, so the ACH slot is wired to the Increase adapter — but this report made no call. Credential present, NOT probed: nothing here proves the slot works.',
    };
  }
  return {
    slot: 'ach',
    provider: ACHSIM_PROVIDER_SLUG,
    selected: 'simulator',
    evidence: 'simulated',
    liveness: 'live',
    environment: 'simulator',
    label: railProbeLabel('simulated', 'live'),
    missingEnv,
    reason:
      'INCREASE_API_KEY is not set, so the ACH slot is served by the SIMULATOR. Nothing it produces is evidence of a real bank transfer.',
  };
}

/**
 * The same report, with the round trip that earns the verdict.
 *
 * This is the only function in this file allowed to return a LIVE label, and
 * it gets there the one legitimate way: it builds the adapter that is actually
 * serving the slot and calls its `probe()` — `GET /accounts?limit=1` against
 * Increase, or the in-process answer from the simulator — and reports what
 * came back. A 401 from a pasted placeholder reads `unauthorised`, a network
 * failure reads `unreachable`, a 429 reads `rate_limited`, and none of them is
 * LIVE. The probe never throws, so neither does this.
 *
 * It deliberately does NOT cache. `src/lib/integrations/verdict-cache.ts` owns
 * the question of when a rationed provider may quote an earned verdict instead
 * of re-proving it, and a second cache here would be a second opinion about
 * the age of the same fact.
 */
export async function probeAchRailHealth(
  opts: { readonly env?: EnvBag | undefined } & RailProbeOptions = {},
): Promise<RailSlotHealth> {
  const env = opts.env ?? process.env;
  const declared = achRailHealth(env);
  const probeOpts: RailProbeOptions = {
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  };

  const adapter =
    declared.selected === 'live_adapter'
      ? increaseAchAdapter({ rail: new IncreaseAchRail({}), env })
      : achSimAdapter({ rail: new AchSimRail({ engine: simEngine(env) }) });

  const probe = await adapter.probe(probeOpts);
  return {
    ...declared,
    liveness: probe.liveness,
    label: probe.label,
    reason: reasonFor(declared, probe.liveness, probe.detail),
  };
}

/** One sentence an operator can act on, for each verdict a probe can return. */
function reasonFor(declared: RailSlotHealth, liveness: RailLiveness, detail: string): string {
  if (declared.selected === 'simulator') return declared.reason;
  switch (liveness) {
    case 'live':
      return `Increase answered: ${detail}. The ACH slot is live, proven by that call and nothing else.`;
    case 'unauthorised':
      return `Increase REFUSED the credential: ${detail}. INCREASE_API_KEY is set but wrong — the placeholder case. The slot is not live.`;
    case 'rate_limited':
      return `Increase rationed the reading: ${detail}. The credential was never evaluated, so nothing is proven either way.`;
    case 'unreachable':
      return `Increase could not be reached: ${detail}. We do not know whether the slot works, so we do not claim it does.`;
    case 'not_configured':
      return `INCREASE_API_KEY is absent: ${detail}.`;
    case 'unprobed':
      return declared.reason;
  }
}

/**
 * A simulator engine wired with the simulator's OWN secret.
 *
 * Shared by `createAchRail` and `probeAchRailHealth` so the rule in
 * ./signing.ts — never reach for the live secret — has exactly one
 * implementation here rather than one per call site.
 */
function simEngine(
  env: EnvBag,
  opts: { readonly seed?: string | number | undefined; readonly signingTime?: 'virtual' | 'wall' | undefined } = {},
): AchSimEngine {
  const secret = readEnv(env, SIM_WEBHOOK_SECRET_ENV) ?? SIM_WEBHOOK_SECRET_DEFAULT;
  return new AchSimEngine({
    signer: new WebhookSigner({ secret, liveSecret: readEnv(env, 'INCREASE_WEBHOOK_SECRET') }),
    seed: opts.seed ?? 'achsim',
    signingTime: opts.signingTime,
  });
}

/** Trimmed, or undefined. An empty string is a missing value, not a value. */
function readEnv(env: EnvBag, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}
