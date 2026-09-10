/**
 * The labelled fallback: a verification WE perform, that says so.
 *
 * Used when the relevant API key is absent, or when Stripe Connect platform
 * onboarding turns out to be gated (research/kyb/NOTES.md §4.4 flags that as
 * the one unconfirmed dependency). It exists so a deployment without keys still
 * runs end to end — and so nobody is ever tempted to make a live adapter return
 * a plausible answer when it could not reach anyone.
 *
 * THREE PROPERTIES, ALL DELIBERATE.
 *
 * 1. IT CANNOT CLAIM TO BE LIVE. The class is declared
 *    `KybLegProvider<'simulated'>`, so `evidence: 'live'` is a type error
 *    inside this file, not a review catch. Everything downstream inherits it:
 *    a composite built from one of these is `CompositeKybResult<'simulated'>`.
 *
 * 2. IT IS DETERMINISTIC AND STATELESS. The outcome is a pure function of the
 *    EIN, and the outcome is encoded into the reference id it returns, so
 *    `refresh()` is a pure function too. No in-memory map to lose across a
 *    serverless invocation, and a demo replays identically.
 *
 * 3. IT MIRRORS STRIPE'S MAGIC EINs. The same `222221000`-`222221005` that
 *    force company-not-found / owners-not-found / directors-not-found /
 *    pending-response-from-registry against the real Stripe test mode produce
 *    the same statuses here. The demo script does not change when the key
 *    appears; only the evidence label does.
 *
 * Every reason string it emits is prefixed `simulated:` so a screenshot of the
 * evidence pack cannot be mistaken for a provider's own words.
 */

import { STRIPE_TEST_EINS, normaliseEin } from './stripe-registry';
import {
  type CreateKybVerificationInput,
  type KybCheck,
  type KybLegKind,
  type KybLegProvider,
  type KybLegResult,
  type KybStatus,
} from './types';

/** Marks every reason string this module produces. */
export const SIMULATED_REASON_PREFIX = 'simulated:';

/**
 * EIN -> outcome, matching what Stripe Connect test mode would answer.
 * Sources for each: https://docs.stripe.com/connect/testing.
 */
const EIN_OUTCOMES: ReadonlyArray<readonly [string, KybStatus, string]> = [
  [STRIPE_TEST_EINS.match, 'approved', 'business id number matched the registry'],
  [STRIPE_TEST_EINS.matchNonProfit, 'approved', 'business id number matched (non-profit)'],
  [STRIPE_TEST_EINS.immediateMatch, 'approved', 'business id number matched immediately'],
  [STRIPE_TEST_EINS.inactiveBusiness, 'rejected', 'business status is inactive'],
  [STRIPE_TEST_EINS.identityMismatch, 'rejected', 'verification_failed_keyed_match'],
  [STRIPE_TEST_EINS.taxIdNotIssued, 'rejected', 'verification_failed_tax_id_not_issued'],
  [STRIPE_TEST_EINS.companyNotFoundInRegistry, 'rejected', 'company not found in registry'],
  [STRIPE_TEST_EINS.ownersNotFoundInRegistry, 'needs_review', 'owners not found in registry'],
  [STRIPE_TEST_EINS.directorsNotFoundInRegistry, 'needs_review', 'directors not found in registry'],
  [STRIPE_TEST_EINS.missingOwnersVsRegistry, 'needs_review', 'verification_missing_owners'],
  [STRIPE_TEST_EINS.missingDirectorsVsRegistry, 'needs_review', 'verification_missing_directors'],
  [STRIPE_TEST_EINS.pendingResponseFromRegistry, 'pending', 'pending response from registry'],
];

/**
 * Personal id number / date of birth -> outcome, matching Stripe Connect's
 * supporting test tables. These give the DIRECTOR leg a lever independent of
 * the EIN, which is what makes "strictest of the two legs" demonstrable: a
 * clean company with a flagged director must come out blocked.
 */
