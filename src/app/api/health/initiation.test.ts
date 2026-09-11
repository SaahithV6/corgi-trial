import { describe, expect, it } from 'vitest';

import {
  DELIVERY_VERDICTS,
  webhookDeliveryHealth,
  type DeliveryRead,
  type WebhookDeliveryHealth,
} from '@/lib/integrations/delivery-health';
import type { Liveness } from '@/lib/integrations/probe';

import { ITEM_VERDICTS } from './item-health';
import {
  INITIATION_VERDICTS,
  attributeDeliverySilence,
  initiationUnavailable,
  type InitiationRead,
  type InitiationRow,
} from './initiation';
import { PROCESSING_VERDICTS } from './processing';

/**
 * The fold is pure, so both states below are constructed rather than induced.
 *
 * The numbers are the real ones, measured against the production database at
 * 2026-09-11T17:56Z, because the whole reason this module exists is that a
 * plausible-looking freshness signal reported an OUTAGE on that exact state.
 */

/** The instant the production reading was taken. */
const NOW = new Date('2026-09-11T17:56:36.752Z');

/** `MAX(webhook_inbox.received_at)` for Lithic, production, 489s before NOW. */
const LAST_DELIVERY = new Date('2026-09-11T17:48:27.752Z');

/**
 * Lithic stale, gating, live, verifier registered — all four clauses
 * `delivery-health.ts` needs before silence may degrade the deployment. This is
 * the state production was in.
 */
function staleLithic(): WebhookDeliveryHealth {
  const read: DeliveryRead = {
    ok: true,
    rows: [{ provider: 'lithic', lastDeliveryAt: LAST_DELIVERY }],
    latencyMs: 4,
  };
  return webhookDeliveryHealth(
    read,
    [{ provider: 'lithic', integrationLive: true, verifierRegistered: true }],
    NOW,
  );
}

function row(over: Partial<InitiationRow> = {}): InitiationRow {
  return {
    provider: 'lithic',
    lastDeliveryAt: LAST_DELIVERY,
    initiatedSinceDeliveryCount: 0,
    oldestInitiatedSinceDeliveryAt: null,
    newestInitiatedAt: null,
    initiatedInHorizonCount: 0,
    ...over,
  };
}

function read(...rows: InitiationRow[]): InitiationRead {
  return { ok: true, rows, latencyMs: 2 };
}

const find = <T extends { provider: string }>(list: readonly T[], provider: string): T => {
  const found = list.find((p) => p.provider === provider);
  expect(found, `no report for ${provider}`).toBeDefined();
  return found!;
};

/**
 * (a) TRANSACTIONS INITIATED, NO WEBHOOK. Three ASA decisions landed after the
 *     newest delivery. Each one is a `card_transaction.updated` we are owed.
 *     This is an outage and must degrade.
 */
const TRANSACTIONS_INITIATED = row({
  initiatedSinceDeliveryCount: 3,
  oldestInitiatedSinceDeliveryAt: new Date('2026-09-11T17:50:00.000Z'),
  newestInitiatedAt: new Date('2026-09-11T17:55:00.000Z'),
  initiatedInHorizonCount: 3,
});

/**
 * (b) NO TRANSACTIONS, NO WEBHOOK. The production state: the last ASA decision
 *     was at 17:33:20, fifteen minutes before NOW and BEFORE the newest
 *     delivery at 17:48:27. Nobody has swiped a card since. Nothing is owed.
 */
const NOBODY_TRANSACTED = row({
  initiatedSinceDeliveryCount: 0,
  oldestInitiatedSinceDeliveryAt: null,
  newestInitiatedAt: new Date('2026-09-11T17:33:20.421Z'),
  initiatedInHorizonCount: 70,
});

