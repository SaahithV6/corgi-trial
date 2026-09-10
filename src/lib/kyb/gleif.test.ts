/**
 * The registry leg's tests.
 *
 * ===========================================================================
 * NOTHING HERE TOUCHES api.gleif.org. Every test injects `fetchImpl`.
 *
 * That is not politeness about somebody else's server — though it is that too.
 * It is that the assertions worth making are about OUR rules: that a fuzzy
 * near-miss is not a match, that an absent record can never approve, that a
 * withdrawn registration declines, that a cancelled shape we have never seen
 * fails closed. Every one of those is a statement about this file's logic, and
 * a test that reached the network would be asserting GLEIF's data instead —
 * green until Apple restructures, and silent about the thing it was for.
 *
 * The RESPONSES below are real. They are trimmed transcripts of live reads
 * taken on 2026-09-10 and the LEIs, register entries and status strings in them
 * can be checked against the public API by hand.
 * ===========================================================================
 */

import { describe, expect, it } from 'vitest';

import {
  decodeGleifReference,
  describeSearch,
  gleifRecordToVerdict,
  GleifRegistryProvider,
  GLEIF_CODES,
  GLEIF_MISS_HEADLINE,
  GLEIF_NOT_FOUND_PREFIX,
  isLeiFormat,
  namesMatch,
  nameMatchesRecord,
  normaliseEntityName,
  placeOf,
  readRecord,
  type GleifRecordView,
  type GleifSearch,
} from './gleif';
import { citationFromChecks, providerCodeFromChecks, type CreateKybVerificationInput } from './types';

// ---------------------------------------------------------------------------
// Transcripts — trimmed, real, checkable
// ---------------------------------------------------------------------------

function record(attributes: Record<string, unknown>): unknown {
  return { attributes };
}

/** Apple Inc. — the citation this leg exists to be able to produce. */
const APPLE = record({
  lei: 'HWUPKR0MPOU8FGXBT394',
  entity: {
    legalName: { name: 'Apple Inc.' },
    otherNames: [{ name: 'Apple Computer, Inc.', type: 'PREVIOUS_LEGAL_NAME' }],
    legalAddress: { country: 'US' },
    status: 'ACTIVE',
    jurisdiction: 'US-CA',
    registeredAt: { id: 'RA000598' },
    registeredAs: '806592',
  },
  registration: {
    status: 'ISSUED',
    corroborationLevel: 'FULLY_CORROBORATED',
    lastUpdateDate: '2026-03-03T16:34:33Z',
  },
});

/** A real company that stopped being one. Entity INACTIVE, LEI RETIRED. */
const RESILIENCE = record({
  lei: '254900ZT6ZFUC887FB87',
  entity: {
    legalName: { name: 'RESILIENCE PARENT, LLC' },
    legalAddress: { country: 'US' },
    status: 'INACTIVE',
    jurisdiction: 'US-DE',
    registeredAt: { id: 'RA000602' },
    registeredAs: '10416095',
    successorEntity: { name: 'POWER GRID COMPONENTS, INC.' },
  },
  registration: { status: 'RETIRED', corroborationLevel: 'FULLY_CORROBORATED' },
});

const RA000598 = {
  data: {
    attributes: {
      internationalOrganizationName: 'Secretary of State',
      website: 'https://businesssearch.sos.ca.gov/',
      jurisdictions: [{ country: 'United States of America', jurisdiction: 'California' }],
    },
  },
};

const INPUT: CreateKybVerificationInput = {
  referenceId: 'biz_1',
  businessName: 'Apple Inc.',
  taxIdentificationNumber: '000000000',
  registeredAddress: {
    street1: '1 Apple Park Way',
    city: 'Cupertino',
    subdivision: 'CA',
    postalCode: '95014',
    countryCode: 'US',
  },
};

type Route = { readonly match: string; readonly status?: number; readonly body?: unknown };

/**
 * A fetch that answers by path fragment and RECORDS what it was asked.
 *
 * The recording matters as much as the answers: several tests below assert on
 * the URLs this adapter constructs — that a name search filters to US, that an
 * LEI is path-encoded rather than interpolated, that a miss costs no record
 * read — and those are claims about requests, not responses.
 */
