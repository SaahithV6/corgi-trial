import { describe, expect, it } from 'vitest';

import {
  decodeSimulatedReference,
  encodeSimulatedReference,
  SimulatedDirectorKycProvider,
  SimulatedRegistryProvider,
  simulatedDirectorOutcomeFor,
  simulatedOutcomeFor,
  SIMULATED_REASON_PREFIX,
} from './simulated-registry';
import { STRIPE_TEST_EINS } from './stripe-registry';
import type { CreateKybVerificationInput, KybLegResult, KybPerson } from './types';

function input(
  ein: string,
  people: readonly KybPerson[] = [{ firstName: 'Jane', lastName: 'Doe' }],
): CreateKybVerificationInput {
  return {
    referenceId: 'biz_1',
    businessName: 'Corgi Test Co',
    taxIdentificationNumber: ein,
    registeredAddress: {
      street1: '1 Market St',
      city: 'San Francisco',
      subdivision: 'CA',
      postalCode: '94105',
      countryCode: 'US',
    },
    associatedPeople: people,
  };
}

describe('SimulatedRegistryProvider', () => {
  it('is typed as a simulated provider and says so on every result', async () => {
    const provider = new SimulatedRegistryProvider();
    expect(provider.evidence).toBe('simulated');
    const leg = await provider.begin(input(STRIPE_TEST_EINS.match));
    expect(leg.evidence).toBe('simulated');
    expect(leg.provider).toBe('simulated-registry');
  });

  it('cannot be typed as producing live evidence', () => {
    const provider = new SimulatedRegistryProvider();
    // @ts-expect-error — `evidence` is the literal 'simulated', so a simulated
    // provider cannot be handed to anything demanding a live one.
    const asLive: { evidence: 'live' } = provider;
    expect(asLive.evidence).toBe('simulated');
  });

  it('mirrors Stripe’s magic EINs so the demo script does not change with the key', async () => {
    const provider = new SimulatedRegistryProvider();
    const cases: [string, string][] = [
      [STRIPE_TEST_EINS.match, 'approved'],
      [STRIPE_TEST_EINS.matchNonProfit, 'approved'],
      [STRIPE_TEST_EINS.immediateMatch, 'approved'],
      [STRIPE_TEST_EINS.companyNotFoundInRegistry, 'rejected'],
      [STRIPE_TEST_EINS.inactiveBusiness, 'rejected'],
      [STRIPE_TEST_EINS.taxIdNotIssued, 'rejected'],
      [STRIPE_TEST_EINS.ownersNotFoundInRegistry, 'needs_review'],
      [STRIPE_TEST_EINS.directorsNotFoundInRegistry, 'needs_review'],
      [STRIPE_TEST_EINS.missingOwnersVsRegistry, 'needs_review'],
      [STRIPE_TEST_EINS.missingDirectorsVsRegistry, 'needs_review'],
      [STRIPE_TEST_EINS.pendingResponseFromRegistry, 'pending'],
    ];
    for (const [ein, expected] of cases) {
      const leg = await provider.begin(input(ein));
      expect(leg.status, ein).toBe(expected);
    }
  });

  it('is deterministic: the same input gives the same answer every time', async () => {
    const provider = new SimulatedRegistryProvider();
    const first = await provider.begin(input(STRIPE_TEST_EINS.ownersNotFoundInRegistry));
    const second = await provider.begin(input(STRIPE_TEST_EINS.ownersNotFoundInRegistry));
    expect(first.status).toBe(second.status);
    expect(first.reference).toBe(second.reference);
  });

  it('is stateless: refresh replays the outcome encoded in the reference', async () => {
    const provider = new SimulatedRegistryProvider();
    const begun = await provider.begin(input(STRIPE_TEST_EINS.pendingResponseFromRegistry));
    // A fresh instance, as a serverless invocation would be.
    const replayed = await new SimulatedRegistryProvider().refresh(begun.reference);
    expect(replayed.status).toBe('pending');
    expect(replayed.referenceId).toBe('biz_1');
  });

  it('holds a reference it did not mint for review', async () => {
    const leg = await new SimulatedRegistryProvider().refresh('acct_1234');
    expect(leg.status).toBe('needs_review');
  });

  it('holds a malformed tax id for review rather than approving it', async () => {
    for (const ein of ['', '123', 'not-a-number', '0000000000']) {
      const leg = await new SimulatedRegistryProvider().begin(input(ein));
      expect(leg.status, ein).toBe('needs_review');
    }
  });

  it('labels every reason so a screenshot cannot be mistaken for a provider’s words', async () => {
    const leg = await new SimulatedRegistryProvider().begin(input(STRIPE_TEST_EINS.match));
    for (const check of leg.checks) {
      for (const reason of check.reasons) {
        expect(reason).toContain(SIMULATED_REASON_PREFIX);
      }
    }
    expect(leg.rawStatus).toContain(SIMULATED_REASON_PREFIX);
  });
});

