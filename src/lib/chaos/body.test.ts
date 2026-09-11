/**
 * The body tests: the measured arithmetic, and the marker.
 *
 * The amounts here are not invented. They are the row
 * `src/lib/rails/lithic/README.md` measured against the live sandbox:
 *
 *   | authorize 5000 then clearing 7340 | SETTLED | hold 0 | settlement -7340 |
 *
 * A chaos body whose aggregates contradicted its own events would trip
 * `providerDisagrees` in `src/lib/holds/apply.ts`, and the dashboard would be
 * showing a reconciliation break that chaos manufactured while claiming to show
 * the ledger surviving. So the arithmetic is asserted rather than assumed.
 */

import { describe, expect, it } from 'vitest';

import { chaosBody, newEpisodeIdentifiers } from './body';
import { CHAOS_AUTH_CENTS, CHAOS_CLEARING_CENTS, CHAOS_MARKER } from './types';

const OPTS = {
  runId: '11112222-3333-4444-5555-666677778888',
  transactionToken: 'aaaaaaaa-0000-0000-0000-000000000001',
  cardToken: 'bbbbbbbb-0000-0000-0000-000000000002',
  authCents: CHAOS_AUTH_CENTS,
  clearingCents: CHAOS_CLEARING_CENTS,
  created: new Date('2026-09-11T12:00:00.000Z'),
  shapedBy: 'reorder_window',
  authEventToken: 'cccccccc-0000-0000-0000-000000000003',
  clearingEventToken: 'dddddddd-0000-0000-0000-000000000004',
  descriptor: 'CORGI CHAOS TEST',
};

type Amounts = { hold: { amount: number }; settlement: { amount: number } | null };
type Body = {
  status: string;
  amounts: Amounts;
  settled_amount: number;
  events: { type: string; amount: number; amounts: Amounts; result: string; token: string }[];
  card_token: string;
  token: string;
  created: string;
  event_type: string;
  [key: string]: unknown;
};

describe('the fields the consumer actually reads', () => {
  it('carries the three fields `asCardTransaction` requires', () => {
    const body = chaosBody('authorization', OPTS) as unknown as Body;
    expect(typeof body.token).toBe('string');
    expect(typeof body.card_token).toBe('string');
    expect(Number.isNaN(Date.parse(body.created))).toBe(false);
  });

  it('is the one Lithic event type that carries the lifecycle', () => {
    const body = chaosBody('authorization', OPTS) as unknown as Body;
    expect(body.event_type).toBe('card_transaction.updated');
  });

  it('authorises APPROVED, not DECLINED', () => {
    // Migration 0026 exists because a refused authorisation and an approved one
    // used to be the same row, and every refusal raised the hold anyway. A
    // chaos episode must authorise for real or it demonstrates the bug.
    const body = chaosBody('authorization', OPTS) as unknown as Body;
    expect(body.events[0]?.result).toBe('APPROVED');
  });
});

describe('the authorisation body', () => {
  it('holds the authorised amount, signed negative per trap 2', () => {
    const body = chaosBody('authorization', OPTS) as unknown as Body;
    expect(body.amounts.hold.amount).toBe(-5000);
    expect(body.status).toBe('PENDING');
    expect(body.settled_amount).toBe(0);
  });

  it('carries exactly one event — the authorisation', () => {
    const body = chaosBody('authorization', OPTS) as unknown as Body;
    expect(body.events.map((e) => e.type)).toEqual(['AUTHORIZATION']);
  });

  it('leaves the event settlement null, so magnitude falls through to `amount`', () => {
    // `eventMagnitude()` in src/lib/holds/lithic-events.ts prefers
    // `amounts.settlement.amount` and falls back to the flat `amount`. The
    // sandbox sends null here and so does this.
    const body = chaosBody('authorization', OPTS) as unknown as Body;
    expect(body.events[0]?.amounts.settlement).toBeNull();
    expect(body.events[0]?.amount).toBe(5000);
  });
});

