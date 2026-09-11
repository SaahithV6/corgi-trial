/**
 * The planner's tests: four controls, four claims, and one about the gate.
 *
 * Pure, so every interesting property of chaos mode is provable without a
 * database, a signature or a network — which is the reason `plan.ts` was
 * separated from `driver.ts` in the first place.
 */

import { describe, expect, it } from 'vitest';

import { describePlan, isDue, planDeliveries } from './plan';
import type { ActiveControl, ChaosControl, ChaosParams } from './types';

const RUN = '11112222-3333-4444-5555-666677778888';
const NOW = new Date('2026-09-11T12:00:00.000Z');

function armed(control: ChaosControl, params: Record<string, unknown> = {}): ActiveControl {
  return {
    control,
    armedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
    armedBy: 'test',
    secondsRemaining: 300,
    params: { control, ...params } as unknown as ChaosParams,
  };
}

describe('no controls', () => {
  it('plans the lifecycle in order, once each, both due now', () => {
    const plan = planDeliveries({ runId: RUN, now: NOW, active: [] });
    expect(plan.map((p) => p.step)).toEqual(['authorization', 'clearing']);
    expect(plan.every((p) => p.copyIndex === 0)).toBe(true);
    expect(plan.every((p) => p.plannedAt.getTime() === NOW.getTime())).toBe(true);
    expect(plan.every((p) => !p.withheld)).toBe(true);
  });
});

describe('settlement_delay — timing', () => {
  it('moves the clearing into the future and leaves the authorisation alone', () => {
    const plan = planDeliveries({
      runId: RUN,
      now: NOW,
      active: [armed('settlement_delay', { seconds: 45 })],
    });
    const auth = plan.find((p) => p.step === 'authorization');
    const clearing = plan.find((p) => p.step === 'clearing');
    expect(auth?.plannedAt.getTime()).toBe(NOW.getTime());
    expect(clearing?.plannedAt.getTime()).toBe(NOW.getTime() + 45_000);
  });

  it('records which control shaped the delivery', () => {
    const plan = planDeliveries({
      runId: RUN,
      now: NOW,
      active: [armed('settlement_delay', { seconds: 10 })],
    });
    expect(plan.find((p) => p.step === 'clearing')?.shapedBy).toContain('settlement_delay');
    // A late settlement is late. It is not a late everything.
    expect(plan.find((p) => p.step === 'authorization')?.shapedBy).toEqual([]);
  });
});

describe('duplicate_delivery — multiplicity', () => {
  it('fans each slot out into N copies', () => {
    const plan = planDeliveries({
      runId: RUN,
      now: NOW,
      active: [armed('duplicate_delivery', { copies: 3 })],
    });
    expect(plan).toHaveLength(6);
    expect(plan.filter((p) => p.step === 'authorization').map((p) => p.copyIndex)).toEqual([0, 1, 2]);
  });

  it('gives every copy of a slot THE SAME webhook id — the whole demonstration', () => {
    // This is what hands the suppression to `webhook_inbox`'s
    // UNIQUE (provider, provider_event_id). If the ids differed, the inbox
    // would accept all three and chaos would have proved nothing.
    const plan = planDeliveries({
      runId: RUN,
      now: NOW,
      active: [armed('duplicate_delivery', { copies: 4 })],
    });
    const auths = plan.filter((p) => p.step === 'authorization');
    expect(new Set(auths.map((p) => p.webhookId)).size).toBe(1);
    const clearings = plan.filter((p) => p.step === 'clearing');
    expect(new Set(clearings.map((p) => p.webhookId)).size).toBe(1);
    // …and the two slots are still different facts.
    expect(auths[0]?.webhookId).not.toBe(clearings[0]?.webhookId);
  });

  it('clamps a nonsensical copy count rather than fanning out for ever', () => {
    const plan = planDeliveries({
      runId: RUN,
      now: NOW,
      active: [armed('duplicate_delivery', { copies: 9_999 })],
    });
    expect(plan.length).toBeLessThanOrEqual(18);
  });
});

