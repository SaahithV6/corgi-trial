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
    expect(selection.registry.provider.name).toBe('stripe-connect');
    expect(evidenceCeiling(selection)).toBe('live');
  });

  it('selects the simulator, and names the missing key, when a key is absent', () => {
    const selection = selectKybLegs({});
    expect(selection.director.mode).toBe('simulated');
    expect(selection.director.provider.name).toBe('simulated-director-kyc');
    expect(selection.director.missingEnv).toEqual([
      KYB_ENV.personaApiKey,
      KYB_ENV.personaInquiryTemplateId,
    ]);
    expect(selection.director.reason).toContain('PERSONA_API_KEY');
    expect(selection.registry.mode).toBe('simulated');
    expect(selection.registry.missingEnv).toEqual([KYB_ENV.stripeSecretKey]);
  });

  it('degrades each leg INDEPENDENTLY', () => {
    // Persona present, Stripe absent: live director KYC, simulated registry.
    const selection = selectKybLegs({
      PERSONA_API_KEY: 'persona_sandbox_key',
      PERSONA_INQUIRY_TEMPLATE_ID: 'itmpl_TEST',
    });
    expect(selection.director.mode).toBe('live');
    expect(selection.registry.mode).toBe('simulated');
    // ...and the deployment as a whole can then only ever claim simulated.
    expect(evidenceCeiling(selection)).toBe('simulated');
  });

  it('treats an empty or whitespace-only key as missing, not as a key', () => {
    const selection = selectKybLegs({ ...LIVE_ENV, STRIPE_SECRET_KEY: '   ' });
    expect(selection.registry.mode).toBe('simulated');
    expect(selection.registry.missingEnv).toEqual([KYB_ENV.stripeSecretKey]);
  });

  it('needs the inquiry template as well as the api key for a live director leg', () => {
    const selection = selectKybLegs({ PERSONA_API_KEY: 'persona_sandbox_key' });
    expect(selection.director.mode).toBe('simulated');
    expect(selection.director.missingEnv).toEqual([KYB_ENV.personaInquiryTemplateId]);
  });

  it('honours the documented escape hatch for a gated registry leg', () => {
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
    // is live regardless of anything else in the environment.
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
    expect(warnings.map((w) => w.record['event'])).toEqual([
      'kyb.leg.simulated',
      'kyb.leg.simulated',
      'kyb.selection',
    ]);
    expect(JSON.stringify(warnings)).toContain('PERSONA_API_KEY');
    expect(JSON.stringify(warnings)).toContain('STRIPE_SECRET_KEY');
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
    announceKybSelection(
      selectKybLegs({ PERSONA_API_KEY: 'k', PERSONA_INQUIRY_TEMPLATE_ID: 'itmpl_TEST' }),
      log,
    );
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
      business_registry: { provider: 'stripe-connect', evidence: 'live' },
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
    const provider = createKybProvider({ env: {}, log });
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
    const report = kybHealthReport({ PERSONA_API_KEY: 'persona_sandbox_key', PERSONA_INQUIRY_TEMPLATE_ID: 'itmpl_TEST' });
    expect(report.evidenceCeiling).toBe('simulated');
    expect(report.legs.map((l) => [l.leg, l.mode])).toEqual([
      ['director_kyc', 'live'],
      ['business_registry', 'simulated'],
    ]);
    expect(report.legs[1]?.missingEnv).toEqual(['STRIPE_SECRET_KEY']);
    expect(JSON.stringify(report)).not.toContain('persona_sandbox_key');
  });

  it('says live only when both legs are live', () => {
    expect(kybHealthReport(LIVE_ENV).evidenceCeiling).toBe('live');
    expect(kybHealthReport({}).evidenceCeiling).toBe('simulated');
  });

  it('agrees with the factory: a leg reported live is the leg that was built', () => {
    // The health endpoint and the factory read the same selection, so they
    // cannot disagree about whether an integration is live.
    for (const env of [LIVE_ENV, {}, { PERSONA_API_KEY: 'k', PERSONA_INQUIRY_TEMPLATE_ID: 't' }]) {
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
