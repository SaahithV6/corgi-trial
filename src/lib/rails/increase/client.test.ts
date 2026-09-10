/**
 * Tests for the LIVE Increase adapter.
 *
 * NO NETWORK. Every test injects a fake `fetch`; there is no Increase key in
 * this repo and this suite must never need one. What is being tested is the
 * mapping — which is where the money bugs are — not Increase's HTTP behaviour.
 *
 * The two that matter most:
 *   - `promotes submitted + settlement.settled_at to settled`
 *   - `parseEvent reads the transfer back, because the body is a pointer`
 */

import { describe, expect, it } from 'vitest';

import {
  IncreaseAchRail,
  INCREASE_PROVIDER,
  mapIncreaseReturnReason,
  normaliseRCode,
  SEC_CODE_BY_AUTHORIZATION,
  type IncreaseAchTransfer,
} from './client';
import { RailError, usd, type Destination, type TransferRequest } from '../types';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const ACH_DESTINATION: Extract<Destination, { type: 'ach' }> = {
  type: 'ach',
  routingNumber: '101050001',
  accountNumber: '987654321',
  accountType: 'checking',
  holderName: 'Ian Crease',
  holderKind: 'individual',
  authorization: 'consumer_online',
};

function request(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    clientReferenceId: 'cref-1',
    sourceAccountId: 'account_in71c4amph0vgo2qllky',
    destination: ACH_DESTINATION,
    amount: usd(12_345n),
    statementDescriptor: 'CORGI PAY',
    ...overrides,
  };
}

function transfer(overrides: Partial<IncreaseAchTransfer> = {}): IncreaseAchTransfer {
  return {
    id: 'ach_transfer_uoxatyh3lt5evrsdvo7q',
    type: 'ach_transfer',
    account_id: 'account_in71c4amph0vgo2qllky',
    amount: 12_345,
    currency: 'USD',
    status: 'submitted',
    created_at: '2026-01-05T09:00:00Z',
    idempotency_key: 'cref-1',
    routing_number: '101050001',
    account_number: '987654321',
    external_account_id: null,
    standard_entry_class_code: 'internet_initiated',
    statement_descriptor: 'CORGI PAY',
    acknowledgement: null,
    submission: { submitted_at: '2026-01-05T09:05:00Z', trace_number: '123456789012345' },
    settlement: null,
    return: null,
    notifications_of_change: [],
    transaction_id: null,
    ...overrides,
  };
}

interface Recorded {
  url: string;
  init: RequestInit;
}

