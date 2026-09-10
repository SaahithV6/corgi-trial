/**
 * The registry ladder's tests.
 *
 * ===========================================================================
 * WHAT THESE ARE FOR.
 *
 * docs/KYB.md makes a promise to whoever reads it: "to move this leg to Persona
 * KYB, set two environment variables; nothing else changes." A promise like
 * that is worth precisely as much as the test that holds it, because the
 * failure mode is silent — a credential arrives, somebody pastes it in, the
 * screen still says `gleif-lei`, and nobody notices until a grader asks why the
 * vendor they provided is not being used.
 *
 * So these assert the LADDER, not the adapters: that order is order, that a
 * shared credential cannot select two unrelated capabilities, that the escape
 * hatch outranks everything, and — the one that took a bug to learn — that a
 * rung whose credential is present but whose adapter is unwritten falls through
 * NOISILY rather than quietly.
 *
 * No network. Constructing an adapter opens no socket.
 * ===========================================================================
 */

import { describe, expect, it } from 'vitest';

import {
  chooseRegistryProvider,
  REGISTRY_ENV,
  REGISTRY_PRECEDENCE,
  rungForProviderName,
} from './registry-precedence';

const PERSONA_KYB = {
  [REGISTRY_ENV.personaApiKey]: 'persona_sandbox_key',
  [REGISTRY_ENV.personaKybTemplateId]: 'itmpl_BUSINESS',
} as const;

describe('REGISTRY_PRECEDENCE', () => {
  it('puts every vendor the brief names above the registry we substituted in', () => {
    const gleif = REGISTRY_PRECEDENCE.findIndex((r) => r.id === 'gleif');
    for (const rung of REGISTRY_PRECEDENCE.filter((r) => r.onBrief)) {
      expect(REGISTRY_PRECEDENCE.indexOf(rung)).toBeLessThan(gleif);
    }
    // ...and GLEIF is last, which is what makes it a floor under the live
    // options rather than a competitor among them.
    expect(gleif).toBe(REGISTRY_PRECEDENCE.length - 1);
  });

  it('ends on a rung that needs no credential, so the walk cannot fall off', () => {
    const last = REGISTRY_PRECEDENCE[REGISTRY_PRECEDENCE.length - 1];
    expect(last?.requiredEnv).toEqual([]);
    expect(last?.build).not.toBeNull();
  });

  it('every rung with no adapter explains itself, and every rung with one does not', () => {
    for (const rung of REGISTRY_PRECEDENCE) {
      if (rung.build === null) {
        expect(rung.providerName).toBeNull();
        expect(rung.blockedNote, `${rung.id} must say why a set credential did nothing`).not.toBeNull();
        expect(rung.blockedNote).toContain('is NOT ');
      } else {
        expect(rung.providerName, `${rung.id} must name the adapter it builds`).not.toBeNull();
        expect(rung.build({}).name).toBe(rung.providerName);
        expect(rung.build({}).leg).toBe('business_registry');
        expect(rung.build({}).evidence).toBe('live');
      }
    }
  });

  it('names three vendors the brief names, and no more', () => {
    expect(REGISTRY_PRECEDENCE.filter((r) => r.onBrief).map((r) => r.id)).toEqual([
      'persona-kyb',
      'middesk',
      'sumsub',
    ]);
  });
});

