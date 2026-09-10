/**
 * `AchSimRail` behind the `PaymentRail` interface.
 *
 * Two things are being proved here.
 *
 *   1. EVERY value it returns says `evidence: 'simulated'` — transfers, all
 *      seven event types, and errors. Not "most". The test enumerates them.
 *   2. OUT-OF-ORDER DELIVERY IS SURVIVABLE, because the body is a pointer and
 *      `parseEvent` reads back. The settlement notification arriving before the
 *      submission notification leaves the consumer in the same place as the
 *      natural order does.
 */

import { describe, expect, it } from 'vitest';

import { days } from './clock';
import { AchSimControl, SIM_PRESETS } from './control';
import { AchSimEngine } from './engine';
import { AchSimRail, ACHSIM_CAPABILITIES } from './rail';
import { WebhookSigner } from './signing';
import {
  assertLive,
  isSimulated,
  RailError,
  usd,
  type Destination,
  type RailEvent,
  type TransferRequest,
} from '../types';

const DESTINATION: Extract<Destination, { type: 'ach' }> = {
  type: 'ach',
  routingNumber: '110000000',
  accountNumber: '000123456789',
  holderName: 'SIMULATED COUNTERPARTY',
  authorization: 'business_agreement',
};

function makeRail(): { rail: AchSimRail; engine: AchSimEngine } {
  const engine = new AchSimEngine({
    signer: new WebhookSigner({ secret: 'sim-secret', liveSecret: 'live-secret' }),
    seed: 'rail-test',
  });
  return { rail: new AchSimRail({ engine }), engine };
}

function req(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    clientReferenceId: 'cref-1',
    sourceAccountId: 'sim_account_0001',
    destination: DESTINATION,
    amount: usd(125_00n),
    statementDescriptor: 'CORGI SIM',
    ...overrides,
  };
}

describe('capabilities', () => {
  it('is simulated, and the type says so as well as the value', () => {
    const { rail } = makeRail();
    expect(rail.capabilities.evidence).toBe('simulated');
    expect(rail.capabilities.environment).toBe('simulator');
    // Narrowed to the literal in ./rail.ts, so widening it back to `Evidence`
    // is a compile error rather than a review comment.
    const literal: 'simulated' = ACHSIM_CAPABILITIES.evidence;
    expect(literal).toBe('simulated');
  });

  it('advertises the same 60-day return window as the live adapter', () => {
    // Shorter here would let a consumer release funds early in testing and late
    // in production, which is the worst direction for that error.
    expect(ACHSIM_CAPABILITIES.returnWindowDays).toBe(60);
  });
});

describe('every returned value is labelled simulated', () => {
  it('transfers are', async () => {
    const { rail } = makeRail();
    const transfer = await rail.initiateDebit(req());
    expect(transfer.evidence).toBe('simulated');
    expect(isSimulated(transfer)).toBe(true);
    expect(() => assertLive(transfer, 'transfer')).toThrow(RailError);
    expect(transfer.id.startsWith('ach_sim_')).toBe(true);
    expect(transfer.provider).toBe('achsim.ach');
  });

  it('read-backs are', async () => {
    const { rail } = makeRail();
    const created = await rail.initiateCredit(req());
    const readBack = await rail.getTransfer(created.id);
    expect(readBack.evidence).toBe('simulated');
    expect((readBack.raw as Record<string, unknown>)['simulated']).toBe(true);
  });

  it('errors are', async () => {
    const { rail } = makeRail();
    await expect(
      rail.initiateCredit(req({ destination: { type: 'card', cardTokenId: 'card_1' } })),
    ).rejects.toMatchObject({ evidence: 'simulated', retryable: false });
    await expect(rail.getTransfer('ach_sim_nope')).rejects.toMatchObject({
      evidence: 'simulated',
      code: 'not_found',
    });
  });

  it('all seven event types are', async () => {
    const seen = new Set<string>();

    /**
     * Drain and parse everything due right now.
     *
     * Note the DRAIN-AS-YOU-GO discipline: because `parseEvent` reads the
     * transfer BACK, a delivery parsed long after the fact reports the state as
     * it is now, not as it was. That is correct behaviour — it is what makes
     * out-of-order and late delivery harmless — but it means a test that wants
     * to observe `submitted` has to look before settlement, exactly like a
     * consumer that is keeping up.
     */
    const collect = async (rail: AchSimRail, engine: AchSimEngine) => {
      for (const delivery of engine.drainDue()) {
        const event = await rail.parseEvent(delivery.signed.rawBody);
        expect(event.evidence).toBe('simulated');
        seen.add(event.type);
      }
    };

    // submitted -> settled -> returned, observed at each step
    {
      const { rail, engine } = makeRail();
      await rail.initiateDebit(
        req({ metadata: { simScenario: JSON.stringify(SIM_PRESETS.return_after_settlement) } }),
      );
      await collect(rail, engine); //          submitted
      engine.advance(days(1));
      await collect(rail, engine); //          settled
      engine.advance(days(4));
      await collect(rail, engine); //          returned
    }

    // correction
    {
      const { rail, engine } = makeRail();
      await rail.initiateDebit(
        req({ metadata: { simScenario: JSON.stringify(SIM_PRESETS.notification_of_change) } }),
      );
      engine.advance(days(1));
      await collect(rail, engine);
    }

    // canceled and failed
    {
      const { rail, engine } = makeRail();
      await rail.initiateDebit(
        req({
          clientReferenceId: 'cancel-me',
          metadata: { simScenario: JSON.stringify({ submitAfterMs: 1000, cancelAfterMs: 1 }) },
        }),
      );
      await rail.initiateDebit(
        req({
          clientReferenceId: 'fail-me',
          metadata: { simScenario: JSON.stringify({ failAfterMs: 1 }) },
        }),
      );
      engine.advance(days(1));
      await collect(rail, engine);
    }

    // unknown
    {
      const { rail } = makeRail();
      const event = await rail.parseEvent('{"id":"evt_x","category":"something.else"}');
      expect(event.evidence).toBe('simulated');
      seen.add(event.type);
    }

    expect([...seen].sort()).toEqual([
      'canceled',
      'correction',
      'failed',
      'returned',
      'settled',
      'submitted',
      'unknown',
    ]);
  });
});