const PERSON_ID_OUTCOMES: ReadonlyArray<readonly [string, KybStatus, string]> = [
  ['000000000', 'approved', 'personal id number matched'],
  ['222222222', 'approved', 'personal id number matched immediately'],
  ['111111111', 'rejected', 'personal id number mismatch'],
  ['111111113', 'rejected', 'personal id number belongs to an inactive record'],
];

const BIRTHDATE_OUTCOMES: ReadonlyArray<readonly [string, KybStatus, string]> = [
  ['1901-01-01', 'approved', 'date of birth matched'],
  ['1902-01-01', 'approved', 'date of birth matched immediately'],
  ['1900-01-01', 'needs_review', 'watchlist (OFAC) alert on the control person'],
];

export interface SimulatedOutcome {
  readonly status: KybStatus;
  readonly reason: string;
}

/**
 * The registry rule, in one place so it can be read and tested.
 *
 * A magic EIN gives its documented outcome. Anything else is `approved` — the
 * simulator is a stand-in for a working registry, not a random failure
 * generator, and an unpredictable simulator makes every other test flaky.
 * A blank or malformed EIN is `needs_review`, because that is a real data
 * problem rather than a registry answer.
 */
export function simulatedOutcomeFor(taxIdentificationNumber: string): SimulatedOutcome {
  const ein = normaliseEin(taxIdentificationNumber);
  if (ein.length !== 9) {
    return { status: 'needs_review', reason: 'tax id is not nine digits' };
  }
  const match = EIN_OUTCOMES.find(([value]) => value === ein);
  if (match !== undefined) return { status: match[1], reason: match[2] };
  return { status: 'approved', reason: 'no forced outcome for this tax id' };
}

/** The director rule. Reads the control person, never the company. */
export function simulatedDirectorOutcomeFor(input: CreateKybVerificationInput): SimulatedOutcome {
  const director = input.associatedPeople?.[0];
  if (director === undefined) {
    return { status: 'needs_review', reason: 'no control person was supplied' };
  }
  const idNumber = director.taxIdentificationNumber?.replace(/\D/g, '') ?? '';
  const byId = PERSON_ID_OUTCOMES.find(([value]) => value === idNumber);
  if (byId !== undefined) return { status: byId[1], reason: byId[2] };

  const byDob = BIRTHDATE_OUTCOMES.find(([value]) => value === director.birthdate);
  if (byDob !== undefined) return { status: byDob[1], reason: byDob[2] };

  return { status: 'approved', reason: 'no forced outcome for this control person' };
}

// ---------------------------------------------------------------------------
// Stateless references: the outcome travels in the id
// ---------------------------------------------------------------------------

const REFERENCE_PREFIX = 'sim';

/**
 * `sim.<leg>.<status>.<businessId>` — the outcome is IN the reference, so
 * `refresh()` needs no storage and returns the same answer for ever. It also
 * means an operator reading a database row can see at a glance that the id
 * belongs to a simulator.
 */
export function encodeSimulatedReference(leg: KybLegKind, status: KybStatus, referenceId: string): string {
  return [REFERENCE_PREFIX, leg, status, referenceId].join('.');
}

export function decodeSimulatedReference(
  reference: string,
): { readonly leg: KybLegKind; readonly status: KybStatus; readonly referenceId: string } | null {
  const parts = reference.split('.');
  const [prefix, leg, status] = parts;
  if (prefix !== REFERENCE_PREFIX || parts.length < 4) return null;
  if (leg !== 'director_kyc' && leg !== 'business_registry') return null;
  if (status !== 'approved' && status !== 'pending' && status !== 'needs_review' && status !== 'rejected') {
    return null;
  }
  return { leg, status, referenceId: parts.slice(3).join('.') };
}

// ---------------------------------------------------------------------------
// The providers
// ---------------------------------------------------------------------------

