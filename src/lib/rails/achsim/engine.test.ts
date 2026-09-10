/**
 * The simulator's engine — one test per awkward case the brief asks for.
 *
 * These are the cases a sandbox cannot give you on demand. Each one runs in
 * microseconds because time is virtual, and each one is byte-for-byte
 * reproducible because the seed is fixed.
 */

import { describe, expect, it } from 'vitest';

import { days, hours } from './clock';
import { AchSimEngine, type AchSimScenario } from './engine';
import { WebhookSigner } from './signing';
import { usd, type Destination } from '../types';

const DESTINATION: Extract<Destination, { type: 'ach' }> = {
  type: 'ach',
  routingNumber: '110000000',
  accountNumber: '000123456789',
  accountType: 'checking',
  holderName: 'SIMULATED COUNTERPARTY',
  holderKind: 'individual',
  authorization: 'consumer_online',
};

function engineWith(scenarioSeed = 'test-seed'): AchSimEngine {
  return new AchSimEngine({
    signer: new WebhookSigner({ secret: 'sim-secret', liveSecret: 'the-live-increase-secret' }),
    seed: scenarioSeed,
  });
}

function start(engine: AchSimEngine, scenario: AchSimScenario, ref = 'cref-1') {
  return engine.create({
    clientReferenceId: ref,
    sourceAccountId: 'sim_account_0001',
    direction: 'debit',
    amount: usd(125_00n),
    statementDescriptor: 'CORGI SIM',
    destination: DESTINATION,
    secCode: 'internet_initiated',
    scenario,
  });
}

// ---------------------------------------------------------------------------

describe('delayed settlement', () => {
  it('stays submitted until the settlement delay elapses, then settles', () => {
    const engine = engineWith();
    const created = start(engine, { submitAfterMs: 0, settleAfterMs: days(3) });
    expect(created.status).toBe('submitted');

    engine.advance(days(2));
    expect(engine.get(created.id)?.status).toBe('submitted');
    expect(engine.get(created.id)?.settledAtMs).toBeNull();

    engine.advance(days(1));
    const settled = engine.get(created.id);
    expect(settled?.status).toBe('settled');
    expect(settled?.settledAtMs).toBe(created.createdAtMs + days(3));
  });

  it('reproduces the Increase shape in the raw view: status stays "submitted"', () => {
    const engine = engineWith();
    const created = start(engine, { settleAfterMs: hours(4) });
    engine.advance(hours(5));
    const record = engine.get(created.id)!;
    const raw = engine.rawTransfer(record);
    // Our normalised status is 'settled'...
    expect(record.status).toBe('settled');
    // ...but the provider-shaped view still says "submitted" with a settlement
    // sub-object, exactly like Increase. A consumer that reads the raw status
    // is wrong here in the same way it would be wrong in production.
    expect(raw['status']).toBe('submitted');
    expect(raw['settlement']).toMatchObject({ settled_at: expect.any(String) });
  });

  it('never settles when settleAfterMs is null', () => {
    const engine = engineWith();
    const created = start(engine, { settleAfterMs: null });
    engine.advance(days(365));
    expect(engine.get(created.id)?.status).toBe('submitted');
  });
});

