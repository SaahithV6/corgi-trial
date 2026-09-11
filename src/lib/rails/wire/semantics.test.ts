/**
 * The wire rail's mapping, against the bytes Increase actually sent.
 *
 * Every assertion below is driven from ./measured.ts, which is a paste of real
 * sandbox responses rather than a fixture somebody wrote. Three of these tests
 * would have passed against a hand-written fixture and told us nothing; the
 * ones that matter are the ones asserting an ABSENCE — no settlement object,
 * no return code, no `returned` event anywhere on the rail.
 */

import { describe, expect, it } from 'vitest';

import {
  MEASURED_INBOUND_DELIVERY,
  MEASURED_INBOUND_WIRE,
  MEASURED_OUTBOUND_DELIVERY,
  MEASURED_OUTBOUND_WIRE,
} from './measured';
import {
  inboundCredit,
  inboundWireEvent,
  outboundWireEvent,
  parseEventPointer,
  returnOfFunds,
  wireSemanticsKey,
  wireSettlementRef,
} from './semantics';
import type { IncreaseInboundWireTransfer, IncreaseWireTransfer } from './types';

const EVENT = { id: 'evt_1', occurredAt: '2026-09-11T03:58:51Z' };

/** A shallow override of a measured object, so the base stays measured. */
function outbound(patch: Partial<IncreaseWireTransfer>): IncreaseWireTransfer {
  return { ...MEASURED_OUTBOUND_WIRE, ...patch };
}
function inbound(patch: Partial<IncreaseInboundWireTransfer>): IncreaseInboundWireTransfer {
  return { ...MEASURED_INBOUND_WIRE, ...patch };
}

describe('the measured payloads say what the rail is built on', () => {
  it('has no settlement object — submission IS settlement', () => {
    // The ACH trap in ../types.ts is "status stays `submitted` and a
    // `settlement.settled_at` appears". The wire trap is the mirror: there is
    // no settlement field to wait for, ever. An adapter that waited for one
    // would hold a customer's money against an event that is not coming.
    expect('settlement' in MEASURED_OUTBOUND_WIRE).toBe(false);
    expect(MEASURED_OUTBOUND_WIRE.submission?.submitted_at).toBe('2026-09-11T03:58:34Z');
    expect(MEASURED_OUTBOUND_WIRE.submission?.input_message_accountability_data).toBe(
      '20260911sgzamiaa787670',
    );
  });

  it('gives the reversal a DIFFERENT IMAD, which is why it is not a reversal of ours', () => {
    const reversal = MEASURED_OUTBOUND_WIRE.reversal;
    expect(reversal).not.toBeNull();
    expect(reversal?.class_name).toBe('inbound_wire_reversal');
    expect(reversal?.input_message_accountability_data).toBe('20260911apvdjfqt599399');
    expect(reversal?.input_message_accountability_data).not.toBe(
      MEASURED_OUTBOUND_WIRE.submission?.input_message_accountability_data,
    );
    // Its own transaction, too. Two movements, not one movement edited.
    expect(reversal?.transaction_id).not.toBe(MEASURED_OUTBOUND_WIRE.transaction_id);
  });

  it('has a return_reason_code field and no code in it — there is no wire R-code table', () => {
    expect(MEASURED_OUTBOUND_WIRE.reversal).toHaveProperty('return_reason_code');
    expect(MEASURED_OUTBOUND_WIRE.reversal?.return_reason_code).toBeNull();
    expect(MEASURED_OUTBOUND_WIRE.reversal?.return_reason_code_description).toBeNull();
  });

  it('accepts an inbound wire at the instant it is created — no pending stage', () => {
    // This is the whole of "available immediately". There is no gap between
    // arrival and value in which anything could be held.
    expect(MEASURED_INBOUND_WIRE.acceptance?.accepted_at).toBe(MEASURED_INBOUND_WIRE.created_at);
  });

  it('reverses an inbound wire at OUR request, not the network`s', () => {
    expect(MEASURED_INBOUND_WIRE.reversal?.reason).toBe('creditor_request');
    // Later than the acceptance: we sent it back, on a later instant, and the
    // acceptance still stands.
    expect(Date.parse(MEASURED_INBOUND_WIRE.reversal?.reversed_at ?? '')).toBeGreaterThan(
      Date.parse(MEASURED_INBOUND_WIRE.acceptance?.accepted_at ?? ''),
    );
  });
});

