/**
 * The wire rail, end to end, against the REAL Increase sandbox and the REAL
 * database.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS SUITE MOVES MONEY. It sends a real wire on Increase's sandbox,      │
 * │ drives it to settlement, receives one back, and posts real journal       │
 * │ entries to the live Neon database. It is gated on RUN_DB_TESTS=1 AND on  │
 * │ INCREASE_API_KEY, so CI — which holds neither — skips rather than fails. │
 * │                                                                          │
 * │   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm vitest run \             │
 * │     src/lib/rails/wire/wire.integration.test.ts                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * EVERY `measured` CELL IN `WIRE_SUPPORT` IS RE-EARNED HERE. That is the point
 * of the file: `docs/RAILS.md` holds the Increase ACH row at `~` because
 * nobody had made the calls, and the only honest way for this rail's row to
 * read `+` is for the calls to be in the repo and runnable by anyone holding
 * the credential.
 *
 * The six questions, in order:
 *
 *   1  the probe asks the WIRE collection and gets a 200 — and the same key
 *      gets a 403 on `/wire_drawdown_requests`, which is why /accounts is the
 *      wrong endpoint to prove a wire capability with
 *   2  a wire is originated, submitted and SETTLES THE SAME DAY, with an IMAD
 *   3  a reversal produces a DIFFERENT IMAD — the evidence for supports.reverse
 *      being false
 *   4  `observe()` runs against a REAL verified delivery out of `webhook_inbox`
 *   5  an inbound wire raises LEDGER AND AVAILABLE TOGETHER — the asymmetry
 *      with the ACH funding leg, proven as a delta and not asserted
 *   6  `v_wire_availability_drift` is empty
 *
 * BALANCES ARE READ AS DELTAS. The ledger is append-only; a test asserting an
 * absolute figure passes once and then asserts the order the suite ran in.
 */

import { beforeAll, describe, expect, it } from 'vitest';

const KEY = process.env['INCREASE_API_KEY'] ?? '';
const RUN = process.env['RUN_DB_TESTS'] === '1' && KEY !== '';

import type * as AdapterModule from './adapter';
import type * as BalancesModule from '@/lib/ledger/balances';
import type * as Db from '@/lib/ledger/db';
import type * as LedgerModule from './ledger';

const suite = RUN ? describe : describe.skip;

/** The seeded demo business. Its 2100 leaf is what the console screens show. */
const RIDGELINE_BUSINESS = 'e274546d-6bdd-5266-b0fb-cc839a7811f9';

/** The trial's Increase sandbox account and its primary account number. */
const INCREASE_ACCOUNT = 'sandbox_account_zkfx1wcn4brwoaiyksj6';
const INCREASE_ACCOUNT_NUMBER_ID = 'sandbox_account_number_96mzhz3n61f5p0jpvytc';

/**
 * JPMorgan Chase's WIRE routing number, and the one on the seeded Plaid item.
 *
 * The same item carries 011401533 for ACH. They are not interchangeable, and
 * substituting one for the other is the mistake this rail is shaped to refuse.
 */
const WIRE_ROUTING = '021000021';