describe('returns with a chosen code, days after settlement', () => {
  it('R01 four days after settlement — the case that breaks ledgers', () => {
    const engine = engineWith();
    const created = start(engine, {
      settleAfterMs: days(1),
      return: { code: 'R01', afterSettlementMs: days(4) },
    });

    engine.advance(days(1));
    expect(engine.get(created.id)?.status).toBe('settled');

    // Three days later it still looks fine. This is the window in which a
    // careless ledger has already released the hold.
    engine.advance(days(3));
    expect(engine.get(created.id)?.status).toBe('settled');

    engine.advance(days(1));
    const returned = engine.get(created.id)!;
    expect(returned.status).toBe('returned');
    expect(returned.returnReason).toMatchObject({
      code: 'R01',
      providerCode: 'insufficient_fund', // singular, exactly as Increase spells it
      category: 'insufficient_funds',
      retryable: true,
    });
    // The settlement timestamp is NOT erased. A return is a second movement,
    // not an edit: the transfer really did settle, and then really did come
    // back, and both facts survive.
    expect(returned.settledAtMs).not.toBeNull();
  });

  it('R02 and R03 map to non-retryable account problems', () => {
    for (const [code, expected] of [
      ['R02', 'account_closed'],
      ['R03', 'no_account'],
    ] as const) {
      const engine = engineWith();
      const created = start(engine, {
        settleAfterMs: days(1),
        return: { code, afterSettlementMs: days(2) },
      });
      engine.advance(days(4));
      const record = engine.get(created.id)!;
      expect(record.status).toBe('returned');
      expect(record.returnReason).toMatchObject({
        code,
        providerCode: expected,
        category: 'account_invalid',
        retryable: false,
      });
    }
  });

  it('can return a transfer that never settled', () => {
    const engine = engineWith();
    const created = start(engine, {
      settleAfterMs: null,
      return: { code: 'R03', afterSettlementMs: days(2) },
    });
    engine.advance(days(3));
    expect(engine.get(created.id)?.status).toBe('returned');
    expect(engine.get(created.id)?.settledAtMs).toBeNull();
  });

  it('forceReturn works on an arbitrary existing transfer, like Increase’s endpoint', () => {
    const engine = engineWith();
    const created = start(engine, { settleAfterMs: days(1) });
    engine.advance(days(1));
    const returned = engine.forceReturn(created.id, 'R10');
    expect(returned.status).toBe('returned');
    expect(returned.returnReason?.category).toBe('unauthorized');
  });
});

describe('notification of change (COR)', () => {
  it('carries corrected routing and account numbers with their C-codes', () => {
    const engine = engineWith();
    const created = start(engine, {
      notificationOfChange: {
        afterMs: hours(6),
        correctedRoutingNumber: '110000000',
        correctedAccountNumber: '111222333',
      },
    });
    engine.advance(hours(7));
    const corrections = engine.get(created.id)?.corrections ?? [];
    expect(corrections).toEqual([
      expect.objectContaining({ field: 'account_number', correctedValue: '111222333', code: 'C01' }),
      expect.objectContaining({ field: 'routing_number', correctedValue: '110000000', code: 'C02' }),
    ]);
    // A correction is not a state change: the transfer carries on settling.
    expect(engine.get(created.id)?.status).not.toBe('returned');
  });
});

describe('out-of-order delivery', () => {
  it('emits the SETTLEMENT notification before the SUBMISSION notification', () => {
    const engine = engineWith();
    start(engine, {
      submitAfterMs: 0,
      settleAfterMs: days(1),
      delivery: 'settlement_before_submission',
      emitCreatedEvent: false,
    });

    // Nothing is deliverable yet: the submission notification has been held
    // back past the settlement, so the first drain is empty rather than
    // yielding the submission.
    expect(engine.drainDue()).toHaveLength(0);

    engine.advance(days(1) + 1);
    const order = engine.drainDue().map((d) => d.intent);
    expect(order).toEqual(['settled', 'submitted']);
  });

  it('does not move settlement earlier — only the notification is late', () => {
    const engine = engineWith();
    const created = start(engine, {
      settleAfterMs: days(1),
      delivery: 'settlement_before_submission',
      emitCreatedEvent: false,
    });
    // The state machine is untouched: the transfer really was submitted at T0
    // and really did settle at T+1d. Reordering the notifications does not
    // reorder reality, and a consumer "handling" an early settlement would be
    // handling something that cannot happen.
    engine.advance(days(1) + 1);
    const record = engine.get(created.id)!;
    expect(record.submittedAtMs).toBe(created.createdAtMs);
    expect(record.settledAtMs).toBe(created.createdAtMs + days(1));
  });
});

describe('duplicate delivery', () => {
  it('redelivers the SAME event id, body and signature bytes', () => {
    const engine = engineWith();
    start(engine, { duplicate: 'all', settleAfterMs: days(1), emitCreatedEvent: false });
    engine.advance(days(1));

    const deliveries = engine.drainDue();
    const settlements = deliveries.filter((d) => d.intent === 'settled');
    expect(settlements).toHaveLength(2);

    const [first, second] = settlements;
    expect(second?.isDuplicate).toBe(true);
    // Identical in every respect a receiver can observe. Nothing downstream can
    // tell this from the provider's own retry — which is the point: the inbox's
    // UNIQUE (provider, provider_event_id) has to be what stops it, not a
    // heuristic.
    expect(second?.eventId).toBe(first?.eventId);
    expect(second?.signed.rawBody).toBe(first?.signed.rawBody);
    expect(second?.signed.headers['webhook-signature']).toBe(
      first?.signed.headers['webhook-signature'],
    );
  });
});

