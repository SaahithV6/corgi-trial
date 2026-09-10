/**
 * The selection rule, and the promise that it is never silent.
 *
 * "If INCREASE_API_KEY is absent, the rail factory must select the simulator
 * and say so loudly in logs and in the health endpoint — never silently."
 * Every clause of that sentence has a test here.
 */

import { describe, expect, it } from 'vitest';

import {
  achRailHealth,
  createAchRail,
  SIM_WEBHOOK_SECRET_DEFAULT,
  type EnvBag,
} from './factory';
import { handleControlCommand, parseCommand, AchSimControl } from './control';

interface Line {
  level: 'info' | 'warn';
  event: string;
  fields: Record<string, unknown>;
}

function collector() {
  const lines: Line[] = [];
  return {
    lines,
    logger: {
      info: (event: string, fields?: Record<string, unknown>) =>
        lines.push({ level: 'info', event, fields: fields ?? {} }),
      warn: (event: string, fields?: Record<string, unknown>) =>
        lines.push({ level: 'warn', event, fields: fields ?? {} }),
    },
  };
}

const WITH_KEY: EnvBag = {
  INCREASE_API_KEY: 'sandbox_key_pretend',
  INCREASE_WEBHOOK_SECRET: 'increase-secret',
};
const WITHOUT_KEY: EnvBag = { ACH_SIM_WEBHOOK_SECRET: 'sim-secret' };

describe('selection', () => {
  it('selects the LIVE adapter when INCREASE_API_KEY is present', () => {
    const { logger, lines } = collector();
    const selection = createAchRail({ env: WITH_KEY, logger });
    expect(selection.rail.capabilities.provider).toBe('increase.ach');
    expect(selection.rail.capabilities.evidence).toBe('live');
    expect(selection.health.label).toBe('LIVE');
    expect(selection.engine).toBeNull();
    expect(lines[0]).toMatchObject({ level: 'info', event: 'rails.ach.selected' });
  });

  it('selects the SIMULATOR when INCREASE_API_KEY is absent', () => {
    const { logger, lines } = collector();
    const selection = createAchRail({ env: WITHOUT_KEY, logger });
    expect(selection.rail.capabilities.provider).toBe('achsim.ach');
    expect(selection.rail.capabilities.evidence).toBe('simulated');
    expect(selection.engine).not.toBeNull();

    // LOUDLY: a warn, not an info. A slot that is not live is not a normal
    // condition, and an info line is one someone filters out.
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('warn');
    expect(lines[0]?.event).toBe('rails.ach.simulator_selected');
    expect(String(lines[0]?.fields['reason'])).toMatch(/SIMULATOR/);
    expect(lines[0]?.fields['label']).toBe('SIMULATED');
    expect(lines[0]?.fields['missingEnv']).toEqual(['INCREASE_API_KEY', 'INCREASE_WEBHOOK_SECRET']);
  });

  it('never logs nothing — every path emits exactly one selection line', () => {
    for (const env of [WITH_KEY, WITHOUT_KEY]) {
      const { logger, lines } = collector();
      createAchRail({ env, logger });
      expect(lines).toHaveLength(1);
    }
  });

  it('can be forced to the simulator even with a key, and says why', () => {
    const { logger, lines } = collector();
    const selection = createAchRail({ env: WITH_KEY, logger, force: 'simulator' });
    expect(selection.health.selected).toBe('simulator');
    expect(String(lines[0]?.fields['reason'])).toMatch(/explicitly forced/);
  });

  it('refuses to be forced to live with no key, rather than handing back a rail that throws', () => {
    const { logger } = collector();
    expect(() => createAchRail({ env: WITHOUT_KEY, logger, force: 'live' })).toThrow(
      /INCREASE_API_KEY is not set/,
    );
  });

  it('flags a live selection that cannot verify inbound webhooks', () => {
    const { logger } = collector();
    const selection = createAchRail({
      env: { INCREASE_API_KEY: 'k' },
      logger,
    });
    expect(selection.health.missingEnv).toEqual(['INCREASE_WEBHOOK_SECRET']);
    expect(selection.health.reason).toMatch(/inbound webhooks cannot be verified/);
  });

  it('falls back to an unmistakable simulator secret rather than to the live one', () => {
    expect(SIM_WEBHOOK_SECRET_DEFAULT).toMatch(/not-a-real-secret/);
    const { logger } = collector();
    // No ACH_SIM_WEBHOOK_SECRET set, and a live secret present: the simulator
    // must still not reach for the live one.
    const selection = createAchRail({
      env: { INCREASE_WEBHOOK_SECRET: 'increase-secret' },
      logger,
      force: 'simulator',
    });
    expect(selection.health.evidence).toBe('simulated');
  });
});