abstract class SimulatedLegProvider implements KybLegProvider<'simulated'> {
  abstract readonly leg: KybLegKind;
  abstract readonly name: string;
  /**
   * The whole point. Declared as the literal type, so no method on any subclass
   * can return anything else without failing `tsc`.
   */
  readonly evidence = 'simulated' as const;

  protected abstract checksFor(status: KybStatus, reason: string): readonly KybCheck[];

  /** Each leg reads the part of the input it is actually responsible for. */
  protected abstract outcomeFor(input: CreateKybVerificationInput): SimulatedOutcome;

  async begin(input: CreateKybVerificationInput): Promise<KybLegResult<'simulated'>> {
    const outcome = this.outcomeFor(input);
    return this.result(
      encodeSimulatedReference(this.leg, outcome.status, input.referenceId),
      input.referenceId,
      outcome,
    );
  }

  async refresh(reference: string): Promise<KybLegResult<'simulated'>> {
    const decoded = decodeSimulatedReference(reference);
    if (decoded === null) {
      // An id this simulator did not mint. Held for review rather than guessed
      // at: the same fail-closed rule the live adapters use for a status they
      // do not recognise.
      return this.result(reference, null, {
        status: 'needs_review',
        reason: 'reference id was not issued by this simulator',
      });
    }
    return this.result(reference, decoded.referenceId, {
      status: decoded.status,
      reason: 'replayed from the simulated reference id',
    });
  }

  private result(
    reference: string,
    referenceId: string | null,
    outcome: SimulatedOutcome,
  ): KybLegResult<'simulated'> {
    return {
      leg: this.leg,
      provider: this.name,
      reference,
      referenceId,
      status: outcome.status,
      rawStatus: `${SIMULATED_REASON_PREFIX}${outcome.status}`,
      checks: this.checksFor(outcome.status, outcome.reason),
      hostedUrl: null,
      observedAt: new Date().toISOString(),
      evidence: this.evidence,
    };
  }
}

/**
 * The business-registry leg, simulated. Used when `STRIPE_SECRET_KEY` is
 * absent, or when Connect platform onboarding proves to be gated.
 */
export class SimulatedRegistryProvider extends SimulatedLegProvider {
  override readonly leg = 'business_registry' as const;
  override readonly name = 'simulated-registry';

  protected override outcomeFor(input: CreateKybVerificationInput): SimulatedOutcome {
    return simulatedOutcomeFor(input.taxIdentificationNumber);
  }

  protected override checksFor(status: KybStatus, reason: string): readonly KybCheck[] {
    const passed = status === 'approved';
    return [
      {
        name: 'business_registry_match',
        status: passed ? 'passed' : status === 'rejected' ? 'failed' : 'pending',
        reasons: [`${SIMULATED_REASON_PREFIX} ${reason}`],
      },
      {
        name: 'business_watchlist',
        status: 'not_applicable',
        reasons: [`${SIMULATED_REASON_PREFIX} no watchlist provider is configured`],
      },
    ];
  }
}

/**
 * The director-KYC leg, simulated. Used when `PERSONA_API_KEY` (or the inquiry
 * template id) is absent.
 *
 * It exists so the factory can degrade EITHER leg independently. It is not a
 * substitute for Persona in any sense that matters: it verifies nobody.
 */
export class SimulatedDirectorKycProvider extends SimulatedLegProvider {
  override readonly leg = 'director_kyc' as const;
  override readonly name = 'simulated-director-kyc';

  protected override outcomeFor(input: CreateKybVerificationInput): SimulatedOutcome {
    return simulatedDirectorOutcomeFor(input);
  }

  protected override checksFor(status: KybStatus, reason: string): readonly KybCheck[] {
    return [
      {
        name: 'director_identity',
        status: status === 'approved' ? 'passed' : status === 'rejected' ? 'failed' : 'pending',
        reasons: [
          `${SIMULATED_REASON_PREFIX} no identity document was examined by anyone`,
          `${SIMULATED_REASON_PREFIX} ${reason}`,
        ],
      },
    ];
  }
}
