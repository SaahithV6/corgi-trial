import { describe, expect, it } from 'vitest';

import { DELIVERY_VERDICTS } from '@/lib/integrations/delivery-health';
import type { Liveness } from '@/lib/integrations/probe';

import {
  PROCESSING_VERDICTS,
  processingUnavailable,
  webhookProcessingHealth,
  type ProcessingRead,
  type ProcessingRow,
} from './processing';

/**
 * The fold is pure, so every branch is reachable from here rather than only
 * from an outage. The numbers in `the Increase case` are the real ones,
 * measured against the production database at 2026-09-11T05:20Z, because the
 * whole reason this module exists is that a plausible-looking freshness signal
 * reported `fresh` on that exact state.
 */

const NOW = new Date('2026-09-11T05:20:00.000Z');

function row(over: Partial<ProcessingRow> = {}): ProcessingRow {
  return {
    provider: 'increase',
    lastConsumedAt: null,
    lastDeliveryAt: null,
    parkedCount: 0,
    parkedOldestAt: null,
    deadCount: 0,
    deadNewestAt: null,
    deadOldestAt: null,
    deadReason: null,
    deadSinceConsumedCount: 0,
    ...over,
  };
}

function read(...rows: ProcessingRow[]): ProcessingRead {
  return { ok: true, rows, latencyMs: 3 };
}

const find = (health: ReturnType<typeof webhookProcessingHealth>, provider: string) => {
  const found = health.providers.find((p) => p.provider === provider);
  expect(found, `no report for ${provider}`).toBeDefined();
  return found!;
};

