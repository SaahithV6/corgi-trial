/**
 * WHICH PROVIDER ANSWERS THE BUSINESS-REGISTRY LEG, AS AN ORDERED LADDER.
 *
 * ===========================================================================
 * WHY THIS IS A TABLE AND NOT AN IF-CHAIN.
 *
 * The registry leg runs on GLEIF, which is a real third-party registry and is
 * NOT one of the three vendors the brief names for this slot (Persona KYB,
 * Middesk, Sumsub). All three were measured shut — Persona's KYB guide opens
 * with "reach out to your Persona team", Middesk and Sumsub KYB are behind a
 * sales conversation — so GLEIF is a considered fallback rather than the only
 * thing anyone thought of, and the difference between those two sentences is
 * only credible if the fallback is VISIBLY a rung on a ladder that a vendor
 * credential displaces automatically.
 *
 * So: the order lives here, once, as data. Both surfaces that choose a provider
 * read this table — `selectKybLegs()` for `/api/health` and `selectWiredLegs()`
 * for the screen — which is what stops them describing the same leg
 * differently, the exact failure this codebase has caught five times.
 *
 *     KYB_FORCE_SIMULATED   the escape hatch, honoured AHEAD of everything.
 *     1. Persona KYB        vendor, named by the brief.  Adapter EXISTS.
 *     2. Middesk            vendor, named by the brief.  Adapter NOT WRITTEN.
 *     3. Sumsub KYB         vendor, named by the brief.  Adapter NOT WRITTEN.
 *     4. Stripe Connect     vendor, not on the brief.    Adapter EXISTS.
 *     5. GLEIF              registry, not a vendor.      Adapter EXISTS. No
 *                           credential, so this rung always matches — it is the
 *                           last LIVE option, ahead of the simulator and behind
 *                           every vendor.
 *     -  simulated-registry reachable only by the escape hatch.
 *
 * TO MOVE THIS LEG TO A VENDOR: set that rung's environment variables. Nothing
 * else changes — not `composite.ts`, which has never known which registry it is
 * talking to; not the screen, which reads the provider name off the leg; not
 * the database, whose `provider` column is a string. See docs/KYB.md.
 *
 * A RUNG WHOSE CREDENTIAL IS PRESENT BUT WHOSE ADAPTER IS NOT WRITTEN DOES NOT
 * SILENTLY FALL THROUGH. It falls through — there is nothing else it can do —
 * but it carries a `blocked` note out with it, which the wiring panel and the
 * health report both print. Setting `MIDDESK_API_KEY` and quietly still running
 * GLEIF, with a screen that says "live", is precisely the shape of failure this
 * whole module exists to prevent, so it is reported in the same breath.
 * ===========================================================================
 */

import { GleifRegistryProvider, GLEIF_LEG_REASON, GLEIF_PROVIDER_NAME } from './gleif';
import { PersonaKybRegistryProvider } from './persona';
import { StripeConnectRegistryProvider } from './stripe-registry';
import type { KybLegProvider } from './types';

/** The env bag shape every selector reads. Values are never logged. */
export type EnvBag = Record<string, string | undefined>;

export const REGISTRY_ENV = {
  personaApiKey: 'PERSONA_API_KEY',
  /**
   * `itmpl_…` for a BUSINESS template. Deliberately a separate variable from
   * `PERSONA_INQUIRY_TEMPLATE_ID`: the director template and the KYB template
   * are different objects, and one variable serving both would silently point a
   * business inquiry at a person flow the first time somebody set it.
   */
  personaKybTemplateId: 'PERSONA_KYB_TEMPLATE_ID',
  middeskApiKey: 'MIDDESK_API_KEY',
  sumsubAppToken: 'SUMSUB_APP_TOKEN',
  sumsubSecretKey: 'SUMSUB_SECRET_KEY',
  stripeSecretKey: 'STRIPE_SECRET_KEY',
  /**
   * AN EXPLICIT OPT-IN, AND IT HAS TO BE.
   *
   * `STRIPE_SECRET_KEY` is already set in this deployment — Stripe Identity
   * answers the DIRECTOR leg with it. If the Connect rung matched on that key
   * alone, the registry leg would jump to an adapter measured non-functional
   * on this account (Accounts v1 is retired for new integrations; DECISION 017)
   * the moment this table shipped. One shared credential must not select two
   * unrelated capabilities.
   */
  stripeConnectKyb: 'STRIPE_CONNECT_KYB',
} as const;