describe('the two states the old signal could not tell apart', () => {
  it('READS IDENTICALLY without the attribution — this is the defect', () => {
    // `webhookDeliveryHealth` is the old code, unmodified. It is handed the
    // SAME delivery fact in both worlds because that is all it can see: the
    // last webhook was 489s ago. Whether anyone swiped a card in those 489
    // seconds is not an input it has.
    const outage = find(staleLithic().providers, 'lithic');
    const quietThursday = find(staleLithic().providers, 'lithic');

    expect(outage.verdict).toBe('stale');
    expect(quietThursday.verdict).toBe('stale');
    expect(outage.degradesDeployment).toBe(true);
    expect(quietThursday.degradesDeployment).toBe(true);
    // Byte for byte the same reading for an outage and for a quiet afternoon.
    expect(JSON.stringify(outage)).toEqual(JSON.stringify(quietThursday));
  });

  it('(a) transactions initiated, no webhook -> STILL DEGRADES', () => {
    const { delivery, initiation } = attributeDeliverySilence(
      staleLithic(),
      read(TRANSACTIONS_INITIATED),
      NOW,
    );
    const d = find(delivery.providers, 'lithic');
    const i = find(initiation.providers, 'lithic');

    expect(i.verdict).toBe('transacting');
    expect(d.verdict).toBe('stale');
    expect(d.degradesDeployment).toBe(true);
    expect(delivery.degradedBy).toEqual(['lithic']);
    expect(initiation.narrowed).toEqual([]);
    expect(i.initiatedSinceLastDelivery).toBe(3);
    expect(i.oldestUnansweredAgeSeconds).toBe(396);
    expect(i.note).toContain('This silence is loss, not disuse');
    // The sentence the old code wrote is left exactly as it was.
    expect(d.note).toBe('silent for longer than 180s after recent traffic — treated as an outage');
  });

  it('(b) no transactions, no webhook -> DOES NOT DEGRADE', () => {
    const { delivery, initiation } = attributeDeliverySilence(
      staleLithic(),
      read(NOBODY_TRANSACTED),
      NOW,
    );
    const d = find(delivery.providers, 'lithic');
    const i = find(initiation.providers, 'lithic');

    expect(i.verdict).toBe('dormant');
    // The measurement is unchanged and still on the record: the feed really has
    // been silent for 489s. What changed is what that silence is read AS.
    expect(d.verdict).toBe('stale');
    expect(d.secondsSinceLastDelivery).toBe(489);
    expect(d.degradesDeployment).toBe(false);
    expect(delivery.degradedBy).toEqual([]);
    expect(initiation.narrowed).toEqual(['lithic']);
    expect(i.narrowedDeliveryAlarm).toBe(true);
    expect(i.initiatedSinceLastDelivery).toBe(0);
    expect(i.secondsSinceNewestInitiated).toBe(1396);
    expect(d.note).toContain('NOTHING WAS INITIATED in that silence');
  });

  it('the two states now DIFFER, which is the whole fix', () => {
    const a = find(
      attributeDeliverySilence(staleLithic(), read(TRANSACTIONS_INITIATED), NOW).delivery.providers,
      'lithic',
    );
    const b = find(
      attributeDeliverySilence(staleLithic(), read(NOBODY_TRANSACTED), NOW).delivery.providers,
      'lithic',
    );
    expect(a.degradesDeployment).not.toBe(b.degradesDeployment);
  });
});

describe('the threshold is NOT widened', () => {
  it('a real outage during a demo is still caught at 180s, to the second', () => {
    // 181 seconds of silence with one transaction initiated inside it. The
    // banned move — widening `staleAfterSeconds` until the complaint stops —
    // would have missed this by definition.
    const now = new Date('2026-09-11T17:51:28.752Z');
    const delivery = webhookDeliveryHealth(
      { ok: true, rows: [{ provider: 'lithic', lastDeliveryAt: LAST_DELIVERY }], latencyMs: 4 },
      [{ provider: 'lithic', integrationLive: true, verifierRegistered: true }],
      now,
    );
    const attributed = attributeDeliverySilence(
      delivery,
      read(
        row({
          initiatedSinceDeliveryCount: 1,
          oldestInitiatedSinceDeliveryAt: new Date('2026-09-11T17:49:00.000Z'),
          newestInitiatedAt: new Date('2026-09-11T17:49:00.000Z'),
          initiatedInHorizonCount: 1,
        }),
      ),
      now,
    );
    const d = find(attributed.delivery.providers, 'lithic');
    expect(d.secondsSinceLastDelivery).toBe(181);
    expect(d.staleAfterSeconds).toBe(180);
    expect(d.verdict).toBe('stale');
    expect(d.degradesDeployment).toBe(true);
  });

  it('ONE initiation after the last delivery is enough to hold the alarm open', () => {
    // No grace period, no snooze, no state: a single owed delivery keeps it red.
    const { delivery } = attributeDeliverySilence(
      staleLithic(),
      read(
        row({
          initiatedSinceDeliveryCount: 1,
          oldestInitiatedSinceDeliveryAt: new Date('2026-09-11T17:56:30.000Z'),
          newestInitiatedAt: new Date('2026-09-11T17:56:30.000Z'),
          initiatedInHorizonCount: 1,
        }),
      ),
      NOW,
    );
    expect(find(delivery.providers, 'lithic').degradesDeployment).toBe(true);
  });
});