describe('the webhook body is a pointer', () => {
  it('parses a real verified delivery and carries no money in it', () => {
    const pointer = parseEventPointer(MEASURED_OUTBOUND_DELIVERY);
    expect(pointer).not.toBeNull();
    expect(pointer?.category).toBe('wire_transfer.updated');
    expect(pointer?.associated_object_id).toBe('sandbox_wire_transfer_897tmwn18z27tzkqbkhe');
    // Nothing about the money. Hence the read-back.
    expect(JSON.parse(MEASURED_OUTBOUND_DELIVERY)).not.toHaveProperty('amount');
    expect(JSON.parse(MEASURED_OUTBOUND_DELIVERY)).not.toHaveProperty('status');
  });

  it('returns null rather than throwing on rubbish', () => {
    // A throw becomes a 5xx and a provider that collects enough of those
    // disables the subscription.
    expect(parseEventPointer('not json')).toBeNull();
    expect(parseEventPointer('null')).toBeNull();
    expect(parseEventPointer('{"id":"x"}')).toBeNull();
    expect(parseEventPointer('[]')).toBeNull();
  });

  it('parses the inbound delivery', () => {
    const pointer = parseEventPointer(MEASURED_INBOUND_DELIVERY);
    expect(pointer?.associated_object_type).toBe('inbound_wire_transfer');
    expect(pointer?.category).toBe('inbound_wire_transfer.created');
  });
});

describe('outbound statuses map to the seven-member union', () => {
  it('settles a complete wire at its SUBMISSION time', () => {
    const event = outboundWireEvent(outbound({ status: 'complete' }), EVENT);
    expect(event.type).toBe('settled');
    if (event.type !== 'settled') throw new Error('unreachable');
    expect(event.settledAt).toBe('2026-09-11T03:58:34Z');
    expect(event.amount).toEqual({ amount: 250000n, currency: 'USD' });
  });

  it('keeps a REVERSED wire settled, at the original time and amount', () => {
    // The load-bearing assertion of the whole rail. The wire settled. It was
    // final. A second payment came back later, and none of that reaches back
    // and un-settles the first.
    const event = outboundWireEvent(MEASURED_OUTBOUND_WIRE, EVENT);
    expect(event.type).toBe('settled');
    if (event.type !== 'settled') throw new Error('unreachable');
    expect(event.settledAt).toBe('2026-09-11T03:58:34Z');
    expect(event.amount.amount).toBe(250000n);
  });

  it('never produces a `returned` event, for any status', () => {
    const statuses = [
      'pending_approval',
      'pending_creating',
      'pending_reviewing',
      'pending_submission',
      'canceled',
      'complete',
      'rejected',
      'requires_attention',
      'reversed',
      'submitted',
      'something_increase_adds_in_2027',
    ] as const;
    for (const status of statuses) {
      const event = outboundWireEvent(outbound({ status }), EVENT);
      expect(event.type, `status ${status}`).not.toBe('returned');
    }
  });

  it('refuses to invent a settlement time when a complete wire has no submission', () => {
    // `settledAt` is never inferred. Complete with no submission means the Fed
    // accepted a message Increase did not tell us about, and the honest answer
    // is that we do not know when.
    const event = outboundWireEvent(outbound({ status: 'complete', submission: null }), EVENT);
    expect(event.type).toBe('unknown');
    if (event.type !== 'unknown') throw new Error('unreachable');
    expect(event.reason).toBe('unparseable');
  });

  it('treats every pending status as no state change, not as a failure', () => {
    for (const status of [
      'pending_approval',
      'pending_creating',
      'pending_reviewing',
      'pending_submission',
      'requires_attention',
    ] as const) {
      const event = outboundWireEvent(outbound({ status }), EVENT);
      expect(event.type).toBe('unknown');
      if (event.type !== 'unknown') throw new Error('unreachable');
      expect(event.reason).toBe('no_state_change');
    }
  });

  it('cancels and rejects without ever claiming money moved', () => {
    const canceled = outboundWireEvent(outbound({ status: 'canceled' }), EVENT);
    expect(canceled.type).toBe('canceled');

    const rejected = outboundWireEvent(outbound({ status: 'rejected' }), EVENT);
    expect(rejected.type).toBe('failed');
    if (rejected.type !== 'failed') throw new Error('unreachable');
    expect(rejected.reason.retryable).toBe(false);
    expect(rejected.reason.category).toBe('invalid_request');
  });

  it('buckets a status Increase invents later as unmodelled, not as a crash', () => {
    const event = outboundWireEvent(outbound({ status: 'teleported' }), EVENT);
    expect(event.type).toBe('unknown');
    if (event.type !== 'unknown') throw new Error('unreachable');
    expect(event.reason).toBe('unmodelled_event');
    expect(event.providerType).toBe('wire_transfer:teleported');
  });
});

