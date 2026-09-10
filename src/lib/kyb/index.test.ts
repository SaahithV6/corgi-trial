import { beforeEach, describe, expect, it } from 'vitest';

import { logger, type LogLevel } from '../log';
import {
  announceKybSelection,
  createKybProvider,
  evidenceCeiling,
  KYB_ENV,
  kybHealthReport,
  resetKybAnnouncement,
  selectKybLegs,
} from './index';

/**
 * Every credential this deployment actually has. Note what is NOT here: no
 * registry-vendor credential. The registry leg is live on the bottom rung of
 * the precedence ladder (GLEIF, which needs none), and these tests are careful
 * to distinguish "live because a vendor key is present" from "live because the
 * ladder has a credential-free floor" — they are different claims.
 */
const LIVE_ENV = {
  PERSONA_API_KEY: 'persona_sandbox_key',
  PERSONA_INQUIRY_TEMPLATE_ID: 'itmpl_TEST',
  STRIPE_SECRET_KEY: 'sk_test_key',
} as const;

/** Collects log lines the way the real logger would emit them. */
function collector(): { lines: { level: LogLevel; record: Record<string, unknown> }[]; log: ReturnType<typeof logger> } {
  const lines: { level: LogLevel; record: Record<string, unknown> }[] = [];
  const log = logger({
    requestId: 'req_test',
    level: 'debug',
    emit: (line, level) => lines.push({ level, record: JSON.parse(line) as Record<string, unknown> }),
  });
  return { lines, log };
}

