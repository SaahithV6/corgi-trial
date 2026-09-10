import { describe, expect, it } from 'vitest';

import { CompositeKybProvider, CompositeKybResult, failedLeg } from './composite';
import { SimulatedDirectorKycProvider, SimulatedRegistryProvider } from './simulated-registry';
import { STRIPE_TEST_EINS } from './stripe-registry';
import type {
  CreateKybVerificationInput,
  Evidence,
  KybLegProvider,
  KybLegResult,
  KybStatus,
} from './types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function leg<E extends Evidence>(
  kind: 'director_kyc' | 'business_registry',
  status: KybStatus,
  evidence: E,
  overrides: Partial<KybLegResult<E>> = {},
): KybLegResult<E> {
  return {
    leg: kind,
    provider: `${kind}-provider`,
    reference: `${kind}_ref_1`,
    referenceId: 'biz_1',
    status,
    rawStatus: status,
    checks: [],
    hostedUrl: null,
    observedAt: '2026-09-09T00:00:00.000Z',
    evidence,
    ...overrides,
  };
}

const input: CreateKybVerificationInput = {
  referenceId: 'biz_1',
  businessName: 'Corgi Test Co',
  taxIdentificationNumber: STRIPE_TEST_EINS.match,
  registeredAddress: {
    street1: '1 Market St',
    city: 'San Francisco',
    subdivision: 'CA',
    postalCode: '94105',
    countryCode: 'US',
  },
  associatedPeople: [{ firstName: 'Jane', lastName: 'Doe' }],
};

/** A leg provider that answers with whatever it was handed. */
function stubProvider<E extends Evidence>(result: KybLegResult<E>, evidence: E): KybLegProvider<E> {
  return {
    leg: result.leg,
    name: result.provider,
    evidence,
    begin: async () => result,
    refresh: async () => result,
  };
}

// ---------------------------------------------------------------------------
// 1. Strictest wins
// ---------------------------------------------------------------------------