function fakeFetch(
  responder: (url: string, init: RequestInit) => { status?: number; body: unknown },
): { fetchImpl: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const { status = 200, body } = responder(url, init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function railWith(
  responder: (url: string, init: RequestInit) => { status?: number; body: unknown },
): { rail: IncreaseAchRail; calls: Recorded[] } {
  const { fetchImpl, calls } = fakeFetch(responder);
  return {
    rail: new IncreaseAchRail({ apiKey: 'test-key', baseUrl: 'https://sandbox.increase.com', fetchImpl }),
    calls,
  };
}

function headerOf(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.[name];
}

// ---------------------------------------------------------------------------

describe('capabilities', () => {
  it('is live evidence, sandbox by default, with a 60-day return window', () => {
    const { rail } = railWith(() => ({ body: transfer() }));
    expect(rail.capabilities).toMatchObject({
      kind: 'ach',
      provider: INCREASE_PROVIDER,
      evidence: 'live',
      environment: 'sandbox',
      supportsReturns: true,
      returnWindowDays: 60,
    });
  });

  it('knows it is production when pointed at the production host', () => {
    const rail = new IncreaseAchRail({ apiKey: 'k', baseUrl: 'https://api.increase.com' });
    expect(rail.capabilities.environment).toBe('production');
  });
});

describe('creating transfers', () => {
  it('sends a POSITIVE amount for a credit and a NEGATIVE one for a debit', async () => {
    const { rail, calls } = railWith(() => ({ body: transfer() }));
    await rail.initiateCredit(request());
    await rail.initiateDebit(request({ clientReferenceId: 'cref-2' }));

    const credit = JSON.parse(String(calls[0]?.init.body)) as { amount: number };
    const debit = JSON.parse(String(calls[1]?.init.body)) as { amount: number };
    expect(credit.amount).toBe(12_345);
    // The sign IS the direction. One endpoint, both ways.
    expect(debit.amount).toBe(-12_345);
  });

  it('reaches the SEC code through the authorisation intent, never from the caller', async () => {
    const { rail, calls } = railWith(() => ({ body: transfer() }));
    await rail.initiateDebit(request());
    const body = JSON.parse(String(calls[0]?.init.body)) as { standard_entry_class_code: string };
    // consumer_online -> WEB
    expect(body.standard_entry_class_code).toBe('internet_initiated');

    expect(SEC_CODE_BY_AUTHORIZATION).toEqual({
      business_agreement: 'corporate_credit_or_debit', // CCD
      consumer_written: 'prearranged_payments_and_deposit', // PPD
      consumer_online: 'internet_initiated', // WEB
      business_remittance: 'corporate_trade_exchange', // CTX
    });
  });

  it('uses the client reference id as the idempotency key', async () => {
    const { rail, calls } = railWith(() => ({ body: transfer() }));
    await rail.initiateCredit(request({ clientReferenceId: 'stable-key-1' }));
    expect(headerOf(calls[0]!.init, 'Idempotency-Key')).toBe('stable-key-1');
    expect(headerOf(calls[0]!.init, 'Authorization')).toBe('Bearer test-key');
  });

  it('prefers a stored external account over raw account numbers', async () => {
    const { rail, calls } = railWith(() => ({ body: transfer() }));
    await rail.initiateCredit(
      request({
        destination: { ...ACH_DESTINATION, externalAccountId: 'external_account_1' },
      }),
    );
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['external_account_id']).toBe('external_account_1');
    expect(body['account_number']).toBeUndefined();
  });

  it('refuses a non-ACH destination, a non-USD amount and a non-positive amount', async () => {
    const { rail } = railWith(() => ({ body: transfer() }));
    await expect(
      rail.initiateCredit(request({ destination: { type: 'card', cardTokenId: 'card_1' } })),
    ).rejects.toMatchObject({ code: 'unsupported_destination', retryable: false, evidence: 'live' });
    await expect(
      rail.initiateCredit(request({ amount: { amount: 1n, currency: 'USDC' } })),
    ).rejects.toMatchObject({ code: 'unsupported_currency' });
    await expect(rail.initiateCredit(request({ amount: usd(0n) }))).rejects.toMatchObject({
      code: 'invalid_amount',
    });
  });

  it('refuses an amount too large for Increase JSON rather than truncating it', async () => {
    const { rail } = railWith(() => ({ body: transfer() }));
    await expect(
      rail.initiateCredit(request({ amount: { amount: 2n ** 60n, currency: 'USD' } })),
    ).rejects.toMatchObject({ code: 'invalid_amount' });
  });
});

describe('THE TRAP: there is no settled status', () => {
  it('leaves a transfer submitted when there is no settlement timestamp', async () => {
    const { rail } = railWith(() => ({ body: transfer({ status: 'submitted', settlement: null }) }));
    const t = await rail.getTransfer('ach_transfer_1');
    expect(t.status).toBe('submitted');
    expect(t.settledAt).toBeUndefined();
  });

  it('promotes submitted + settlement.settled_at to settled', async () => {
    // Increase's own status field still reads "submitted" here. An adapter that
    // maps status-to-status is correct on every value in the enum and still
    // never releases a hold, because the state it is waiting for is not in the
    // enum. This is the line that absorbs that.
    const { rail } = railWith(() => ({
      body: transfer({ status: 'submitted', settlement: { settled_at: '2026-01-06T14:00:00Z' } }),
    }));
    const t = await rail.getTransfer('ach_transfer_1');
    expect(t.status).toBe('settled');
    expect(t.settledAt).toBe('2026-01-06T14:00:00Z');
    // The provider's own view is preserved untouched for audit.
    expect((t.raw as IncreaseAchTransfer).status).toBe('submitted');
  });

  it('maps the direction from the sign of the amount, not from our request', async () => {
    const { rail } = railWith(() => ({ body: transfer({ amount: -5_000 }) }));
    const t = await rail.getTransfer('ach_transfer_1');
    expect(t.direction).toBe('debit');
    expect(t.amount).toEqual({ amount: 5_000n, currency: 'USD' });
  });
});

describe('return reasons', () => {
  it('normalises R01 while preserving Increase’s singular spelling', () => {
    const reason = mapIncreaseReturnReason({
      created_at: '2026-01-10T09:00:00Z',
      return_reason_code: 'insufficient_fund',
      raw_return_reason_code: 'R01',
      trace_number: null,
      transaction_id: null,
      transfer_id: 'ach_transfer_1',
    });
    expect(reason).toMatchObject({
      category: 'insufficient_funds',
      code: 'R01',
      providerCode: 'insufficient_fund',
      retryable: true,
    });
  });

  it('marks account_closed and no_account as non-retryable account problems', () => {
    for (const [name, code] of [
      ['account_closed', 'R02'],
      ['no_account', 'R03'],
    ] as const) {
      const reason = mapIncreaseReturnReason({
        created_at: '2026-01-10T09:00:00Z',
        return_reason_code: name,
        raw_return_reason_code: code,
        trace_number: null,
        transaction_id: null,
        transfer_id: 'ach_transfer_1',
      });
      expect(reason).toMatchObject({ category: 'account_invalid', code, retryable: false });
    }
  });

  it('keeps an unmapped provider code rather than dropping it', () => {
    const reason = mapIncreaseReturnReason({
      created_at: '2026-01-10T09:00:00Z',
      return_reason_code: 'some_reason_increase_added_last_tuesday',
      raw_return_reason_code: null,
      trace_number: null,
      transaction_id: null,
      transfer_id: 'ach_transfer_1',
    });
    expect(reason.category).toBe('unknown');
    expect(reason.retryable).toBe(false);
    expect(reason.providerCode).toBe('some_reason_increase_added_last_tuesday');
  });

  it('canonicalises R-codes', () => {
    expect(normaliseRCode('01')).toBe('R01');
    expect(normaliseRCode('r02')).toBe('R02');
    expect(normaliseRCode(null)).toBeNull();
  });
});

describe('parseEvent — the body is a pointer, not a payload', () => {
  const eventBody = (category: string, objectId: string) =>
    JSON.stringify({
      id: 'event_123abc',
      type: 'event',
      category,
      associated_object_id: objectId,
      associated_object_type: 'ach_transfer',
      created_at: '2026-01-06T14:00:01Z',
    });

  it('reads the transfer back, because the event carries no state', async () => {
    const { rail, calls } = railWith(() => ({
      body: transfer({ settlement: { settled_at: '2026-01-06T14:00:00Z' } }),
    }));
    const event = await rail.parseEvent(eventBody('ach_transfer.updated', 'ach_transfer_1'));
    expect(event.type).toBe('settled');
    expect(event.evidence).toBe('live');
    // The read-back is the whole mechanism: one GET per notification.
    expect(calls[0]?.url).toContain('/ach_transfers/ach_transfer_1');
  });

  it('turns a return into a returned event carrying its own amount', async () => {
    const { rail } = railWith(() => ({
      body: transfer({
        status: 'returned',
        amount: -5_000,
        settlement: { settled_at: '2026-01-06T14:00:00Z' },
        return: {
          created_at: '2026-01-10T09:00:00Z',
          return_reason_code: 'insufficient_fund',
          raw_return_reason_code: 'R01',
          trace_number: null,
          transaction_id: null,
          transfer_id: 'ach_transfer_1',
        },
      }),
    }));
    const event = await rail.parseEvent(eventBody('ach_transfer.updated', 'ach_transfer_1'));
    if (event.type !== 'returned') throw new Error(`expected returned, got ${event.type}`);
    // A SECOND MONEY MOVEMENT: the event carries the amount to post, so the
    // ledger appends an entry rather than editing the original one.
    expect(event.amount).toEqual({ amount: 5_000n, currency: 'USD' });
    expect(event.reason.code).toBe('R01');
    expect(event.returnedAt).toBe('2026-01-10T09:00:00Z');
  });

  it('reports a notification of change as a correction', async () => {
    const { rail } = railWith(() => ({
      body: transfer({
        notifications_of_change: [
          { created_at: '2026-01-06T10:00:00Z', change_code: 'C02', corrected_data: '110000000' },
        ],
      }),
    }));
    const event = await rail.parseEvent(eventBody('ach_transfer.updated', 'ach_transfer_1'));
    if (event.type !== 'correction') throw new Error(`expected correction, got ${event.type}`);
    expect(event.corrections[0]).toMatchObject({
      field: 'routing_number',
      correctedValue: '110000000',
      code: 'C02',
    });
  });

  it('reports a not-yet-submitted transfer as unknown/no_state_change', async () => {
    const { rail } = railWith(() => ({ body: transfer({ status: 'pending_submission' }) }));
    const event = await rail.parseEvent(eventBody('ach_transfer.created', 'ach_transfer_1'));
    if (event.type !== 'unknown') throw new Error(`expected unknown, got ${event.type}`);
    expect(event.reason).toBe('no_state_change');
  });

  it('NEVER THROWS on an unrecognised or unparseable body', async () => {
    const { rail, calls } = railWith(() => ({ body: transfer() }));

    const garbage = await rail.parseEvent('not json at all');
    expect(garbage.type).toBe('unknown');

    const empty = await rail.parseEvent('{}');
    expect(empty.type).toBe('unknown');

    const other = await rail.parseEvent(eventBody('inbound_ach_transfer.created', 'inbound_ach_transfer_9'));
    if (other.type !== 'unknown') throw new Error('expected unknown');
    expect(other.reason).toBe('unmodelled_event');

    // None of the three needed a read-back, so none of them cost an API call.
    expect(calls).toHaveLength(0);
  });

  it('DOES throw when the read-back fails, so the row is retried and not lost', async () => {
    const { rail } = railWith(() => ({ status: 500, body: { title: 'boom' } }));
    await expect(
      rail.parseEvent(eventBody('ach_transfer.updated', 'ach_transfer_1')),
    ).rejects.toBeInstanceOf(RailError);
  });
});

describe('errors', () => {
  it('marks 429 and 5xx retryable, and 4xx not', async () => {
    const rateLimited = railWith(() => ({ status: 429, body: { title: 'slow down', type: 'rate_limited_error' } }));
    await expect(rateLimited.rail.getTransfer('x')).rejects.toMatchObject({
      retryable: true,
      httpStatus: 429,
    });

    const badRequest = railWith(() => ({ status: 400, body: { title: 'bad', type: 'invalid_parameters_error' } }));
    await expect(badRequest.rail.getTransfer('x')).rejects.toMatchObject({
      retryable: false,
      code: 'invalid_parameters_error',
    });

    // A 409 is our idempotency key being reused with different parameters.
    // Retrying produces another 409, so it is deliberately not retryable.
    const conflict = railWith(() => ({
      status: 409,
      body: { type: 'idempotency_key_already_used_error' },
    }));
    await expect(conflict.rail.getTransfer('x')).rejects.toMatchObject({ retryable: false });
  });

  it('marks a network failure retryable, because the idempotency key makes a retry safe', async () => {
    const fetchImpl = (() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;
    const rail = new IncreaseAchRail({ apiKey: 'k', fetchImpl });
    await expect(rail.getTransfer('x')).rejects.toMatchObject({
      code: 'network_error',
      retryable: true,
      evidence: 'live',
    });
  });

  it('says where to look when the key is missing', async () => {
    const rail = new IncreaseAchRail({ apiKey: undefined, fetchImpl: (() => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch });
    const saved = process.env['INCREASE_API_KEY'];
    delete process.env['INCREASE_API_KEY'];
    try {
      await expect(rail.getTransfer('x')).rejects.toMatchObject({ code: 'not_configured' });
    } finally {
      if (saved !== undefined) process.env['INCREASE_API_KEY'] = saved;
    }
  });
});
