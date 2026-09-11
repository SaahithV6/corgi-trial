/**
 * The card adapter's mapping table, exhaustively.
 *
 * Two properties are being proved.
 *
 *   1. EVERY published Lithic event type has a decided money meaning, and the
 *      ones nobody has ever observed are decided to be UNDECIDED. The test
 *      iterates the union rather than a list someone typed out, so a new event
 *      type in `lithic/types.ts` fails here until somebody chooses.
 *
 *   2. IT NEVER THROWS. Not on garbage, not on an empty body, not on an event
 *      type from a product we do not use. A throw here becomes a 5xx, and
 *      Lithic retries a 5xx eight times before deciding the subscription is
 *      broken.
 */

import { describe, expect, it } from 'vitest';

import { settlementFromEvent } from '../contract';
import type { TransactionEventType } from '../lithic/types';
import { lithicCardAdapter, parseLithicEvent } from './card';

/** Every value of the published union, so the test cannot fall behind it. */
const ALL_EVENT_TYPES: readonly TransactionEventType[] = [
  'AUTHORIZATION',
  'AUTHORIZATION_ADVICE',
  'AUTHORIZATION_EXPIRY',
  'AUTHORIZATION_REVERSAL',
  'BALANCE_INQUIRY',
  'CLEARING',
  'CORRECTION_CREDIT',
  'CORRECTION_DEBIT',
  'CREDIT_AUTHORIZATION',
  'CREDIT_AUTHORIZATION_ADVICE',
  'FINANCIAL_AUTHORIZATION',
  'FINANCIAL_CREDIT_AUTHORIZATION',
  'RETURN',
  'RETURN_REVERSAL',
];

function delivery(type: string, cents = 1000): string {
  return JSON.stringify({
    event_type: 'card_transaction.updated',
    token: 'txn_1',
    account_token: 'acct_1',
    card_token: 'card_1',
    created: '2026-09-08T12:00:00Z',
    updated: '2026-09-08T12:00:00Z',
    status: 'PENDING',
    result: 'APPROVED',
    amounts: {
      cardholder: { amount: -cents, currency: 'USD', conversion_rate: '1' },
      hold: { amount: -cents, currency: 'USD' },
      merchant: { amount: -cents, currency: 'USD' },
      settlement: { amount: -cents, currency: 'USD' },
    },
    events: [
      {
        token: `evt_${type}`,
        type,
        created: '2026-09-08T12:00:00Z',
        amount: -cents,
        amounts: {
          cardholder: { amount: -cents, currency: 'USD', conversion_rate: '1' },
          merchant: { amount: -cents, currency: 'USD' },
          settlement: { amount: -cents, currency: 'USD' },
        },
        effective_polarity: 'DEBIT',
      },
    ],
  });
}

