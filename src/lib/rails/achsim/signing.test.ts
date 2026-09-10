/**
 * The most load-bearing test in this package.
 *
 * It verifies a SIMULATED delivery using the PRODUCTION verifier — the real
 * `increaseVerifier` and the real generic `standardWebhooksVerifier` out of
 * `src/lib/webhooks/inbox.ts`, not a copy, not a stub. If the simulator's
 * signatures were subtly different from Increase's, this test fails and the
 * claim "the receiving code path is identical" is falsified automatically
 * rather than by someone noticing during a demo.
 *
 * It then proves the other half: that the label cannot be forged. A simulated
 * delivery does NOT verify against the Increase shared secret, the marker lives
 * inside the signed bytes, and the signer refuses to be constructed with the
 * live secret at all.
 */

import { describe, expect, it } from 'vitest';

import {
  increaseVerifier,
  toHeaderLookup,
  type VerifyOutcome,
  type WebhookVerifier,
} from '../../webhooks/inbox';
import {
  achsimVerifier,
  SIMULATED_MARKER,
  SimulatedSecretMisuseError,
  WebhookSigner,
} from './signing';

const SIM_SECRET = 'achsim-test-secret';
const LIVE_SECRET = 'increase-shared-secret-pretend';

const signer = new WebhookSigner({ secret: SIM_SECRET, liveSecret: LIVE_SECRET });

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'evt_sim_abc123',
    type: 'event',
    category: 'ach_transfer.updated',
    associated_object_id: 'ach_sim_deadbeef',
    associated_object_type: 'ach_transfer',
    created_at: '2026-01-06T14:00:00.000Z',
    [SIMULATED_MARKER]: true,
    ...overrides,
  });
}

async function verify(
  verifier: WebhookVerifier,
  raw: string,
  headers: Record<string, string>,
  now: Date,
): Promise<VerifyOutcome> {
  return verifier.verify({ raw, headers: toHeaderLookup(headers), now });
}

describe('the simulator signs exactly the way Increase does', () => {
  it('a simulated delivery verifies with the PRODUCTION Standard Webhooks verifier', async () => {
    const now = new Date('2026-09-09T12:00:00Z');
    const timestamp = Math.floor(now.getTime() / 1000);
    const raw = body();
    const delivery = signer.sign('evt_sim_abc123', timestamp, raw);

    // The real verifier, with the simulator's own secret and provider name.
    // Nothing about it was written for the simulator; it is
    // `standardWebhooksVerifier` from the inbox with two arguments.
    const outcome = await verify(achsimVerifier({ secret: SIM_SECRET }), delivery.rawBody, {
      ...delivery.headers,
    }, now);
    expect(outcome).toEqual({ ok: true });
  });

  it('produces the v1,<base64> shape over `id.timestamp.rawBody`', () => {
    const delivery = signer.sign('evt_sim_abc123', 1_757_419_200, body());
    const signature = delivery.headers['webhook-signature'] ?? '';
    expect(signature.startsWith('v1,')).toBe(true);
    expect(delivery.headers['webhook-id']).toBe('evt_sim_abc123');
    expect(delivery.headers['webhook-timestamp']).toBe('1757419200');
    // Base64 of a SHA-256 digest is always 44 chars with padding.
    expect(signature.slice(3)).toHaveLength(44);
  });

  it('is rejected by the production verifier if a single byte of the body changes', async () => {
    const now = new Date('2026-09-09T12:00:00Z');
    const timestamp = Math.floor(now.getTime() / 1000);
    const delivery = signer.sign('evt_sim_abc123', timestamp, body());

    const tampered = delivery.rawBody.replace('ach_sim_deadbeef', 'ach_sim_deadbeee');
    const outcome = await verify(
      achsimVerifier({ secret: SIM_SECRET }),
      tampered,
      { ...delivery.headers },
      now,
    );
    expect(outcome.ok).toBe(false);
  });

  it('honours the replay window the inbox enforces', async () => {
    // Signed two hours ago. The 300s tolerance rejects it — which is exactly
    // why `signingTime: 'wall'` exists for deliveries sent over real HTTP.
    const now = new Date('2026-09-09T12:00:00Z');
    const stale = Math.floor(now.getTime() / 1000) - 7200;
    const delivery = signer.sign('evt_sim_abc123', stale, body());
    const outcome = await verify(
      achsimVerifier({ secret: SIM_SECRET }),
      delivery.rawBody,
      { ...delivery.headers },
      now,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.reason).toMatch(/too old/);
  });
});

describe('the label cannot be forged', () => {
  it('LAYER 1 — the marker is inside the signed bytes', async () => {
    const now = new Date('2026-09-09T12:00:00Z');
    const timestamp = Math.floor(now.getTime() / 1000);
    const delivery = signer.sign('evt_sim_abc123', timestamp, body());

    expect(JSON.parse(delivery.rawBody)).toMatchObject({ [SIMULATED_MARKER]: true });

    // Strip the marker to make it look real, and the signature no longer
    // verifies. Keep the signature, and the marker is still there. There is no
    // third option, and that is the whole argument.
    const stripped = JSON.stringify(
      Object.fromEntries(
        Object.entries(JSON.parse(delivery.rawBody) as Record<string, unknown>).filter(
          ([key]) => key !== SIMULATED_MARKER,
        ),
      ),
    );
    expect(stripped).not.toContain(SIMULATED_MARKER);
    const outcome = await verify(
      achsimVerifier({ secret: SIM_SECRET }),
      stripped,
      { ...delivery.headers },
      now,
    );
    expect(outcome.ok).toBe(false);
  });

  it('LAYER 2 — a simulated delivery does NOT verify as a real Increase one', async () => {
    const now = new Date('2026-09-09T12:00:00Z');
    const timestamp = Math.floor(now.getTime() / 1000);
    const delivery = signer.sign('evt_sim_abc123', timestamp, body());

    // The same bytes, presented to the `increase` provider's verifier with
    // Increase's own shared secret. Forging a live delivery would require that
    // secret; the simulator does not have it and refuses to accept it.
    const outcome = await verify(
      increaseVerifier({ secret: LIVE_SECRET }),
      delivery.rawBody,
      { ...delivery.headers },
      now,
    );
    expect(outcome.ok).toBe(false);
  });

  it('LAYER 2b — the signer refuses to be constructed with the live secret', () => {
    expect(() => new WebhookSigner({ secret: LIVE_SECRET, liveSecret: LIVE_SECRET })).toThrow(
      SimulatedSecretMisuseError,
    );
    // Whitespace is not a loophole.
    expect(() => new WebhookSigner({ secret: ` ${LIVE_SECRET} `, liveSecret: LIVE_SECRET })).toThrow(
      SimulatedSecretMisuseError,
    );
    expect(() => new WebhookSigner({ secret: '', liveSecret: undefined })).toThrow(
      SimulatedSecretMisuseError,
    );
    // A genuinely different secret is fine.
    expect(() => new WebhookSigner({ secret: SIM_SECRET, liveSecret: LIVE_SECRET })).not.toThrow();
  });

  it('LAYER 3 — ids live in their own key space', () => {
    const delivery = signer.sign('evt_sim_abc123', 1_757_419_200, body());
    // A row filed from this delivery has a provider_event_id that begins
    // `evt_sim_`, so a simulated event is distinguishable in the inbox, the
    // ledger and any log line by its PRIMARY DATA, not only by a flag some
    // consumer might forget to read.
    expect(delivery.webhookId.startsWith('evt_sim_')).toBe(true);
  });
});