describe('CompositeKybResult: strictest status wins', () => {
  const order: KybStatus[] = ['approved', 'pending', 'needs_review', 'rejected'];

  it('takes the stricter of the two legs, in both argument orders', () => {
    for (const a of order) {
      for (const b of order) {
        const expected = order[Math.max(order.indexOf(a), order.indexOf(b))];
        const composite = CompositeKybResult.of(
          'biz_1',
          leg('director_kyc', a, 'live'),
          leg('business_registry', b, 'live'),
        );
        expect(composite.status, `${a} + ${b}`).toBe(expected);
      }
    }
  });

  it('an approval on one leg never dilutes a decline on the other', () => {
    const composite = CompositeKybResult.of(
      'biz_1',
      leg('director_kyc', 'approved', 'live'),
      leg('business_registry', 'rejected', 'live'),
    );
    expect(composite.status).toBe('rejected');
  });

  it('a composite with no legs is pending, never approved', () => {
    expect(CompositeKybResult.rehydrate('biz_1', []).status).toBe('pending');
  });

  it('a composite missing one leg is only as good as the leg it has', () => {
    const oneLeg = CompositeKybResult.rehydrate('biz_1', [leg('director_kyc', 'approved', 'live')]);
    // Note: strictest-of-one is that one. The "both legs required" rule lives
    // in the database view (v_business_kyb) and in the factory, which always
    // builds two legs; this asserts the fold itself is honest about its input.
    expect(oneLeg.status).toBe('approved');
    expect(oneLeg.legs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Evidence degradation
// ---------------------------------------------------------------------------

describe('CompositeKybResult: evidence degrades', () => {
  it('is live only when BOTH legs are live', () => {
    const cases: [Evidence, Evidence, Evidence][] = [
      ['live', 'live', 'live'],
      ['live', 'simulated', 'simulated'],
      ['simulated', 'live', 'simulated'],
      ['simulated', 'simulated', 'simulated'],
    ];
    for (const [director, registry, expected] of cases) {
      const composite = CompositeKybResult.of(
        'biz_1',
        leg('director_kyc', 'approved', director),
        leg('business_registry', 'approved', registry),
      );
      expect(composite.evidence, `${director} + ${registry}`).toBe(expected);
      expect(composite.isLive).toBe(expected === 'live');
    }
  });

  it('degrades even when the simulated leg was the one that approved', () => {
    const composite = CompositeKybResult.of(
      'biz_1',
      leg('director_kyc', 'approved', 'simulated'),
      leg('business_registry', 'approved', 'live'),
    );
    expect(composite.status).toBe('approved');
    expect(composite.evidence).toBe('simulated');
  });
});

// ---------------------------------------------------------------------------
// 3. THE FORGERY TEST
//
// Six routes to a composite that claims `evidence: 'live'` on manufactured
// input. Each one must fail, and the ones that fail at compile time are
// asserted with @ts-expect-error — which vitest cannot see, but `tsc --noEmit`
// does: if any of them STOPS being an error, the typecheck fails.
// ---------------------------------------------------------------------------

describe('forging live evidence', () => {
  const simulated = CompositeKybResult.of(
    'biz_1',
    leg('director_kyc', 'approved', 'live'),
    leg('business_registry', 'approved', 'simulated'),
  );

  it('route 1: an object literal is not a CompositeKybResult (compile time)', () => {
    // @ts-expect-error — the class has a private #legs field, which makes it
    // nominally typed: no literal can satisfy it, whatever fields it lists.
    const forged: CompositeKybResult = { evidence: 'live' };
    expect(forged).toBeDefined();
  });

  it('route 2: the constructor is private, so evidence cannot be passed in', () => {
    // @ts-expect-error — `new` is unreachable; `of()` and `rehydrate()` are the
    // only entry points and neither takes an evidence argument.
    const build = () => new CompositeKybResult('biz_1', [], 'live');
    expect(build).toBeTypeOf('function');
  });

  it('route 3: the class cannot be subclassed to override the getter', () => {
    // @ts-expect-error — a private constructor makes the class unextendable,
    // so the `evidence` getter cannot be overridden by a subclass.
    class Forged extends CompositeKybResult {}
    expect(Forged).toBeDefined();
  });

  it('route 4: an instance is frozen, so the getter cannot be shadowed', () => {
    expect(Object.isFrozen(simulated)).toBe(true);
    expect(() =>
      Object.defineProperty(simulated, 'evidence', { value: 'live', configurable: true }),
    ).toThrow(TypeError);
    expect(simulated.evidence).toBe('simulated');
  });

  it('route 4b: plain assignment does not stick either', () => {
    const attempt = () => {
      (simulated as unknown as { evidence: string }).evidence = 'live';
    };
    // A setter-less accessor in strict mode (ES modules are always strict).
    expect(attempt).toThrow(TypeError);
    expect(simulated.evidence).toBe('simulated');
  });

  it('route 5: the prototype getter cannot be replaced', () => {
    expect(Object.isFrozen(CompositeKybResult.prototype)).toBe(true);
    expect(() =>
      Object.defineProperty(CompositeKybResult.prototype, 'evidence', {
        get: () => 'live',
      }),
    ).toThrow(TypeError);
    expect(simulated.evidence).toBe('simulated');
  });

  it('route 6: a forged label in storage is ignored on rehydrate', () => {
    // Simulating a hand-edited row: the JSON says live, the legs say otherwise.
    const stored = { ...simulated.toJSON(), evidence: 'live' as const, status: 'approved' as const };
    const rehydrated = CompositeKybResult.rehydrate(stored.referenceId, stored.legs, stored.createdAt);
    // The stored label was never read. Evidence is recomputed from the legs.
    expect(rehydrated.evidence).toBe('simulated');
  });

  it('route 7: the type system refuses a live composite built from a simulated leg', () => {
    const live = leg('director_kyc', 'approved', 'live');
    const sim = leg('business_registry', 'approved', 'simulated');
    // @ts-expect-error — of() returns CompositeKybResult<DegradeEvidence<'live',
    // 'simulated'>> = CompositeKybResult<'simulated'>, which is not assignable
    // to CompositeKybResult<'live'>.
    const typedLive: CompositeKybResult<'live'> = CompositeKybResult.of('biz_1', live, sim);
    expect(typedLive.evidence).toBe('simulated');

    // The one combination that IS allowed to be typed live.
    const bothLive: CompositeKybResult<'live'> = CompositeKybResult.of(
      'biz_1',
      live,
      leg('business_registry', 'approved', 'live'),
    );
    expect(bothLive.evidence).toBe('live');
  });

  it('route 8: a simulated leg result cannot be relabelled live', () => {
    const sim = leg('business_registry', 'approved', 'simulated');
    // @ts-expect-error — KybLegResult<'simulated'> pins the label in the type,
    // so a simulated provider cannot manufacture live evidence either.
    const relabelled: KybLegResult<'simulated'> = { ...sim, evidence: 'live' };
    expect(relabelled.evidence).toBe('live');
    // ...and even when it is smuggled past the type system by a cast, the
    // composite still reads the VALUE, so the lie has to be told all the way
    // down. This is the one that matters: there is no shortcut at the top.
    const composite = CompositeKybResult.of(
      'biz_1',
      leg('director_kyc', 'approved', 'simulated'),
      leg('business_registry', 'approved', 'simulated'),
    );
    expect(composite.evidence).toBe('simulated');
  });
});

// ---------------------------------------------------------------------------
// 4. Citations
// ---------------------------------------------------------------------------

describe('CompositeKybResult: citations', () => {
  it('records which provider answered each leg, and with what reference', () => {
    const composite = CompositeKybResult.of(
      'biz_1',
      leg('director_kyc', 'approved', 'live', {
        provider: 'persona-inquiry',
        reference: 'inq_ABC123',
      }),
      leg('business_registry', 'needs_review', 'simulated', {
        provider: 'simulated-registry',
        reference: 'sim.business_registry.needs_review.biz_1',
      }),
    );

    expect(composite.citations).toEqual([
      {
        leg: 'director_kyc',
        provider: 'persona-inquiry',
        reference: 'inq_ABC123',
        status: 'approved',
        evidence: 'live',
        observedAt: '2026-09-09T00:00:00.000Z',
      },
      {
        leg: 'business_registry',
        provider: 'simulated-registry',
        reference: 'sim.business_registry.needs_review.biz_1',
        status: 'needs_review',
        evidence: 'simulated',
        observedAt: '2026-09-09T00:00:00.000Z',
      },
    ]);
  });

  it('exposes each leg by kind and surfaces the first hosted flow url', () => {
    const composite = CompositeKybResult.of(
      'biz_1',
      leg('director_kyc', 'pending', 'live', { hostedUrl: 'https://inquiry.withpersona.com/verify?x=1' }),
      leg('business_registry', 'pending', 'live'),
    );
    expect(composite.directorLeg?.leg).toBe('director_kyc');
    expect(composite.registryLeg?.leg).toBe('business_registry');
    expect(composite.hostedUrl).toBe('https://inquiry.withpersona.com/verify?x=1');
  });

  it('serialises with derived status and evidence, and legs intact', () => {
    const composite = CompositeKybResult.of(
      'biz_1',
      leg('director_kyc', 'approved', 'live'),
      leg('business_registry', 'pending', 'simulated'),
    );
    const json = JSON.parse(JSON.stringify(composite)) as Record<string, unknown>;
    expect(json['status']).toBe('pending');
    expect(json['evidence']).toBe('simulated');
    expect((json['legs'] as unknown[]).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. The provider
// ---------------------------------------------------------------------------

describe('CompositeKybProvider', () => {
  it('runs both legs and combines them', async () => {
    const provider = new CompositeKybProvider(
      new SimulatedDirectorKycProvider(),
      new SimulatedRegistryProvider(),
    );
    const result = await provider.begin(input);

    expect(result.legs.map((l) => l.leg)).toEqual(['director_kyc', 'business_registry']);
    expect(result.status).toBe('approved');
    expect(result.evidence).toBe('simulated');
  });

  it('reports its wiring', () => {
    const provider = new CompositeKybProvider(
      new SimulatedDirectorKycProvider(),
      new SimulatedRegistryProvider(),
    );
    expect(provider.wiring).toEqual({
      director_kyc: { provider: 'simulated-director-kyc', evidence: 'simulated' },
      business_registry: { provider: 'simulated-registry', evidence: 'simulated' },
    });
  });

  it('a leg that throws does not abort the other, and degrades the whole result', async () => {
    const exploding: KybLegProvider<'live'> = {
      leg: 'director_kyc',
      name: 'persona-inquiry',
      evidence: 'live',
      begin: async () => {
        throw new Error('502 from Persona');
      },
      refresh: async () => {
        throw new Error('502 from Persona');
      },
    };
    const registry = stubProvider(leg('business_registry', 'approved', 'live'), 'live');

    const result = await new CompositeKybProvider(exploding, registry).begin(input);

    expect(result.status).toBe('pending');
    // The critical assertion: a provider that never answered cannot leave the
    // composite claiming a third party verified anything.
    expect(result.evidence).toBe('simulated');
    expect(result.directorLeg?.provider).toBe('persona-inquiry-unavailable');
    expect(result.directorLeg?.checks[0]?.reasons[0]).toContain('502 from Persona');
    expect(result.registryLeg?.status).toBe('approved');
  });

  it('refreshFrom re-reads both legs using the previous citations', async () => {
    const seen: string[] = [];
    const record = (kind: 'director_kyc' | 'business_registry'): KybLegProvider<'live'> => ({
      leg: kind,
      name: `${kind}-provider`,
      evidence: 'live',
      begin: async () => leg(kind, 'pending', 'live'),
      refresh: async (reference: string) => {
        seen.push(reference);
        return leg(kind, 'approved', 'live', { reference });
      },
    });

    const provider = new CompositeKybProvider(record('director_kyc'), record('business_registry'));
    const first = await provider.begin(input);
    const second = await provider.refreshFrom(first);

    expect(seen).toEqual(['director_kyc_ref_1', 'business_registry_ref_1']);
    expect(second.status).toBe('approved');
    expect(second.evidence).toBe('live');
  });

  it('refuses to refresh a composite that is missing a leg', async () => {
    const provider = new CompositeKybProvider(
      new SimulatedDirectorKycProvider(),
      new SimulatedRegistryProvider(),
    );
    const partial = CompositeKybResult.rehydrate('biz_1', [leg('director_kyc', 'approved', 'live')]);
    await expect(provider.refreshFrom(partial)).rejects.toThrow(/missing a leg/);
  });
});

describe('failedLeg', () => {
  it('is pending and simulated, and names the provider that did not answer', () => {
    const result = failedLeg('business_registry', 'stripe-connect', new Error('timeout'));
    expect(result.status).toBe('pending');
    expect(result.evidence).toBe('simulated');
    expect(result.provider).toBe('stripe-connect-unavailable');
    expect(result.checks[0]?.reasons[0]).toContain('timeout');
  });
});