describe('the reversal is lifted out as an arrival, not a return', () => {
  it('reads the money coming back as an inbound credit with its own identity', () => {
    const credit = returnOfFunds(MEASURED_OUTBOUND_WIRE);
    expect(credit).not.toBeNull();
    if (credit === null) throw new Error('unreachable');

    expect(credit.amount).toEqual({ amount: 250000n, currency: 'USD' });
    // ITS OWN IMAD and ITS OWN transaction — not the original's. Keying it on
    // the original would make a settle-then-return pair look like one event
    // seen twice, which is exactly what reportSettlements dedupes on.
    expect(credit.imad).toBe('20260911apvdjfqt599399');
    expect(credit.transferId).toBe(MEASURED_OUTBOUND_WIRE.reversal?.transaction_id);
    expect(credit.transferId).not.toBe(MEASURED_OUTBOUND_WIRE.id);
    // Its own value date, from its own timestamp.
    expect(credit.acceptedAt).toBe(MEASURED_OUTBOUND_WIRE.reversal?.created_at);
    // And it remembers which wire it answers, for the ledger description only.
    expect(credit.returnOfWireTransferId).toBe(MEASURED_OUTBOUND_WIRE.id);
  });

  it('is null for a wire that was never reversed, which is almost all of them', () => {
    expect(returnOfFunds(outbound({ reversal: null }))).toBeNull();
  });
});

describe('inbound statuses', () => {
  it('settles an accepted wire at its ACCEPTANCE time', () => {
    const event = inboundWireEvent(inbound({ status: 'accepted' }), EVENT);
    expect(event.type).toBe('settled');
    if (event.type !== 'settled') throw new Error('unreachable');
    expect(event.settledAt).toBe('2026-09-11T03:59:29Z');
    expect(event.amount.amount).toBe(1250000n);
  });

  it('keeps an arrival settled after we send it back out', () => {
    // The statement for the day the wire landed must keep saying it landed.
    const event = inboundWireEvent(MEASURED_INBOUND_WIRE, EVENT);
    expect(MEASURED_INBOUND_WIRE.status).toBe('reversed');
    expect(event.type).toBe('settled');
  });

  it('declines without crediting, and never as a return', () => {
    const event = inboundWireEvent(inbound({ status: 'declined' }), EVENT);
    expect(event.type).toBe('failed');
    if (event.type !== 'failed') throw new Error('unreachable');
    expect(event.reason.category).toBe('blocked');
  });

  it('reads an accepted arrival as a bookable credit, and a pending one as nothing', () => {
    const credit = inboundCredit(MEASURED_INBOUND_WIRE);
    expect(credit?.amount.amount).toBe(1250000n);
    expect(credit?.imad).toBe('20260911conbtmwu493867');
    expect(credit?.returnOfWireTransferId).toBeNull();

    // Not our money until it is accepted, and a wire has no receivable stage
    // to park it in — there is no wire equivalent of account 1130.
    expect(inboundCredit(inbound({ status: 'pending', acceptance: null }))).toBeNull();
  });
});

describe('the settlement identity is the IMAD', () => {
  it('prefers the network`s name for the message over the provider`s', () => {
    // The strongest of the three settlement identities in the contract,
    // because it is the NETWORK's. Two providers describing the same Fedwire
    // message agree on the IMAD; they do not agree on their own transfer ids.
    expect(wireSettlementRef('20260911sgzamiaa787670', 'sandbox_wire_transfer_x')).toBe(
      '20260911sgzamiaa787670',
    );
  });

  it('falls back to the provider id only when there is no message yet', () => {
    expect(wireSettlementRef(null, 'sandbox_wire_transfer_x')).toBe('sandbox_wire_transfer_x');
    expect(wireSettlementRef('', 'sandbox_wire_transfer_x')).toBe('sandbox_wire_transfer_x');
    expect(wireSettlementRef(undefined, 'sandbox_wire_transfer_x')).toBe('sandbox_wire_transfer_x');
  });
});

describe('the rail_event_semantics key', () => {
  it('nests the status, because one category covers the whole lifecycle', () => {
    expect(wireSemanticsKey('wire_transfer.updated', 'complete')).toBe(
      'wire_transfer.updated/complete',
    );
    expect(wireSemanticsKey('wire_transfer.updated', 'reversed')).toBe(
      'wire_transfer.updated/reversed',
    );
    expect(wireSemanticsKey('inbound_wire_transfer.updated', 'reversed')).toBe(
      'inbound_wire_transfer.updated/reversed',
    );
  });

  it('leaves `.created` unnested — there is only one thing it can mean', () => {
    expect(wireSemanticsKey('wire_transfer.created', 'pending_creating')).toBe(
      'wire_transfer.created',
    );
    expect(wireSemanticsKey('inbound_wire_transfer.created', 'accepted')).toBe(
      'inbound_wire_transfer.created',
    );
  });
});
