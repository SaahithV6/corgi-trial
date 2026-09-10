import { describe, expect, it } from 'vitest';

import * as stripeModule from './stripe-registry';
import {
  legFromStripeAccountEvent,
  normaliseEin,
  StripeConnectRegistryProvider,
  stripeRequirementsToStatus,
  STRIPE_TEST_EINS,
  type StripeRequirementsView,
} from './stripe-registry';
import type { CreateKybVerificationInput } from './types';

const BASE = 'https://stripe.invalid';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  form: URLSearchParams;
}

function recordingFetch(response: unknown, status = 200): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      form: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function provider(fetchImpl: typeof fetch): StripeConnectRegistryProvider {
  return new StripeConnectRegistryProvider({
    secretKey: 'sk_test_notarealkey',
    baseUrl: BASE,
    fetchImpl,
  });
}

function inputWithEin(ein: string): CreateKybVerificationInput {
  return {
    referenceId: 'biz_1',
    businessName: 'Corgi Test Co',
    taxIdentificationNumber: ein,
    registeredAddress: {
      street1: '1 Market St',
      street2: 'Floor 3',
      city: 'San Francisco',
      subdivision: 'CA',
      postalCode: '94105',
      countryCode: 'US',
    },
    associatedPeople: [{ firstName: 'Jane', lastName: 'Doe', phoneNumber: '+15005550006' }],
  };
}

function account(requirements: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'acct_TEST',
    object: 'account',
    created: 1_757_376_000,
    metadata: { reference_id: 'biz_1' },
    requirements,
  };
}