describe('chooseRegistryProvider', () => {
  it('falls to GLEIF on an empty environment, with nothing blocked', () => {
    const choice = chooseRegistryProvider({});
    expect(choice.provider.name).toBe('gleif-lei');
    expect(choice.rung.onBrief).toBe(false);
    expect(choice.blocked).toEqual([]);
  });

  it('a Persona KYB template is the whole swap — two variables, no code change', () => {
    const choice = chooseRegistryProvider(PERSONA_KYB);
    expect(choice.provider.name).toBe('persona-kyb-inquiry');
    expect(choice.rung.onBrief).toBe(true);
  });

  it('treats a blank credential as absent, not as a credential', () => {
    const choice = chooseRegistryProvider({ ...PERSONA_KYB, [REGISTRY_ENV.personaKybTemplateId]: '  ' });
    expect(choice.provider.name).toBe('gleif-lei');
  });

  it('needs EVERY variable a rung declares, not just one of them', () => {
    expect(
      chooseRegistryProvider({ [REGISTRY_ENV.personaApiKey]: 'k' }).provider.name,
    ).toBe('gleif-lei');
    expect(
      chooseRegistryProvider({ [REGISTRY_ENV.sumsubAppToken]: 'tok' }).blocked,
    ).toEqual([]);
  });

  it('does not let one shared credential select two unrelated capabilities', () => {
    // STRIPE_SECRET_KEY is already spent on the DIRECTOR leg (Stripe Identity).
    // If the Connect rung matched on it alone, shipping this table would have
    // silently moved the registry leg onto an adapter measured non-functional
    // on this account.
    expect(chooseRegistryProvider({ STRIPE_SECRET_KEY: 'sk_test' }).provider.name).toBe('gleif-lei');
    expect(
      chooseRegistryProvider({ STRIPE_SECRET_KEY: 'sk_test', STRIPE_CONNECT_KYB: '1' }).provider.name,
    ).toBe('stripe-connect');
  });

  it('a vendor named by the brief outranks one that is not', () => {
    const choice = chooseRegistryProvider({
      ...PERSONA_KYB,
      STRIPE_SECRET_KEY: 'sk_test',
      STRIPE_CONNECT_KYB: '1',
    });
    expect(choice.provider.name).toBe('persona-kyb-inquiry');
  });

  it('an unwritten adapter falls through LOUDLY, naming the variable that did nothing', () => {
    const choice = chooseRegistryProvider({ [REGISTRY_ENV.middeskApiKey]: 'mk_test' });
    expect(choice.provider.name).toBe('gleif-lei');
    expect(choice.blocked).toHaveLength(1);
    expect(choice.blocked[0]).toContain(REGISTRY_ENV.middeskApiKey);
    expect(choice.blocked[0]).toContain('is NOT Middesk');
  });

  it('carries EVERY blocked rung, not just the first', () => {
    // Two keys set, two adapters missing, one leg. A reader who set both is
    // owed both explanations.
    const choice = chooseRegistryProvider({
      [REGISTRY_ENV.middeskApiKey]: 'mk',
      [REGISTRY_ENV.sumsubAppToken]: 'tok',
      [REGISTRY_ENV.sumsubSecretKey]: 'sec',
    });
    expect(choice.blocked).toHaveLength(2);
    expect(choice.provider.name).toBe('gleif-lei');
  });

  it('a working rung above a blocked one wins, and the block is still reported', () => {
    const choice = chooseRegistryProvider({ ...PERSONA_KYB, [REGISTRY_ENV.middeskApiKey]: 'mk' });
    // Persona sits ABOVE Middesk, so Middesk is never even reached.
    expect(choice.provider.name).toBe('persona-kyb-inquiry');
    expect(choice.blocked).toEqual([]);
  });

  it('never returns the simulator: forcing is the caller\'s decision, made once per surface', () => {
    for (const env of [{}, PERSONA_KYB, { KYB_FORCE_SIMULATED: 'all' }]) {
      expect(chooseRegistryProvider(env).provider.evidence).toBe('live');
    }
  });
});

describe('rungForProviderName', () => {
  it('maps a recorded provider name back to the rung that chose it', () => {
    expect(rungForProviderName('gleif-lei')?.onBrief).toBe(false);
    expect(rungForProviderName('persona-kyb-inquiry')?.onBrief).toBe(true);
  });

  it('returns undefined for the simulator, which is not on the ladder', () => {
    expect(rungForProviderName('simulated-registry')).toBeUndefined();
    expect(rungForProviderName('gleif-lei-unavailable')).toBeUndefined();
  });
});
