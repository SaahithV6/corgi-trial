import { describe, expect, it } from 'vitest';

import { findStatusContradictions } from '@/app/api/health/consistency.test';
import { WEBHOOK_INTEGRATIONS } from '@/lib/webhooks/route-handler';

import {
  DELIVERY_THRESHOLDS,
  DELIVERY_VERDICTS,
  deliveriesUnavailable,
  quietAfterSeconds,
  readWebhookDeliveries,
  webhookDeliveryHealth,
  type DeliveryRead,
  type DeliverySql,
  type ProviderDeliveryContext,
} from './delivery-health';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = new Date('2026-09-10T20:00:00.000Z');

/** `now` minus n seconds. */
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

function read(rows: Record<string, Date | null>): DeliveryRead {
  return {
    ok: true,
    rows: Object.entries(rows).map(([provider, lastDeliveryAt]) => ({ provider, lastDeliveryAt })),
    latencyMs: 71,
  };
}

/** Every provider live and verified — the state the deployment aims at. */
const ALL_WIRED: readonly ProviderDeliveryContext[] = WEBHOOK_INTEGRATIONS.map((i) => ({
  provider: i.provider,
  integrationLive: true,
  verifierRegistered: true,
}));

function providerNamed(doc: ReturnType<typeof webhookDeliveryHealth>, provider: string) {
  const found = doc.providers.find((p) => p.provider === provider);
  if (found === undefined) throw new Error(`no report for ${provider}`);
  return found;
}

// ---------------------------------------------------------------------------
// 1. The table covers the catalogue
// ---------------------------------------------------------------------------

describe('the threshold table and the webhook catalogue', () => {
  it('covers exactly the providers that can deliver webhooks', () => {
    // Adding a sixth provider without a threshold must fail here rather than
    // going silently unmonitored, which is the failure mode this whole field
    // exists to remove.
    expect(Object.keys(DELIVERY_THRESHOLDS).sort()).toEqual(
      WEBHOOK_INTEGRATIONS.map((i) => i.provider).sort(),
    );
  });

  it('gives Lithic the shortest threshold and it alone gates the deployment', () => {
    const gating = Object.entries(DELIVERY_THRESHOLDS)
      .filter(([, t]) => t.gatesDeploymentStatus)
      .map(([p]) => p);
    expect(gating).toEqual(['lithic']);

    const lithic = DELIVERY_THRESHOLDS['lithic'];
    expect(lithic).toBeDefined();
    for (const [provider, threshold] of Object.entries(DELIVERY_THRESHOLDS)) {
      if (provider === 'lithic') continue;
      expect(threshold.staleAfterSeconds).toBeGreaterThan(lithic!.staleAfterSeconds);
    }
  });

  it('makes the gating threshold short enough to see a five-minute silence', () => {
    // The concrete scenario: the feed is silenced for five minutes and the
    // outage must be visible INSIDE that window, not at its edge.
    expect(DELIVERY_THRESHOLDS['lithic']!.staleAfterSeconds).toBeLessThan(5 * 60);
  });
});

// ---------------------------------------------------------------------------
// 2. never is not stale
// ---------------------------------------------------------------------------

