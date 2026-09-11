/**
 * `IncreaseAchRail.parseEvent()`, run against REAL Increase deliveries.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS SUITE TALKS TO THE REAL INCREASE SANDBOX AND TO THE REAL DATABASE.  │
 * │ It reads, and only reads: a SELECT over `webhook_inbox`, then one        │
 * │ authenticated `GET /ach_transfers/{id}` per delivery. No POST, no        │
 * │ transfer, no simulation, no money, and not one row written anywhere.     │
 * │ Gated on RUN_LIVE_PROBES=1 AND INCREASE_API_KEY AND APP_DATABASE_URL, so │
 * │ CI — which holds none of them — skips rather than fails. Run it with:    │
 * │                                                                          │
 * │   set -a; . ./.env; set +a; RUN_LIVE_PROBES=1 pnpm vitest run \          │
 * │     src/lib/rails/increase/observe.integration.test.ts                   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ─── WHY IT READS THE INBOX INSTEAD OF CARRYING A FIXTURE ───────────────────
 *
 * `parseEvent` had never been handed a real delivery. Every test of it fed it
 * a body somebody in this repo typed, which means every test of it asserted
 * that the adapter agrees with our own idea of what Increase sends — the exact
 * shape of mistake that put `sandbox_` in front of every id and nobody noticed.
 *
 * So this suite takes its input from `webhook_inbox.raw_body`: the EXACT bytes
 * Increase signed, which reached the deployed endpoint over the public
 * internet and had their signature verified before the row was allowed to
 * exist. Nothing here re-serialises a parsed payload. The same standard the
 * wire rail's `observe()` cell was earned to (docs/RAILS.md §3).
 *
 * ─── WHAT IT PROVES, AND THE ONE THING IT DELIBERATELY DOES NOT ─────────────
 *
 * It proves `observe`: real verified bytes in, a normalised `RailEvent` about
 * money out, with the read-back really made. It proves the id-prefix
 * regression cannot come back, because the fixture IS the sandbox spelling.
 *
 * It does NOT originate, submit, settle or return anything. Those calls were
 * already made against this sandbox — `sandbox_ach_transfer_x5vdo5m7b6k924sszlms`
 * carries `Idempotency-Key: test:approvals:1789097931095:gate`, which only
 * `createAchTransfer` sends — and re-running them would mean a second live ACH
 * transfer with no approved payment instruction behind it, which this book
 * treats as a maker-checker incident and parks. A test that manufactures an
 * unapprovable payment to colour in a cell is the failure this file exists to
 * avoid, one layer up.
 */

import { describe, expect, it } from 'vitest';

import { IncreaseAchRail } from './client';

const KEY = process.env['INCREASE_API_KEY'] ?? '';
const DB = process.env['APP_DATABASE_URL'] ?? '';
const RUN = process.env['RUN_LIVE_PROBES'] === '1' && KEY !== '' && DB !== '';

const suite = RUN ? describe : describe.skip;

interface StoredDelivery {
  readonly provider_event_id: string;
  readonly event_type: string | null;
  readonly raw_body: string;
  readonly signature_verified_at: Date;
}