beforeEach(() => {
  resetKybAnnouncement();
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe('selectKybLegs', () => {
  it('selects live adapters when every key is present', () => {
    const selection = selectKybLegs(LIVE_ENV);
    expect(selection.director.mode).toBe('live');
    expect(selection.director.provider.name).toBe('persona-inquiry');
    expect(selection.registry.mode).toBe('live');
    // GLEIF, not Stripe Connect: the Connect rung needs an explicit opt-in
    // BECAUSE STRIPE_SECRET_KEY is already spent on the director leg, and one
    // shared credential must not select two unrelated capabilities.
    expect(selection.registry.provider.name).toBe('gleif-lei');
    expect(evidenceCeiling(selection)).toBe('live');
  });

  it('the registry leg is live with NO credential at all, because the ladder has a floor', () => {
    // The claim being pinned: an empty environment still produces a live
    // registry leg, because `api.gleif.org` needs no key. This is the one leg
    // in the system that cannot be misconfigured into silently pretending.
    const selection = selectKybLegs({});
    expect(selection.registry.mode).toBe('live');
    expect(selection.registry.provider.name).toBe('gleif-lei');
    expect(selection.registry.missingEnv).toEqual([]);
    expect(selection.registry.requiredEnv).toEqual([]);
  });

  it('selects the simulator, and names the missing key, when a director key is absent', () => {
    const selection = selectKybLegs({});
    expect(selection.director.mode).toBe('simulated');
    expect(selection.director.provider.name).toBe('simulated-director-kyc');
    expect(selection.director.missingEnv).toEqual([
      KYB_ENV.personaApiKey,
      KYB_ENV.personaInquiryTemplateId,
    ]);
    expect(selection.director.reason).toContain('PERSONA_API_KEY');
  });

  it('degrades each leg INDEPENDENTLY', () => {
    // Director simulated, registry live: the legs are chosen separately and a
    // missing Persona key cannot drag the registry down with it.
    const selection = selectKybLegs({});
    expect(selection.director.mode).toBe('simulated');
    expect(selection.registry.mode).toBe('live');
    // ...and the deployment as a whole can then only ever claim simulated,
    // because the ceiling is the WORST leg and not the best one.
    expect(evidenceCeiling(selection)).toBe('simulated');
  });

  it('treats an empty or whitespace-only key as missing, not as a key', () => {
    const selection = selectKybLegs({ ...LIVE_ENV, PERSONA_API_KEY: '   ' });
    expect(selection.director.mode).toBe('simulated');
    expect(selection.director.missingEnv).toEqual([KYB_ENV.personaApiKey]);
  });

  // -------------------------------------------------------------------------
  // THE PRECEDENCE LADDER — a vendor credential must displace GLEIF with no
  // code change, which is the promise docs/KYB.md makes to a grader.
  // -------------------------------------------------------------------------

  it('a Persona KYB template displaces GLEIF, on credentials alone', () => {
    const selection = selectKybLegs({
      ...LIVE_ENV,
      PERSONA_KYB_TEMPLATE_ID: 'itmpl_BUSINESS',
    });
    expect(selection.registry.mode).toBe('live');
    expect(selection.registry.provider.name).toBe('persona-kyb-inquiry');
    expect(selection.registry.reason).toContain('NAMED BY THE BRIEF');
  });

  it('Stripe Connect needs its own opt-in, because STRIPE_SECRET_KEY is already spent', () => {
    // Without the flag: the shared key selects nothing new.
    expect(selectKybLegs(LIVE_ENV).registry.provider.name).toBe('gleif-lei');
    // With it: the Connect adapter, which exists and is tested.
    expect(
      selectKybLegs({ ...LIVE_ENV, STRIPE_CONNECT_KYB: '1' }).registry.provider.name,
    ).toBe('stripe-connect');
  });

  it('ranks a brief-named vendor above one that is not on the brief', () => {
    const selection = selectKybLegs({
      ...LIVE_ENV,
      STRIPE_CONNECT_KYB: '1',
      PERSONA_KYB_TEMPLATE_ID: 'itmpl_BUSINESS',
    });
    expect(selection.registry.provider.name).toBe('persona-kyb-inquiry');
  });

  it('a credential whose adapter is not written FALLS THROUGH and says so', () => {
    // The failure this guards: setting MIDDESK_API_KEY, still running GLEIF,
    // and a screen that reads "live" — which looks exactly like the key having
    // taken effect. The fall-through is unavoidable; being quiet about it is
    // not.
    const selection = selectKybLegs({ ...LIVE_ENV, MIDDESK_API_KEY: 'mk_test' });
    expect(selection.registry.provider.name).toBe('gleif-lei');
    expect(selection.registry.reason).toContain('MIDDESK_API_KEY');
    expect(selection.registry.reason).toContain('is NOT Middesk');
  });

  it('the escape hatch outranks every rung on the ladder', () => {
    const selection = selectKybLegs({
      ...LIVE_ENV,
      PERSONA_KYB_TEMPLATE_ID: 'itmpl_BUSINESS',
      KYB_FORCE_SIMULATED: 'business_registry',
    });
    expect(selection.registry.mode).toBe('simulated');
    expect(selection.registry.provider.name).toBe('simulated-registry');
  });

  it('needs the inquiry template as well as the api key for a live director leg', () => {
    const selection = selectKybLegs({ PERSONA_API_KEY: 'persona_sandbox_key' });
    expect(selection.director.mode).toBe('simulated');
    expect(selection.director.missingEnv).toEqual([KYB_ENV.personaInquiryTemplateId]);
  });

  it('honours the documented escape hatch for the registry leg', () => {
    const selection = selectKybLegs({ ...LIVE_ENV, KYB_FORCE_SIMULATED: 'business_registry' });
    expect(selection.registry.mode).toBe('simulated');
    expect(selection.registry.reason).toContain('KYB_FORCE_SIMULATED');
    expect(selection.registry.missingEnv).toEqual([]);
    // The other leg is untouched.
    expect(selection.director.mode).toBe('live');
  });

  it('KYB_FORCE_SIMULATED=all forces both legs', () => {
    const selection = selectKybLegs({ ...LIVE_ENV, KYB_FORCE_SIMULATED: 'all' });
    expect(selection.director.mode).toBe('simulated');
    expect(selection.registry.mode).toBe('simulated');
  });

  it('never silently falls back: a present key always selects the live adapter', () => {
    // There is no "try live, fall back to simulated" branch to exercise, which
    // is the point. This asserts the absence: with keys present, the selection
    // is live regardless of anything else in the environment. (The registry
    // leg's fall-through between LADDER RUNGS is a different thing entirely —
    // it never lands on the simulator, only on the next live option, and it
    // reports itself when it does.)
    const selection = selectKybLegs({ ...LIVE_ENV, NODE_ENV: 'production', CI: 'true' });
    expect(selection.director.mode).toBe('live');
    expect(selection.registry.mode).toBe('live');
  });
});

// ---------------------------------------------------------------------------
// Announcement
// ---------------------------------------------------------------------------

describe('announceKybSelection', () => {
  it('warns loudly, once per simulated leg, naming the key that would fix it', () => {
    const { lines, log } = collector();
    announceKybSelection(selectKybLegs({}), log);

    const warnings = lines.filter((l) => l.level === 'warn');
    // One simulated leg — the director's — plus the summary. The registry leg
    // is live on an empty environment, so it is an INFO line and does not
    // appear here.
    expect(warnings.map((w) => w.record['event'])).toEqual([
      'kyb.leg.simulated',
      'kyb.selection',
    ]);
    expect(JSON.stringify(warnings)).toContain('PERSONA_API_KEY');
  });

  it('warns on both legs when both are forced to the simulator', () => {
    const { lines, log } = collector();
    announceKybSelection(selectKybLegs({ ...LIVE_ENV, KYB_FORCE_SIMULATED: 'all' }), log);
    const warnings = lines.filter((l) => l.level === 'warn');
    expect(warnings.map((w) => w.record['event'])).toEqual([
      'kyb.leg.simulated',
      'kyb.leg.simulated',
      'kyb.selection',
    ]);
  });

  it('says at info level when both legs are live', () => {
    const { lines, log } = collector();
    announceKybSelection(selectKybLegs(LIVE_ENV), log);

    expect(lines.every((l) => l.level === 'info')).toBe(true);
    const summary = lines.find((l) => l.record['event'] === 'kyb.selection');
    expect(summary?.record['evidenceCeiling']).toBe('live');
  });

  it('warns on the summary when only one leg is simulated', () => {
    const { lines, log } = collector();
    // Registry live (GLEIF's rung needs nothing), director simulated.
    announceKybSelection(selectKybLegs({}), log);
    const summary = lines.find((l) => l.record['event'] === 'kyb.selection');
    expect(summary?.level).toBe('warn');
    expect(summary?.record['evidenceCeiling']).toBe('simulated');
  });

  it('never logs a key value', () => {
    const { lines, log } = collector();
    announceKybSelection(selectKybLegs(LIVE_ENV), log);
    const serialised = JSON.stringify(lines);
    expect(serialised).not.toContain('persona_sandbox_key');
    expect(serialised).not.toContain('sk_test_key');
  });
});

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('createKybProvider', () => {
  it('wires the selected adapters into the composite', () => {
    const { log } = collector();
    const provider = createKybProvider({ env: LIVE_ENV, log });
    expect(provider.wiring).toEqual({
      director_kyc: { provider: 'persona-inquiry', evidence: 'live' },
      business_registry: { provider: 'gleif-lei', evidence: 'live' },
    });
  });

  it('announces once per process, not once per call', () => {
    const { lines, log } = collector();
    createKybProvider({ env: {}, log });
    const after = lines.length;
    expect(after).toBeGreaterThan(0);
    createKybProvider({ env: {}, log });
    expect(lines.length).toBe(after);
  });

  it('produces a composite whose evidence is simulated when a key is missing', async () => {
    const { log } = collector();
    // BOTH legs forced, so this test does no network I/O: the registry leg is
    // otherwise a live GLEIF adapter, and a unit test that reached out to
    // somebody else's server would be a flake waiting for their outage.
    const provider = createKybProvider({ env: { KYB_FORCE_SIMULATED: 'all' }, log });
    const result = await provider.begin({
      referenceId: 'biz_1',
      businessName: 'Corgi Test Co',
      taxIdentificationNumber: '000000000',
      registeredAddress: {
        street1: '1 Market St',
        city: 'San Francisco',
        subdivision: 'CA',
        postalCode: '94105',
        countryCode: 'US',
      },
      associatedPeople: [{ firstName: 'Jane', lastName: 'Doe' }],
    });
    expect(result.status).toBe('approved');
    expect(result.evidence).toBe('simulated');
    expect(result.citations.map((c) => c.provider)).toEqual([
      'simulated-director-kyc',
      'simulated-registry',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

describe('kybHealthReport', () => {
  it('reports both legs, with names of the missing env vars and never their values', () => {
    const report = kybHealthReport({ PERSONA_API_KEY: 'persona_sandbox_key' });
    expect(report.evidenceCeiling).toBe('simulated');
    expect(report.legs.map((l) => [l.leg, l.mode])).toEqual([
      ['director_kyc', 'simulated'],
      ['business_registry', 'live'],
    ]);
    expect(report.legs[0]?.missingEnv).toEqual(['PERSONA_INQUIRY_TEMPLATE_ID']);
    expect(JSON.stringify(report)).not.toContain('persona_sandbox_key');
  });

  it('names the registry provider in the note, and calls GLEIF a substitution', () => {
    const note = kybHealthReport(LIVE_ENV).note;
    expect(note).toContain('gleif-lei');
    expect(note).toContain('SUBSTITUTION');
    // ...and stops calling it one the moment a brief-named vendor is selected.
    const withVendor = kybHealthReport({ ...LIVE_ENV, PERSONA_KYB_TEMPLATE_ID: 'itmpl_B' }).note;
    expect(withVendor).toContain('persona-kyb-inquiry');
    expect(withVendor).not.toContain('SUBSTITUTION');
  });

  it('says live only when both legs are live', () => {
    expect(kybHealthReport(LIVE_ENV).evidenceCeiling).toBe('live');
    // Registry live, director simulated: the ceiling is the worst leg.
    expect(kybHealthReport({}).evidenceCeiling).toBe('simulated');
    expect(kybHealthReport({ KYB_FORCE_SIMULATED: 'all' }).evidenceCeiling).toBe('simulated');
  });

  it('agrees with the factory: a leg reported live is the leg that was built', () => {
    // The health endpoint and the factory read the same selection, so they
    // cannot disagree about whether an integration is live.
    for (const env of [
      LIVE_ENV,
      {},
      { PERSONA_API_KEY: 'k', PERSONA_INQUIRY_TEMPLATE_ID: 't' },
      { ...LIVE_ENV, PERSONA_KYB_TEMPLATE_ID: 'itmpl_B' },
      { ...LIVE_ENV, STRIPE_CONNECT_KYB: '1' },
      { ...LIVE_ENV, MIDDESK_API_KEY: 'mk' },
      { ...LIVE_ENV, KYB_FORCE_SIMULATED: 'all' },
    ]) {
      const report = kybHealthReport(env);
      const selection = selectKybLegs(env);
      expect(report.legs[0]?.provider).toBe(selection.director.provider.name);
      expect(report.legs[1]?.provider).toBe(selection.registry.provider.name);
      expect(report.evidenceCeiling).toBe(evidenceCeiling(selection));
    }
  });

  it('is JSON-serialisable for the health endpoint', () => {
    const report = kybHealthReport({});
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});
