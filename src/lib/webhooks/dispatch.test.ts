import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  ConsumerRegistry,
  DEFAULT_RETRY_POLICY,
  dispatchOnce,
  dispatchUntilIdle,
  failedAttempts,
  ignored,
  parked,
  processed,
  type ConsumerResult,
  type WebhookConsumer,
} from './dispatch';
import { createMemoryInboxStore, type InboxEvent, type InboxStore } from './inbox';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A clock we control. Nothing in the dispatcher calls `new Date()` itself. */
function clock(start = new Date('2026-09-10T12:00:00Z')) {
  let t = start;
  return {
    now: () => t,
    advanceMs(ms: number) {
      t = new Date(t.getTime() + ms);
    },
    set(d: Date) {
      t = d;
    },
  };
}

/** Jitter off, so delays are exact numbers a test can assert. */
const NO_JITTER = () => 0;

async function put(
  store: InboxStore,
  provider: string,
  providerEventId: string,
  eventType: string,
  payload: unknown,
  receivedAt: Date,
) {
  const res = await store.insertIfNew({
    provider,
    providerEventId,
    eventType,
    payload,
    headers: {},
    rawBody: JSON.stringify(payload),
    receivedAt,
    signatureVerifiedAt: receivedAt,
  });
  return res;
}

/**
 * A consumer shaped like the real card one: a clearing that names an
 * authorisation we have never seen is PARKED, and the authorisation event
 * reports the auth it created so the parked clearing can be woken.
 */
function cardConsumer() {
  const effects: string[] = [];
  const knownAuths = new Set<string>();
  const consumer: WebhookConsumer = {
    provider: 'lithic',
    handle(event: InboxEvent): ConsumerResult {
      const payload = event.payload as { auth_id: string };
      switch (event.eventType) {
        case 'authorization':
          knownAuths.add(payload.auth_id);
          effects.push(`auth:${payload.auth_id}`);
          return processed([{ kind: 'card_authorization', ref: payload.auth_id }]);
        case 'clearing':
          if (!knownAuths.has(payload.auth_id)) {
            return parked('card_authorization', payload.auth_id, 'clearing arrived before its authorisation');
          }
          effects.push(`clearing:${payload.auth_id}`);
          return processed();
        default:
          return ignored('not a card lifecycle event');
      }
    },
  };
  return { consumer, effects, knownAuths };
}

// ---------------------------------------------------------------------------
// Backoff arithmetic
// ---------------------------------------------------------------------------

describe('backoffDelayMs', () => {
  const opts = { baseDelayMs: 5_000, maxDelayMs: 60 * 60_000, jitter: 0 };

  it('doubles per attempt', () => {
    expect([1, 2, 3, 4, 5].map((n) => backoffDelayMs(n, opts, NO_JITTER))).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000,
    ]);
  });

  it('is capped, so an old event does not retry in a decade', () => {
    expect(backoffDelayMs(50, opts, NO_JITTER)).toBe(60 * 60_000);
    expect(Number.isFinite(backoffDelayMs(1e9, opts, NO_JITTER))).toBe(true);
  });

  it('applies jitter downwards only, within the fraction given', () => {
    const jittered = backoffDelayMs(3, { ...opts, jitter: 0.2 }, () => 1);
    expect(jittered).toBe(16_000); // 20_000 * (1 - 0.2)
  });
});

