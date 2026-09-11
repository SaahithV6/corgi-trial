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
  probeAchRailHealth,
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
    expect(selection.health.selected).toBe('live_adapter');
    // SELECTED, NOT PROVEN. The key decides which adapter is wired up and that
    // is all it decides: this constructor made no call, so it has no verdict,
    // and `unprobed` is that sentence in one word. It used to say LIVE here,
    // off a non-empty string — the DECISIONS 011 failure, in the factory.
    expect(selection.health.liveness).toBe('unprobed');
    expect(selection.health.label).not.toBe('LIVE');
    expect(selection.health.reason).toMatch(/NOT probed/);
    expect(selection.engine).toBeNull();
    expect(lines[0]).toMatchObject({ level: 'info', event: 'rails.ach.selected' });
    expect(lines[0]?.fields['liveness']).toBe('unprobed');
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
  it('NEVER says LIVE from a key alone — a credential with no round trip is `unprobed`', () => {
    // The regression this file now guards. `achRailHealth` returned
    // `label: 'LIVE'` for any non-empty INCREASE_API_KEY — a placeholder
    // pasted out of .env.example would have done — with no call to Increase,
    // which is liveness by presence: the exact mistake DECISIONS 011 killed
    // and src/lib/integrations/probe.ts exists to prevent.
    expect(achRailHealth(WITH_KEY)).toMatchObject({
      slot: 'ach',
      provider: 'increase.ach',
      // Which adapter is wired up is still decided by the key. That part was
      // always right.
      selected: 'live_adapter',
      // The provider is real...
      evidence: 'live',
      // ...and nothing has been proven about it.
      liveness: 'unprobed',
      label: 'SIMULATED',
    });
    expect(achRailHealth(WITH_KEY).reason).toMatch(/NOT probed/);

    expect(achRailHealth(WITHOUT_KEY)).toMatchObject({
      slot: 'ach',
      provider: 'achsim.ach',
      selected: 'simulator',
      evidence: 'simulated',
      // The simulator is in this process, so `live` is honest here — and
      // `evidence: 'simulated'` keeps the label SIMULATED by construction.
      liveness: 'live',
      label: 'SIMULATED',
      environment: 'simulator',
    });
  });

  it('cannot produce a LIVE label at all, for any environment, because it makes no call', () => {
    const bags: EnvBag[] = [
      WITH_KEY,
      WITHOUT_KEY,
      { INCREASE_API_KEY: 'your_increase_api_key_here' },
      { INCREASE_API_KEY: ' k ', INCREASE_WEBHOOK_SECRET: 's' },
      { INCREASE_API_KEY: 'k', INCREASE_BASE_URL: 'https://api.increase.com' },
    ];
    for (const env of bags) expect(achRailHealth(env).label).toBe('SIMULATED');
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

describe('the verdict that is earned, not assumed', () => {
  /** A fetch that answers with one status and records what it was asked. */
  function stubFetch(status: number): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      fetchImpl: ((url: string | URL | Request, init?: RequestInit) => {
        calls.push(String(url));
        const headers = new Headers(init?.headers);
        // The credential really is presented. A probe that forgot the header
        // would get a 401 from the provider and report `unauthorised`, so the
        // stub must be at least as strict as Increase is.
        if (!(headers.get('authorization') ?? '').startsWith('Bearer ')) {
          return Promise.resolve(new Response('{}', { status: 401 }));
        }
        return Promise.resolve(new Response('{"data":[]}', { status }));
      }) as unknown as typeof fetch,
    };
  }

  it('says LIVE only after Increase answers 200, and names the call that did it', async () => {
    const { fetchImpl, calls } = stubFetch(200);
    const health = await probeAchRailHealth({ env: WITH_KEY, fetchImpl });

    expect(calls).toEqual(['https://sandbox.increase.com/accounts?limit=1']);
    expect(health.liveness).toBe('live');
    expect(health.label).toBe('LIVE');
    expect(health.selected).toBe('live_adapter');
    expect(health.reason).toMatch(/GET \/accounts\?limit=1 -> 200/);
  });

  it('refuses to call a rejected credential live — the pasted-placeholder case', async () => {
    const { fetchImpl } = stubFetch(401);
    const health = await probeAchRailHealth({ env: WITH_KEY, fetchImpl });

    expect(health.liveness).toBe('unauthorised');
    expect(health.label).toBe('SIMULATED');
    expect(health.reason).toMatch(/REFUSED/);
  });

  it('claims nothing when the provider cannot be reached', async () => {
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    const health = await probeAchRailHealth({ env: WITH_KEY, fetchImpl });

    expect(health.liveness).toBe('unreachable');
    expect(health.label).toBe('SIMULATED');
    // Never LIVE, and never a throw: a probe that throws takes the health
    // surface down with it.
    expect(health.reason).toMatch(/we do not claim/);
  });

  it('separates a rationed reading from a failed one', async () => {
    const { fetchImpl } = stubFetch(429);
    const health = await probeAchRailHealth({ env: WITH_KEY, fetchImpl });

    expect(health.liveness).toBe('rate_limited');
    expect(health.label).toBe('SIMULATED');
  });

  it('probes the simulator too, and the simulator still cannot read LIVE', async () => {
    const health = await probeAchRailHealth({ env: WITHOUT_KEY });

    expect(health.selected).toBe('simulator');
    expect(health.liveness).toBe('live');
    expect(health.label).toBe('SIMULATED');
    expect(health.reason).toMatch(/Nothing it produces is evidence of a real bank transfer/);
  });

  it('keeps the env-only facts the round trip has no opinion about', async () => {
    const { fetchImpl } = stubFetch(200);
    const health = await probeAchRailHealth({ env: { INCREASE_API_KEY: 'k' }, fetchImpl });

    // A working credential does not conjure a webhook secret.
    expect(health.missingEnv).toEqual(['INCREASE_WEBHOOK_SECRET']);
    expect(JSON.stringify(health)).not.toContain('"k"');
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
