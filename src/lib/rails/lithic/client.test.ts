import { afterEach, describe, expect, it } from 'vitest';

import {
  createCard,
  getTransaction,
  LithicApiError,
  LithicConfigError,
  normalizeTransaction,
  simulateAuthorize,
  simulateClearing,
  simulateReturn,
  simulateVoid,
} from './client';
import { RateLimiter } from './ratelimit';
import type { Transaction, TransactionEvent, TransactionEventType } from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * Fixtures built from the numbers MEASURED against the live sandbox
 * (DECISIONS.md 006). These are the exact states the adapter must survive.
 *
 *   authorize 1000            status=PENDING   hold=-1000  settled=0
 *   clearing 600  (partial)   status=SETTLED   hold=-400   settled=-600
 *   clearing 300  (2nd)       status=SETTLED   hold=-100   settled=-900
 *   authorize 5000            status=PENDING   hold=-5000  settled=0
 *   clearing 7340 (over-cap)  status=SETTLED   hold=0      settled=-7340
 *   FINANCIAL_AUTHORIZATION   status=SETTLED   hold=0      settled=-2500
 *
 * Note the two traps encoded here: `status` reads SETTLED while a hold is still
 * outstanding, and every hold/settlement figure is signed NEGATIVE.
 * ──────────────────────────────────────────────────────────────────────────── */

function event(type: TransactionEventType, signedAmount: number): TransactionEvent {
  return {
    token: `evt_${type}_${Math.abs(signedAmount)}`,
    type,
    created: '2026-09-10T01:00:00Z',
    amount: signedAmount,
    amounts: {
      cardholder: { amount: signedAmount, conversion_rate: '1.0', currency: 'USD' },
      merchant: { amount: signedAmount, currency: 'USD' },
      settlement: { amount: signedAmount, currency: 'USD' },
    },
    effective_polarity: 'DEBIT',
    result: 'APPROVED',
  };
}

function txn(
  status: Transaction['status'],
  holdAmount: number,
  settlementAmount: number,
  events: TransactionEvent[],
): Transaction {
  return {
    token: 'txn_measured',
    account_token: 'acct_1',
    card_token: 'card_1',
    created: '2026-09-10T01:00:00Z',
    updated: '2026-09-10T01:00:05Z',
    status,
    result: 'APPROVED',
    amounts: {
      cardholder: { amount: settlementAmount, conversion_rate: '1.0', currency: 'USD' },
      hold: { amount: holdAmount, currency: 'USD' },
      merchant: { amount: settlementAmount, currency: 'USD' },
      settlement: { amount: settlementAmount, currency: 'USD' },
    },
    events,
  };
}

const AUTH_1000 = txn('PENDING', -1000, 0, [event('AUTHORIZATION', -1000)]);
const AFTER_CLEARING_600 = txn('SETTLED', -400, -600, [
  event('AUTHORIZATION', -1000),
  event('CLEARING', -600),
]);
const AFTER_CLEARING_300 = txn('SETTLED', -100, -900, [
  event('AUTHORIZATION', -1000),
  event('CLEARING', -600),
  event('CLEARING', -300),
]);
const OVER_CAPTURE = txn('SETTLED', 0, -7340, [
  event('AUTHORIZATION', -5000),
  event('CLEARING', -7340),
]);
const FINANCIAL_AUTH = txn('SETTLED', 0, -2500, [event('FINANCIAL_AUTHORIZATION', -2500)]);