describe('provider outage', () => {
  it('fails calls, stops webhooks, then delivers a catch-up burst', () => {
    const engine = engineWith();
    const created = start(engine, {
      submitAfterMs: hours(1),
      settleAfterMs: hours(2),
      emitCreatedEvent: false,
    });

    engine.beginOutage(hours(6));
    expect(engine.isDown()).toBe(true);

    // 1. API calls fail — retryably, which is the honest and the dangerous
    //    answer: a caller that treats this as a failed payment is the bug.
    let thrown: unknown;
    try {
      engine.assertUp('read a transfer');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: 'provider_outage',
      retryable: true,
      evidence: 'simulated',
      httpStatus: 503,
    });

    // 2. Webhooks stop. The events still HAPPEN — the network does not care
    //    that the API is down — they just do not get delivered.
    engine.advance(hours(4));
    expect(engine.drainDue()).toHaveLength(0);
    expect(engine.get(created.id)?.status).toBe('settled');

    // 3. The far side of the outage: everything queued arrives at once, in due
    //    order. This burst is what breaks per-request assumptions.
    engine.advance(hours(3));
    expect(engine.isDown()).toBe(false);
    const burst = engine.drainDue();
    expect(burst.map((d) => d.intent)).toEqual(['submitted', 'settled']);
    expect(burst[0]!.deliverAtMs).toBeLessThan(burst[1]!.deliverAtMs);
  });
});

describe('determinism', () => {
  it('two runs of the same script produce identical ids, bodies and signatures', () => {
    const script = (seed: string) => {
      const engine = engineWith(seed);
      start(engine, {
        settleAfterMs: days(1),
        return: { code: 'R01', afterSettlementMs: days(4) },
        notificationOfChange: { afterMs: hours(2), correctedAccountNumber: '111222333' },
      });
      engine.advance(days(6));
      return engine.drainDue().map((d) => ({
        eventId: d.eventId,
        intent: d.intent,
        rawBody: d.signed.rawBody,
        signature: d.signed.headers['webhook-signature'],
      }));
    };

    const a = script('same-seed');
    const b = script('same-seed');
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);

    // A different seed changes the ids (and therefore the signatures), but not
    // the shape of the story.
    const c = script('different-seed');
    expect(c.map((d) => d.intent)).toEqual(a.map((d) => d.intent));
    expect(c[0]?.eventId).not.toBe(a[0]?.eventId);
  });

  it('mints ids in their own key space, so a simulated row is visibly simulated', () => {
    const engine = engineWith();
    const created = start(engine, {});
    expect(created.id).toMatch(/^ach_sim_/);
    engine.advance(days(1));
    for (const delivery of engine.drainDue()) {
      expect(delivery.eventId).toMatch(/^evt_sim_/);
    }
  });
});

describe('housekeeping', () => {
  it('is idempotent on the client reference id, like Increase’s Idempotency-Key', () => {
    const engine = engineWith();
    const first = start(engine, { settleAfterMs: days(1) }, 'same-ref');
    const second = start(engine, { settleAfterMs: days(1) }, 'same-ref');
    expect(second.id).toBe(first.id);
    expect(engine.list()).toHaveLength(1);
  });

  it('refuses to move the clock backwards', () => {
    const engine = engineWith();
    expect(() => engine.advance(-1)).toThrow(RangeError);
    expect(() => engine.advanceTo(0)).toThrow(RangeError);
  });

  it('ignores a cancellation that arrives after submission, like the network does', () => {
    const engine = engineWith();
    const created = start(engine, { submitAfterMs: 0, cancelAfterMs: hours(1) });
    engine.advance(hours(2));
    // Submitted first, so the cancel never applies. An ACH entry in the network
    // is irrevocable and pretending otherwise would teach a consumer a lie.
    expect(engine.get(created.id)?.status).not.toBe('canceled');
  });

  it('cancels before submission when the cancel wins the race', () => {
    const engine = engineWith();
    const created = start(engine, { submitAfterMs: hours(2), cancelAfterMs: hours(1) });
    engine.advance(hours(3));
    expect(engine.get(created.id)?.status).toBe('canceled');
  });

  it('masks the account number even in a simulator', () => {
    const engine = engineWith();
    const created = start(engine, {});
    expect(created.accountNumber).toBe('****6789');
  });
});
