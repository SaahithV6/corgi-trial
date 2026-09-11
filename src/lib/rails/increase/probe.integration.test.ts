/**
 * The ONE Increase operation that has been run against Increase.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS SUITE TALKS TO THE REAL INCREASE SANDBOX. It reads, and only reads: │
 * │ two authenticated GETs, no POST, no transfer, no money. It is gated on   │
 * │ RUN_LIVE_PROBES=1 AND on INCREASE_API_KEY being present, so CI — which   │
 * │ holds neither — skips rather than fails. Run it with:                    │
 * │                                                                          │
 * │   set -a; . ./.env; set +a; RUN_LIVE_PROBES=1 pnpm vitest run \          │
 * │     src/lib/rails/increase/probe.integration.test.ts                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * WHY THIS FILE EXISTS. `INCREASE_SUPPORT.probe` in ../adapters/ach.ts is the
 * only cell in the Increase row of the capability matrix that says `measured`
 * rather than `unexercised`, and `measured` is a claim about a call somebody
 * made. A claim whose only evidence is a paragraph decays the moment the key
 * is rotated or the account is closed. This is that call, in the repo, runnable
 * by anyone holding the credential — so the matrix cell can be re-earned in
 * eight seconds instead of believed.
 *
 * WHAT IT DOES NOT EARN, AND THE DISTINCTION IS THE WHOLE POINT.
 * `originate`, `observe`, `settle` and `reverse` stay `unexercised`. Reading
 * `/accounts` proves the credential authenticates and the host answers; it
 * proves nothing whatsoever about whether `POST /ach_transfers` maps our
 * `TransferRequest` correctly, whether the settlement promotion fires, or
 * whether an R01 arrives shaped the way `research/ach/NOTES.md` guessed. A
 * probe that was allowed to promote its neighbours would be liveness by
 * presence wearing a round trip as a disguise.
 */

import { describe, expect, it } from 'vitest';

import { increaseAchAdapter } from '../adapters/ach';
import { IncreaseAchRail, INCREASE_SANDBOX_BASE_URL } from './client';

const KEY = process.env['INCREASE_API_KEY'] ?? '';
const RUN = process.env['RUN_LIVE_PROBES'] === '1' && KEY !== '';

const suite = RUN ? describe : describe.skip;

suite('the Increase ACH probe, against Increase', () => {
  const adapter = (): ReturnType<typeof increaseAchAdapter> =>
    increaseAchAdapter({
      rail: new IncreaseAchRail({}),
      env: { INCREASE_API_KEY: KEY, INCREASE_BASE_URL: INCREASE_SANDBOX_BASE_URL },
    });

  it('earns `live` from a real authenticated round trip, and names the call', async () => {
    const probe = await adapter().probe({ timeoutMs: 15_000 });

    expect(probe.liveness).toBe('live');
    // Both halves. A real provider AND a successful call.
    expect(probe.label).toBe('LIVE');
    expect(probe.evidence).toBe('live');
    expect(probe.provider).toBe('increase.ach');
    // The detail is the evidence, so it must name the call, not summarise it.
    expect(probe.detail).toBe('GET /accounts?limit=1 -> 200');
    expect(probe.ms).toBeGreaterThan(0);
    expect(Date.parse(probe.checkedAt)).not.toBeNaN();
  });

  it('is refused, not believed, when the credential is wrong', async () => {
    // The placeholder case, run for real: a well-formed key Increase has never
    // issued. It is non-empty, so every presence check in the repo would have
    // called it LIVE. Increase answers 401 and the verdict is `unauthorised`.
    const bogus = increaseAchAdapter({
      rail: new IncreaseAchRail({}),
      env: {
        INCREASE_API_KEY: 'not_a_real_increase_key_0000000000',
        INCREASE_BASE_URL: INCREASE_SANDBOX_BASE_URL,
      },
    });
    const probe = await bogus.probe({ timeoutMs: 15_000 });

    expect(probe.liveness).toBe('unauthorised');
    expect(probe.label).toBe('SIMULATED');
  });

  it('declares probe `measured` and every other Increase operation `unexercised`', () => {
    const supports = adapter().supports;
    // The matrix in docs/RAILS.md is generated from exactly these values, so
    // this is the assertion that keeps the published table honest.
    expect(supports.probe).toMatchObject({ supported: true, proof: 'measured' });
    for (const op of ['originate', 'observe', 'settle', 'reverse'] as const) {
      expect(supports[op]).toMatchObject({ supported: true, proof: 'unexercised' });
    }
  });
});