describe('health report', () => {
  it('says LIVE with a key and SIMULATED without one', () => {
    expect(achRailHealth(WITH_KEY)).toMatchObject({
      slot: 'ach',
      provider: 'increase.ach',
      selected: 'live_adapter',
      evidence: 'live',
      label: 'LIVE',
    });
    expect(achRailHealth(WITHOUT_KEY)).toMatchObject({
      slot: 'ach',
      provider: 'achsim.ach',
      selected: 'simulator',
      evidence: 'simulated',
      label: 'SIMULATED',
      environment: 'simulator',
    });
  });

  it('explains itself in a sentence an operator can act on', () => {
    expect(achRailHealth(WITHOUT_KEY).reason).toBe(
      'INCREASE_API_KEY is not set, so the ACH slot is served by the SIMULATOR. Nothing it produces is evidence of a real bank transfer.',
    );
  });

  it('names missing env vars but never their values', () => {
    const report = achRailHealth({ INCREASE_API_KEY: 'super-secret-key' });
    expect(report.missingEnv).toEqual(['INCREASE_WEBHOOK_SECRET']);
    expect(JSON.stringify(report)).not.toContain('super-secret-key');
  });

  it('is pure — it constructs no client and touches no network', () => {
    // Called twice with a bag containing nothing; if it tried to build a client
    // or read a global it would throw here.
    expect(achRailHealth({})).toEqual(achRailHealth({}));
  });
});

describe('the control API', () => {
  const control = () =>
    new AchSimControl({ secret: 'sim-secret', liveSecret: 'live-secret', seed: 'control-test' });

  it('labels every response, success and failure alike', async () => {
    const c = control();
    const ok = await handleControlCommand(c, { action: 'status' });
    expect(ok.body).toMatchObject({ evidence: 'simulated', label: 'SIMULATED' });

    const bad = await handleControlCommand(c, { action: 'start', preset: 'nope' });
    expect(bad.httpStatus).toBe(400);
    // A rule with an exception for error responses is a rule with a hole in it.
    expect(bad.body).toMatchObject({ evidence: 'simulated', label: 'SIMULATED' });
  });

  it('runs a preset end to end and reports JSON-safe money', async () => {
    const c = control();
    const started = await handleControlCommand(c, {
      action: 'start',
      preset: 'return_after_settlement',
    });
    const transfer = started.body['transfer'] as Record<string, unknown>;
    // bigint cannot cross a JSON boundary, so amounts are decimal strings.
    expect(transfer['amount']).toEqual({ amount: '12500', currency: 'USD' });
    expect(JSON.stringify(started.body)).toContain('"amount":"12500"');

    const advanced = await handleControlCommand(c, { action: 'advance', ms: 6 * 24 * 3600 * 1000 });
    const delivered = advanced.body['delivered'] as { intent: string }[];
    expect(delivered.map((d) => d.intent)).toContain('returned');
  });

  it('rejects an unknown return code with the list of known ones', async () => {
    const c = control();
    const result = await handleControlCommand(c, {
      action: 'force_return',
      transferId: 'ach_sim_x',
      code: 'R99',
    });
    expect(result.httpStatus).toBe(400);
    expect(result.body['error']).toMatchObject({ code: 'UNKNOWN_RETURN_CODE' });
  });

  it('validates untrusted command bodies rather than trusting the shape', () => {
    expect(parseCommand(null)).toMatchObject({ error: expect.any(String) });
    expect(parseCommand({})).toMatchObject({ error: expect.any(String) });
    expect(parseCommand({ action: 'advance' })).toMatchObject({ error: expect.any(String) });
    expect(parseCommand({ action: 'nonsense' })).toMatchObject({ error: expect.any(String) });
    expect(parseCommand({ action: 'advance', ms: 5 })).toEqual({ action: 'advance', ms: 5 });
    expect(parseCommand({ action: 'status' })).toEqual({ action: 'status' });
  });
});
