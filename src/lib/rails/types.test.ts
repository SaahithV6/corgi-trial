/**
 * Tests for the shared rail interface.
 *
 * The most valuable assertions in this file are the ones that never run: the
 * three `const _x: PaymentRail = ...` stubs below are COMPILE-TIME proofs that
 * an ACH rail, a card rail and a USDC rail all satisfy one interface without it
 * growing an ACH-shaped bulge. If someone widens `PaymentRail` for ACH's
 * benefit, the card and USDC stubs stop compiling and `pnpm typecheck` fails —
 * which is the only kind of architectural rule that actually holds.
 */

import { describe, expect, it } from 'vitest';

import {
  assertLive,
  deserializeMoney,
  evidenceLabel,
  isSimulated,
  RAIL_EVENT_TYPES,
  RailError,
  serializeMoney,
  toMinorUnits,
  usd,
  type Money,
  type PaymentRail,
  type RailCapabilities,
  type RailEvent,
  type RailTransfer,
  type TransferRequest,
} from './types';

describe('money', () => {
  it('is integer minor units as bigint', () => {
    expect(usd(12_345n)).toEqual({ amount: 12_345n, currency: 'USD' });
    expect(usd(12_345)).toEqual({ amount: 12_345n, currency: 'USD' });
  });

  it('refuses a float rather than truncating it', () => {
    expect(() => usd(12.34)).toThrow(TypeError);
    expect(() => toMinorUnits(0.1 + 0.2)).toThrow(TypeError);
  });

  it('refuses a number past the safe integer range', () => {
    expect(() => toMinorUnits(Number.MAX_SAFE_INTEGER + 2)).toThrow(TypeError);
  });

  it('round-trips through JSON as a string, because bigint cannot', () => {
    const money = usd(999_99n);
    const wire = serializeMoney(money);
    expect(JSON.stringify(wire)).toBe('{"amount":"99999","currency":"USD"}');
    expect(deserializeMoney(wire)).toEqual(money);
    // The reason the helpers exist at all:
    expect(() => JSON.stringify({ amount: money.amount })).toThrow(TypeError);
  });

  it('carries USDC micro-units without losing precision', () => {
    // 12345678901234567890 base units is well past Number.MAX_SAFE_INTEGER.
    const huge: Money = { amount: 12345678901234567890n, currency: 'USDC' };
    expect(deserializeMoney(serializeMoney(huge)).amount).toBe(12345678901234567890n);
    // The reason the interface is bigint and not number: a round trip through
    // `number` silently loses the low digits, and this is a balance.
    expect(BigInt(Number(huge.amount))).not.toBe(huge.amount);
    expect(Number.isSafeInteger(Number(huge.amount))).toBe(false);
  });
});

describe('evidence', () => {
  const live = { evidence: 'live' } as const;
  const simulated = { evidence: 'simulated' } as const;

  it('labels for humans', () => {
    expect(evidenceLabel('live')).toBe('LIVE');
    expect(evidenceLabel('simulated')).toBe('SIMULATED');
  });

  it('assertLive passes a live value through', () => {
    expect(assertLive(live)).toBe(live);
    expect(isSimulated(live)).toBe(false);
  });

  it('assertLive THROWS on a simulated value rather than returning false', () => {
    // A boolean is forgettable. A throw is not, and the failure being defended
    // against is a caller who forgot to look.
    expect(() => assertLive(simulated, 'transfer')).toThrow(RailError);
    expect(() => assertLive(simulated, 'transfer')).toThrow(/simulated transfer as live/);
    expect(isSimulated(simulated)).toBe(true);
  });
});