describe('the vocabulary cannot be mistaken for the other two', () => {
  /**
   * Literal, and pinned to `Liveness` by the COMPILER — `delivery-health.test.ts`
   * records why: a hand-copied list of the words a reader might confuse had
   * already drifted, so the disjointness invariant was being proved against a
   * vocabulary that was no longer the vocabulary. `Missing` is `never` only
   * while every member of the union appears below, so adding a liveness verdict
   * and forgetting this file fails `pnpm typecheck` instead of silently
   * narrowing the check. The import is type-only, so nothing here loads
   * `probe.ts` at runtime — it parses the environment on import and CI has no
   * secrets.
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

  it('shares no word with liveness or with delivery freshness', () => {
    // The structural reason a reader never has to reconcile the three fields:
    // no string in one vocabulary appears in another, so `live` + `fresh` +
    // `dropping` reads as three answers to three questions.
    for (const v of PROCESSING_VERDICTS) {
      expect(LIVENESS_WORDS as readonly string[]).not.toContain(v);
      expect(DELIVERY_VERDICTS as readonly string[]).not.toContain(v);
    }
  });
});

describe('the Increase case — received everything, processed nothing', () => {
  // 179 deliveries accepted and dead-lettered; the newest arrived at 04:46:06
  // and was dead-lettered at 05:00:29. `MAX(received_at)` is 1,834s old, well
  // inside Increase's 6h freshness threshold, so the old signal said `fresh`.
  const increase = row({
    provider: 'increase',
    lastConsumedAt: new Date('2026-09-11T04:27:13.572Z'),
    lastDeliveryAt: new Date('2026-09-11T04:46:06.024Z'),
    deadCount: 179,
    deadNewestAt: new Date('2026-09-11T05:00:29.349Z'),
    deadOldestAt: new Date('2026-09-11T03:58:18.202Z'),
    deadReason: "dead-lettered after 8 failed attempts: no consumer registered for provider 'increase'",
    // Every one of them died AFTER the last thing we consumed. At 05:20 that
    // was the truth, and it is why this must still read `dropping`: nothing had
    // got through since, so there was no evidence the pipeline worked.
    deadSinceConsumedCount: 179,
  });

  it('reads `dropping`, not fresh', () => {
    const health = webhookProcessingHealth(read(increase), NOW);
    expect(find(health, 'increase').verdict).toBe('dropping');
  });

  it('degrades the deployment even though Increase does not gate freshness', () => {
    // `gatesDeploymentStatus` is false for Increase in DELIVERY_THRESHOLDS —
    // ACH is a batch rail and its silence is not an outage. Loss is not
    // silence, so it must not inherit that exemption.
    const health = webhookProcessingHealth(read(increase), NOW);
    expect(find(health, 'increase').degradesDeployment).toBe(true);
    expect(health.degradedBy).toContain('increase');
  });

  it('publishes the consumed instant and the dead-letter reason, not just a verdict', () => {
    const r = find(webhookProcessingHealth(read(increase), NOW), 'increase');
    expect(r.lastConsumed).toBe('2026-09-11T04:27:13.572Z');
    expect(r.secondsSinceLastConsumed).toBe(3166);
    expect(r.deadLettered.count).toBe(179);
    expect(r.deadLettered.reason).toContain('no consumer registered');
    // The arrival instant is still published beside it: the two together are
    // the diagnosis, and dropping either one hides half of it.
    expect(r.lastDelivery).toBe('2026-09-11T04:46:06.024Z');
  });
});

describe('the other branches', () => {
  it('a rail consuming inside its cadence reads `consuming` and degrades nothing', () => {
    const health = webhookProcessingHealth(
      read(
        row({
          provider: 'lithic',
          lastConsumedAt: new Date('2026-09-11T05:19:00.000Z'),
          lastDeliveryAt: new Date('2026-09-11T05:19:00.000Z'),
        }),
      ),
      NOW,
    );
    const r = find(health, 'lithic');
    expect(r.verdict).toBe('consuming');
    expect(r.degradesDeployment).toBe(false);
  });

  it('deliveries arriving with no consumer that has ever run reads `never_consumed` and degrades', () => {
    const health = webhookProcessingHealth(
      read(row({ provider: 'increase', lastDeliveryAt: new Date('2026-09-11T05:19:00.000Z') })),
      NOW,
    );
    const r = find(health, 'increase');
    expect(r.verdict).toBe('never_consumed');
    expect(r.degradesDeployment).toBe(true);
  });

  it('parked deliveries read `backlogged` and deliberately do NOT degrade', () => {
    // Parking is a designed state with a retry behind it. It is the early
    // warning for a drop, not the drop.
    const health = webhookProcessingHealth(
      read(
        row({
          provider: 'lithic',
          lastConsumedAt: new Date('2026-09-11T05:19:00.000Z'),
          lastDeliveryAt: new Date('2026-09-11T05:19:00.000Z'),
          parkedCount: 57,
          parkedOldestAt: new Date('2026-09-11T04:00:00.000Z'),
        }),
      ),
      NOW,
    );
    const r = find(health, 'lithic');
    expect(r.verdict).toBe('backlogged');
    expect(r.degradesDeployment).toBe(false);
    expect(r.parked.count).toBe(57);
  });

  it('an old dead letter outside the alarm window stops being an alarm', () => {
    // Lithic's cadence is 3m, so the window is 15m. A drop from yesterday is
    // history: it is still reported in the counts, and it no longer degrades.
    // It reads `superseded` rather than `consuming` because 18 unbooked
    // deliveries are a fact worth a word of its own — the feed being healthy
    // does not make them disappear.
    const health = webhookProcessingHealth(
      read(
        row({
          provider: 'lithic',
          lastConsumedAt: new Date('2026-09-11T05:19:00.000Z'),
          lastDeliveryAt: new Date('2026-09-11T05:19:00.000Z'),
          deadCount: 18,
          deadNewestAt: new Date('2026-09-10T23:59:42.218Z'),
          deadOldestAt: new Date('2026-09-10T16:34:34.552Z'),
          deadReason: 'referent never arrived',
          deadSinceConsumedCount: 0,
        }),
      ),
      NOW,
    );
    const r = find(health, 'lithic');
    expect(r.verdict).toBe('superseded');
    expect(r.degradesDeployment).toBe(false);
    expect(r.deadLettered.count).toBe(18);
    expect(r.deadLettered.supersededByConsumption).toBe(true);
  });

  describe('"dying now" versus "died once and was never cleared"', () => {
    /** The state the 167 Increase dead letters were actually in at 09:04Z. */
    const cleared = row({
      provider: 'increase',
      // Consumed 33 seconds ago; the newest death was two and a half hours
      // before that. The consumer demonstrably works.
      lastConsumedAt: new Date('2026-09-11T05:19:30.000Z'),
      lastDeliveryAt: new Date('2026-09-11T05:19:30.000Z'),
      deadCount: 167,
      deadNewestAt: new Date('2026-09-11T04:46:06.024Z'),
      deadOldestAt: new Date('2026-09-11T03:58:18.202Z'),
      deadReason: "dead-lettered after 8 failed attempts: no consumer registered for provider 'increase'",
      deadSinceConsumedCount: 0,
    });

    it('does NOT degrade the deployment when every death predates a later success', () => {
      // This is the whole fix. The newest death is 2,034s old — well inside
      // Increase's 30h alarm window — so recency alone still calls it
      // `dropping`, and the deployment reads `degraded` for a fault that was
      // fixed hours ago and can never be un-fixed by waiting.
      const health = webhookProcessingHealth(read(cleared), NOW);
      const r = find(health, 'increase');
      expect(r.verdict).toBe('superseded');
      expect(r.degradesDeployment).toBe(false);
      expect(health.degradedBy).not.toContain('increase');
    });

    it('still publishes the rows in full, so a cleared alarm is not a hidden one', () => {
      const r = find(webhookProcessingHealth(read(cleared), NOW), 'increase');
      expect(r.deadLettered.count).toBe(167);
      expect(r.deadLettered.sinceLastConsumed).toBe(0);
      expect(r.deadLettered.supersededByConsumption).toBe(true);
      expect(r.deadLettered.reason).toContain('no consumer registered');
      expect(r.deadLettered.clearedBy).toBe('node scripts/redrive.mjs --apply');
      expect(r.note).toContain('redrive');
    });

    it('comes straight back the moment ONE delivery dies after a success', () => {
      // No acknowledge button, no snooze, no state: one unsuperseded death and
      // the alarm is live again, even while the provider is consuming.
      const r = find(
        webhookProcessingHealth(
          read(row({ ...cleared, deadSinceConsumedCount: 1, deadNewestAt: new Date('2026-09-11T05:19:50.000Z') })),
          NOW,
        ),
        'increase',
      );
      expect(r.verdict).toBe('dropping');
      expect(r.degradesDeployment).toBe(true);
      expect(r.deadLettered.supersededByConsumption).toBe(false);
      expect(r.note).toContain('1 of 167');
    });

    it('a provider that never consumed anything counts every death as current', () => {
      // The `-infinity` coalesce in the query, asserted at the fold: a feed
      // with no successes must not read `superseded` — there is nothing for
      // its deaths to be superseded BY.
      const r = find(
        webhookProcessingHealth(
          read(
            row({
              provider: 'plaid',
              lastDeliveryAt: new Date('2026-09-11T05:19:00.000Z'),
              deadCount: 4,
              deadNewestAt: new Date('2026-09-11T05:10:00.000Z'),
              deadOldestAt: new Date('2026-09-11T05:00:00.000Z'),
              deadSinceConsumedCount: 4,
            }),
          ),
          NOW,
        ),
        'plaid',
      );
      expect(r.verdict).toBe('dropping');
      expect(r.degradesDeployment).toBe(true);
    });

    it('never claims a time it has not measured', () => {
      // The old note said "the newest just now" on every dropping row,
      // including one whose newest dead letter was 8,123 seconds old.
      const r = find(
        webhookProcessingHealth(
          read(row({ ...cleared, deadSinceConsumedCount: 167, deadNewestAt: new Date('2026-09-11T03:04:37.000Z') })),
          NOW,
        ),
        'increase',
      );
      expect(r.verdict).toBe('dropping');
      expect(r.note).toContain('8123s ago');
      expect(r.note).not.toContain('just now');
    });
  });

  it('a feed with nothing to consume reads `idle`', () => {
    const health = webhookProcessingHealth(read(row({ provider: 'persona' })), NOW);
    const r = find(health, 'persona');
    expect(r.verdict).toBe('idle');
    expect(r.degradesDeployment).toBe(false);
  });

  it('a failed read is a STATED unmeasured, never a fabricated verdict', () => {
    const health = webhookProcessingHealth(processingUnavailable('database unreachable'), NOW);
    expect(health.measured).toBe(false);
    expect(health.error).toBe('database unreachable');
    expect(health.degradedBy).toEqual([]);
    for (const p of health.providers) {
      expect(p.verdict).toBe('unmeasured');
      expect(p.degradesDeployment).toBe(false);
    }
  });

  it('covers every provider in the shared threshold table, not only the ones with rows', () => {
    const health = webhookProcessingHealth(read(), NOW);
    expect(health.providers.map((p) => p.provider).sort()).toEqual([
      'increase',
      'lithic',
      'persona',
      'plaid',
      'stripe',
    ]);
  });

  it('never publishes a negative age when the database clock runs ahead', () => {
    const health = webhookProcessingHealth(
      read(
        row({
          provider: 'lithic',
          lastConsumedAt: new Date('2026-09-11T05:21:00.000Z'),
          lastDeliveryAt: new Date('2026-09-11T05:21:00.000Z'),
        }),
      ),
      NOW,
    );
    expect(find(health, 'lithic').secondsSinceLastConsumed).toBe(0);
  });
});

describe('it cannot become a second opinion about liveness', () => {
  it('emits no slot and no status field anywhere', () => {
    const health = webhookProcessingHealth(read(row({ provider: 'increase' })), NOW);
    const serialised = JSON.stringify(health);
    expect(serialised).not.toContain('"slot"');
    expect(serialised).not.toContain('"status"');
  });
});
