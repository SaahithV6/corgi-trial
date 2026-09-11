/**
 * The narrowing has to still fire on a real drop.
 *
 * `deadletters.ts` exists to take 90 rows OUT of an alarm. That is exactly the
 * shape of change this repo has been burned by, so the tests that matter here
 * are not the ones proving a refusal is recognised — they are the ones proving
 * every other way a delivery can die is still a `fault`, including the two
 * that are deliberately built to look like refusals.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  deadLetterCause,
  faultDeathSql,
  isRefusalDeath,
  refusalDeathSql,
  type DeadLetterCounters,
} from './deadletters';
import {
  ConsumerRegistry,
  DEFAULT_RETRY_POLICY,
  dispatchOnce,
  parked,
  type WebhookConsumer,
} from './dispatch';
import { createMemoryInboxStore, type InboxStore } from './inbox';

const P = DEFAULT_RETRY_POLICY;

function row(over: Partial<DeadLetterCounters>): DeadLetterCounters {
  return { attempts: 0, parkAttempts: 0, parkedOnRef: null, ...over };
}

describe('deadLetterCause', () => {
  it('calls an exhausted park ladder a refusal', () => {
    // The production shape: 12 parks, a named referent, a handful of pickups
    // that were not parks, nowhere near the failure budget.
    expect(
      deadLetterCause(row({ attempts: 13, parkAttempts: 12, parkedOnRef: 'card:abc' })),
    ).toBe('refusal');
    expect(
      deadLetterCause(row({ attempts: 16, parkAttempts: 12, parkedOnRef: 'card:abc' })),
    ).toBe('refusal');
  });

  // -------------------------------------------------------------------------
  // Everything below is a DROP. Every one of these must stay `fault`.
  // -------------------------------------------------------------------------

  it('calls "no consumer registered" a fault — it never parks at all', () => {
    // The 167-delivery outage this endpoint was written for. park_attempts 0.
    expect(deadLetterCause(row({ attempts: 8, parkAttempts: 0, parkedOnRef: null }))).toBe(
      'fault',
    );
  });

  it('calls a consumer that threw to exhaustion a fault', () => {
    expect(
      deadLetterCause(row({ attempts: P.maxFailedAttempts, parkAttempts: 0, parkedOnRef: null })),
    ).toBe('fault');
  });

  it('calls a row that parked its full ladder AND THEN blew the failure budget a fault', () => {
    // The hole the third clause exists for. `unparkWaitingFor` deliberately
    // does not clear `parked_on_ref`, so a row can carry a full ladder and a
    // referent and still have died of eight real failures afterwards. That is
    // a drop, and it must not hide behind the park counters.
    expect(
      deadLetterCause(
        row({
          attempts: P.maxParkAttempts + P.maxFailedAttempts,
          parkAttempts: P.maxParkAttempts,
          parkedOnRef: 'card:abc',
        }),
      ),
    ).toBe('fault');
  });

  it('calls a partial park ladder a fault — the ladder did not run out', () => {
    expect(
      deadLetterCause(
        row({ attempts: 20, parkAttempts: P.maxParkAttempts - 1, parkedOnRef: 'card:abc' }),
      ),
    ).toBe('fault');
  });

  it('calls a full ladder with no named referent a fault', () => {
    expect(
      deadLetterCause(row({ attempts: 13, parkAttempts: P.maxParkAttempts, parkedOnRef: null })),
    ).toBe('fault');
  });

  it('is exactly on the failure-budget boundary, in both directions', () => {
    const at = (failures: number): DeadLetterCounters =>
      row({
        attempts: P.maxParkAttempts + failures,
        parkAttempts: P.maxParkAttempts,
        parkedOnRef: 'card:abc',
      });
    expect(isRefusalDeath(at(P.maxFailedAttempts - 1))).toBe(true);
    expect(isRefusalDeath(at(P.maxFailedAttempts))).toBe(false);
  });

  it('honours a policy that is not the default', () => {
    const policy = { ...P, maxParkAttempts: 3, maxFailedAttempts: 2 };
    const r = row({ attempts: 4, parkAttempts: 3, parkedOnRef: 'card:abc' });
    expect(isRefusalDeath(r, policy)).toBe(true);
    // Same row, default policy: three parks is not the default ladder.
    expect(isRefusalDeath(r)).toBe(false);
  });
});

describe('the predicate matches what the dispatcher actually writes', () => {
  /** A consumer that parks for ever on a referent nobody will ever create. */
  function refuser(provider = 'increase'): WebhookConsumer {
    return {
      provider,
      handle() {
        return parked('inbound_ach_account_mapping', 'ghost', 'NOTHING WAS POSTED; a person must attribute this');
      },
    };
  }

  async function put(store: InboxStore, now: Date): Promise<void> {
    await store.insertIfNew({
      provider: 'increase',
      providerEventId: 'evt_1',
      eventType: 'inbound_ach_transfer.created',
      payload: {},
      headers: {},
      rawBody: '{}',
      receivedAt: now,
      signatureVerifiedAt: now,
    });
  }

  it('classifies a real dispatcher-produced park death as a refusal, and keeps the reason', async () => {
    const store = createMemoryInboxStore();
    let t = new Date('2026-09-11T00:00:00Z');
    const registry = new ConsumerRegistry().register(refuser());
    await put(store, t);

    for (let i = 0; i < P.maxParkAttempts + 4; i += 1) {
      await dispatchOnce({ store, registry, now: () => t, random: () => 0 });
      t = new Date(t.getTime() + 2 * 60 * 60_000);
    }

    const dead = store.all()[0]!;
    expect(dead.state).toBe('dead');
    expect(
      deadLetterCause({
        attempts: dead.attempts,
        parkAttempts: dead.parkAttempts,
        parkedOnRef: dead.parkedOnRef,
      }),
    ).toBe('refusal');
    // The consumer's own sentence survives the dead-lettering, and is first.
    expect(dead.processingError).toMatch(/^NOTHING WAS POSTED; a person must attribute this/);
    expect(dead.processingError).toContain('inbound_ach_account_mapping:ghost');
  });

  it('classifies a dispatcher-produced fault death as a fault', async () => {
    const store = createMemoryInboxStore();
    let t = new Date('2026-09-11T00:00:00Z');
    // No consumer registered: the original outage.
    const registry = new ConsumerRegistry();
    await put(store, t);

    for (let i = 0; i < P.maxFailedAttempts + 2; i += 1) {
      await dispatchOnce({ store, registry, now: () => t, random: () => 0 });
      t = new Date(t.getTime() + 2 * 60 * 60_000);
    }

    const dead = store.all()[0]!;
    expect(dead.state).toBe('dead');
    expect(
      deadLetterCause({
        attempts: dead.attempts,
        parkAttempts: dead.parkAttempts,
        parkedOnRef: dead.parkedOnRef,
      }),
    ).toBe('fault');
  });
});