describe('the clearing body — the measured over-capture row', () => {
  it('clamps the hold at zero rather than going negative', () => {
    // max(5000 − 7340, 0) = 0. The README's measured row says the provider
    // reports 0 here too, so the two independent derivations agree and
    // `providerDisagrees` stays false.
    const body = chaosBody('clearing', OPTS) as unknown as Body;
    expect(body.amounts.hold.amount).toBe(0);
  });

  it('reports the settlement signed negative at the captured amount', () => {
    const body = chaosBody('clearing', OPTS) as unknown as Body;
    expect(body.amounts.settlement?.amount).toBe(-7340);
    expect(body.settled_amount).toBe(-7340);
  });

  it('says SETTLED, which is trap 1 and is not a statement about the money', () => {
    const body = chaosBody('clearing', OPTS) as unknown as Body;
    expect(body.status).toBe('SETTLED');
  });

  it('carries BOTH events, because that is what Lithic sends every time', () => {
    // This is also why the reorder control is an honest test: delivering this
    // body first hands the system an authorisation it has never heard of AND
    // the clearing that closes it, in one delivery, out of order.
    const body = chaosBody('clearing', OPTS) as unknown as Body;
    expect(body.events.map((e) => e.type)).toEqual(['AUTHORIZATION', 'CLEARING']);
  });

  it('captures more than it authorised — the fuel pump', () => {
    const body = chaosBody('clearing', OPTS) as unknown as Body;
    const clearing = body.events.find((e) => e.type === 'CLEARING');
    expect(clearing?.amount).toBeGreaterThan(Number(CHAOS_AUTH_CENTS));
  });
});

describe('the marker', () => {
  it('is a top-level key, so `payload -> $marker` finds it without a path', () => {
    const body = chaosBody('authorization', OPTS) as unknown as Record<string, unknown>;
    expect(body[CHAOS_MARKER]).toBeDefined();
  });

  it('names chaos as the origin and disclaims the provider', () => {
    const body = chaosBody('authorization', OPTS) as unknown as Record<string, unknown>;
    const mark = body[CHAOS_MARKER] as { origin: string; note: string; run_id: string };
    expect(mark.origin).toBe('corgi-chaos-mode');
    expect(mark.run_id).toBe(OPTS.runId);
    expect(mark.note).toMatch(/not by Lithic/);
  });

  it('records which control shaped this delivery', () => {
    const body = chaosBody('clearing', OPTS) as unknown as Record<string, unknown>;
    expect((body[CHAOS_MARKER] as { control: string }).control).toBe('reorder_window');
  });
});

describe('chaos does not alter a body to suit a control', () => {
  it('produces byte-identical bytes for the same slot however it was shaped', () => {
    // The four controls change WHEN a body leaves, HOW MANY copies leave and
    // IN WHAT ORDER. None of them changes a byte of what is inside — apart
    // from the marker, which exists to say so.
    const a = { ...OPTS, shapedBy: '' };
    const b = { ...OPTS, shapedBy: '' };
    expect(JSON.stringify(chaosBody('clearing', a))).toBe(JSON.stringify(chaosBody('clearing', b)));
  });
});

describe('episode identifiers', () => {
  it('mints four distinct tokens', () => {
    const ids = newEpisodeIdentifiers();
    const all = [ids.transactionToken, ids.cardToken, ids.authEventToken, ids.clearingEventToken];
    expect(new Set(all).size).toBe(4);
  });

  it('mints a fresh transaction each time, so an episode is a new fact', () => {
    // Reusing a transaction token would make the episode a REPLAY of an
    // existing authorisation rather than a new one: `financialPostingKey` and
    // `holdPostingKey` are derived from the provider's ids and land in
    // `journal_entry`'s UNIQUE idempotency key.
    expect(newEpisodeIdentifiers().transactionToken).not.toBe(
      newEpisodeIdentifiers().transactionToken,
    );
  });
});