describe('absent evidence reads as the alarm, never as the all-clear', () => {
  it('a failed read is a STATED `uncounted` and narrows nothing', () => {
    const { delivery, initiation } = attributeDeliverySilence(
      staleLithic(),
      initiationUnavailable('database unreachable'),
      NOW,
    );
    expect(initiation.measured).toBe(false);
    expect(initiation.error).toBe('database unreachable');
    expect(initiation.narrowed).toEqual([]);
    const i = find(initiation.providers, 'lithic');
    expect(i.verdict).toBe('uncounted');
    expect(i.initiatedSinceLastDelivery).toBeNull();
    expect(i.note).toContain('cannot tell a provider outage from a quiet card rail');
    expect(find(delivery.providers, 'lithic').degradesDeployment).toBe(true);
    expect(delivery.degradedBy).toEqual(['lithic']);
  });

  it('a missing row is `uncounted`, not a counted zero', () => {
    // The inversion that made the first draft of the dead-letter narrowing
    // wrong one module over: "absent evidence of traffic" must never become
    // "proven quiet".
    const { delivery, initiation } = attributeDeliverySilence(staleLithic(), read(), NOW);
    expect(find(initiation.providers, 'lithic').verdict).toBe('uncounted');
    expect(find(delivery.providers, 'lithic').degradesDeployment).toBe(true);
  });

  it('a count that did not parse is `uncounted`, not zero', () => {
    const { delivery, initiation } = attributeDeliverySilence(
      staleLithic(),
      read(row({ initiatedSinceDeliveryCount: Number.NaN })),
      NOW,
    );
    expect(find(initiation.providers, 'lithic').verdict).toBe('uncounted');
    expect(find(delivery.providers, 'lithic').degradesDeployment).toBe(true);
  });

  it('a provider with no initiation ledger is `unattributable` and keeps its alarm', () => {
    // The allow-list, asserted. If Increase were ever marked as gating, its
    // silence must stay an alarm until somebody names the table that records
    // its traffic — not inherit a `dormant` from a count of a table that does
    // not exist for it.
    const delivery = webhookDeliveryHealth(
      {
        ok: true,
        rows: [{ provider: 'increase', lastDeliveryAt: new Date('2026-09-11T09:00:00.000Z') }],
        latencyMs: 4,
      },
      [{ provider: 'increase', integrationLive: true, verifierRegistered: true }],
      NOW,
    );
    const before = find(delivery.providers, 'increase');
    const { delivery: after, initiation } = attributeDeliverySilence(delivery, read(), NOW);
    const i = find(initiation.providers, 'increase');
    expect(i.verdict).toBe('unattributable');
    expect(i.source).toBeNull();
    expect(initiation.narrowed).toEqual([]);
    // Byte for byte what delivery-health.ts said about it.
    expect(JSON.stringify(find(after.providers, 'increase'))).toEqual(JSON.stringify(before));
  });
});