describe('refusalDeathSql', () => {
  it('names the columns, qualified by the alias it is given', () => {
    expect(refusalDeathSql('w')).toBe(
      '(w.parked_on_ref is not null and w.park_attempts >= 12 and w.attempts - w.park_attempts < 8)',
    );
    expect(refusalDeathSql('')).toBe(
      '(parked_on_ref is not null and park_attempts >= 12 and attempts - park_attempts < 8)',
    );
  });

  it('is the exact negation of faultDeathSql', () => {
    expect(faultDeathSql('w')).toBe(`(not ${refusalDeathSql('w')})`);
  });

  it('is the same string scripts/redrive.mjs uses — a .mjs cannot import this, so it is CHECKED', () => {
    // Two copies of a predicate that decides what stays in an alarm is exactly
    // how an alarm quietly stops covering something. The script's copy is
    // pinned to this one here rather than trusted to stay in step.
    const script = readFileSync(new URL('../../../scripts/redrive.mjs', import.meta.url), 'utf8');
    expect(script).toContain(`const REFUSAL_DEATH =\n  "${refusalDeathSql('w')}";`);
  });

  it('interpolates integers only, whatever the caller passes', () => {
    const hostile = {
      ...P,
      maxParkAttempts: 12.9,
      maxFailedAttempts: 8.9,
    };
    expect(refusalDeathSql('w', hostile)).toContain('>= 12');
    expect(refusalDeathSql('w', hostile)).toContain('< 8');
    expect(refusalDeathSql('w', hostile)).not.toMatch(/[^\w\s.()>=<*+-]/);
  });
});