describe('never versus stale', () => {
  it("reads `never` for a provider that has never delivered, not `stale`", () => {
    const doc = webhookDeliveryHealth(read({}), ALL_WIRED, NOW);
    for (const p of doc.providers) {
      expect(p.verdict).toBe('never');
      expect(p.lastDelivery).toBeNull();
      expect(p.secondsSinceLastDelivery).toBeNull();
    }
    expect(doc.degradedBy).toEqual([]);
  });

  it('treats a null MAX(received_at) row the same as an absent row', () => {
    const doc = webhookDeliveryHealth(read({ lithic: null }), ALL_WIRED, NOW);
    expect(providerNamed(doc, 'lithic').verdict).toBe('never');
  });

  it('never degrades the deployment on `never`, even for the gating provider', () => {
    // A deployment must not be born degraded because a feed has not been used
    // yet: an alarm that is on from first boot is not an alarm.
    const doc = webhookDeliveryHealth(read({}), ALL_WIRED, NOW);
    expect(providerNamed(doc, 'lithic').degradesDeployment).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. The verdicts
// ---------------------------------------------------------------------------

describe('verdicts', () => {
  it('reports a recent delivery as fresh with the real lag in seconds', () => {
    const doc = webhookDeliveryHealth(read({ lithic: ago(42) }), ALL_WIRED, NOW);
    const lithic = providerNamed(doc, 'lithic');
    expect(lithic.verdict).toBe('fresh');
    expect(lithic.secondsSinceLastDelivery).toBe(42);
    expect(lithic.lastDelivery).toBe(ago(42).toISOString());
    expect(lithic.degradesDeployment).toBe(false);
  });

  it('is fresh exactly at the threshold and stale one second past it', () => {
    const at = DELIVERY_THRESHOLDS['lithic']!.staleAfterSeconds;
    expect(providerNamed(webhookDeliveryHealth(read({ lithic: ago(at) }), ALL_WIRED, NOW), 'lithic').verdict).toBe(
      'fresh',
    );
    expect(
      providerNamed(webhookDeliveryHealth(read({ lithic: ago(at + 1) }), ALL_WIRED, NOW), 'lithic').verdict,
    ).toBe('stale');
  });

  it('degrades the deployment when the live card rail goes stale after traffic', () => {
    // The graders silence Lithic for five minutes. This is that.
    const doc = webhookDeliveryHealth(read({ lithic: ago(5 * 60) }), ALL_WIRED, NOW);
    const lithic = providerNamed(doc, 'lithic');
    expect(lithic.verdict).toBe('stale');
    expect(lithic.degradesDeployment).toBe(true);
    expect(doc.degradedBy).toEqual(['lithic']);
  });

  it('falls back to `quiet` once silence stops being evidence, and stops alarming', () => {
    // Nobody swiped a card since this morning. This must NOT read as an
    // outage, or the endpoint is red all afternoon and nobody reads it again.
    // Measured against production, the first version of this window reported
    // the deployment degraded 18 minutes after the last card event.
    const quietAt = quietAfterSeconds(DELIVERY_THRESHOLDS['lithic']!.staleAfterSeconds);
    expect(
      providerNamed(webhookDeliveryHealth(read({ lithic: ago(quietAt) }), ALL_WIRED, NOW), 'lithic')
        .verdict,
    ).toBe('stale');
    const doc = webhookDeliveryHealth(read({ lithic: ago(quietAt + 1) }), ALL_WIRED, NOW);
    const lithic = providerNamed(doc, 'lithic');
    expect(lithic.verdict).toBe('quiet');
    expect(lithic.degradesDeployment).toBe(false);
    expect(doc.degradedBy).toEqual([]);
  });

  it('keeps the alarm band short enough that an idle afternoon is not an outage', () => {
    // 18 minutes of no card traffic is an idle rail, not a dead one.
    const doc = webhookDeliveryHealth(read({ lithic: ago(18 * 60) }), ALL_WIRED, NOW);
    expect(providerNamed(doc, 'lithic').verdict).toBe('quiet');
    expect(doc.degradedBy).toEqual([]);
  });

  it('does not let a quiet sandbox provider degrade anything', () => {
    const doc = webhookDeliveryHealth(
      read({
        lithic: ago(10),
        persona: ago(30 * 24 * 3600),
        stripe: ago(30 * 24 * 3600),
        plaid: ago(30 * 24 * 3600),
        increase: ago(30 * 24 * 3600),
      }),
      ALL_WIRED,
      NOW,
    );
    expect(doc.degradedBy).toEqual([]);
    for (const p of ['persona', 'stripe', 'plaid', 'increase']) {
      expect(providerNamed(doc, p).verdict).toBe('quiet');
      expect(providerNamed(doc, p).degradesDeployment).toBe(false);
    }
  });

  it('floors a future-dated delivery at zero rather than publishing a negative lag', () => {
    const doc = webhookDeliveryHealth(
      read({ lithic: new Date(NOW.getTime() + 30_000) }),
      ALL_WIRED,
      NOW,
    );
    expect(providerNamed(doc, 'lithic').secondsSinceLastDelivery).toBe(0);
    expect(providerNamed(doc, 'lithic').verdict).toBe('fresh');
  });
});

// ---------------------------------------------------------------------------
// 4. What the field refuses to alarm on
// ---------------------------------------------------------------------------

describe('the gate on the top-level status', () => {
  const stale = read({ lithic: ago(5 * 60) });

  it('will not degrade on a provider the probe has not proven live', () => {
    // Silence from an integration that is not live is already reported, once,
    // by the slot table. Saying it again here is DECISIONS 021 in a new hat.
    const context = ALL_WIRED.map((c) =>
      c.provider === 'lithic' ? { ...c, integrationLive: false } : c,
    );
    const doc = webhookDeliveryHealth(stale, context, NOW);
    expect(providerNamed(doc, 'lithic').verdict).toBe('stale');
    expect(providerNamed(doc, 'lithic').degradesDeployment).toBe(false);
    expect(doc.degradedBy).toEqual([]);
  });

  it('will not degrade when no verifier is registered — that silence is ours', () => {
    const context = ALL_WIRED.map((c) =>
      c.provider === 'lithic' ? { ...c, verifierRegistered: false } : c,
    );
    const doc = webhookDeliveryHealth(stale, context, NOW);
    expect(providerNamed(doc, 'lithic').degradesDeployment).toBe(false);
  });

  it('will not degrade on a provider missing from the context entirely', () => {
    const doc = webhookDeliveryHealth(stale, [], NOW);
    expect(providerNamed(doc, 'lithic').degradesDeployment).toBe(false);
  });

  it('still REPORTS the staleness in every one of those cases', () => {
    // Refusing to alarm is not the same as refusing to say. The verdict is
    // data; only `degradesDeployment` is the alarm.
    for (const context of [
      ALL_WIRED.map((c) => (c.provider === 'lithic' ? { ...c, integrationLive: false } : c)),
      ALL_WIRED.map((c) => (c.provider === 'lithic' ? { ...c, verifierRegistered: false } : c)),
      [],
    ]) {
      const doc = webhookDeliveryHealth(stale, context, NOW);
      expect(providerNamed(doc, 'lithic').verdict).toBe('stale');
      expect(providerNamed(doc, 'lithic').secondsSinceLastDelivery).toBe(300);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. A failed read is a stated unknown, never a fabricated verdict
// ---------------------------------------------------------------------------

describe('when the query fails', () => {
  it('reports every provider as `unknown` and says why', () => {
    const doc = webhookDeliveryHealth(
      deliveriesUnavailable('database unreachable: connect ETIMEDOUT'),
      ALL_WIRED,
      NOW,
    );
    expect(doc.measured).toBe(false);
    expect(doc.error).toBe('database unreachable: connect ETIMEDOUT');
    expect(doc.providers.map((p) => p.verdict)).toEqual(doc.providers.map(() => 'unknown'));
    expect(doc.degradedBy).toEqual([]);
  });

  it('never invents a lag it did not measure', () => {
    const doc = webhookDeliveryHealth(deliveriesUnavailable('nope'), ALL_WIRED, NOW);
    for (const p of doc.providers) {
      expect(p.lastDelivery).toBeNull();
      expect(p.secondsSinceLastDelivery).toBeNull();
      expect(p.degradesDeployment).toBe(false);
    }
  });

  it('turns a throwing client into a failed read rather than a throw', async () => {
    const boom = (() => {
      throw new Error('connection terminated');
    }) as unknown as DeliverySql;
    const result = await readWebhookDeliveries(boom, 50);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('connection terminated');
  });

  it('gives up inside its own budget rather than spending the route’s', async () => {
    const hang = (() => new Promise(() => {})) as unknown as DeliverySql;
    const started = Date.now();
    const result = await readWebhookDeliveries(hang, 60);
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('exceeded 60ms');
  });
});

// ---------------------------------------------------------------------------
// 6. One query, and rows read defensively
// ---------------------------------------------------------------------------

describe('the read', () => {
  it('asks for every provider in a single round trip', async () => {
    let calls = 0;
    let text = '';
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls += 1;
      text = strings.join('?');
      expect(values[0]).toEqual(Object.keys(DELIVERY_THRESHOLDS));
      return Promise.resolve([{ provider: 'lithic', last_delivery_at: ago(10) }]);
    }) as unknown as DeliverySql;

    const result = await readWebhookDeliveries(sql);
    expect(calls).toBe(1);
    expect(text).toContain('webhook_inbox');
    expect(text).toContain('max(w.received_at)');
    expect(result.ok).toBe(true);
  });

  it('coerces timestamps the driver hands back as strings', async () => {
    const sql = (() =>
      Promise.resolve([
        { provider: 'lithic', last_delivery_at: '2026-09-10T19:59:00.000Z' },
        { provider: 'stripe', last_delivery_at: null },
        { provider: 'plaid', last_delivery_at: 'not a date' },
      ])) as unknown as DeliverySql;

    const result = await readWebhookDeliveries(sql);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const doc = webhookDeliveryHealth(result, ALL_WIRED, NOW);
    expect(providerNamed(doc, 'lithic').secondsSinceLastDelivery).toBe(60);
    expect(providerNamed(doc, 'stripe').verdict).toBe('never');
    // An unparseable instant is not evidence of a delivery.
    expect(providerNamed(doc, 'plaid').verdict).toBe('never');
  });
});

// ---------------------------------------------------------------------------
// 7. THE CONSISTENCY INVARIANT — this field must not be a second opinion
// ---------------------------------------------------------------------------

describe('the health document still has exactly one answer per slot', () => {
  /**
   * The vocabulary `/api/health` uses for LIVENESS. Sources: `SlotStatus` in
   * env.schema.ts and `Liveness` in probe.ts.
   */
  const LIVENESS_WORDS = [
    'live',
    'simulated',
    'unauthorised',
    'unreachable',
    'not_configured',
  ] as const;

  it('uses a verdict vocabulary disjoint from the liveness vocabulary', () => {
    // This is the structural reason the field cannot contradict the slot
    // table: there is no string a reader could mistake for a liveness verdict.
    for (const verdict of DELIVERY_VERDICTS) {
      expect(LIVENESS_WORDS).not.toContain(verdict);
    }
  });

  it('emits no `slot` and no `status` key, so nothing keys off the slot table', () => {
    const doc = webhookDeliveryHealth(read({ lithic: ago(5 * 60) }), ALL_WIRED, NOW);
    for (const p of doc.providers) {
      expect(Object.keys(p)).not.toContain('slot');
      expect(Object.keys(p)).not.toContain('status');
      expect(Object.keys(p)).not.toContain('liveness');
    }
  });

  it('lets a provider be live AND stale at once without contradicting anything', () => {
    // The whole point of the field. A working credential and a dead feed are
    // two independent facts, and the outage lives in the gap between them.
    const webhookHealth = webhookDeliveryHealth(read({ lithic: ago(5 * 60) }), ALL_WIRED, NOW);
    const doc = {
      integrations: {
        slots: [
          { slot: 'card_issuing', status: 'live' },
          { slot: 'card_webhooks', status: 'live' },
        ],
        webhooks: [
          {
            slots: [
              { slot: 'card_issuing', status: 'live' },
              { slot: 'card_webhooks', status: 'live' },
            ],
          },
        ],
        webhookHealth,
      },
    };
    expect(findStatusContradictions(doc)).toEqual([]);
    expect(providerNamed(webhookHealth, 'lithic').verdict).toBe('stale');
  });

  it('still catches a real contradiction when the field is present', () => {
    // Proving the checker was not simply blinded by the new field.
    const doc = {
      integrations: {
        slots: [{ slot: 'business_registry', status: 'simulated' }],
        webhooks: [{ slots: [{ slot: 'business_registry', status: 'live' }] }],
        webhookHealth: webhookDeliveryHealth(read({ stripe: ago(10) }), ALL_WIRED, NOW),
      },
    };
    expect(findStatusContradictions(doc)).toEqual([
      "business_registry: authoritative='simulated' but nested='live'",
    ]);
  });
});