/** One rung. `build` is null exactly when no adapter has been written yet. */
export interface RegistryRung {
  /** Stable id, used in logs and on the health endpoint. */
  readonly id: string;
  readonly vendor: string;
  /**
   * The `name` the adapter stamps on every leg it produces, so a surface can
   * map a recorded provider back to the rung that chose it WITHOUT constructing
   * an adapter to ask. Null on a rung with no adapter yet.
   */
  readonly providerName: string | null;
  /** Named by the brief for the KYB slot? Persona KYB, Middesk and Sumsub are. */
  readonly onBrief: boolean;
  /** Every variable that must be present for this rung to be selected. */
  readonly requiredEnv: readonly string[];
  /** Null when the credential would be honoured but the adapter is unwritten. */
  readonly build: ((env: EnvBag) => KybLegProvider<'live'>) | null;
  /** One sentence, safe to print, that becomes the leg's `reason`. */
  readonly reason: string;
  /**
   * What to say when this rung's credential is present and `build` is null.
   * Null on rungs that can always be built.
   */
  readonly blockedNote: string | null;
}

/** Trimmed, or undefined. `KEY=` in a .env file is a missing value, not a value. */
export function readEnv(env: EnvBag, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function has(env: EnvBag, keys: readonly string[]): boolean {
  return keys.every((key) => readEnv(env, key) !== undefined);
}

/**
 * THE LADDER. Order is precedence; first match wins.
 *
 * Every vendor rung sits above GLEIF, and GLEIF sits above the simulator. A
 * credential arriving for any rung above therefore displaces GLEIF on the next
 * boot without a code change — which is the property that makes the
 * substitution a choice rather than a corner.
 */
export const REGISTRY_PRECEDENCE: readonly RegistryRung[] = [
  {
    id: 'persona-kyb',
    vendor: 'Persona KYB',
    providerName: 'persona-kyb-inquiry',
    onBrief: true,
    requiredEnv: [REGISTRY_ENV.personaApiKey, REGISTRY_ENV.personaKybTemplateId],
    build: (env) =>
      new PersonaKybRegistryProvider({
        apiKey: readEnv(env, REGISTRY_ENV.personaApiKey) ?? '',
        inquiryTemplateId: readEnv(env, REGISTRY_ENV.personaKybTemplateId) ?? '',
        ...(readEnv(env, 'PERSONA_ENVIRONMENT_ID') === undefined
          ? {}
          : { environmentId: readEnv(env, 'PERSONA_ENVIRONMENT_ID') }),
      }),
    reason:
      "Persona KYB business inquiries — a vendor NAMED BY THE BRIEF for this slot, so this leg is compliant rather than substituted. Selected automatically because PERSONA_KYB_TEMPLATE_ID is set; nothing else in this build changed to make that happen.",
    blockedNote: null,
  },
  {
    id: 'middesk',
    vendor: 'Middesk',
    providerName: null,
    onBrief: true,
    requiredEnv: [REGISTRY_ENV.middeskApiKey],
    // NOT WRITTEN. Middesk KYB is behind a sales conversation, so nobody here
    // has seen a key, a response body or an error shape. Writing an adapter
    // against documentation alone and shipping it as though it worked would be
    // a bigger lie than the substitution it was meant to avoid.
    build: null,
    reason: 'Middesk — a vendor named by the brief for this slot.',
    blockedNote:
      `${REGISTRY_ENV.middeskApiKey} is set, but no Middesk adapter has been written — the vendor is behind a sales conversation and nobody here has seen a response body, so there is nothing to test one against. This leg has therefore FALLEN THROUGH to the next rung and is NOT Middesk. Add src/lib/kyb/middesk.ts implementing KybLegProvider<'live'> for business_registry and set this rung's build function; no other file needs to change.`,
  },
  {
    id: 'sumsub',
    vendor: 'Sumsub KYB',
    providerName: null,
    onBrief: true,
    requiredEnv: [REGISTRY_ENV.sumsubAppToken, REGISTRY_ENV.sumsubSecretKey],
    build: null,
    reason: 'Sumsub KYB — a vendor named by the brief for this slot.',
    blockedNote:
      `${REGISTRY_ENV.sumsubAppToken} and ${REGISTRY_ENV.sumsubSecretKey} are set, but no Sumsub adapter has been written — the vendor is behind a sales conversation. This leg has FALLEN THROUGH to the next rung and is NOT Sumsub. Add src/lib/kyb/sumsub.ts implementing KybLegProvider<'live'> for business_registry and set this rung's build function.`,
  },
  {
    id: 'stripe-connect',
    vendor: 'Stripe Connect company verification',
    providerName: 'stripe-connect',
    // Not on the brief's list for this slot; it was the fourth candidate.
    onBrief: false,
    requiredEnv: [REGISTRY_ENV.stripeSecretKey, REGISTRY_ENV.stripeConnectKyb],
    build: (env) =>
      new StripeConnectRegistryProvider({
        secretKey: readEnv(env, REGISTRY_ENV.stripeSecretKey) ?? '',
      }),
    reason:
      'Stripe Connect company verification — a real third-party KYB check, selected because STRIPE_CONNECT_KYB opts in explicitly. Measured non-functional on this account in 2026-09 (Accounts v1 is retired for new integrations and POST /v2/core/accounts is not wired here), which is why it needs the opt-in and why it sits below the brief-named vendors.',
    blockedNote: null,
  },
  {
    id: 'gleif',
    vendor: 'GLEIF (Global LEI index)',
    providerName: GLEIF_PROVIDER_NAME,
    onBrief: false,
    // NO CREDENTIAL. `api.gleif.org` needs no key, no account and no header,
    // so this rung always matches — which is exactly what makes it a floor
    // under the live options rather than another thing that can be absent.
    requiredEnv: [],
    build: () => new GleifRegistryProvider(),
    reason: GLEIF_LEG_REASON,
    blockedNote: null,
  },
];

/** What the ladder decided, and everything a surface needs to explain it. */
export interface RegistryChoice {
  readonly rung: RegistryRung;
  readonly provider: KybLegProvider<'live'>;
  /**
   * Rungs whose credentials were present but whose adapter is not written, in
   * ladder order. Every one of these is a leg that a reader might reasonably
   * believe is running and is not, so all of them are carried, not just the
   * first.
   */
  readonly blocked: readonly string[];
}

/**
 * Walk the ladder.
 *
 * Never returns the simulator: forcing is the CALLER's decision and is checked
 * before this is called, so that the escape hatch is honoured in exactly one
 * place per surface rather than half-implemented in two.
 *
 * The last rung has no required environment, so this cannot fall off the end —
 * and the non-null assertion that would otherwise be needed is avoided by
 * throwing, because a ladder edited into having no unconditional rung is a
 * programming error that should stop the process rather than quietly select
 * something.
 */
export function chooseRegistryProvider(env: EnvBag): RegistryChoice {
  const blocked: string[] = [];

  for (const rung of REGISTRY_PRECEDENCE) {
    if (!has(env, rung.requiredEnv)) continue;
    if (rung.build === null) {
      if (rung.blockedNote !== null) blocked.push(rung.blockedNote);
      continue;
    }
    return { rung, provider: rung.build(env), blocked };
  }

  throw new Error(
    'REGISTRY_PRECEDENCE has no unconditional rung: every entry required an environment variable that is absent. The GLEIF rung is meant to be that floor.',
  );
}

/** The provider name the GLEIF rung produces. Re-exported for the surfaces. */
export { GLEIF_PROVIDER_NAME };

/**
 * The rung that produced a leg carrying this provider name, if any.
 *
 * Matched on the adapter's own `name` — the value recorded on every evidence
 * row and printed on the screen — so a leg read back from the database a month
 * from now can still be attributed to the rung that chose it. Returns undefined
 * for the simulator, which is not on the ladder at all.
 */
export function rungForProviderName(name: string): RegistryRung | undefined {
  return REGISTRY_PRECEDENCE.find((rung) => rung.providerName === name);
}