describe('failedAttempts', () => {
  it('does not count parks as failures', () => {
    expect(failedAttempts({ attempts: 5, parkAttempts: 4 })).toBe(1);
    expect(failedAttempts({ attempts: 3, parkAttempts: 3 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The happy path, and "twice is exactly once"
// ---------------------------------------------------------------------------

describe('dispatchOnce', () => {
  it('processes a pending event once and marks it done', async () => {
    const store = createMemoryInboxStore();
    const c = clock();
    const { consumer, effects } = cardConsumer();
    const registry = new ConsumerRegistry().register(consumer);

    await put(store, 'lithic', 'msg_1', 'authorization', { auth_id: 'auth_1' }, c.now());
    const summary = await dispatchOnce({ store, registry, now: c.now, random: NO_JITTER });

    expect(summary).toMatchObject({ claimed: 1, processed: 1 });
    expect(effects).toEqual(['auth:auth_1']);
    expect(store.all()[0]!.state).toBe('done');
    expect(store.all()[0]!.processedAt).not.toBeNull();
  });

  it('does not pick a done event up again', async () => {
    const store = createMemoryInboxStore();
    const c = clock();
    const { consumer, effects } = cardConsumer();
    const registry = new ConsumerRegistry().register(consumer);

    await put(store, 'lithic', 'msg_1', 'authorization', { auth_id: 'auth_1' }, c.now());
    await dispatchOnce({ store, registry, now: c.now, random: NO_JITTER });
    c.advanceMs(10 * 60_000);
    const second = await dispatchOnce({ store, registry, now: c.now, random: NO_JITTER });

    expect(second.claimed).toBe(0);
    expect(effects).toEqual(['auth:auth_1']);
  });

  it('TWICE IS EXACTLY ONCE: a redelivered event produces one effect', async () => {
    const store = createMemoryInboxStore();
    const c = clock();
    const { consumer, effects } = cardConsumer();
    const registry = new ConsumerRegistry().register(consumer);

    // The provider delivers the same event id twice, which is normal: Lithic
    // retries eight times on any non-2xx, and its webhook-id is stable.
    const first = await put(store, 'lithic', 'msg_1', 'authorization', { auth_id: 'auth_1' }, c.now());
    const second = await put(store, 'lithic', 'msg_1', 'authorization', { auth_id: 'auth_1' }, c.now());

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false); // the unique index decided this
    await dispatchUntilIdle({ store, registry, now: c.now, random: NO_JITTER });

    expect(store.all()).toHaveLength(1);
    expect(effects).toEqual(['auth:auth_1']);
  });

  it('marks an ignored event done without an effect', async () => {
    const store = createMemoryInboxStore();
    const c = clock();
    const { consumer, effects } = cardConsumer();
    const registry = new ConsumerRegistry().register(consumer);

    await put(store, 'lithic', 'msg_9', 'card.created', {}, c.now());
    const summary = await dispatchOnce({ store, registry, now: c.now, random: NO_JITTER });

    expect(summary).toMatchObject({ ignored: 1, processed: 0 });
    expect(effects).toEqual([]);
    expect(store.all()[0]!.state).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Out of order, and the parked state
// ---------------------------------------------------------------------------

describe('out-of-order delivery', () => {
  it('parks a clearing whose authorisation has not arrived, naming what it waits for', async () => {
    const store = createMemoryInboxStore();
    const c = clock();
    const { consumer, effects } = cardConsumer();
    const registry = new ConsumerRegistry().register(consumer);

    await put(store, 'lithic', 'msg_clr', 'clearing', { auth_id: 'auth_1' }, c.now());
    const summary = await dispatchOnce({ store, registry, now: c.now, random: NO_JITTER });

    expect(summary).toMatchObject({ parked: 1, processed: 0, deadLettered: 0 });
    expect(effects).toEqual([]);

    const row = store.all()[0]!; // exactly one row exists; asserted rather than re-checked each line
    expect(row.state).toBe('parked'); // not dropped, not failed, not crashed
    expect(row.parkedOnKind).toBe('card_authorization');
    expect(row.parkedOnRef).toBe('auth_1');
    expect(row.parkAttempts).toBe(1);
  });

  it('wakes the parked clearing the moment its authorisation appears', async () => {
    const store = createMemoryInboxStore();
    const c = clock();
    const { consumer, effects } = cardConsumer();
    const registry = new ConsumerRegistry().register(consumer);

    await put(store, 'lithic', 'msg_clr', 'clearing', { auth_id: 'auth_1' }, c.now());
    await dispatchOnce({ store, registry, now: c.now, random: NO_JITTER });
    expect(store.all()[0]!.state).toBe('parked');

    // The authorisation turns up two minutes later — well inside the parked
    // row's own re-check delay, so this wake-up is the unpark, not the timer.
    c.advanceMs(120_000);
    await put(store, 'lithic', 'msg_auth', 'authorization', { auth_id: 'auth_1' }, c.now());
    const summary = await dispatchUntilIdle({ store, registry, now: c.now, random: NO_JITTER });

    expect(summary.unparked).toBe(1);
    expect(effects).toEqual(['auth:auth_1', 'clearing:auth_1']);
    expect(store.all().every((r) => r.state === 'done')).toBe(true);
  });

  it('reaches the same state whichever order the two events arrive in', async () => {
    async function run(order: ('authorization' | 'clearing')[]) {
      const store = createMemoryInboxStore();
      const c = clock();
      const { consumer, effects } = cardConsumer();
      const registry = new ConsumerRegistry().register(consumer);
      for (const kind of order) {
        await put(store, 'lithic', `msg_${kind}`, kind, { auth_id: 'auth_1' }, c.now());
        await dispatchUntilIdle({ store, registry, now: c.now, random: NO_JITTER });
        c.advanceMs(1_000);
      }
      // The park's own re-check timer, as the safety net under the unpark.
      c.advanceMs(60 * 60_000);
      await dispatchUntilIdle({ store, registry, now: c.now, random: NO_JITTER });
      return { effects: [...effects].sort(), states: store.all().map((r) => r.state).sort() };
    }

    const inOrder = await run(['authorization', 'clearing']);
    const reversed = await run(['clearing', 'authorization']);

    expect(inOrder.effects).toEqual(['auth:auth_1', 'clearing:auth_1']);
    expect(reversed).toEqual(inOrder);
  });

  it('re-checks a parked event on a timer even if nothing ever unparks it', async () => {
    const store = createMemoryInboxStore();
    const c = clock();
    const { consumer, knownAuths, effects } = cardConsumer();
    const registry = new ConsumerRegistry().register(consumer);

    await put(store, 'lithic', 'msg_clr', 'clearing', { auth_id: 'auth_1' }, c.now());
    await dispatchOnce({ store, registry, now: c.now, random: NO_JITTER });
    expect(store.all()[0]!.state).toBe('parked');

    // The referent appears by some other route entirely (a backfill, a manual
    // repair) — nothing calls unparkWaitingFor, and the timer still finds it.
    knownAuths.add('auth_1');
    c.advanceMs(DEFAULT_RETRY_POLICY.parkBaseDelayMs + 1_000);
    await dispatchOnce({ store, registry, now: c.now, random: NO_JITTER });

    expect(effects).toEqual(['clearing:auth_1']);
    expect(store.all()[0]!.state).toBe('done');
  });

  it('dead-letters an event whose referent never arrives, instead of parking for ever', async () => {
    const store = createMemoryInboxStore();
    const c = clock();
    const { consumer } = cardConsumer();
    const registry = new ConsumerRegistry().register(consumer);
    const policy = { ...DEFAULT_RETRY_POLICY, maxParkAttempts: 3 };

    await put(store, 'lithic', 'msg_clr', 'clearing', { auth_id: 'ghost' }, c.now());
    for (let i = 0; i < 10; i++) {
      await dispatchOnce({ store, registry, policy, now: c.now, random: NO_JITTER });
      c.advanceMs(2 * 60 * 60_000); // past any backoff
    }

    const row = store.all()[0]!; // exactly one row exists; asserted rather than re-checked each line
    expect(row.state).toBe('dead');
    expect(row.parkAttempts).toBe(3);
    expect(row.processingError).toContain('card_authorization:ghost');
    expect(await store.listDeadLetters()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Bounded retry and the dead letter
// ---------------------------------------------------------------------------

describe('bounded retry', () => {
  function alwaysThrows(provider = 'lithic'): WebhookConsumer {
    return {
      provider,
      handle() {
        throw new Error('consumer exploded');
      },
    };
  }

  it('retries with growing backoff and does not lose the error', async () => {
    const store = createMemoryInboxStore();
    const c = clock();
    const registry = new ConsumerRegistry().register(alwaysThrows());

    await put(store, 'lithic', 'msg_1', 'authorization', { auth_id: 'a' }, c.now());
    const summary = await dispatchOnce({ store, registry, now: c.now, random: NO_JITTER });

    expect(summary).toMatchObject({ retried: 1, deadLettered: 0 });
    const row = store.all()[0]!; // exactly one row exists; asserted rather than re-checked each line
    expect(row.state).toBe('pending');
    expect(row.processingError).toContain('consumer exploded');
    expect(row.nextAttemptAt.getTime() - c.now().getTime()).toBe(DEFAULT_RETRY_POLICY.baseDelayMs);

    // Second failure waits twice as long.
    c.set(row.nextAttemptAt);
    await dispatchOnce({ store, registry, now: c.now, random: NO_JITTER });
    expect(store.all()[0]!.nextAttemptAt.getTime() - c.now().getTime()).toBe(
      DEFAULT_RETRY_POLICY.baseDelayMs * 2,
    );
  });

  it('dead-letters after the attempt cap and never retries again', async () => {
    const store = createMemoryInboxStore();
    const c = clock();
    const registry = new ConsumerRegistry().register(alwaysThrows());
    const policy = { ...DEFAULT_RETRY_POLICY, maxFailedAttempts: 3 };

    for (let i = 0; i < 20; i++) {
      await dispatchOnce({ store, registry, policy, now: c.now, random: NO_JITTER });
      c.advanceMs(24 * 60 * 60_000);
      if (i === 0) await put(store, 'lithic', 'msg_1', 'authorization', { auth_id: 'a' }, c.now());
    }

    const row = store.all()[0]!; // exactly one row exists; asserted rather than re-checked each line
    expect(row.state).toBe('dead');
    expect(row.attempts).toBe(3); // stopped exactly at the cap
    expect(row.processingError).toContain('consumer exploded');
    expect(await store.listDeadLetters()).toHaveLength(1);
  });

  it('treats a missing consumer as a retryable failure, not a crash', async () => {
    const store = createMemoryInboxStore();
    const c = clock();
    const registry = new ConsumerRegistry(); // nothing registered at all
    await put(store, 'increase', 'event_1', 'ach_transfer.updated', {}, c.now());

    const summary = await dispatchOnce({ store, registry, now: c.now, random: NO_JITTER });

    expect(summary).toMatchObject({ retried: 1 });
    expect(store.all()[0]!.processingError).toContain("no consumer registered for provider 'increase'");
  });

  it('one poisoned event does not block the rest of the batch', async () => {
    const store = createMemoryInboxStore();
    const c = clock();
    const { consumer, effects } = cardConsumer();
    const registry = new ConsumerRegistry()
      .register(consumer)
      .register(alwaysThrows('increase'));

    await put(store, 'increase', 'event_bad', 'ach_transfer.updated', {}, c.now());
    c.advanceMs(1);
    await put(store, 'lithic', 'msg_good', 'authorization', { auth_id: 'auth_1' }, c.now());

    const summary = await dispatchOnce({ store, registry, now: c.now, random: NO_JITTER });

    expect(summary).toMatchObject({ claimed: 2, processed: 1, retried: 1 });
    expect(effects).toEqual(['auth:auth_1']);
  });

  it('lets staff requeue a dead letter after the bug is fixed', async () => {
    const store = createMemoryInboxStore();
    const c = clock();
    const registry = new ConsumerRegistry().register(alwaysThrows());
    const policy = { ...DEFAULT_RETRY_POLICY, maxFailedAttempts: 1 };

    const { id } = await put(store, 'lithic', 'msg_1', 'authorization', { auth_id: 'auth_1' }, c.now());
    await dispatchOnce({ store, registry, policy, now: c.now, random: NO_JITTER });
    expect(store.all()[0]!.state).toBe('dead');

    // Fix deployed: swap in a working consumer and put the row back.
    const { consumer, effects } = cardConsumer();
    const fixed = new ConsumerRegistry().register(consumer);
    expect(await store.requeueDeadLetter(id!, c.now())).toBe(true);
    await dispatchOnce({ store, registry: fixed, policy, now: c.now, random: NO_JITTER });

    expect(effects).toEqual(['auth:auth_1']);
    expect(store.all()[0]!.state).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Leases
// ---------------------------------------------------------------------------

describe('claim leases', () => {
  it('hides a claimed row from a second worker until the lease expires', async () => {
    const store = createMemoryInboxStore();
    const c = clock();
    await put(store, 'lithic', 'msg_1', 'authorization', { auth_id: 'a' }, c.now());

    const workerA = await store.claimBatch({ limit: 10, now: c.now(), leaseMs: 60_000 });
    const workerB = await store.claimBatch({ limit: 10, now: c.now(), leaseMs: 60_000 });
    expect(workerA).toHaveLength(1);
    expect(workerB).toHaveLength(0);

    // Worker A died without answering. The lease, not a heartbeat, releases it.
    c.advanceMs(60_001);
    const workerC = await store.claimBatch({ limit: 10, now: c.now(), leaseMs: 60_000 });
    expect(workerC).toHaveLength(1);
    // ...and the crashed attempt was still counted, so a poison event is bounded.
    expect(workerC[0]!.attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Provider agnosticism
// ---------------------------------------------------------------------------

describe('provider agnosticism', () => {
  it('dispatches a fifth provider with no change to the dispatcher', async () => {
    const store = createMemoryInboxStore();
    const c = clock();
    const seen: string[] = [];
    const registry = new ConsumerRegistry().register({
      provider: 'acme-bank', // a provider this repo has never heard of
      handle(event) {
        seen.push(`${event.provider}/${event.eventType}`);
        return processed();
      },
    });

    await put(store, 'acme-bank', 'evt_1', 'transfer.settled', {}, c.now());
    const summary = await dispatchOnce({ store, registry, now: c.now, random: NO_JITTER });

    expect(summary.processed).toBe(1);
    expect(seen).toEqual(['acme-bank/transfer.settled']);
  });
});
