/**
 * The KYB factory: choose a provider PER LEG from the environment, say so
 * loudly, and never let a missing key look like a live integration.
 *
 * The rule, and it has no exceptions:
 *
 *     key present  -> live adapter,      evidence 'live'
 *     key absent   -> simulated adapter, evidence 'simulated', and it says so
 *
 * There is no third branch. In particular there is no "try live, fall back to
 * simulated on error" path anywhere in this module — a silent fallback is
 * exactly the failure this design exists to prevent, because it produces a
 * system that looks live in the logs and is not. A live adapter that cannot
 * reach its provider fails the leg loudly (see `failedLeg` in ./composite.ts);
 * it never quietly becomes a simulator.
 *
 * The two legs are selected INDEPENDENTLY. Persona present but Stripe absent is
 * a normal, expected state — live director KYC, simulated registry — and the
 * composite then reports `evidence: 'simulated'` overall, because half the
 * evidence was manufactured. See ./composite.ts for why that is not merely a
 * convention.
 *
 * Startup logging is deliberately noisy: one line per leg, WARN for any leg
 * running simulated, naming the env var that would fix it. `/api/health` reads
 * the same selection through `kybHealthReport()`, so the boot log and the
 * health endpoint cannot disagree.
 */

import { rootLogger, type Logger } from '../log';
import type { EnvBag } from '../webhooks/route-handler';
import { CompositeKybProvider } from './composite';
import { PersonaDirectorKycProvider } from './persona';
import { SimulatedDirectorKycProvider, SimulatedRegistryProvider } from './simulated-registry';
import { StripeConnectRegistryProvider } from './stripe-registry';
import { KybConfigError, KYB_LEG_LABEL, type Evidence, type KybLegKind, type KybLegProvider } from './types';

export const KYB_ENV = {
  personaApiKey: 'PERSONA_API_KEY',
  personaInquiryTemplateId: 'PERSONA_INQUIRY_TEMPLATE_ID',
  personaVerificationTemplateId: 'PERSONA_VERIFICATION_TEMPLATE_ID',
  personaEnvironmentId: 'PERSONA_ENVIRONMENT_ID',
  stripeSecretKey: 'STRIPE_SECRET_KEY',
  /**
   * Comma-separated legs to force onto the simulator even when a key exists:
   * `business_registry`, `director_kyc`, or `all`. The documented escape hatch
   * for the one unconfirmed dependency in the research — if Stripe Connect
   * platform onboarding turns out to need approval, this switches the registry
   * leg back without a deploy, and the health endpoint shows the reason.
   */
  forceSimulated: 'KYB_FORCE_SIMULATED',
} as const;

/** Env vars each leg needs before it can run live. */
export const KYB_REQUIRED_ENV: Record<KybLegKind, readonly string[]> = {
  director_kyc: [KYB_ENV.personaApiKey, KYB_ENV.personaInquiryTemplateId],
  business_registry: [KYB_ENV.stripeSecretKey],
};

export type KybMode = 'live' | 'simulated';

export interface KybLegSelection {
  readonly leg: KybLegKind;
  readonly mode: KybMode;
  /** The adapter that will answer this leg. */
  readonly provider: KybLegProvider;
  /** Evidence this leg is CAPABLE of producing. Same value as `mode`. */
  readonly evidence: Evidence;
  readonly requiredEnv: readonly string[];
  /** Env var NAMES only. This is rendered on a public health endpoint. */
  readonly missingEnv: readonly string[];
  /** One sentence, safe to print, saying why this mode was chosen. */
  readonly reason: string;
}

export interface KybSelection {
  readonly director: KybLegSelection;
  readonly registry: KybLegSelection;
}

// ---------------------------------------------------------------------------
// 1. Selection
// ---------------------------------------------------------------------------

/**
 * Decide, per leg, which adapter answers. Pure: reads the env bag, builds
 * adapters, touches no network and logs nothing.
 */
export function selectKybLegs(env: EnvBag = process.env): KybSelection {
  return {
    director: selectDirectorLeg(env),
    registry: selectRegistryLeg(env),
  };
}

function selectDirectorLeg(env: EnvBag): KybLegSelection {
  const required = KYB_REQUIRED_ENV.director_kyc;
  const missingEnv = required.filter((key) => readEnv(env, key) === undefined);
  const forced = isForced('director_kyc', env);

  if (forced || missingEnv.length > 0) {
    return {
      leg: 'director_kyc',
      mode: 'simulated',
      provider: new SimulatedDirectorKycProvider(),
      evidence: 'simulated',
      requiredEnv: required,
      missingEnv,
      reason: forced
        ? `forced to the simulator by ${KYB_ENV.forceSimulated}`
        : `no live director KYC: ${missingEnv.join(', ')} not set`,
    };
  }

  const apiKey = mustRead(env, KYB_ENV.personaApiKey);
  const inquiryTemplateId = mustRead(env, KYB_ENV.personaInquiryTemplateId);
  const verificationTemplateId = readEnv(env, KYB_ENV.personaVerificationTemplateId);
  const environmentId = readEnv(env, KYB_ENV.personaEnvironmentId);

  return {
    leg: 'director_kyc',
    mode: 'live',
    provider: new PersonaDirectorKycProvider({
      apiKey,
      inquiryTemplateId,
      ...(verificationTemplateId === undefined ? {} : { verificationTemplateId }),
      ...(environmentId === undefined ? {} : { environmentId }),
    }),
    evidence: 'live',
    requiredEnv: required,
    missingEnv: [],
    reason: 'Persona sandbox inquiries (live third-party KYC)',
  };
}