describe('it only ever subtracts, and only from `stale`', () => {
  it('leaves `quiet` and `never` exactly as delivery-health computed them', () => {
    // Both words are load-bearing and neither degrades anything today, so there
    // is nothing here to narrow — and this module must not blur them.
    const delivery = webhookDeliveryHealth(
      {
        ok: true,
        rows: [
          // 3h of silence on a 3m cadence: past the 15m alarm window.
          { provider: 'lithic', lastDeliveryAt: new Date('2026-09-11T14:56:36.752Z') },
          { provider: 'persona', lastDeliveryAt: null },
        ],
        latencyMs: 4,
      },
      [
        { provider: 'lithic', integrationLive: true, verifierRegistered: true },
        { provider: 'persona', integrationLive: true, verifierRegistered: true },
      ],
      NOW,
    );
    const { delivery: after, initiation } = attributeDeliverySilence(
      delivery,
      read(NOBODY_TRANSACTED),
      NOW,
    );
    expect(find(after.providers, 'lithic').verdict).toBe('quiet');
    expect(find(after.providers, 'persona').verdict).toBe('never');
    expect(initiation.narrowed).toEqual([]);
    expect(JSON.stringify(after.providers)).toEqual(JSON.stringify(delivery.providers));
  });

  it('cannot make anything degrade that was not already degrading', () => {
    // `dormant` on a fresh feed changes nothing: the flag was already false.
    const delivery = webhookDeliveryHealth(
      { ok: true, rows: [{ provider: 'lithic', lastDeliveryAt: NOW }], latencyMs: 4 },
      [{ provider: 'lithic', integrationLive: true, verifierRegistered: true }],
      NOW,
    );
    const { delivery: after, initiation } = attributeDeliverySilence(
      delivery,
      read(TRANSACTIONS_INITIATED),
      NOW,
    );
    expect(find(after.providers, 'lithic').verdict).toBe('fresh');
    expect(after.degradedBy).toEqual([]);
    expect(find(initiation.providers, 'lithic').verdict).toBe('transacting');
    expect(find(initiation.providers, 'lithic').narrowedDeliveryAlarm).toBe(false);
  });

  it('covers every provider the delivery field reports on', () => {
    const { initiation } = attributeDeliverySilence(staleLithic(), read(NOBODY_TRANSACTED), NOW);
    expect(initiation.providers.map((p) => p.provider).sort()).toEqual([
      'increase',
      'lithic',
      'persona',
      'plaid',
      'stripe',
    ]);
  });

  it('never publishes a negative age when the database clock runs ahead', () => {
    const { initiation } = attributeDeliverySilence(
      staleLithic(),
      read(row({ newestInitiatedAt: new Date('2026-09-11T17:57:00.000Z') })),
      NOW,
    );
    expect(find(initiation.providers, 'lithic').secondsSinceNewestInitiated).toBe(0);
  });
});

describe('the vocabulary cannot be mistaken for the other four', () => {
  /**
   * Pinned to `Liveness` by the COMPILER, for the reason `processing.test.ts`
   * records: a hand-copied list of the words a reader might confuse had already
   * drifted once, so the disjointness invariant was being proved against a
   * vocabulary that was no longer the vocabulary.
   */
  const LIVENESS_WORDS = [
    'live',
    'simulated',
    'unauthorised',
    'unreachable',
    'rate_limited',
    'not_configured',
    'unprobed',
  ] as const;
  type Missing = Exclude<Liveness, (typeof LIVENESS_WORDS)[number]>;
  const noLivenessWordIsMissing: Missing extends never ? true : Missing = true;

  it('names every liveness verdict, checked by the compiler', () => {
    expect(noLivenessWordIsMissing).toBe(true);
  });

  it('shares no word with liveness, delivery, processing or item health', () => {
    for (const v of INITIATION_VERDICTS) {
      expect(LIVENESS_WORDS as readonly string[]).not.toContain(v);
      expect(DELIVERY_VERDICTS as readonly string[]).not.toContain(v);
      expect(PROCESSING_VERDICTS as readonly string[]).not.toContain(v);
      expect(ITEM_VERDICTS as readonly string[]).not.toContain(v);
    }
  });

  it('emits no slot and no status field anywhere', () => {
    const { initiation } = attributeDeliverySilence(staleLithic(), read(NOBODY_TRANSACTED), NOW);
    const serialised = JSON.stringify(initiation);
    expect(serialised).not.toContain('"slot"');
    expect(serialised).not.toContain('"status"');
  });
});