describe('the event union', () => {
  it('has exactly the seven normalised types, including unknown', () => {
    expect([...RAIL_EVENT_TYPES].sort()).toEqual(
      ['canceled', 'correction', 'failed', 'returned', 'settled', 'submitted', 'unknown'].sort(),
    );
  });

  it('an unknown event is a complete event, not a stub', () => {
    // The point of `unknown` is that the route can still answer 200 with a
    // well-formed event rather than throwing and collecting a 5xx that gets the
    // subscription disabled.
    const event: RailEvent = {
      provider: 'increase.ach',
      railKind: 'ach',
      evidence: 'live',
      eventId: 'event_1',
      transferId: 'ach_transfer_1',
      occurredAt: '2026-01-05T09:00:00.000Z',
      raw: {},
      type: 'unknown',
      providerType: 'ach_transfer.some_future_thing',
      reason: 'unmodelled_event',
    };
    expect(event.type).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Compile-time conformance. These stubs exist to be type-checked, not run.
// ---------------------------------------------------------------------------

const notCalled = (): never => {
  throw new Error('conformance stub');
};

/**
 * A CARD rail behind the same interface. Note what it does not have to know:
 * nothing about SEC codes, nothing about routing numbers, nothing about return
 * windows measured in banking days. A chargeback is a `returned` event with an
 * `unauthorized` category and the network's own reason code — the same shape an
 * R10 takes, which is exactly why the ledger's retry logic is written once.
 *
 * (`../lithic/client.ts` is the real one; it is a function module rather than a
 * class, and this stub is the shape an adapter over it takes. Lithic's
 * `Cents = number` becomes bigint at that boundary and nowhere else.)
 */
const _cardRail: PaymentRail = {
  capabilities: {
    kind: 'card',
    provider: 'lithic.card',
    evidence: 'live',
    environment: 'sandbox',
    supportsCredit: true,
    supportsDebit: true,
    supportsReturns: true,
    // Chargeback rights run months, not days. Same field, same meaning.
    returnWindowDays: 120,
    supportsIdempotency: true,
    supportsAccountCorrection: true,
  } satisfies RailCapabilities,
  initiateCredit: (_req: TransferRequest): Promise<RailTransfer> => notCalled(),
  initiateDebit: (_req: TransferRequest): Promise<RailTransfer> => notCalled(),
  getTransfer: (_id: string): Promise<RailTransfer> => notCalled(),
  parseEvent: (_raw: string): Promise<RailEvent> => notCalled(),
};

/**
 * A USDC rail behind the same interface. `supportsDebit: false` and
 * `returnWindowDays: null` are the whole difference: an on-chain transfer
 * cannot be pulled and cannot be clawed back, so the fields that drive holds
 * and dunning are absent rather than zero. `initiateDebit` rejects.
 */
const _usdcRail: PaymentRail = {
  capabilities: {
    kind: 'usdc',
    provider: 'base-sepolia.usdc',
    evidence: 'live',
    environment: 'sandbox',
    supportsCredit: true,
    supportsDebit: false,
    supportsReturns: false,
    returnWindowDays: null,
    supportsIdempotency: true,
    supportsAccountCorrection: false,
  } satisfies RailCapabilities,
  initiateCredit: (_req: TransferRequest): Promise<RailTransfer> => notCalled(),
  initiateDebit: (_req: TransferRequest): Promise<RailTransfer> =>
    Promise.reject(
      new RailError('usdc cannot pull funds', {
        provider: 'base-sepolia.usdc',
        code: 'unsupported_operation',
        retryable: false,
        evidence: 'live',
      }),
    ),
  getTransfer: (_id: string): Promise<RailTransfer> => notCalled(),
  parseEvent: (_raw: string): Promise<RailEvent> => notCalled(),
};

describe('one interface, three rails', () => {
  it('card and USDC satisfy PaymentRail without any ACH vocabulary', () => {
    expect(_cardRail.capabilities.kind).toBe('card');
    expect(_usdcRail.capabilities.kind).toBe('usdc');
    // The USDC rail is the interesting one: returns are impossible, so the
    // return window is null rather than 0. Null means "the question does not
    // apply"; 0 would mean "funds are spendable immediately", and a hold policy
    // that cannot tell those apart is a hold policy waiting to be wrong.
    expect(_usdcRail.capabilities.returnWindowDays).toBeNull();
    expect(_cardRail.capabilities.returnWindowDays).toBe(120);
  });

  it('a rail that cannot pull funds rejects with a non-retryable RailError', async () => {
    await expect(
      _usdcRail.initiateDebit({
        clientReferenceId: 'x',
        sourceAccountId: 'y',
        destination: { type: 'usdc', chain: 'base-sepolia', address: '0x0' },
        amount: { amount: 1n, currency: 'USDC' },
        statementDescriptor: 'X',
      }),
    ).rejects.toMatchObject({ code: 'unsupported_operation', retryable: false });
  });
});