suite('parseEvent, against real signature-verified Increase deliveries', () => {
  /** Lazily imported: a missing APP_DATABASE_URL must not blow up at load. */
  async function deliveries(like: string): Promise<readonly StoredDelivery[]> {
    const { sql } = await import('@/lib/ledger/db');
    return sql<StoredDelivery[]>`
      SELECT provider_event_id, event_type, raw_body, signature_verified_at
        FROM webhook_inbox
       WHERE provider = 'increase'
         AND event_type LIKE ${like}
       ORDER BY received_at`;
  }

  it('turns every stored ach_transfer delivery into a fact about money', async () => {
    const rows = await deliveries('ach\\_transfer.%');
    expect(
      rows.length,
      'no real ach_transfer delivery is stored; this suite has nothing to prove against',
    ).toBeGreaterThan(0);

    const rail = new IncreaseAchRail({});
    const events = [];
    for (const row of rows) {
      // THE BYTES, not a re-serialisation of the parsed payload.
      events.push(await rail.parseEvent(row.raw_body));
    }

    for (const [i, event] of events.entries()) {
      const row = rows[i]!;
      // THE REGRESSION, STANDING IN FRONT OF US. Every sandbox id is
      // `sandbox_ach_transfer_…`, so the old `startsWith('ach_transfer_')`
      // gate classified exactly these deliveries as `unmodelled_event` and
      // answered 200. Routing on `associated_object_type` is what makes this
      // pass, and the fixture is the provider's own spelling rather than ours.
      expect(JSON.parse(row.raw_body).associated_object_id).toMatch(/^sandbox_ach_transfer_/);
      expect(event.type, `${row.event_type} (${row.provider_event_id}) was dropped`).not.toBe(
        'unknown',
      );
      expect(event.provider).toBe('increase.ach');
      expect(event.railKind).toBe('ach');
      expect(event.evidence).toBe('live');
      expect(event.transferId).toMatch(/^sandbox_ach_transfer_/);
    }

    // ONE TRANSFER, MANY NOTIFICATIONS, ONE ANSWER. The body is a pointer, so
    // `ach_transfer.created` and four `ach_transfer.updated` deliveries all
    // read the transfer back and resolve to its CURRENT state. That is why
    // out-of-order delivery is harmless on this rail, and it is observable
    // here rather than argued: five deliveries, one verdict.
    const kinds = new Set(events.map((e) => e.type));
    expect(kinds.size).toBe(1);
    expect(kinds.has('returned')).toBe(true);
  });

  it('reads the return as a second movement carrying its own amount and R-code', async () => {
    const rows = await deliveries('ach\\_transfer.%');
    const rail = new IncreaseAchRail({});
    const event = await rail.parseEvent(rows[rows.length - 1]!.raw_body);

    expect(event.type).toBe('returned');
    if (event.type !== 'returned') return;

    // $6,000.00, in cents, as a bigint. Never a float, never a string.
    expect(event.amount).toEqual({ amount: 600_000n, currency: 'USD' });
    // Increase spells R01 `insufficient_fund`, SINGULAR, in
    // `return_reason_code`, and puts the Nacha string in
    // `raw_return_reason_code`. Both are kept: ours canonical, theirs verbatim.
    expect(event.reason).toMatchObject({
      category: 'insufficient_funds',
      code: 'R01',
      providerCode: 'insufficient_fund',
      retryable: true,
    });
    // The return's OWN date, not the settlement's. A return is a new event at
    // a new value date; the settlement stays on the settlement day.
    expect(Date.parse(event.returnedAt)).not.toBeNaN();
  });

  it('agrees, on live data, with what the consumer independently booked', async () => {
    // The consumer in src/lib/webhooks/consumers/increase-ach.ts reimplements
    // this branch rather than calling `parseEvent`. Two implementations of one
    // rail is a drift risk, and this is the assertion that measures the drift
    // instead of assuming it away: the adapter's reading of the same verified
    // bytes must name the same transfer, the same amount and the same R-code
    // as the entries already on the book.
    //
    // Read through the LEDGER'S OWN READERS, never with SQL of this module's
    // own — `src/lib/ledger/boundary.test.ts` is the rule and it is the right
    // one: a rail that grows a private idea of what a journal row looks like
    // will eventually disagree with the screen.
    const { sql } = await import('@/lib/ledger/db');
    const { findEntryByIdempotencyKey, listLedgerLines } = await import('@/lib/ledger/readers');

    const rows = await deliveries('ach\\_transfer.%');
    const rail = new IncreaseAchRail({});
    const event = await rail.parseEvent(rows[rows.length - 1]!.raw_body);
    if (event.type !== 'returned') throw new Error('expected a returned event');

    // The settlement. Its key is derived from the TRANSFER, so every delivery
    // about it resolves to this one entry.
    const settled = await findEntryByIdempotencyKey(`ach:settled:${event.transferId}`, sql);
    expect(settled, 'the settlement this observation describes is not on the book').not.toBeNull();

    // The return, keyed by the trace number — which this observation read back
    // off the provider itself, so finding the entry IS the agreement.
    const trace = (event.raw as { transfer?: { return?: { trace_number?: string } } }).transfer
      ?.return?.trace_number;
    expect(trace).toBeTruthy();
    const returned = await findEntryByIdempotencyKey(
      `ach:return:${event.transferId}:${trace}`,
      sql,
    );
    expect(returned, 'the return this observation describes is not on the book').not.toBeNull();

    // And the amounts. The reader pages by booking sequence, and both entries
    // already named their own, so this asks for the handful of lines at and
    // below the return rather than scanning the book.
    const lines = (
      await listLedgerLines(
        { rail: 'ach', book: 'financial', bookingSeqBelow: returned!.bookingSeq + 1n, limit: 8 },
        sql,
      )
    ).filter((l) => l.externalRef === event.transferId);
    expect(lines.length).toBe(4);
    for (const line of lines) {
      const magnitude = line.amountCents < 0n ? -line.amountCents : line.amountCents;
      expect(magnitude).toBe(event.amount.amount);
    }
  });

  it('routes on the object type, so a real wire delivery is unmodelled and not mis-booked', async () => {
    // Increase sends every rail down one subscription. These bytes are a real
    // `wire_transfer.*` delivery from the same account — ACH's adapter must
    // refuse it by TYPE and return 200, not classify it by an id prefix and
    // not throw.
    const rows = await deliveries('wire\\_transfer.%');
    if (rows.length === 0) return; // nothing to prove against; not a failure.

    const rail = new IncreaseAchRail({});
    const event = await rail.parseEvent(rows[0]!.raw_body);

    expect(event.type).toBe('unknown');
    if (event.type !== 'unknown') return;
    expect(event.reason).toBe('unmodelled_event');
    expect(event.providerType).toMatch(/^wire_transfer\./);
  });
});