describe('normalizeTransaction — measured sandbox states', () => {
  it('auth 1000: PENDING, hold 1000, settled 0', () => {
    const n = normalizeTransaction(AUTH_1000);
    expect(n.providerStatus).toBe('PENDING');
    expect(n.providerSaysSettled).toBe(false);
    expect(n.holdCents).toBe(1000);
    expect(n.settledCents).toBe(0);
    expect(n.hasOutstandingHold).toBe(true);
    expect(n.events).toEqual([
      expect.objectContaining({ type: 'AUTHORIZATION', amountCents: 1000 }),
    ]);
  });

  it('THE TRAP: after a partial clearing of 600 the status says SETTLED but 400 is still held', () => {
    const n = normalizeTransaction(AFTER_CLEARING_600);
    expect(n.providerStatus).toBe('SETTLED');
    expect(n.providerSaysSettled).toBe(true);
    // The obvious implementation releases the hold here and frees 400 cents
    // that are still authorised.
    expect(n.holdCents).toBe(400);
    expect(n.settledCents).toBe(600);
    expect(n.hasOutstandingHold).toBe(true);
    expect(n.providerSaysSettled && n.hasOutstandingHold).toBe(true);
  });

  it('second clearing of 300: hold 100, settled 900, still reporting SETTLED', () => {
    const n = normalizeTransaction(AFTER_CLEARING_300);
    expect(n.providerStatus).toBe('SETTLED');
    expect(n.holdCents).toBe(100);
    expect(n.settledCents).toBe(900);
    expect(n.hasOutstandingHold).toBe(true);
    expect(n.events.map((e) => e.amountCents)).toEqual([1000, 600, 300]);
  });

  it('over-capture (auth 5000, clearing 7340): hold 0, settled 7340', () => {
    const n = normalizeTransaction(OVER_CAPTURE);
    expect(n.holdCents).toBe(0);
    expect(n.settledCents).toBe(7340);
    expect(n.hasOutstandingHold).toBe(false);
    // max(5000 - 7340, 0) — the hold cannot go negative.
    expect(n.eventDerivedHoldCents).toBe(0);
  });

  it('FINANCIAL_AUTHORIZATION settles immediately and never holds', () => {
    const n = normalizeTransaction(FINANCIAL_AUTH);
    expect(n.providerSaysSettled).toBe(true);
    expect(n.holdCents).toBe(0);
    expect(n.settledCents).toBe(2500);
    expect(n.eventDerivedHoldCents).toBe(0);
    expect(n.hasOutstandingHold).toBe(false);
  });

  it('normalises the sign: every exposed amount is a positive magnitude', () => {
    for (const t of [AUTH_1000, AFTER_CLEARING_600, AFTER_CLEARING_300, OVER_CAPTURE]) {
      const n = normalizeTransaction(t);
      expect(n.holdCents).toBeGreaterThanOrEqual(0);
      expect(n.settledCents).toBeGreaterThanOrEqual(0);
      for (const e of n.events) expect(e.amountCents).toBeGreaterThanOrEqual(0);
    }
  });

  it('preserves the raw provider fields, signs and all', () => {
    const n = normalizeTransaction(AFTER_CLEARING_600);
    expect(n.raw).toEqual({
      status: 'SETTLED',
      result: 'APPROVED',
      holdAmount: -400,
      settlementAmount: -600,
      holdCurrency: 'USD',
      settlementCurrency: 'USD',
    });
  });
});