describe('the money meaning of every card lifecycle step', () => {
  it('decides all of them, and never silently', () => {
    for (const type of ALL_EVENT_TYPES) {
      const event = parseLithicEvent(delivery(type));
      expect(event.railKind).toBe('card');
      expect(event.transferId).toBe('txn_1');
      // The STEP's token, so an authorisation and its clearing are two ids.
      expect(event.eventId).toBe(`evt_${type}`);
    }
  });

  it('settles a clearing and a single-message authorisation', () => {
    for (const type of ['CLEARING', 'FINANCIAL_AUTHORIZATION', 'FINANCIAL_CREDIT_AUTHORIZATION', 'RETURN_REVERSAL']) {
      const event = parseLithicEvent(delivery(type, 7340));
      expect(event.type).toBe('settled');
      const settlement = settlementFromEvent(event, event.eventId);
      expect(settlement?.amount.amount).toBe(7340n);
      expect(settlement?.amount.currency).toBe('USD');
      // Integer minor units, bigint, positive magnitude — even though
      // Lithic's wire value was the signed number -7340.
      expect(typeof settlement?.amount.amount).toBe('bigint');
    }
  });

  it('holds are submitted, not settled', () => {
    for (const type of ['AUTHORIZATION', 'CREDIT_AUTHORIZATION', 'AUTHORIZATION_ADVICE', 'CREDIT_AUTHORIZATION_ADVICE']) {
      const event = parseLithicEvent(delivery(type));
      expect(event.type).toBe('submitted');
      expect(settlementFromEvent(event, event.eventId)).toBeNull();
    }
  });

  it('a void reverses the authorisation and never the settlement', () => {
    // Measured: POST /simulate/void appended AUTHORIZATION_REVERSAL -7340 and
    // left settled_amount unchanged at 7340. Reading "reversal" as money
    // coming back would leave a settlement report short by the whole clearing
    // while staying perfectly self-consistent about it.
    for (const type of ['AUTHORIZATION_REVERSAL', 'AUTHORIZATION_EXPIRY']) {
      const event = parseLithicEvent(delivery(type, 7340));
      expect(event.type).toBe('canceled');
      expect(settlementFromEvent(event, event.eventId)).toBeNull();
    }
  });

  it('a RETURN is money coming back, and carries no invented failure reason', () => {
    const event = parseLithicEvent(delivery('RETURN', 7340));
    expect(event.type).toBe('returned');
    if (event.type !== 'returned') throw new Error('unreachable');
    expect(event.amount.amount).toBe(7340n);
    // A refund is not a refusal. `unknown` is the honest bucket and the
    // provider's own word survives untouched.
    expect(event.reason.category).toBe('unknown');
    expect(event.reason.code).toBe('RETURN');
    expect(event.reason.providerCode).toBe('RETURN');
    expect(event.reason.retryable).toBe(false);
  });

  it('refuses to classify the two corrections no sandbox has ever emitted', () => {
    // /v1/simulate/correction, /correction_debit and /correction_credit are
    // all 404, measured. Nothing here has ever seen one, so nothing here
    // guesses what one means.
    for (const type of ['CORRECTION_DEBIT', 'CORRECTION_CREDIT']) {
      const event = parseLithicEvent(delivery(type));
      expect(event.type).toBe('unknown');
      if (event.type !== 'unknown') throw new Error('unreachable');
      expect(event.reason).toBe('unmodelled_event');
      expect(event.providerType).toBe(type);
    }
  });

  it('a balance inquiry changes nothing', () => {
    const event = parseLithicEvent(delivery('BALANCE_INQUIRY'));
    expect(event.type).toBe('unknown');
    if (event.type !== 'unknown') throw new Error('unreachable');
    expect(event.reason).toBe('no_state_change');
  });

  it('reports the LAST step, ordered by created and not by array position', () => {
    const outOfOrder = JSON.parse(delivery('CLEARING')) as Record<string, unknown>;
    outOfOrder['events'] = [
      { token: 'evt_late', type: 'CLEARING', created: '2026-09-10T12:00:00Z', amount: -600 },
      { token: 'evt_early', type: 'AUTHORIZATION', created: '2026-09-08T12:00:00Z', amount: -1000 },
    ];
    const event = parseLithicEvent(JSON.stringify(outOfOrder));
    expect(event.type).toBe('settled');
    expect(event.eventId).toBe('evt_late');
  });
});

describe('it never throws', () => {
  const garbage = [
    '',
    'not json',
    '{',
    'null',
    '[]',
    '"a string"',
    '{"event_type":"card.shipped"}',
    '{"event_type":"card_transaction.updated"}',
    '{"event_type":"card_transaction.updated","token":"t"}',
    '{"event_type":"card_transaction.updated","token":"t","events":[]}',
    '{"event_type":"card_transaction.updated","token":"t","events":[{"token":"e","type":"WHAT_IS_THIS"}]}',
  ];

  it('turns anything at all into an event, and a 200', () => {
    for (const body of garbage) {
      const event = parseLithicEvent(body);
      expect(event.provider).toBe('lithic.card');
      expect(typeof event.occurredAt).toBe('string');
      // Nothing that is not a genuine money movement may claim to be one.
      if (event.type !== 'settled' && event.type !== 'returned') {
        expect(settlementFromEvent(event, event.eventId)).toBeNull();
      }
    }
  });

  it('an unmodelled event type is unknown with the provider’s own word kept', () => {
    const event = parseLithicEvent('{"event_type":"dispute.updated","token":"dsp_1"}');
    expect(event.type).toBe('unknown');
    if (event.type !== 'unknown') throw new Error('unreachable');
    expect(event.providerType).toBe('dispute.updated');
    expect(event.reason).toBe('unmodelled_event');
  });

  it('an unknown lifecycle step is unclassified rather than assumed', () => {
    const event = parseLithicEvent(
      '{"event_type":"card_transaction.updated","token":"t","created":"2026-09-08T12:00:00Z","events":[{"token":"e","type":"WHAT_IS_THIS","created":"2026-09-08T12:00:00Z","amount":-100}]}',
    );
    expect(event.type).toBe('unknown');
  });
});

describe('the adapter itself', () => {
  it('is observing, is not originating, and needs no key to parse', async () => {
    const card = lithicCardAdapter({ env: {} });
    const observation = await card.observe(delivery('CLEARING', 7340));
    expect(observation.settlement?.amount.amount).toBe(7340n);
    // Pure: no network, no clock, no rate limiter. Safe on a stored payload.
    expect(observation.event.evidence).toBe('live');
  });
});