function selectRegistryLeg(env: EnvBag): KybLegSelection {
  const required = KYB_REQUIRED_ENV.business_registry;
  const missingEnv = required.filter((key) => readEnv(env, key) === undefined);
  const forced = isForced('business_registry', env);

  if (forced || missingEnv.length > 0) {
    return {
      leg: 'business_registry',
      mode: 'simulated',
      provider: new SimulatedRegistryProvider(),
      evidence: 'simulated',
      requiredEnv: required,
      missingEnv,
      reason: forced
        ? `forced to the simulator by ${KYB_ENV.forceSimulated}`
        : `no live registry check: ${missingEnv.join(', ')} not set`,
    };
  }

  return {
    leg: 'business_registry',
    mode: 'live',
    provider: new StripeConnectRegistryProvider({ secretKey: mustRead(env, KYB_ENV.stripeSecretKey) }),
    evidence: 'live',
    requiredEnv: required,
    missingEnv: [],
    reason: "Stripe Connect test-mode company verification (real registry check, not a KYB vendor)",
  };
}

// ---------------------------------------------------------------------------
// 2. Construction
// ---------------------------------------------------------------------------

let announced = false;

export interface CreateKybProviderOptions {
  readonly env?: EnvBag | undefined;
  readonly log?: Logger | undefined;
  /** Announce even if this process has announced before. Tests use it. */
  readonly forceAnnounce?: boolean | undefined;
}

/**
 * Build the composite provider and announce the selection once per process.
 *
 * The announcement is here rather than at module load so that importing this
 * module for its types cannot emit log lines, and so the tests can inject an
 * env bag and a log sink.
 */
export function createKybProvider(options: CreateKybProviderOptions = {}): CompositeKybProvider {
  const env = options.env ?? process.env;
  const selection = selectKybLegs(env);

  if (!announced || options.forceAnnounce === true) {
    announceKybSelection(selection, options.log ?? rootLogger);
    announced = true;
  }

  return new CompositeKybProvider(selection.director.provider, selection.registry.provider);
}

/** Test seam: forget that this process has already announced. */
export function resetKybAnnouncement(): void {
  announced = false;
}

/**
 * The loud part. One line per leg, plus a summary line carrying the best
 * evidence this deployment can possibly produce.
 *
 * A simulated leg is a WARN, not an info: it is not an error (the deployment is
 * working as configured) but it must never scroll past unnoticed in a boot log.
 */