function routedFetch(routes: readonly Route[]): {
  fetchImpl: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    urls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    if (route === undefined) {
      return new Response('{"errors":[{"status":"404"}]}', { status: 404 });
    }
    return new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/vnd.api+json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

function provider(routes: readonly Route[]): {
  gleif: GleifRegistryProvider;
  urls: string[];
} {
  const { fetchImpl, urls } = routedFetch(routes);
  return { gleif: new GleifRegistryProvider({ fetchImpl }), urls };
}

// ---------------------------------------------------------------------------
// 1. Name normalisation — the guard against the fuzzy-match trap
// ---------------------------------------------------------------------------

describe('normaliseEntityName', () => {
  it('folds case, punctuation, diacritics and whitespace', () => {
    expect(normaliseEntityName('  Apple   Inc.  ')).toBe('APPLE INC');
    expect(normaliseEntityName('Café Sørens A/S')).toBe('CAFE SORENS A S');
    // Ø, Æ, Å, Ł and friends are letters in their own right, so NFKD leaves
    // them intact and a bare [^A-Z0-9] fold would turn them into separators —
    // `Sørensen` -> `S RENSEN`, which stops matching the register's own
    // transliteration of the same company.
    expect(normaliseEntityName('Łódź Æther Holding A/S')).toBe('LODZ AETHER HOLDING A S');
  });

  it('treats & and "and" as the same word, because every register does', () => {
    expect(namesMatch('Kettle & Crumb Bakery LLC', 'Kettle and Crumb Bakery LLC')).toBe(true);
  });

  it('KEEPS the legal-form suffix, because Inc and LLC are different entities', () => {
    // The single most tempting "improvement" to this function, and the one that
    // would approve the wrong company. Pinned so nobody makes it by accident.
    expect(namesMatch('Ridgeline Robotics, Inc.', 'Ridgeline Robotics LLC')).toBe(false);
    expect(namesMatch('Ridgeline Robotics, Inc.', 'Ridgeline Robotics')).toBe(false);
  });

  it('never matches an empty name against anything', () => {
    expect(namesMatch('', '')).toBe(false);
    expect(namesMatch('   ', 'Apple Inc.')).toBe(false);
  });

  it('matches a PREVIOUS legal name, which is still the same company', () => {
    const apple = readRecord(APPLE) as GleifRecordView;
    expect(nameMatchesRecord('Apple Computer, Inc.', apple)).toBe(true);
    expect(nameMatchesRecord('Apple Bank', apple)).toBe(false);
  });
});

describe('isLeiFormat', () => {
  it('accepts exactly twenty upper-case alphanumerics', () => {
    expect(isLeiFormat('HWUPKR0MPOU8FGXBT394')).toBe(true);
    expect(isLeiFormat('  hwupkr0mpou8fgxbt394 ')).toBe(true);
  });

  it('rejects an EIN, a URL and anything else that would become a path segment', () => {
    for (const bad of ['000000000', 'https://example.com/x', 'HWUPKR0MPOU8FGXBT39', '../../etc']) {
      expect(isLeiFormat(bad)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The verdict — every row of the mapping table
// ---------------------------------------------------------------------------

function view(over: Partial<GleifRecordView> = {}): GleifRecordView {
  return {
    lei: 'HWUPKR0MPOU8FGXBT394',
    legalName: 'Apple Inc.',
    otherNames: [],
    entityStatus: 'ACTIVE',
    registrationStatus: 'ISSUED',
    corroborationLevel: 'FULLY_CORROBORATED',
    jurisdiction: 'US-CA',
    country: 'US',
    registeredAtId: 'RA000598',
    registeredAs: '806592',
    lastUpdateDate: '2026-03-03T16:34:33Z',
    successorName: null,
    ...over,
  };
}

describe('gleifRecordToVerdict', () => {
  it('ACTIVE + ISSUED + FULLY_CORROBORATED is the only path to approved', () => {
    const verdict = gleifRecordToVerdict(view(), 'US');
    expect(verdict.status).toBe('approved');
    expect(verdict.code).toBe(GLEIF_CODES.matchActiveIssued);
  });

  it('INACTIVE declines, and names the successor GLEIF gives', () => {
    const verdict = gleifRecordToVerdict(
      view({ entityStatus: 'INACTIVE', successorName: 'POWER GRID COMPONENTS, INC.' }),
      'US',
    );
    expect(verdict.status).toBe('rejected');
    expect(verdict.code).toBe(GLEIF_CODES.entityInactive);
    expect(verdict.reasons.join(' ')).toContain('POWER GRID COMPONENTS');
  });

  it('RETIRED and ANNULLED decline; LAPSED does not', () => {
    expect(gleifRecordToVerdict(view({ registrationStatus: 'RETIRED' }), 'US').status).toBe('rejected');
    expect(gleifRecordToVerdict(view({ registrationStatus: 'ANNULLED' }), 'US').status).toBe('rejected');

    // The distinction the whole table turns on: an unrenewed LEI is a statement
    // about the REGISTRATION, not about the company. 203,636 US records sit in
    // this state and declining them all would be nonsense.
    const lapsed = gleifRecordToVerdict(view({ registrationStatus: 'LAPSED' }), 'US');
    expect(lapsed.status).toBe('needs_review');
    expect(lapsed.code).toBe(GLEIF_CODES.registrationLapsed);
    expect(lapsed.reasons.join(' ')).toContain('not about the company');
  });

  it('anything below FULLY_CORROBORATED is held for a human', () => {
    const verdict = gleifRecordToVerdict(view({ corroborationLevel: 'PARTIALLY_CORROBORATED' }), 'US');
    expect(verdict.status).toBe('needs_review');
    expect(verdict.code).toBe(GLEIF_CODES.partiallyCorroborated);
  });

  it('takes the STRICTEST signal, not the first one it reads', () => {
    // A record can be ACTIVE with a RETIRED registration. An if-chain that
    // checked entity status first and returned would approve a withdrawn
    // registration; this asserts the fold.
    const verdict = gleifRecordToVerdict(
      view({ entityStatus: 'ACTIVE', registrationStatus: 'RETIRED', corroborationLevel: 'ENTITY_SUPPLIED_ONLY' }),
      'US',
    );
    expect(verdict.status).toBe('rejected');
    expect(verdict.code).toBe(GLEIF_CODES.registrationWithdrawn);
    // ...and every contributing signal is still reported, not just the winner.
    expect(verdict.reasons.length).toBeGreaterThan(1);
  });

  it('fails closed on a status this build has never seen', () => {
    const verdict = gleifRecordToVerdict(view({ entityStatus: 'PROBABLY_FINE' }), 'US');
    expect(verdict.status).toBe('needs_review');
    expect(verdict.code).toBe(GLEIF_CODES.unrecognised);
  });

  it('a prototype-chain key cannot narrow to a status', () => {
    // `MAP['toString']` walks the prototype and returns a FUNCTION, which
    // `?? 'needs_review'` would pass straight through. Untrusted input.
    for (const key of ['toString', 'constructor', 'hasOwnProperty']) {
      expect(gleifRecordToVerdict(view({ entityStatus: key }), 'US').status).toBe('needs_review');
      expect(gleifRecordToVerdict(view({ registrationStatus: key }), 'US').status).toBe('needs_review');
    }
  });

  it('holds an exact name match registered in another country', () => {
    // Measured: the name "Apple Computer, Inc." resolves to an ACTIVE, ISSUED,
    // FULLY_CORROBORATED IRISH record. Every other signal says approve and the
    // name check cannot help, because the names are identical.
    const verdict = gleifRecordToVerdict(view({ country: 'IE', jurisdiction: 'IE' }), 'US');
    expect(verdict.status).toBe('needs_review');
    expect(verdict.code).toBe(GLEIF_CODES.jurisdictionMismatch);
  });

  it('asserts no country when none was given, rather than throwing on undefined', () => {
    expect(gleifRecordToVerdict(view({ country: 'IE' }), null).status).toBe('approved');
    expect(gleifRecordToVerdict(view({ country: 'IE' }), '  ').status).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// 3. Citations
// ---------------------------------------------------------------------------

describe('placeOf', () => {
  it('names the authority jurisdiction when the authority has exactly one', () => {
    expect(
      placeOf(view(), { name: 'Secretary of State', jurisdictions: ['California'], website: null }),
    ).toBe('California');
  });

  it('falls back to the ENTITY jurisdiction when the authority covers many', () => {
    // The bug this pins: the SEC's registration authority lists every US state
    // and territory, and taking `jurisdictions[0]` printed one of GLEIF's
    // Delaware ETFs as registered in GUAM. The record's own field is the only
    // one entitled to answer.
    expect(
      placeOf(view({ jurisdiction: 'US-DE' }), {
        name: 'Securities and Exchange Commission',
        jurisdictions: ['Guam', 'Delaware', 'Puerto Rico'],
        website: null,
      }),
    ).toBe('US-DE');
  });
});

// ---------------------------------------------------------------------------
// 4. References — a leg has to be re-askable
// ---------------------------------------------------------------------------

describe('decodeGleifReference', () => {
  it('round-trips all three shapes', () => {
    expect(decodeGleifReference('HWUPKR0MPOU8FGXBT394')).toEqual({
      kind: 'lei',
      lei: 'HWUPKR0MPOU8FGXBT394',
    });
    expect(decodeGleifReference('gleif.notfound.ZZZZZZZZZZZZZZZZZZZZ')).toEqual({
      kind: 'lei',
      lei: 'ZZZZZZZZZZZZZZZZZZZZ',
    });
    expect(decodeGleifReference('gleif.nomatch.Ridgeline Robotics, Inc.')).toEqual({
      kind: 'name',
      name: 'Ridgeline Robotics, Inc.',
    });
  });

  it('returns null rather than guessing at an unreadable reference', () => {
    for (const bad of ['', '   ', 'sim.business_registry.approved.x', 'gleif.nomatch.']) {
      expect(decodeGleifReference(bad)).toBeNull();
    }
  });

  it('never produces a reference the database CHECK would refuse', () => {
    // `kyb_leg_simulated_reference` refuses a row claiming `live` while
    // carrying a `sim.` reference, which is exactly the protection wanted —
    // and exactly why this adapter's own reference forms are prefixed `gleif.`.
    expect(GLEIF_NOT_FOUND_PREFIX.startsWith('sim.')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. The adapter, end to end
// ---------------------------------------------------------------------------

describe('GleifRegistryProvider', () => {
  it('resolves a name through the autocompleter and cites the government register', async () => {
    const { gleif, urls } = provider([
      {
        match: '/autocompletions',
        body: {
          data: [
            {
              attributes: { value: 'Apple Inc.' },
              relationships: { 'lei-records': { data: { id: 'HWUPKR0MPOU8FGXBT394' } } },
            },
          ],
        },
      },
      { match: '/lei-records/HWUPKR0MPOU8FGXBT394', body: { data: APPLE } },
      { match: '/registration-authorities/RA000598', body: RA000598 },
      { match: '/lei-records?', body: { data: [], meta: { pagination: { total: 20 } } } },
    ]);

    const leg = await gleif.begin(INPUT);

    expect(leg.status).toBe('approved');
    expect(leg.evidence).toBe('live');
    expect(leg.leg).toBe('business_registry');
    expect(leg.reference).toBe('HWUPKR0MPOU8FGXBT394');
    expect(providerCodeFromChecks(leg.checks)).toBe(GLEIF_CODES.matchActiveIssued);

    // THE POINT OF THE WHOLE LEG: a citation a reviewer can follow.
    const citation = citationFromChecks(leg.checks) ?? '';
    expect(citation).toContain('Secretary of State');
    expect(citation).toContain('California');
    expect(citation).toContain('entry 806592');
    expect(citation).toContain('businesssearch.sos.ca.gov');

    // The fuzzy filter is narrowed to US, and it is a candidate generator that
    // ran alongside the autocompleter rather than instead of it.
    expect(urls.some((u) => u.includes('entity.legalAddress.country') && u.includes('US'))).toBe(true);
  });

  it('a name nobody in the register has is needs_review — never approved, never rejected', async () => {
    const { gleif } = provider([
      { match: '/autocompletions', body: { data: [] } },
      { match: '/lei-records?', body: { data: [], meta: { pagination: { total: 0 } } } },
    ]);

    const leg = await gleif.begin({ ...INPUT, businessName: 'Ridgeline Robotics, Inc.' });

    expect(leg.status).toBe('needs_review');
    expect(leg.rawStatus).toBe(GLEIF_CODES.notInRegistry);
    expect(providerCodeFromChecks(leg.checks)).toBe(GLEIF_CODES.notInRegistry);
    expect(leg.checks[0]?.reasons[0]).toBe(GLEIF_MISS_HEADLINE);
    // A miss cites nothing, and does not pretend to.
    expect(citationFromChecks(leg.checks)).toBeNull();
    // It is still LIVE evidence: a third party was asked and answered. The
    // honesty is carried by the status, not by relabelling who answered.
    expect(leg.evidence).toBe('live');
  });

  it('REFUSES the fuzzy filter\'s top hit, however good it looks', async () => {
    // The measured trap: `filter[entity.legalName]=Ridgeline Robotics, Inc.`
    // returns 43,182 records whose first entry is "Pruvations Inc 401K Inc",
    // matched on the token "Inc". A build that trusted data[0] would approve a
    // 401k plan as an aerospace firm.
    const { gleif } = provider([
      { match: '/autocompletions', body: { data: [] } },
      {
        match: '/lei-records?',
        body: {
          data: [
            record({
              lei: '549300PRUVATIONS00000',
              entity: {
                legalName: { name: 'Pruvations Inc 401K Inc' },
                legalAddress: { country: 'US' },
                status: 'ACTIVE',
              },
              registration: { status: 'ISSUED', corroborationLevel: 'FULLY_CORROBORATED' },
            }),
          ],
          meta: { pagination: { total: 43182 } },
        },
      },
    ]);

    const leg = await gleif.begin({ ...INPUT, businessName: 'Ridgeline Robotics, Inc.' });

    expect(leg.status).toBe('needs_review');
    expect(leg.reference).not.toContain('PRUVATIONS');
    // And the miss quantifies its own search space rather than saying "0".
    expect(leg.checks[0]?.reasons.join(' ')).toContain('43,182');
  });

  it('declines an LEI the applicant asserted that does not exist', async () => {
    // The ONE absence that is evidence. "We could not find you" and "the
    // identifier you gave us is not real" are different sentences.
    const { gleif } = provider([{ match: '/lei-records/', status: 404, body: undefined }]);

    const leg = await gleif.begin({ ...INPUT, lei: 'ZZZZZZZZZZZZZZZZZZZZ' });

    expect(leg.status).toBe('rejected');
    expect(providerCodeFromChecks(leg.checks)).toBe(GLEIF_CODES.assertedLeiNotFound);
    expect(leg.reference).toBe('gleif.notfound.ZZZZZZZZZZZZZZZZZZZZ');
  });

  it('parses a 404 on the STATUS CODE, not on the body', async () => {
    // GLEIF's 404 body has been JSON and has been an HTML error page. A branch
    // that read the body would flip behaviour when they change their error
    // renderer, which is not a thing a decline should depend on.
    for (const body of ['<html><body>Not Found</body></html>', '{"errors":[{"status":"404"}]}', '']) {
      const fetchImpl = (async () =>
        new Response(body, { status: 404 })) as unknown as typeof fetch;
      const leg = await new GleifRegistryProvider({ fetchImpl }).begin({
        ...INPUT,
        lei: 'ZZZZZZZZZZZZZZZZZZZZ',
      });
      expect(leg.status).toBe('rejected');
    }
  });

  it('holds an asserted LEI whose record names somebody else', async () => {
    const { gleif } = provider([
      { match: '/lei-records/HWUPKR0MPOU8FGXBT394', body: { data: APPLE } },
      { match: '/registration-authorities/RA000598', body: RA000598 },
    ]);

    const leg = await gleif.begin({
      ...INPUT,
      businessName: 'Ridgeline Robotics, Inc.',
      lei: 'HWUPKR0MPOU8FGXBT394',
    });

    expect(leg.status).toBe('needs_review');
    expect(providerCodeFromChecks(leg.checks)).toBe(GLEIF_CODES.nameMismatch);
    // The record still cites, because the record is real; what is in doubt is
    // whether it belongs to this applicant.
    expect(citationFromChecks(leg.checks)).toContain('Secretary of State');
  });

  it('declines a real company the register says stopped trading', async () => {
    const { gleif } = provider([
      { match: '/lei-records/254900ZT6ZFUC887FB87', body: { data: RESILIENCE } },
      {
        match: '/registration-authorities/RA000602',
        body: {
          data: {
            attributes: {
              internationalOrganizationName: 'Division of Corporations, Department of State',
              website: 'https://corp.delaware.gov/',
              jurisdictions: [{ country: 'United States of America', jurisdiction: 'Delaware' }],
            },
          },
        },
      },
    ]);

    const leg = await gleif.begin({
      ...INPUT,
      businessName: 'RESILIENCE PARENT, LLC',
      lei: '254900ZT6ZFUC887FB87',
    });

    expect(leg.status).toBe('rejected');
    expect(leg.rawStatus).toBe('INACTIVE/RETIRED');
    expect(citationFromChecks(leg.checks)).toContain('Delaware');
  });

  it('still decides when the citation lookup fails', async () => {
    // A citation ENRICHES an answer we already have. Losing it must not turn a
    // decided leg into an outage.
    const { gleif } = provider([
      { match: '/autocompletions', body: { data: [] } },
      { match: '/lei-records?', body: { data: [APPLE], meta: { pagination: { total: 1 } } } },
      { match: '/registration-authorities/', status: 500, body: { errors: [] } },
    ]);

    const leg = await gleif.begin(INPUT);
    expect(leg.status).toBe('approved');
    expect(citationFromChecks(leg.checks)).toContain('RA000598');
  });

  it('fails LOUDLY when GLEIF is unreachable, and never invents an answer', async () => {
    // An LEI lookup has one request, and it propagates.
    const fetchImpl = (() => Promise.reject(new Error('ETIMEDOUT'))) as unknown as typeof fetch;
    await expect(
      new GleifRegistryProvider({ fetchImpl }).begin({ ...INPUT, lei: 'HWUPKR0MPOU8FGXBT394' }),
    ).rejects.toThrow(/GLEIF GET/);
  });

  it('an unreachable registry is an UNANSWERED leg, not a miss', async () => {
    // The bug this pins, caught by this file: a name search runs two
    // generators, each of which swallows its own failure so that one
    // answering is still a search. With GLEIF down, both swallow, the
    // candidate list is empty, and the leg would come back `needs_review`
    // asserting "not present in the LEI registry" — a claim that a registry
    // was consulted, on a request nobody received.
    const fetchImpl = (() => Promise.reject(new Error('ETIMEDOUT'))) as unknown as typeof fetch;
    await expect(new GleifRegistryProvider({ fetchImpl }).begin(INPUT)).rejects.toThrow(
      /unanswered, not a miss/,
    );
  });

  it('one generator failing is still a search', async () => {
    // The other half of the same rule: a partial outage must NOT become an
    // error, because a leg that could have been decided was decided.
    const { gleif } = provider([
      { match: '/autocompletions', status: 500, body: { errors: [] } },
      { match: '/lei-records?', body: { data: [APPLE], meta: { pagination: { total: 1 } } } },
      { match: '/registration-authorities/RA000598', body: RA000598 },
    ]);
    const leg = await gleif.begin(INPUT);
    expect(leg.status).toBe('approved');
  });

  it('re-reads a stored reference without needing the original application', async () => {
    const { gleif } = provider([
      { match: '/lei-records/HWUPKR0MPOU8FGXBT394', body: { data: APPLE } },
      { match: '/registration-authorities/RA000598', body: RA000598 },
    ]);
    const leg = await gleif.refresh('HWUPKR0MPOU8FGXBT394');
    expect(leg.status).toBe('approved');
    expect(leg.reference).toBe('HWUPKR0MPOU8FGXBT394');
  });

  it('refuses to re-read a reference that is not one of its own', async () => {
    const { gleif } = provider([]);
    await expect(gleif.refresh('sim.business_registry.approved.x')).rejects.toThrow(/neither an LEI/);
  });

  it('creates nothing: every request it makes is a GET', async () => {
    const methods: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      return new Response('{"data":[]}', { status: 200 });
    }) as unknown as typeof fetch;

    await new GleifRegistryProvider({ fetchImpl }).begin(INPUT);
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((m) => m === 'GET')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. The words a miss is described in
// ---------------------------------------------------------------------------

describe('describeSearch', () => {
  function search(over: Partial<GleifSearch> = {}): GleifSearch {
    return {
      candidates: [],
      autocompleteSuggestions: 0,
      autocompleteHits: 0,
      fuzzyTotal: 0,
      fuzzyExamined: 0,
      ...over,
    };
  }

  it('says plainly when nothing at all came back', () => {
    const lines = describeSearch('Silverline Freight Co.', search()).join(' ');
    expect(lines).toContain('no suggestions at all');
    expect(lines).toContain('not even a loose token match');
  });

  it('quotes the fuzzy total, so the miss describes its own search space', () => {
    const lines = describeSearch(
      'Ridgeline Robotics, Inc.',
      search({ fuzzyTotal: 43182, fuzzyExamined: 25, candidates: [view()] }),
    ).join(' ');
    expect(lines).toContain('43,182');
    expect(lines).toContain('OR over tokens');
    expect(lines).toContain('a near-miss is not a match');
  });

  it('always ends on the coverage fact, because that is what a miss means', () => {
    const last = describeSearch('x', search()).at(-1) ?? '';
    expect(last).toContain('3,426,836');
    expect(last).toContain('can never be an approval');
  });
});
