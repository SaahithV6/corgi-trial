/**
 * The honesty tests.
 *
 * The first one is the important one and it is deliberately awkward: it
 * verifies a chaos delivery with `lithicVerifier` — THE PRODUCTION VERIFIER
 * FACTORY, imported from `src/lib/webhooks/inbox.ts` — rather than with a
 * re-implementation of the scheme. If the receiving path ever grew a
 * chaos-shaped branch, this test would keep passing while the claim it stands
 * for became false, so it is written the only way that cannot happen: chaos
 * signs, production verifies, and nothing in between belongs to chaos.
 *
 * The rest assert the three anti-forgery layers, one test each, because they
 * are three independent claims and passing one does not earn the others.
 */

import { describe, expect, it } from 'vitest';

import { lithicVerifier } from '@/lib/webhooks/inbox';

import {
  assertNotAProviderSecret,
  chaosSecret,
  chaosWebhookId,
  ChaosSecretMisuseError,
  CHAOS_WEBHOOK_SECRET_DEFAULT,
  CHAOS_WEBHOOK_SECRET_ENV,
  signChaosDelivery,
} from './sign';
import { CHAOS_EVENT_ID_PREFIX } from './types';

const SECRET = CHAOS_WEBHOOK_SECRET_DEFAULT;

function headerLookup(headers: Readonly<Record<string, string>>): (name: string) => string | null {
  return (name) => headers[name.toLowerCase()] ?? null;
}

describe('chaos deliveries go through the production verifier', () => {
  it('is accepted by lithicVerifier when signed with the chaos key', async () => {
    const signed = signChaosDelivery({
      secret: SECRET,
      webhookId: chaosWebhookId('11112222-3333-4444-5555-666677778888', 0),
      body: { event_type: 'card_transaction.updated', token: 't', corgi_chaos: { origin: 'x' } },
    });

    const verifier = lithicVerifier({ secret: SECRET });
    const outcome = await verifier.verify({
      raw: signed.rawBody,
      headers: headerLookup(signed.headers),
      now: new Date(),
    });

    expect(outcome.ok).toBe(true);
  });

  it('is REFUSED by a verifier holding any other key — the whole point', async () => {
    const signed = signChaosDelivery({
      secret: SECRET,
      webhookId: chaosWebhookId('11112222-3333-4444-5555-666677778888', 0),
      body: { event_type: 'card_transaction.updated' },
    });

    // Stands in for LITHIC_WEBHOOK_SECRET: the deployed /api/webhooks/lithic
    // route holds Lithic's own subscription secret and will answer 401 to
    // everything chaos signs, for ever. That is the property, not a limitation
    // to be worked around.
    const lithicsOwnKey = lithicVerifier({ secret: 'whsec_bm90LXRoZS1jaGFvcy1rZXk=' });
    const outcome = await lithicsOwnKey.verify({
      raw: signed.rawBody,
      headers: headerLookup(signed.headers),
      now: new Date(),
    });

    expect(outcome.ok).toBe(false);
  });

  it('identifies the row by the chaos key space, which is the inbox dedupe key', () => {
    const signed = signChaosDelivery({
      secret: SECRET,
      webhookId: chaosWebhookId('11112222-3333-4444-5555-666677778888', 1),
      body: {},
    });
    const identity = lithicVerifier({ secret: SECRET }).identify({
      raw: signed.rawBody,
      headers: headerLookup(signed.headers),
      payload: JSON.parse(signed.rawBody) as unknown,
    });
    // `provider_event_id` IS the webhook id for Lithic, so the id key space
    // lands in half of UNIQUE (provider, provider_event_id).
    expect(identity.providerEventId.startsWith(CHAOS_EVENT_ID_PREFIX)).toBe(true);
  });
});

describe('the marker cannot be stripped from a delivery that still verifies', () => {
  it('breaks the signature when the marker is removed', async () => {
    const body = {
      corgi_chaos: { origin: 'corgi-chaos-mode', run_id: 'r', control: '', note: 'n' },
      event_type: 'card_transaction.updated',
      token: 't',
    };
    const signed = signChaosDelivery({ secret: SECRET, webhookId: chaosWebhookId('abcd', 0), body });

    const stripped = JSON.parse(signed.rawBody) as Record<string, unknown>;
    delete stripped['corgi_chaos'];
    const forged = JSON.stringify(stripped);

    const outcome = await lithicVerifier({ secret: SECRET }).verify({
      raw: forged,
      // Same headers, same signature — only the marker is gone.
      headers: headerLookup(signed.headers),
      now: new Date(),
    });

    expect(outcome.ok).toBe(false);
  });
});

describe('the refusal', () => {
  it('refuses to sign with a provider secret', () => {
    expect(() =>
      assertNotAProviderSecret('shared-with-lithic', { LITHIC_WEBHOOK_SECRET: 'shared-with-lithic' }),
    ).toThrow(ChaosSecretMisuseError);
  });

  it('names the variable it was handed, so the fix is obvious', () => {
    expect(() =>
      assertNotAProviderSecret('same', { INCREASE_WEBHOOK_SECRET: 'same' }),
    ).toThrow(/INCREASE_WEBHOOK_SECRET/);
  });

  it('refuses an empty secret rather than signing with zero bytes', () => {
    expect(() => assertNotAProviderSecret('   ', {})).toThrow(ChaosSecretMisuseError);
  });

  it('ignores a provider variable that is absent or blank', () => {
    expect(() =>
      assertNotAProviderSecret(SECRET, { LITHIC_WEBHOOK_SECRET: '', PERSONA_WEBHOOK_SECRET: undefined }),
    ).not.toThrow();
  });

  it('applies the refusal when resolving from the environment', () => {
    expect(() =>
      chaosSecret({ [CHAOS_WEBHOOK_SECRET_ENV]: 'collide', STRIPE_WEBHOOK_SECRET: 'collide' }),
    ).toThrow(ChaosSecretMisuseError);
  });

  it('falls back to the loudly-named default when nothing is configured', () => {
    expect(chaosSecret({})).toBe(CHAOS_WEBHOOK_SECRET_DEFAULT);
  });

  it('refuses a webhook id outside the chaos key space', () => {
    expect(() =>
      signChaosDelivery({ secret: SECRET, webhookId: 'msg_looks_like_lithic', body: {} }),
    ).toThrow(ChaosSecretMisuseError);
  });
});

describe('duplicate copies are the same delivery, not a similar one', () => {
  it('gives every copy of a slot the same webhook id', () => {
    // `chaosWebhookId` takes no copy index. If it ever did, N duplicates would
    // become N distinct facts and the replay suppression they are meant to
    // demonstrate would be suppressing nothing.
    expect(chaosWebhookId('run-1', 0)).toBe(chaosWebhookId('run-1', 0));
    expect(chaosWebhookId('run-1', 0)).not.toBe(chaosWebhookId('run-1', 1));
  });
});