describe('reorder_window — order', () => {
  it('delivers the settlement BEFORE the authorisation it belongs to', () => {
    const plan = planDeliveries({
      runId: RUN,
      now: NOW,
      active: [armed('reorder_window', { seconds: 20 })],
    });
    expect(plan.map((p) => p.step)).toEqual(['clearing', 'authorization']);
  });

  it('makes the reversal observable in wall-clock time, not only in an index', () => {
    const plan = planDeliveries({
      runId: RUN,
      now: NOW,
      active: [armed('reorder_window', { seconds: 20 })],
    });
    expect(plan[0]?.plannedAt.getTime()).toBe(NOW.getTime());
    expect(plan[1]?.plannedAt.getTime()).toBe(NOW.getTime() + 20_000);
  });

  it('still reverses when the settlement delay is also armed', () => {
    // The delay decides how late; the buffer decides the order. Both armed is
    // a legitimate demo, and the schedule must stay coherent.
    const plan = planDeliveries({
      runId: RUN,
      now: NOW,
      active: [armed('settlement_delay', { seconds: 60 }), armed('reorder_window', { seconds: 5 })],
    });
    expect(plan.map((p) => p.step)).toEqual(['clearing', 'authorization']);
    expect(plan[0]?.plannedAt.getTime()).toBeLessThan(plan[1]?.plannedAt.getTime() ?? 0);
  });
});

describe('webhooks_off — availability', () => {
  it('withholds everything, and plans it anyway', () => {
    const plan = planDeliveries({ runId: RUN, now: NOW, active: [armed('webhooks_off')] });
    // The deliveries EXIST. That is what makes turning the switch off a
    // provider coming back rather than a cancellation.
    expect(plan).toHaveLength(2);
    expect(plan.every((p) => p.withheld)).toBe(true);
  });

  it('applies to whatever the other three produced', () => {
    const plan = planDeliveries({
      runId: RUN,
      now: NOW,
      active: [armed('webhooks_off'), armed('duplicate_delivery', { copies: 2 })],
    });
    expect(plan).toHaveLength(4);
    expect(plan.every((p) => p.withheld)).toBe(true);
  });
});

describe('the release gate', () => {
  const row = { plannedAt: NOW, outcome: 'withheld' };

  it('holds everything while webhooks are off, however overdue', () => {
    const later = new Date(NOW.getTime() + 10 * 60_000);
    expect(isDue(row, { now: later, webhooksOff: true })).toBe(false);
  });

  it('releases the backlog the moment the switch goes off — no sweeper', () => {
    const later = new Date(NOW.getTime() + 10 * 60_000);
    expect(isDue(row, { now: later, webhooksOff: false })).toBe(true);
  });

  it('does not release a delivery before its planned instant', () => {
    const early = new Date(NOW.getTime() - 1_000);
    expect(isDue(row, { now: early, webhooksOff: false })).toBe(false);
  });

  it('never releases a delivery that has already left', () => {
    expect(isDue({ plannedAt: NOW, outcome: 'accepted' }, { now: NOW, webhooksOff: false })).toBe(
      false,
    );
  });
});

describe('the schedule reads as English', () => {
  it('describes what a grader just pressed', () => {
    const plan = planDeliveries({
      runId: RUN,
      now: NOW,
      active: [armed('reorder_window', { seconds: 20 }), armed('duplicate_delivery', { copies: 3 })],
    });
    expect(describePlan(plan)).toBe('clearing immediately (3x), then authorization +20s (3x)');
  });

  it('says so when nothing can leave', () => {
    const plan = planDeliveries({ runId: RUN, now: NOW, active: [armed('webhooks_off')] });
    expect(describePlan(plan)).toContain('all withheld, webhooks are off');
  });
});