describe('normalizeTransaction — hold derived from events', () => {
  it('reproduces the provider hold in every measured case', () => {
    const cases: Array<[Transaction, number]> = [
      [AUTH_1000, 1000],
      [AFTER_CLEARING_600, 400],
      [AFTER_CLEARING_300, 100],
      [OVER_CAPTURE, 0],
      [FINANCIAL_AUTH, 0],
    ];
    for (const [t, expected] of cases) {
      const n = normalizeTransaction(t);
      expect(n.eventDerivedHoldCents).toBe(expected);
      expect(n.holdCents).toBe(expected);
      expect(n.holdMatchesEvents).toBe(true);
    }
  });

  it('treats an authorization advice as an absolute override, not a delta', () => {
    // 1000 -> advice 1500 -> clearing 1200 leaves 300, not 800.
    const advised = txn('SETTLED', -300, -1200, [
      event('AUTHORIZATION', -1000),
      event('AUTHORIZATION_ADVICE', -1500),
      event('CLEARING', -1200),
    ]);
    expect(normalizeTransaction(advised).eventDerivedHoldCents).toBe(300);
  });

  it('counts a reversal as releasing the hold', () => {
    const reversed = txn('PENDING', -800, 0, [
      event('AUTHORIZATION', -1000),
      event('AUTHORIZATION_REVERSAL', -200),
    ]);
    const n = normalizeTransaction(reversed);
    expect(n.eventDerivedHoldCents).toBe(800);
    expect(n.holdMatchesEvents).toBe(true);
  });

  it('flags divergence between the provider hold and the event set', () => {
    // Provider says 400 held; the events only account for 100. That is a
    // reconciliation break, not something to paper over.
    const diverged = txn('SETTLED', -400, -900, [
      event('AUTHORIZATION', -1000),
      event('CLEARING', -900),
    ]);
    const n = normalizeTransaction(diverged);
    expect(n.holdCents).toBe(400);
    expect(n.eventDerivedHoldCents).toBe(100);
    expect(n.holdMatchesEvents).toBe(false);
  });

  it('does not claim divergence when the list view omitted events', () => {
    const listRow = txn('PENDING', -1000, 0, []);
    delete listRow.events;
    const n = normalizeTransaction(listRow);
    expect(n.events).toEqual([]);
    expect(n.holdMatchesEvents).toBe(true);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * Request construction, against a fake fetch. No network is touched.
 * ──────────────────────────────────────────────────────────────────────────── */

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

function fakeFetch(
  responses: Array<{ status?: number; json?: unknown; headers?: Record<string, string> }>,
): { fetchImpl: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  let index = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const spec = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    });
    return new Response(JSON.stringify(spec.json ?? {}), {
      status: spec.status ?? 200,
      headers: { 'content-type': 'application/json', ...spec.headers },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A limiter that never actually waits, so the suite is not paced at 1 RPS. */
const fastLimiter = (): RateLimiter => new RateLimiter({ limit: 1_000, windowMs: 1 });

const TEST_KEY = 'e65e2478-f516-4c9d-af36-7d1ebc5414fd';

const originalKey = process.env.LITHIC_API_KEY;
afterEach(() => {
  if (originalKey === undefined) delete process.env.LITHIC_API_KEY;
  else process.env.LITHIC_API_KEY = originalKey;
});

describe('client — transport', () => {
  it('sends the RAW key as Authorization, with no Bearer prefix', async () => {
    const { fetchImpl, calls } = fakeFetch([{ json: { token: 't' } }]);
    await getTransaction('txn_1', { apiKey: TEST_KEY, fetchImpl, limiter: fastLimiter() });
    expect(calls[0]?.headers.Authorization).toBe(TEST_KEY);
    expect(calls[0]?.headers.Authorization).not.toMatch(/^Bearer /);
  });

  it('targets the sandbox base URL including /v1', async () => {
    const { fetchImpl, calls } = fakeFetch([{ json: { token: 't' } }]);
    await getTransaction('txn_1', { apiKey: TEST_KEY, fetchImpl, limiter: fastLimiter() });
    expect(calls[0]?.url).toBe('https://sandbox.lithic.com/v1/transactions/txn_1');
  });

  it('reads the API key from the environment at call time, not at import time', async () => {
    delete process.env.LITHIC_API_KEY;
    const { fetchImpl, calls } = fakeFetch([{ json: {} }]);

    await expect(
      getTransaction('txn_1', { fetchImpl, limiter: fastLimiter() }),
    ).rejects.toThrow(LithicConfigError);

    // Key arrives after the module was already loaded.
    process.env.LITHIC_API_KEY = 'set-later';
    await getTransaction('txn_1', { fetchImpl, limiter: fastLimiter() });
    expect(calls[0]?.headers.Authorization).toBe('set-later');
  });

  it('retries a 429 and honours retry-after', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 429, json: { message: 'rate limited' }, headers: { 'retry-after': '0' } },
      { status: 200, json: { token: 'txn_1' } },
    ]);
    const result = await getTransaction('txn_1', {
      apiKey: TEST_KEY,
      fetchImpl,
      limiter: fastLimiter(),
    });
    expect(calls).toHaveLength(2);
    expect(result.token).toBe('txn_1');
  });

  it('surfaces a 422 as a LithicApiError carrying the debugging id', async () => {
    const { fetchImpl } = fakeFetch([
      {
        status: 422,
        json: { message: 'Exceeds transaction limit', debugging_request_id: 'dbg_1' },
      },
    ]);
    const error = await simulateAuthorize(
      { amount: 100, descriptor: 'X', pan: '4111111111111111' },
      { apiKey: TEST_KEY, fetchImpl, limiter: fastLimiter(), maxRateLimitRetries: 0 },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LithicApiError);
    expect((error as LithicApiError).status).toBe(422);
    expect((error as LithicApiError).message).toBe('Exceeds transaction limit');
    expect((error as LithicApiError).debuggingRequestId).toBe('dbg_1');
  });
});

describe('client — simulateAuthorize body', () => {
  it('always sends merchant_amount together with merchant_currency', async () => {
    // MEASURED: merchant_currency alone is rejected with
    // "'merchant_currency' requires that 'merchant_amount' is set" — and
    // omitting the currency makes the simulator default to GBP.
    const { fetchImpl, calls } = fakeFetch([{ status: 201, json: { token: 'txn_1' } }]);
    await simulateAuthorize(
      { amount: 3831, descriptor: 'COFFEE SHOP', pan: '4111111111111111' },
      { apiKey: TEST_KEY, fetchImpl, limiter: fastLimiter() },
    );

    expect(calls[0]?.url).toBe('https://sandbox.lithic.com/v1/simulate/authorize');
    expect(calls[0]?.body).toEqual({
      amount: 3831,
      merchant_amount: 3831,
      merchant_currency: 'USD',
      descriptor: 'COFFEE SHOP',
      pan: '4111111111111111',
      status: 'AUTHORIZATION',
    });
  });

  it('lets the caller drive a single-message settle via FINANCIAL_AUTHORIZATION', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, json: { token: 'txn_2' } }]);
    await simulateAuthorize(
      {
        amount: 2500,
        descriptor: 'ATM',
        pan: '4111111111111111',
        status: 'FINANCIAL_AUTHORIZATION',
      },
      { apiKey: TEST_KEY, fetchImpl, limiter: fastLimiter() },
    );
    expect(calls[0]?.body?.status).toBe('FINANCIAL_AUTHORIZATION');
  });

  it('rejects a non-integer amount before it reaches the wire', async () => {
    const { fetchImpl, calls } = fakeFetch([{ json: {} }]);
    await expect(
      simulateAuthorize(
        { amount: 38.31, descriptor: 'X', pan: '4111111111111111' },
        { apiKey: TEST_KEY, fetchImpl, limiter: fastLimiter() },
      ),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe('client — simulateClearing body', () => {
  it('omits amount entirely to clear the full authorised amount', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, json: {} }]);
    await simulateClearing(
      { token: 'txn_1' },
      { apiKey: TEST_KEY, fetchImpl, limiter: fastLimiter() },
    );
    expect(calls[0]?.body).toEqual({ token: 'txn_1' });
    expect(calls[0]?.body).not.toHaveProperty('amount');
  });

  it('sends a partial clearing amount when given one', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, json: {} }]);
    await simulateClearing(
      { token: 'txn_1', amountCents: 600 },
      { apiKey: TEST_KEY, fetchImpl, limiter: fastLimiter() },
    );
    expect(calls[0]?.body).toEqual({ token: 'txn_1', amount: 600 });
  });
});