describe('parseEvent', () => {
  it('never throws on an unparseable or unrecognised body', async () => {
    const { rail } = makeRail();
    for (const body of ['', 'not json', '{}', '[]', '{"id":"x"}']) {
      const event = await rail.parseEvent(body);
      expect(event.type).toBe('unknown');
      expect(event.evidence).toBe('simulated');
    }
  });

  it('DOES throw when the read-back is impossible, so the row is retried', async () => {
    const { rail, engine } = makeRail();
    const transfer = await rail.initiateDebit(req());
    engine.beginOutage(days(1));
    await expect(
      rail.parseEvent(
        JSON.stringify({ id: 'evt_sim_x', category: 'ach_transfer.updated', associated_object_id: transfer.id }),
      ),
    ).rejects.toMatchObject({ code: 'provider_outage', retryable: true });
  });

  it('reports a return with its own amount, because a return is a second movement', async () => {
    const { rail, engine } = makeRail();
    await rail.initiateDebit(
      req({ metadata: { simScenario: JSON.stringify(SIM_PRESETS.return_after_settlement) } }),
    );
    engine.advance(days(10));
    const events: RailEvent[] = [];
    for (const delivery of engine.drainDue()) {
      events.push(await rail.parseEvent(delivery.signed.rawBody));
    }
    const returned = events.find((e) => e.type === 'returned');
    if (returned?.type !== 'returned') throw new Error('expected a returned event');
    expect(returned.amount).toEqual({ amount: 125_00n, currency: 'USD' });
    expect(returned.reason).toMatchObject({
      code: 'R01',
      providerCode: 'insufficient_fund',
      category: 'insufficient_funds',
      retryable: true,
    });
  });
});

describe('out-of-order delivery converges', () => {
  it('reaches the same final state whichever order the notifications arrive in', async () => {
    const run = async (delivery: 'natural' | 'settlement_before_submission') => {
      const control = new AchSimControl({
        secret: 'sim-secret',
        liveSecret: 'live-secret',
        seed: 'ooo',
      });
      await control.rail.initiateDebit({
        clientReferenceId: 'ooo-1',
        sourceAccountId: 'sim_account_0001',
        destination: DESTINATION,
        amount: usd(50_00n),
        statementDescriptor: 'CORGI SIM',
        metadata: {
          simScenario: JSON.stringify({
            submitAfterMs: 0,
            settleAfterMs: days(1),
            delivery,
            emitCreatedEvent: false,
          }),
        },
      });
      control.engine.advance(days(1) + 1);
      return control.drainAndParse();
    };

    const natural = await run('natural');
    const reordered = await run('settlement_before_submission');

    // The DELIVERIES are in different orders...
    expect(natural.map((x) => x.delivery.intent)).toEqual(['submitted', 'settled']);
    expect(reordered.map((x) => x.delivery.intent)).toEqual(['settled', 'submitted']);

    // ...but every parsed event is `settled`, in both runs, because the body is
    // a pointer and `parseEvent` reads the transfer back. The late submission
    // notification resolves to the CURRENT state, so it is a harmless no-op
    // instead of a regression that un-settles a settled transfer.
    expect(reordered.map((x) => x.event.type)).toEqual(['settled', 'settled']);
    expect(natural.at(-1)?.event.type).toBe('settled');
  });
});

describe('per-request scenario override', () => {
  it('rides in metadata, so the interface does not have to widen for it', async () => {
    const { rail, engine } = makeRail();
    const transfer = await rail.initiateDebit(
      req({ metadata: { simScenario: JSON.stringify({ submitAfterMs: 0, settleAfterMs: 0 }) } }),
    );
    // Settles immediately rather than the default one day.
    expect((await rail.getTransfer(transfer.id)).status).toBe('settled');
    expect(engine.get(transfer.id)?.settledAtMs).toBe(engine.get(transfer.id)?.createdAtMs);
  });

  it('ignores malformed metadata rather than failing the transfer', async () => {
    const { rail } = makeRail();
    const transfer = await rail.initiateDebit(req({ metadata: { simScenario: 'not json' } }));
    expect(transfer.status).toBe('submitted');
  });
});