suite('the wire rail, against Increase', () => {
  let increaseWireAdapter: typeof AdapterModule.increaseWireAdapter;
  let creditInboundWire: typeof LedgerModule.creditInboundWire;
  let readWireAvailabilityDrift: typeof LedgerModule.readWireAvailabilityDrift;
  let readWireCredits: typeof LedgerModule.readWireCredits;
  let availableBalance: typeof BalancesModule.availableBalance;
  let sql: Db.Sql;

  beforeAll(async () => {
    ({ increaseWireAdapter } = await import('./adapter'));
    ({ creditInboundWire, readWireAvailabilityDrift, readWireCredits } = await import(
      './ledger'
    ));
    ({ availableBalance } = await import('@/lib/ledger/balances'));
    ({ sql } = await import('@/lib/ledger/db'));
  });

  /* ---- 1. the probe ---------------------------------------------------- */

  it('earns LIVE from the WIRE collection, and shows why /accounts would not do', async () => {
    const probe = await increaseWireAdapter().probe({ timeoutMs: 15_000 });

    expect(probe.liveness).toBe('live');
    // Both halves: a real provider AND a round trip that worked.
    expect(probe.label).toBe('LIVE');
    expect(probe.evidence).toBe('live');
    expect(probe.provider).toBe('increase.wire');
    expect(probe.detail).toBe('GET /wire_transfers?limit=1 -> 200');

    // The same credential, one endpoint over: 403 private_feature_error.
    // Increase gates features per key, so "the key works" and "this deployment
    // may move wires" are different questions and only one endpoint answers
    // the second one.
    const gated = await fetch('https://sandbox.increase.com/wire_drawdown_requests?limit=1', {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    expect(gated.status).toBe(403);
    expect((await gated.json()).type).toBe('private_feature_error');
  });

  /* ---- 2 and 3. originate, settle, and the reversal that is not one ----- */

  it('originates a wire, settles it the SAME DAY, and reverses it to a DIFFERENT IMAD', async () => {
    const adapter = increaseWireAdapter();
    const reference = `corgi-itest-${Date.now()}`;

    const origination = await adapter.originate({
      clientReferenceId: reference,
      sourceAccountId: INCREASE_ACCOUNT,
      beneficiary: {
        name: 'Ridgeline Robotics Inc',
        wireRoutingNumber: WIRE_ROUTING,
        accountNumber: '1111222233330000',
      },
      amount: { amount: 125_000n, currency: 'USD' },
      remittance: 'CORGI INTEGRATION TEST',
    });

    // Nothing has been put on a wire yet: `pending_creating`.
    expect(origination.status).toBe('accepted');
    expect(origination.ref).toMatch(/^sandbox_wire_transfer_/);
    expect(origination.amount).toEqual({ amount: 125_000n, currency: 'USD' });
    const transferId = origination.ref ?? '';

    // Play the Fed accepting the message. ONE call, and it is done — there is
    // no T+1 on this rail and no settlement notification to wait for.
    const submitted = await adapter.client.simulateSubmit(transferId);
    expect(submitted.status).toBe('complete');
    expect(submitted.submission?.input_message_accountability_data).toMatch(/^\d{8}[a-z0-9]+$/);
    // AND THERE IS NO SETTLEMENT OBJECT. The ACH trap inverted: an adapter
    // waiting for `settlement.settled_at` here would wait for ever.
    expect('settlement' in submitted).toBe(false);
    const settledImad = submitted.submission?.input_message_accountability_data;

    // Read back through the contract: settled, at the submission time.
    const settled = await adapter.readOrigination(transferId);
    expect(settled.status).toBe('settled');
    expect(settled.at).toBe(submitted.submission?.submitted_at);

    // Now play the BENEFICIARY'S bank sending it back.
    const reversed = await adapter.client.simulateReverse(transferId);
    expect(reversed.status).toBe('reversed');

    const returned = await adapter.wireReturnOfFunds(transferId);
    expect(returned).not.toBeNull();
    if (returned === null) return;

    // THE ASSERTION THE WHOLE RAIL RESTS ON. A different IMAD means the
    // network saw a different message — a second payment, not our transfer
    // being unwound. A null reason code means there is no wire return-code
    // table to classify it with.
    expect(returned.imad).not.toBe(settledImad);
    expect(reversed.reversal?.class_name).toBe('inbound_wire_reversal');
    expect(reversed.reversal?.return_reason_code).toBeNull();

    // And the rail says so in its type, not by throwing.
    const support = increaseWireAdapter().supports.reverse;
    expect(support.supported).toBe(false);
    expect('reverse' in adapter).toBe(false);

    // The original is STILL settled after the reversal. Its day is untouched.
    const afterReversal = await adapter.readOrigination(transferId);
    expect(afterReversal.status).toBe('settled');
    expect(afterReversal.at).toBe(submitted.submission?.submitted_at);
  }, 60_000);

  /* ---- 4. observe, against a real verified delivery --------------------- */

  it('observes the exact bytes of a delivery the deployed system verified', async () => {
    // Not a fixture shaped like a delivery: the raw body Increase signed, read
    // out of the inbox of the deployed endpoint that verified the signature.
    const rows = await sql<{ raw_body: string; provider_event_id: string }[]>`
      SELECT raw_body, provider_event_id
        FROM webhook_inbox
       WHERE provider = 'increase'
         AND event_type IN ('wire_transfer.updated', 'inbound_wire_transfer.created')
         AND signature_verified_at IS NOT NULL
       ORDER BY received_at DESC
       LIMIT 1`;
    const delivery = rows[0];
    expect(delivery, 'no verified wire delivery in webhook_inbox to observe').toBeDefined();
    if (delivery === undefined) return;

    const observation = await increaseWireAdapter().observe(delivery.raw_body);

    // The body carried no money — it is a pointer — so this only works because
    // `observe` read the object back.
    expect(JSON.parse(delivery.raw_body)).not.toHaveProperty('amount');
    expect(observation.event.eventId).toBe(delivery.provider_event_id);
    expect(observation.event.provider).toBe('increase.wire');
    // Whatever it turned out to be, it is never a return on this rail.
    expect(observation.settlement?.kind ?? 'settled').toBe('settled');
  }, 30_000);

  /* ---- 5. the asymmetry: ledger and available move TOGETHER ------------- */

  it('credits an inbound wire with IMMEDIATE availability — both balances move', async () => {
    const adapter = increaseWireAdapter();
    const amountCents = 750_00n;

    // Play another bank wiring us money. MEASURED: the endpoint accepts only
    // `account_number_id` and `amount`; every other field is rejected by name.
    const inbound = await adapter.client.simulateInbound({
      accountNumberId: INCREASE_ACCOUNT_NUMBER_ID,
      amount: { amount: amountCents, currency: 'USD' },
    });
    expect(inbound.status).toBe('accepted');
    // No pending stage. Acceptance IS arrival, to the second.
    expect(inbound.acceptance?.accepted_at).toBe(inbound.created_at);

    const credit = await adapter.readInboundCredit(inbound.id);
    expect(credit).not.toBeNull();
    if (credit === null) return;

    const before = await availableBalance(RIDGELINE_BUSINESS, sql);
    const receipt = await creditInboundWire({ businessId: RIDGELINE_BUSINESS, credit });
    const after = await availableBalance(RIDGELINE_BUSINESS, sql);

    // THE CLAIM, AS TWO DELTAS. The ACH funding leg moves the first and not
    // the second; a wire moves both, TOGETHER, because
    // `funds_availability_policy` says 0 banking days from midnight ET and
    // `ledger_availability`'s own release predicate does the rest.
    //
    // The claim is the EQUALITY of the two deltas, not their absolute value,
    // and that is not a hedge — it is what makes the assertion survive
    // `outbound.integration.test.ts` releasing a wire out of the same account
    // while this file runs. A concurrent entry moves both terms, so it cannot
    // make a broken rail look correct: only a hold that actually withheld
    // something can separate them. The exact +$750.00 is asserted below, off
    // this wire's own rows, where no other test can reach.
    expect(after.ledgerCents - before.ledgerCents).toBe(
      after.availableCents - before.availableCents,
    );
    // And the uncleared-credit term — the difference between them — did not
    // move at all, which is the same statement said the other way round.
    expect(after.unclearedCents - before.unclearedCents).toBe(0n);
    expect(after.holdsCents - before.holdsCents).toBe(0n);

    // The hold WAS written. That is what makes this a proof rather than a
    // choice: something was there for the model to release.
    expect(receipt.created).toBe(true);
    expect(receipt.availableImmediately).toBe(true);
    expect(receipt.schedule.bankingDaysHold).toBe(0);
    expect(receipt.schedule.releaseLocalTime).toBe('00:00:00');

    // THREE ENTRIES, the same three an ACH credit gets — financial, memo
    // hold, memo release — with the one-to-two banking days taken out. The
    // release is the part that did NOT fall out of the model: a hold released
    // on arrival has no later sweep to square its memo book, and
    // `v_hold_release_drift` requires a released hold to be flat.
    expect(receipt.releaseEntryId).not.toBeNull();
    const [closure] = await sql<{ reason: string }[]>`
      SELECT reason FROM hold_closure WHERE hold_id = ${receipt.holdId}::uuid`;
    expect(closure?.reason).toMatch(/zero-day policy releases on arrival/);

    const [drift] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM v_hold_release_drift WHERE hold_id = ${receipt.holdId}::uuid`;
    expect(drift?.n, 'a released wire hold must withhold nothing').toBe(0);

    // And the receipt a demo reads, with the sign the customer's statement
    // uses: $750.00 credited, $0.00 held.
    const credits = await readWireCredits(
      (await sql<{ account_id: string }[]>`
        SELECT account_id FROM hold WHERE id = ${receipt.holdId}::uuid`)[0]?.account_id ?? '',
      sql,
    );
    const mine = credits.find((c) => c.externalRef === receipt.externalRef);
    expect(mine?.creditedCents).toBe(amountCents);
    expect(mine?.heldCents).toBe(0n);

    const [hold] = await sql<{ available_at: Date; policy_id: string | null }[]>`
      SELECT available_at, policy_id FROM hold WHERE id = ${receipt.holdId}::uuid`;
    expect(hold?.policy_id).not.toBeNull();
    // Already in the past at the instant it was written. Born released.
    expect(hold?.available_at.getTime()).toBeLessThanOrEqual(Date.parse(credit.acceptedAt));

    // Replay: the same arrival books nothing twice. Decided by
    // `hold_ref UNIQUE (kind, external_ref)` and the entry idempotency key,
    // not by an `if`.
    const replay = await creditInboundWire({ businessId: RIDGELINE_BUSINESS, credit });
    expect(replay.created).toBe(false);
    expect(replay.entryId).toBe(receipt.entryId);
    expect(replay.memoEntryId).toBe(receipt.memoEntryId);

    // Counted on THIS wire's own rows rather than on the account's balance,
    // for the same reason the deltas above are an equality: another suite may
    // be booking against this business at the same moment, and "the balance
    // did not change" would be asserting that nothing else in the system is
    // running. Three entries for this arrival — financial, memo hold, memo
    // release — and no more, however many times it is delivered.
    const { listLedgerLines } = await import('@/lib/ledger/queries');
    const lines = await listLedgerLines({ rail: 'wire', limit: 500 }, sql);
    const entries = new Set(
      lines.filter((l) => l.externalRef === receipt.externalRef).map((l) => l.entryId),
    );
    expect(entries.size).toBe(3);
    expect(entries).toContain(receipt.entryId);
    expect(entries).toContain(receipt.memoEntryId);
  }, 60_000);

  /* ---- 6. the invariant ------------------------------------------------ */

  it('leaves v_wire_availability_drift empty — no wire hold ever bound', async () => {
    // Rows here are holds that actually withheld money on a rail whose policy
    // says nothing is withheld. Nothing repairs what this reports.
    expect(await readWireAvailabilityDrift(sql)).toEqual([]);
  });
});