export function announceKybSelection(selection: KybSelection, log: Logger = rootLogger): void {
  const legs = [selection.director, selection.registry];
  for (const leg of legs) {
    const fields = {
      leg: leg.leg,
      legLabel: KYB_LEG_LABEL[leg.leg],
      mode: leg.mode,
      provider: leg.provider.name,
      evidence: leg.evidence,
      reason: leg.reason,
      missingEnv: leg.missingEnv,
    };
    if (leg.mode === 'live') log.info('kyb.leg.selected', fields);
    else log.warn('kyb.leg.simulated', fields);
  }

  const ceiling = evidenceCeiling(selection);
  const summary = {
    evidenceCeiling: ceiling,
    director: selection.director.provider.name,
    registry: selection.registry.provider.name,
  };
  if (ceiling === 'live') {
    log.info('kyb.selection', {
      ...summary,
      note: 'both legs are live; a verification can claim third-party evidence',
    });
  } else {
    log.warn('kyb.selection', {
      ...summary,
      note: 'at least one leg is simulated; every verification this deployment produces is labelled simulated',
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Health
// ---------------------------------------------------------------------------

export interface KybLegReport {
  readonly leg: KybLegKind;
  readonly label: string;
  readonly mode: KybMode;
  readonly provider: string;
  readonly evidence: Evidence;
  readonly requiredEnv: readonly string[];
  readonly missingEnv: readonly string[];
  readonly reason: string;
}

export interface KybHealthReport {
  /**
   * The BEST evidence this deployment could produce if every check passed.
   * Named a ceiling rather than "evidence" on purpose: it is a statement about
   * the wiring, not a claim that anything has been verified.
   */
  readonly evidenceCeiling: Evidence;
  readonly legs: readonly KybLegReport[];
  readonly note: string;
}

/**
 * Per-leg status for `/api/health`, derived from the same `selectKybLegs` the
 * factory uses, so the endpoint cannot advertise a leg as live while the
 * factory built a simulator for it.
 *
 * Wire it into the health route with one line:
 *
 *     kyb: kybHealthReport(env),
 *
 * Env var NAMES appear here; values never do.
 */
export function kybHealthReport(env: EnvBag = process.env): KybHealthReport {
  const selection = selectKybLegs(env);
  const legs = [selection.director, selection.registry].map(toReport);
  const ceiling = evidenceCeiling(selection);
  return {
    evidenceCeiling: ceiling,
    legs,
    note:
      ceiling === 'live'
        ? 'Both legs are live third-party integrations. Persona verifies the director; Stripe Connect test mode performs the company registry check.'
        : `At least one leg is simulated, so every verification is labelled simulated. Missing: ${legs
            .flatMap((l) => l.missingEnv)
            .join(', ') || '(none — a leg was forced to the simulator)'}.`,
  };
}

function toReport(leg: KybLegSelection): KybLegReport {
  return {
    leg: leg.leg,
    label: KYB_LEG_LABEL[leg.leg],
    mode: leg.mode,
    provider: leg.provider.name,
    evidence: leg.evidence,
    requiredEnv: leg.requiredEnv,
    missingEnv: leg.missingEnv,
    reason: leg.reason,
  };
}

/** `live` only when BOTH legs are live. Same rule as the composite's. */
export function evidenceCeiling(selection: KybSelection): Evidence {
  return selection.director.mode === 'live' && selection.registry.mode === 'live' ? 'live' : 'simulated';
}

// ---------------------------------------------------------------------------
// 4. Helpers
// ---------------------------------------------------------------------------

function isForced(leg: KybLegKind, env: EnvBag): boolean {
  const raw = readEnv(env, KYB_ENV.forceSimulated);
  if (raw === undefined) return false;
  const entries = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
  return entries.includes('all') || entries.includes(leg);
}

/**
 * Trimmed, or undefined. An empty string is a missing value, not a value —
 * `PERSONA_API_KEY=` in a .env file must not select the live adapter.
 *
 * Deliberately a local four-liner rather than an import from
 * `../webhooks/route-handler`: that module constructs a Postgres driver, and
 * the KYB layer has no business pulling a database client in to read an
 * environment variable. Only the `EnvBag` TYPE is shared, which erases.
 */
function readEnv(env: EnvBag, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Unreachable in practice — every caller checks `missingEnv` first — and kept
 * as a guard rather than a `!` so that adding a third leg badly fails loudly at
 * construction instead of sending `Bearer undefined` to a provider.
 */
function mustRead(env: EnvBag, key: string): string {
  const value = readEnv(env, key);
  if (value === undefined) throw new KybConfigError(`${key} is not set`, [key]);
  return value;
}

// ---------------------------------------------------------------------------
// 5. Public surface
// ---------------------------------------------------------------------------

export {
  CompositeKybProvider,
  CompositeKybResult,
  failedLeg,
  type CompositeKybJson,
  type KybReferences,
} from './composite';
export {
  legFromPersonaEvent,
  PersonaDirectorKycProvider,
  personaDemoScript,
  personaStatusToKyb,
  PERSONA_EVENTS,
  PERSONA_STATUS_MAP,
  type PersonaConfig,
  type PersonaDemoOutcome,
  type PersonaSimulateAction,
} from './persona';
export {
  legFromStripeAccountEvent,
  normaliseEin,
  StripeConnectRegistryProvider,
  stripeAccountToLeg,
  stripeRequirementsToStatus,
  STRIPE_REJECT_CODES,
  STRIPE_REVIEW_CODES,
  STRIPE_TEST_EINS,
  type StripeRegistryConfig,
} from './stripe-registry';
export {
  decodeSimulatedReference,
  encodeSimulatedReference,
  SimulatedDirectorKycProvider,
  SimulatedRegistryProvider,
  simulatedDirectorOutcomeFor,
  simulatedOutcomeFor,
  SIMULATED_REASON_PREFIX,
} from './simulated-registry';
export {
  asEvidence,
  asKybStatus,
  assertCanTransact,
  businessKybStateFromRow,
  canTransact,
  degradeEvidence,
  DEFAULT_TRANSACT_POLICY,
  EVIDENCE_LABEL,
  isEvidence,
  isKybStatus,
  KybConfigError,
  KybGateError,
  KybProviderError,
  KYB_LEG_LABEL,
  KYB_STATUSES,
  KYB_STATUS_STRICTNESS,
  strictestOf,
  strictestStatus,
  type BusinessKybState,
  type CreateKybVerificationInput,
  type DegradeEvidence,
  type Evidence,
  type KybAddress,
  type KybCheck,
  type KybLegKind,
  type KybLegProvider,
  type KybLegResult,
  type KybPerson,
  type KybStatus,
  type TransactDecision,
  type TransactDenialCode,
  type TransactPolicy,
} from './types';
