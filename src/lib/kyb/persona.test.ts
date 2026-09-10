import { describe, expect, it } from 'vitest';

import * as personaModule from './persona';
import {
  legFromPersonaEvent,
  PersonaDirectorKycProvider,
  personaDemoScript,
  personaStatusToKyb,
} from './persona';
import type { CreateKybVerificationInput } from './types';

// No test in this file may reach the network. Persona's trial is metered ("up
// to 50 services", one trial per business ever), so every call is served by an
// injected fetch double and the base url is a black hole.
const BASE = 'https://persona.invalid/api/v1';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
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
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function provider(fetchImpl: typeof fetch): PersonaDirectorKycProvider {
  return new PersonaDirectorKycProvider({
    apiKey: 'persona_sandbox_test_key',
    inquiryTemplateId: 'itmpl_TEST',
    verificationTemplateId: 'vtmpl_TEST',
    environmentId: 'env_TEST',
    baseUrl: BASE,
    fetchImpl,
  });
}

const input: CreateKybVerificationInput = {
  referenceId: 'biz_1',
  businessName: 'Corgi Test Co',
  taxIdentificationNumber: '00-0000000',
  registeredAddress: {
    street1: '1 Market St',
    city: 'San Francisco',
    subdivision: 'CA',
    postalCode: '94105',
    countryCode: 'US',
  },
  associatedPeople: [
    {
      firstName: 'Jane',
      lastName: 'Doe',
      birthdate: '1990-01-01',
      emailAddress: 'jane@example.com',
      taxIdentificationNumber: '000-00-0000',
      address: {
        street1: '2 Main St',
        city: 'Oakland',
        // Unabbreviated on this endpoint — see the note in personaFields.
        subdivision: 'California',
        postalCode: '94607',
        countryCode: 'US',
      },
    },
  ],
};