function view(overrides: Partial<StripeRequirementsView> = {}): StripeRequirementsView {
  return {
    errors: [],
    currentlyDue: [],
    pastDue: [],
    pendingVerification: [],
    disabledReason: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Requirements -> status
// ---------------------------------------------------------------------------

describe('stripeRequirementsToStatus', () => {
  it('approves an account with nothing outstanding', () => {
    expect(stripeRequirementsToStatus(view())).toBe('approved');
  });

  it('is pending while fields are due', () => {
    expect(stripeRequirementsToStatus(view({ currentlyDue: ['company.tax_id'] }))).toBe('pending');
    expect(stripeRequirementsToStatus(view({ pastDue: ['company.name'] }))).toBe('pending');
  });

  it('is pending while the registry has not answered (EIN 222221005)', () => {
    expect(stripeRequirementsToStatus(view({ pendingVerification: ['company.tax_id'] }))).toBe(
      'pending',
    );
  });

  it('rejects on a registry decision to say no', () => {
    for (const code of [
      'verification_failed_tax_id_match',
      'verification_failed_tax_id_not_issued',
      'verification_failed_name_match',
      'verification_failed_keyed_match',
      'verification_directors_mismatch',
      'invalid_company_name_denylisted',
    ]) {
      const status = stripeRequirementsToStatus(
        view({ errors: [{ code, reason: 'r', requirement: 'company.tax_id' }] }),
      );
      expect(status, code).toBe('rejected');
    }
  });

  it('holds recoverable errors for review', () => {
    for (const code of ['verification_missing_owners', 'verification_missing_directors']) {
      expect(
        stripeRequirementsToStatus(view({ errors: [{ code, reason: 'r', requirement: 'x' }] })),
        code,
      ).toBe('needs_review');
    }
  });

  it('holds an error code this build does not recognise for review, never approves it', () => {
    const status = stripeRequirementsToStatus(
      view({ errors: [{ code: 'verification_some_future_code', reason: null, requirement: null }] }),
    );
    expect(status).toBe('needs_review');
  });

  it('rejects on a terminal disabled_reason', () => {
    expect(stripeRequirementsToStatus(view({ disabledReason: 'rejected.fraud' }))).toBe('rejected');
    expect(stripeRequirementsToStatus(view({ disabledReason: 'listed' }))).toBe('rejected');
    expect(stripeRequirementsToStatus(view({ disabledReason: 'rejected.incomplete_verification' }))).toBe(
      'rejected',
    );
  });

  it('a hard decline is not masked by an outstanding field', () => {
    const status = stripeRequirementsToStatus(
      view({
        errors: [{ code: 'verification_failed_name_match', reason: null, requirement: null }],
        currentlyDue: ['company.name'],
        pendingVerification: ['company.tax_id'],
      }),
    );
    expect(status).toBe('rejected');
  });

  it('reviews an account under review', () => {
    expect(stripeRequirementsToStatus(view({ disabledReason: 'under_review' }))).toBe('needs_review');
  });

  it('never approves an account that is disabled for an unrecognised reason', () => {
    expect(stripeRequirementsToStatus(view({ disabledReason: 'some_new_reason' }))).toBe('needs_review');
  });
});

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

describe('StripeConnectRegistryProvider.begin', () => {
  it('creates a company account with the EIN stripped to nine digits', async () => {
    const { fetch, calls } = recordingFetch(account({ currently_due: [] }));
    await provider(fetch).begin(inputWithEin('22-2221000'));

    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/v1/accounts`);
    expect(call?.headers['authorization']).toBe('Bearer sk_test_notarealkey');
    expect(call?.headers['idempotency-key']).toBe('kyb-registry-biz_1');
    expect(call?.form.get('business_type')).toBe('company');
    // Dashes produce invalid_tax_id_format rather than a registry answer.
    expect(call?.form.get('company[tax_id]')).toBe(STRIPE_TEST_EINS.companyNotFoundInRegistry);
    expect(call?.form.get('company[name]')).toBe('Corgi Test Co');
    // Abbreviated here, unlike Persona's Inquiries API.
    expect(call?.form.get('company[address][state]')).toBe('CA');
    expect(call?.form.get('company[address][line2]')).toBe('Floor 3');
    expect(call?.form.get('metadata[reference_id]')).toBe('biz_1');
  });

  it('reads the registry outcome out of requirements, not a verification status field', async () => {
    // There is NO company.verification.status field on the Account object. A
    // response that carries one must still be read from requirements.
    const { fetch } = recordingFetch({
      ...account({
        errors: [
          {
            code: 'verification_failed_name_match',
            reason: 'The company name could not be verified.',
            requirement: 'company.name',
          },
        ],
      }),
      company: { verification: { status: 'verified' } },
    });

    const leg = await provider(fetch).begin(inputWithEin(STRIPE_TEST_EINS.companyNotFoundInRegistry));
    expect(leg.status).toBe('rejected');
    expect(leg.evidence).toBe('live');
    expect(leg.reference).toBe('acct_TEST');
    expect(leg.referenceId).toBe('biz_1');
    expect(leg.checks.map((c) => c.name)).toContain('company.name');
  });

  it('surfaces the code and the human-safe reason on each check', async () => {
    const { fetch } = recordingFetch(
      account({
        errors: [
          {
            code: 'verification_missing_directors',
            reason: 'We identified directors that are not on the account.',
            requirement: 'relationship.director',
          },
        ],
      }),
    );
    const leg = await provider(fetch).begin(inputWithEin(STRIPE_TEST_EINS.directorsNotFoundInRegistry));
    expect(leg.status).toBe('needs_review');
    const check = leg.checks.find((c) => c.name === 'relationship.director');
    expect(check?.reasons).toContain('verification_missing_directors');
    expect(check?.reasons).toContain('We identified directors that are not on the account.');
  });

  it('reports the pending-registry case as pending', async () => {
    const { fetch } = recordingFetch(account({ pending_verification: ['company.tax_id'] }));
    const leg = await provider(fetch).begin(inputWithEin(STRIPE_TEST_EINS.pendingResponseFromRegistry));
    expect(leg.status).toBe('pending');
  });

  it('surfaces Stripe’s own error message on a failure', async () => {
    const { fetch } = recordingFetch({ error: { message: 'Invalid API Key provided' } }, 401);
    await expect(provider(fetch).begin(inputWithEin('000000000'))).rejects.toThrow(
      /Invalid API Key provided/,
    );
  });

  it('reads an account back by id on refresh', async () => {
    const { fetch, calls } = recordingFetch(account({}));
    const leg = await provider(fetch).refresh('acct_TEST');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`${BASE}/v1/accounts/acct_TEST`);
    expect(leg.status).toBe('approved');
  });

  it('tolerates a malformed requirements object without approving it by accident', async () => {
    const { fetch } = recordingFetch({ id: 'acct_TEST', object: 'account', requirements: 'nonsense' });
    const leg = await provider(fetch).refresh('acct_TEST');
    // Nothing outstanding is readable, so this DOES approve — which is why the
    // composite requires both legs and the gate requires an evidence label.
    // Asserted so the behaviour is a decision on the record, not a surprise.
    expect(leg.status).toBe('approved');
    expect(leg.rawStatus).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

describe('legFromStripeAccountEvent', () => {
  it('maps an account.updated delivery', () => {
    const leg = legFromStripeAccountEvent({
      id: 'evt_1',
      type: 'account.updated',
      data: { object: account({ pending_verification: ['company.tax_id'] }) },
    });
    expect(leg?.leg).toBe('business_registry');
    expect(leg?.status).toBe('pending');
    expect(leg?.reference).toBe('acct_TEST');
    expect(leg?.referenceId).toBe('biz_1');
    expect(leg?.evidence).toBe('live');
  });

  it('ignores events that are not about an account', () => {
    expect(
      legFromStripeAccountEvent({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: {} } }),
    ).toBeNull();
    expect(legFromStripeAccountEvent({ type: 'account.updated', data: { object: { id: 'x' } } })).toBeNull();
    expect(legFromStripeAccountEvent(null)).toBeNull();
  });
});

describe('normaliseEin', () => {
  it('keeps digits only', () => {
    expect(normaliseEin('22-2221000')).toBe('222221000');
    expect(normaliseEin(' 00 0000000 ')).toBe('000000000');
  });
});

describe('webhook authentication is not this module’s job', () => {
  it('exports no signature verification of its own', () => {
    // `stripeVerifier` in src/lib/webhooks/inbox.ts already authenticates
    // Stripe deliveries. One implementation, registered once.
    const suspicious = Object.keys(stripeModule).filter((name) =>
      /signature|hmac|verifywebhook/i.test(name),
    );
    expect(suspicious).toEqual([]);
  });
});