describe('client — simulateVoid body', () => {
  it('omits amount rather than sending 0, which Lithic accepts as a no-op void', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, json: {} }]);
    await simulateVoid(
      { token: 'txn_1' },
      { apiKey: TEST_KEY, fetchImpl, limiter: fastLimiter() },
    );
    expect(calls[0]?.body).toEqual({ token: 'txn_1' });
  });

  it('refuses an explicit zero-amount void', async () => {
    const { fetchImpl, calls } = fakeFetch([{ json: {} }]);
    await expect(
      simulateVoid(
        { token: 'txn_1', amountCents: 0 },
        { apiKey: TEST_KEY, fetchImpl, limiter: fastLimiter() },
      ),
    ).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });

  it('passes the void type through', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, json: {} }]);
    await simulateVoid(
      { token: 'txn_1', amountCents: 1000, type: 'AUTHORIZATION_EXPIRY' },
      { apiKey: TEST_KEY, fetchImpl, limiter: fastLimiter() },
    );
    expect(calls[0]?.body).toEqual({
      token: 'txn_1',
      amount: 1000,
      type: 'AUTHORIZATION_EXPIRY',
    });
  });
});

describe('client — cards and returns', () => {
  it('sends an Idempotency-Key on card creation', async () => {
    const { fetchImpl, calls } = fakeFetch([{ json: { token: 'card_1' } }]);
    await createCard(
      { type: 'VIRTUAL', memo: 'corgi', spend_limit: 500_000, spend_limit_duration: 'MONTHLY' },
      { apiKey: TEST_KEY, fetchImpl, limiter: fastLimiter() },
    );
    expect(calls[0]?.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]?.body).toEqual({
      type: 'VIRTUAL',
      memo: 'corgi',
      spend_limit: 500_000,
      spend_limit_duration: 'MONTHLY',
    });
  });

  it('honours a caller-supplied idempotency key', async () => {
    const { fetchImpl, calls } = fakeFetch([{ json: { token: 'card_1' } }]);
    await createCard(
      { type: 'VIRTUAL' },
      {
        apiKey: TEST_KEY,
        fetchImpl,
        limiter: fastLimiter(),
        idempotencyKey: 'ledger-row-42',
      },
    );
    expect(calls[0]?.headers['Idempotency-Key']).toBe('ledger-row-42');
  });

  it('sends a return keyed by PAN, not by transaction token', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 201, json: { token: 'txn_ret' } }]);
    await simulateReturn(
      { amount: 2934, descriptor: 'COFFEE SHOP', pan: '4111111111111111' },
      { apiKey: TEST_KEY, fetchImpl, limiter: fastLimiter() },
    );
    expect(calls[0]?.body).toEqual({
      amount: 2934,
      descriptor: 'COFFEE SHOP',
      pan: '4111111111111111',
    });
    expect(calls[0]?.body).not.toHaveProperty('token');
  });
});