function inquiry(status: string, extra: Record<string, unknown> = {}): unknown {
  return {
    data: {
      type: 'inquiry',
      id: 'inq_ABC123',
      attributes: {
        status,
        'reference-id': 'biz_1',
        'created-at': '2026-09-09T00:00:00.000Z',
        'updated-at': '2026-09-09T00:05:00.000Z',
        ...extra,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

describe('personaStatusToKyb', () => {
  it('maps the documented inquiry lifecycle', () => {
    expect(personaStatusToKyb('created')).toBe('pending');
    expect(personaStatusToKyb('pending')).toBe('pending');
    expect(personaStatusToKyb('approved')).toBe('approved');
    expect(personaStatusToKyb('declined')).toBe('rejected');
    expect(personaStatusToKyb('needs_review')).toBe('needs_review');
    expect(personaStatusToKyb('needs-review')).toBe('needs_review');
  });

  it('maps completed to pending, NOT approved', () => {
    // Persona: "completed" means the user reached the Completed screen. The
    // approve/decline decision is a separate post-inquiry phase. Treating it as
    // approved is the single easiest way to let an unverified person through.
    expect(personaStatusToKyb('completed')).toBe('pending');
  });

  it('maps expired and failed to needs_review, not rejected', () => {
    // Neither is a decision to say no; both need a human to re-invite.
    expect(personaStatusToKyb('expired')).toBe('needs_review');
    expect(personaStatusToKyb('failed')).toBe('needs_review');
  });

  it('holds an unrecognised status for review — Persona warns the enum is open', () => {
    expect(personaStatusToKyb('some_future_status')).toBe('needs_review');
    expect(personaStatusToKyb('')).toBe('needs_review');
    expect(personaStatusToKyb(null)).toBe('needs_review');
    expect(personaStatusToKyb(undefined)).toBe('needs_review');
  });

  it('does not mistake a prototype key for a status', () => {
    expect(personaStatusToKyb('toString')).toBe('needs_review');
    expect(personaStatusToKyb('constructor')).toBe('needs_review');
  });

  it('tolerates casing and stray whitespace from the provider', () => {
    // Leniency about how a provider spells its OWN status is safe — it is the
    // same word. Leniency about a value stored in our database is not, which is
    // why asKybStatus() in types.ts is strict where this is not.
    expect(personaStatusToKyb(' Approved ')).toBe('approved');
    expect(personaStatusToKyb('DECLINED')).toBe('rejected');
  });

  it('never maps anything unknown to approved', () => {
    for (const candidate of ['approve', 'ok', 'verified', 'passed', 'valueOf', 'appr oved']) {
      expect(personaStatusToKyb(candidate), candidate).not.toBe('approved');
    }
  });
});

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

describe('PersonaDirectorKycProvider.begin', () => {
  it('creates an inquiry with the pinned api version and an idempotency key', async () => {
    const { fetch, calls } = recordingFetch(inquiry('created'));
    await provider(fetch).begin(input);

    const call = calls[0];
    expect(call?.url).toBe(`${BASE}/inquiries`);
    expect(call?.method).toBe('POST');
    expect(call?.headers['authorization']).toBe('Bearer persona_sandbox_test_key');
    expect(call?.headers['persona-version']).toBe('2025-12-08');
    expect(call?.headers['key-inflection']).toBe('kebab');
    // A retried create must not burn a second service against the trial cap.
    expect(call?.headers['idempotency-key']).toBe('kyb-director-biz_1');
  });

  it('sends the director fields and the reference id, and omits their SSN', async () => {
    const { fetch, calls } = recordingFetch(inquiry('created'));
    await provider(fetch).begin(input);

    const body = calls[0]?.body as {
      data: { attributes: { 'inquiry-template-id': string; fields: Record<string, string> } };
      meta: Record<string, unknown>;
    };
    expect(body.data.attributes['inquiry-template-id']).toBe('itmpl_TEST');
    expect(body.data.attributes.fields['name-first']).toBe('Jane');
    expect(body.data.attributes.fields['address-subdivision']).toBe('California');
    expect(body.meta['auto-create-account-reference-id']).toBe('biz_1');

    // The director's SSN is never sent on this call.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('000-00-0000');
    expect(serialised).not.toContain('tax');
  });

  it('returns a live leg result carrying the inquiry id', async () => {
    const { fetch } = recordingFetch(inquiry('pending'));
    const leg = await provider(fetch).begin(input);

    expect(leg.leg).toBe('director_kyc');
    expect(leg.provider).toBe('persona-inquiry');
    expect(leg.reference).toBe('inq_ABC123');
    expect(leg.referenceId).toBe('biz_1');
    expect(leg.status).toBe('pending');
    expect(leg.rawStatus).toBe('pending');
    expect(leg.evidence).toBe('live');
  });

  it('builds a hosted-flow url when the response carries no one-time link', async () => {
    const { fetch } = recordingFetch(inquiry('created'));
    const leg = await provider(fetch).begin(input);
    expect(leg.hostedUrl).toBe(
      'https://inquiry.withpersona.com/verify?inquiry-id=inq_ABC123&environment-id=env_TEST',
    );
  });

  it('prefers a one-time link when Persona returns one', async () => {
    const { fetch } = recordingFetch({
      ...(inquiry('created') as Record<string, unknown>),
      meta: { 'one-time-link': 'https://inquiry.withpersona.com/verify?one-time=abc' },
    });
    const leg = await provider(fetch).begin(input);
    expect(leg.hostedUrl).toBe('https://inquiry.withpersona.com/verify?one-time=abc');
  });

  it('throws a KybProviderError without echoing the response body', async () => {
    const { fetch } = recordingFetch({ errors: [{ title: 'inquiry-template-id is invalid' }] }, 422);
    await expect(provider(fetch).begin(input)).rejects.toThrow(/persona post \/inquiries -> 422/i);
    await expect(provider(fetch).begin(input)).rejects.not.toThrow(/inquiry-template-id is invalid/);
  });
});

describe('PersonaDirectorKycProvider.refresh', () => {
  it('reads the inquiry back by id', async () => {
    const { fetch, calls } = recordingFetch(inquiry('approved'));
    const leg = await provider(fetch).refresh('inq_ABC123');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`${BASE}/inquiries/inq_ABC123`);
    expect(leg.status).toBe('approved');
  });
});

describe('PersonaDirectorKycProvider.simulate', () => {
  it('posts the action list to perform-simulate-actions', async () => {
    const { fetch, calls } = recordingFetch(inquiry('approved'));
    const p = provider(fetch);
    await p.simulate('inq_ABC123', p.scriptFor('approved'));

    expect(calls[0]?.url).toBe(`${BASE}/inquiries/inq_ABC123/perform-simulate-actions`);
    expect(calls[0]?.body).toEqual({
      meta: {
        'simulate-actions': [
          { type: 'start_inquiry' },
          { type: 'create_passed_verification', data: { 'verification-template-id': 'vtmpl_TEST' } },
          { type: 'complete_inquiry' },
          { type: 'approve_inquiry' },
        ],
      },
    });
  });
});

describe('personaDemoScript', () => {
  it('drives each of the four demo states', () => {
    expect(personaDemoScript('pending').map((a) => a.type)).toEqual(['start_inquiry']);
    expect(personaDemoScript('approved').map((a) => a.type)).toEqual([
      'start_inquiry',
      'complete_inquiry',
      'approve_inquiry',
    ]);
    expect(personaDemoScript('declined', 'vtmpl_X').map((a) => a.type)).toEqual([
      'start_inquiry',
      'create_failed_verification',
      'complete_inquiry',
      'decline_inquiry',
    ]);
    expect(personaDemoScript('needs_review').map((a) => a.type)).toEqual([
      'start_inquiry',
      'complete_inquiry',
      'mark_for_review_inquiry',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

function event(name: string, status: string): unknown {
  return {
    data: {
      type: 'event',
      id: 'evt_1',
      attributes: {
        name,
        payload: {
          data: {
            type: 'inquiry',
            id: 'inq_ABC123',
            attributes: {
              status,
              'reference-id': 'biz_1',
              'created-at': '2026-09-09T00:00:00.000Z',
              'updated-at': '2026-09-09T00:06:00.000Z',
            },
          },
        },
      },
    },
  };
}

describe('legFromPersonaEvent', () => {
  it('maps an approved inquiry event to a live approved leg', () => {
    const leg = legFromPersonaEvent(event('inquiry.approved', 'approved'));
    expect(leg?.status).toBe('approved');
    expect(leg?.reference).toBe('inq_ABC123');
    expect(leg?.referenceId).toBe('biz_1');
    expect(leg?.evidence).toBe('live');
    expect(leg?.observedAt).toBe('2026-09-09T00:06:00.000Z');
  });

  it('maps a declined inquiry event to rejected', () => {
    expect(legFromPersonaEvent(event('inquiry.declined', 'declined'))?.status).toBe('rejected');
  });

  it('maps marked-for-review to needs_review', () => {
    expect(legFromPersonaEvent(event('inquiry.marked-for-review', 'needs_review'))?.status).toBe(
      'needs_review',
    );
  });

  it('ignores events that are not about an inquiry', () => {
    expect(legFromPersonaEvent(event('verification.passed', 'passed'))).toBeNull();
    expect(legFromPersonaEvent({})).toBeNull();
    expect(legFromPersonaEvent(null)).toBeNull();
    expect(legFromPersonaEvent('not json at all')).toBeNull();
  });

  it('ignores an inquiry event with no inquiry id', () => {
    expect(
      legFromPersonaEvent({
        data: { attributes: { name: 'inquiry.approved', payload: { data: { attributes: {} } } } },
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The rule about not re-implementing signature verification
// ---------------------------------------------------------------------------

describe('webhook authentication is not this module’s job', () => {
  it('exports no signature verification of its own', () => {
    // Persona deliveries are authenticated exactly once, by `personaVerifier`
    // in src/lib/webhooks/inbox.ts, before they reach the inbox. A second HMAC
    // implementation here would be a second thing to keep correct — so this
    // test fails if one ever appears.
    const suspicious = Object.keys(personaModule).filter((name) =>
      /signature|hmac|verifywebhook/i.test(name),
    );
    expect(suspicious).toEqual([]);
  });
});