describe('SimulatedDirectorKycProvider', () => {
  it('reads the control person, not the company', async () => {
    const provider = new SimulatedDirectorKycProvider();
    const clean = await provider.begin(
      input(STRIPE_TEST_EINS.companyNotFoundInRegistry, [{ firstName: 'Jane', lastName: 'Doe' }]),
    );
    // A company the registry would decline does not change the director leg.
    expect(clean.status).toBe('approved');
    expect(clean.leg).toBe('director_kyc');
  });

  it('rejects a mismatched personal id number', async () => {
    const leg = await new SimulatedDirectorKycProvider().begin(
      input(STRIPE_TEST_EINS.match, [
        { firstName: 'Jane', lastName: 'Doe', taxIdentificationNumber: '111-11-1111' },
      ]),
    );
    expect(leg.status).toBe('rejected');
  });

  it('holds a watchlist date of birth for review', async () => {
    const leg = await new SimulatedDirectorKycProvider().begin(
      input(STRIPE_TEST_EINS.match, [{ firstName: 'Jane', lastName: 'Doe', birthdate: '1900-01-01' }]),
    );
    expect(leg.status).toBe('needs_review');
  });

  it('holds a verification with no control person for review', async () => {
    const leg = await new SimulatedDirectorKycProvider().begin(input(STRIPE_TEST_EINS.match, []));
    expect(leg.status).toBe('needs_review');
  });

  it('never claims an identity document was examined', async () => {
    const leg = await new SimulatedDirectorKycProvider().begin(input(STRIPE_TEST_EINS.match));
    expect(leg.checks[0]?.reasons.join(' ')).toContain('no identity document was examined by anyone');
  });
});

describe('outcome rules', () => {
  it('registry: an EIN with no forced outcome is approved', () => {
    expect(simulatedOutcomeFor('123456789').status).toBe('approved');
  });

  it('director: a person with no forced outcome is approved', () => {
    expect(simulatedDirectorOutcomeFor(input('123456789')).status).toBe('approved');
  });
});

describe('simulated references', () => {
  it('round-trips', () => {
    const reference = encodeSimulatedReference('business_registry', 'needs_review', 'biz_1');
    expect(reference).toBe('sim.business_registry.needs_review.biz_1');
    expect(decodeSimulatedReference(reference)).toEqual({
      leg: 'business_registry',
      status: 'needs_review',
      referenceId: 'biz_1',
    });
  });

  it('survives a business id containing the separator', () => {
    const reference = encodeSimulatedReference('director_kyc', 'approved', 'biz.1.2');
    expect(decodeSimulatedReference(reference)?.referenceId).toBe('biz.1.2');
  });

  it('refuses anything it did not mint', () => {
    expect(decodeSimulatedReference('inq_ABC')).toBeNull();
    expect(decodeSimulatedReference('sim.director_kyc.verified.biz_1')).toBeNull();
    expect(decodeSimulatedReference('sim.unknown_leg.approved.biz_1')).toBeNull();
    expect(decodeSimulatedReference('sim.director_kyc.approved')).toBeNull();
  });

  it('is visibly a simulator id, which the 0005 CHECK constraint relies on', () => {
    // db/migrations/0005_kyb.sql refuses a row claiming live evidence whose
    // provider_reference starts 'sim.' or whose provider starts 'simulated-'.
    const reference = encodeSimulatedReference('business_registry', 'approved', 'biz_1');
    expect(reference.startsWith('sim.')).toBe(true);
    expect(new SimulatedRegistryProvider().name.startsWith('simulated-')).toBe(true);
    expect(new SimulatedDirectorKycProvider().name.startsWith('simulated-')).toBe(true);
  });
});

describe('the type-level guarantee', () => {
  it('a simulated leg result cannot be relabelled live', () => {
    const result: KybLegResult<'simulated'> = {
      leg: 'business_registry',
      provider: 'simulated-registry',
      reference: 'sim.business_registry.approved.biz_1',
      referenceId: 'biz_1',
      status: 'approved',
      rawStatus: 'simulated:approved',
      checks: [],
      hostedUrl: null,
      observedAt: '2026-09-09T00:00:00.000Z',
      evidence: 'simulated',
    };
    // @ts-expect-error — 'live' is not assignable to 'simulated'.
    const forged: KybLegResult<'simulated'> = { ...result, evidence: 'live' };
    expect(forged.evidence).toBe('live');
  });
});
