/**
 * The contract, and whether it earns its keep.
 *
 * The claim being tested is narrow and falsifiable: THERE IS SOMETHING GENERIC
 * WORTH WRITING. Two things, in fact, and both are here — a settlement
 * reporter and a liveness reporter that each hold a heterogeneous set of rails
 * and never once ask which rail they are holding.
 *
 * The settlement test is the load-bearing one, because it is the one that was
 * impossible before. It drives a REAL simulated ACH transfer through
 * submission and settlement, takes the exact signed bytes the simulator
 * produced, puts them in an array next to the MEASURED Lithic payload for the
 * $50-authorised / $73.40-cleared fuel pump out of docs/CARD-CORRECTIONS.md,
 * and hands the array to one function. That function routes by provider slug,
 * calls `observe`, and adds up `bigint` cents. It contains no `if` about ACH,
 * no `if` about cards, and no mention of either word.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { Liveness } from '@/lib/integrations/probe';

import { achSimAdapter, increaseAchAdapter } from './adapters/ach';
import { lithicCardAdapter, LITHIC_PROVIDER_SLUG, parseLithicEvent } from './adapters/card';
import { allRailAdapters, achAdapterFor } from './adapters/index';
import { plaidOpenBankingAdapter } from './adapters/openbanking';
import { livenessFromStatus } from './adapters/probe-http';
import { stablecoinRailAdapter } from './adapters/stablecoin';
import { days } from './achsim/clock';
import { AchSimEngine, ACHSIM_PROVIDER_SLUG } from './achsim/engine';
import { AchSimRail } from './achsim/rail';
import { WebhookSigner } from './achsim/signing';
import {
  canObserve,
  canOriginate,
  makeRailProbe,
  probeRails,
  railCapabilityMatrix,
  railProbeLabel,
  renderRailCapabilityMatrix,
  reportSettlements,
  settlementFromEvent,
  settlementFromOrigination,
  summariseProbes,
  supportsOperation,
  unsupportedReason,
  RAIL_LIVENESS_VERDICTS,
  RAIL_OPERATIONS,
  type ObservingRail,
  type RailAdapter,
  type RailDelivery,
  type RailLiveness,
  type RailOrigination,
} from './contract';
import { IncreaseAchRail } from './increase/client';
import { increaseWireAdapter } from './wire/adapter';
import {
  usdc,
  type PayoutOutcome,
  type StablecoinPayoutProvider,
  type StablecoinProviderId,
} from './stablecoin/types';
import { usd, type Destination, type TransferRequest } from './types';

/* -------------------------------------------------------------------------- */
/* Vocabulary: one set of words, asserted at compile time                     */
/* -------------------------------------------------------------------------- */

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * Fails to compile if `RailLiveness` and `src/lib/integrations/probe.ts`'s
 * `Liveness` ever diverge.
 *
 * They are separate declarations because that module is `server-only` and
 * pulls in the validated env bag, which a rail adapter must not need. The
 * price of restating a union is that it can drift; this line is the payment.
 */
export const LIVENESS_VOCABULARIES_AGREE: Mutual<RailLiveness, Liveness> = true;

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const SIM_DESTINATION: Extract<Destination, { type: 'ach' }> = {
  type: 'ach',
  routingNumber: '110000000',
  accountNumber: '000123456789',
  holderName: 'SIMULATED COUNTERPARTY',
  authorization: 'business_agreement',
};

function achRig(): { engine: AchSimEngine; adapter: ObservingRail } {
  const engine = new AchSimEngine({
    signer: new WebhookSigner({ secret: 'sim-secret', liveSecret: 'live-secret' }),
    seed: 'contract-test',
  });
  return { engine, adapter: achSimAdapter({ rail: new AchSimRail({ engine }) }) };
}

function achRequest(amount: bigint): TransferRequest {
  return {
    clientReferenceId: `cref-${amount}`,
    sourceAccountId: 'sim_account_0001',
    destination: SIM_DESTINATION,
    amount: usd(amount),
    statementDescriptor: 'CORGI SIM',
  };
}

/**
 * The fuel pump, measured.
 *
 * $50.00 authorised, $73.40 cleared two days later — the exact asymmetry the
 * brief calls "the heart of the track", and the exact numbers in
 * docs/CARD-CORRECTIONS.md and in lithic/client.test.ts. The webhook body IS
 * the transaction with `event_type` on top; the `{token, event_type, payload}`
 * wrapper is what `GET /v1/events` returns and is NOT what arrives over HTTP.
 */
function cardEvent(
  events: readonly { type: string; cents: number; token: string; created: string }[],
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    event_type: 'card_transaction.updated',
    token: 'txn_fuel_pump',
    account_token: 'acct_1',
    card_token: 'card_1',
    created: '2026-09-08T12:00:00Z',
    updated: '2026-09-10T12:00:00Z',
    status: 'SETTLED',
    result: 'APPROVED',
    amounts: {
      cardholder: { amount: -7340, currency: 'USD', conversion_rate: '1' },
      // Signed negative for a debit. TRAP #2.
      hold: { amount: 0, currency: 'USD' },
      merchant: { amount: -7340, currency: 'USD' },
      settlement: { amount: -7340, currency: 'USD' },
    },
    events: events.map((e) => ({
      token: e.token,
      type: e.type,
      created: e.created,
      amount: -e.cents,
      amounts: {
        cardholder: { amount: -e.cents, currency: 'USD', conversion_rate: '1' },
        merchant: { amount: -e.cents, currency: 'USD' },
        settlement: { amount: -e.cents, currency: 'USD' },
      },
      effective_polarity: 'DEBIT',
    })),
    ...overrides,
  });
}

const AUTH_50 = cardEvent([
  { type: 'AUTHORIZATION', cents: 5000, token: 'evt_auth', created: '2026-09-08T12:00:00Z' },
]);

const CLEARED_7340 = cardEvent([
  { type: 'AUTHORIZATION', cents: 5000, token: 'evt_auth', created: '2026-09-08T12:00:00Z' },
  { type: 'CLEARING', cents: 7340, token: 'evt_clear', created: '2026-09-10T12:00:00Z' },
]);

/* -------------------------------------------------------------------------- */

describe('what the contract says a rail is', () => {
  it('names five operations and exactly one of them is universal', async () => {
    const rails = allRailAdapters({ env: {} });
    expect(RAIL_OPERATIONS).toEqual(['originate', 'observe', 'settle', 'reverse', 'probe']);

    // `probe` is supported by every adapter. Nothing else is.
    for (const rail of rails) expect(supportsOperation(rail, 'probe')).toBe(true);

    const universal = RAIL_OPERATIONS.filter((op) => rails.every((r) => supportsOperation(r, op)));
    expect(universal).toEqual(['probe']);
  });

  it('a card rail cannot originate, and the type says so rather than a throw', () => {
    const card = lithicCardAdapter({ env: {} });
    expect(canOriginate(card)).toBe(false);
    expect(canObserve(card)).toBe(true);
    // Not "not implemented". A reason, in domain terms.
    expect(unsupportedReason(card, 'originate')).toMatch(/never originates a payment/i);
    // And there is genuinely no method to call.
    expect((card as unknown as Record<string, unknown>)['originate']).toBeUndefined();
  });

  it('a chain rail cannot be reversed, and Plaid cannot do anything with money', () => {
    const usdcRail = stablecoinRailAdapter(stubProvider('confirmed'));
    expect(canOriginate(usdcRail)).toBe(true);
    expect(canObserve(usdcRail)).toBe(false);
    expect(unsupportedReason(usdcRail, 'reverse')).toMatch(/final/i);
    expect(unsupportedReason(usdcRail, 'observe')).toMatch(/nobody calls us/i);

    const plaid = plaidOpenBankingAdapter({ env: {} });
    expect(canOriginate(plaid)).toBe(false);
    expect(canObserve(plaid)).toBe(false);
    for (const op of ['originate', 'observe', 'settle', 'reverse'] as const) {
      expect(supportsOperation(plaid, op)).toBe(false);
      expect(unsupportedReason(plaid, op)).toBeTruthy();
    }
    expect(supportsOperation(plaid, 'probe')).toBe(true);
  });

  it('every declared capability has a method, and every method is declared', () => {
    const rails = [
      ...allRailAdapters({ env: {} }),
      stablecoinRailAdapter(stubProvider('confirmed')),
      increaseAchAdapter({ rail: new AchSimRail({ engine: achRig().engine }), env: {} }),
    ];
    for (const rail of rails) {
      const bag = rail as unknown as Record<string, unknown>;
      expect(canObserve(rail)).toBe(
        rail.supports.observe.supported && typeof bag['observe'] === 'function',
      );
      // The two halves cannot disagree: a declaration without a method would
      // narrow a caller straight into a crash.
      expect(rail.supports.observe.supported).toBe(typeof bag['observe'] === 'function');
      expect(rail.supports.originate.supported).toBe(typeof bag['originate'] === 'function');
    }
  });

  it('a supported operation carries how much of it has actually been run', () => {
    const increase = increaseAchAdapter({
      rail: new AchSimRail({ engine: achRig().engine }),
      env: {},
    });
    // ONE operation has met Increase, and exactly one. `probe` is `measured`
    // — GET /accounts?limit=1 answered 200 on 2026-09-11, re-runnable from
    // ../increase/probe.integration.test.ts. The other four are still
    // `unexercised`: reading /accounts proves a credential authenticates and
    // proves nothing at all about POST /ach_transfers, the settlement
    // promotion, or an R01's shape. A probe that promoted its neighbours would
    // be liveness by presence with a round trip painted on it.
    for (const op of RAIL_OPERATIONS) {
      const entry = increase.supports[op];
      expect(entry.supported).toBe(true);
      if (entry.supported) {
        expect(entry.proof).toBe(op === 'probe' ? 'measured' : 'unexercised');
      }
    }

    // The simulator proves our code and never a bank.
    const sim = achSimAdapter({ rail: new AchSimRail({ engine: achRig().engine }) });
    for (const op of RAIL_OPERATIONS) {
      const entry = sim.supports[op];
      if (entry.supported) expect(entry.proof).toBe('simulated');
    }

    // Lithic has been driven against the real sandbox.
    const card = lithicCardAdapter({ env: {} });
    const settle = card.supports.settle;
    expect(settle.supported && settle.proof).toBe('measured');
  });
});

/* -------------------------------------------------------------------------- */
/* THE PAYOFF, PART ONE: one settlement reporter, several rails               */
/* -------------------------------------------------------------------------- */

describe('the generic settlement reporter', () => {
  it('reads an ACH settlement and a card clearing through one code path', async () => {
    const { engine, adapter } = achRig();

    // A real simulated transfer, driven to settlement on the virtual clock.
    const rail = new AchSimRail({ engine });
    await rail.initiateCredit(achRequest(125_00n));
    engine.advance(days(2));
    const simDeliveries = engine.drainDue();
    expect(simDeliveries.length).toBeGreaterThan(0);

    const rails: readonly ObservingRail[] = [adapter, lithicCardAdapter({ env: {} })];

    const deliveries: readonly RailDelivery[] = [
      ...simDeliveries.map((d) => ({
        provider: ACHSIM_PROVIDER_SLUG,
        rawBody: d.signed.rawBody,
      })),
      { provider: LITHIC_PROVIDER_SLUG, rawBody: AUTH_50 },
      { provider: LITHIC_PROVIDER_SLUG, rawBody: CLEARED_7340 },
    ];

    const report = await reportSettlements(rails, deliveries);

    // $125.00 of ACH and $73.40 of card, added up by a function that has never
    // heard of either rail. The $50.00 authorisation contributes nothing: a
    // hold is not a movement.
    //
    // Note what this number survives. The simulator sent TWO notifications for
    // that transfer and both read the transfer back to `settled`, because the
    // body is a pointer — so the feed saw the $125.00 settlement twice and
    // reported it once. That is `settlementRef` doing its job, and it is the
    // bug this test found on its first run.
    expect(report.net.get('USD')).toBe(125_00n + 7340n);
    expect(report.settlements.map((s) => s.slot).sort()).toEqual(['ach', 'card']);
    expect(report.unroutable).toEqual([]);
    expect(report.duplicates.length).toBeGreaterThan(0);
    expect(report.duplicates.every((d) => d.slot === 'ach')).toBe(true);

    const card = report.settlements.find((s) => s.slot === 'card');
    expect(card?.amount.amount).toBe(7340n);
    expect(card?.kind).toBe('settled');
    // The settled amount is NOT the authorised amount, and the reporter got
    // the right one without being told which rail does that.
    expect(card?.amount.amount).not.toBe(5000n);

    // The authorisation is in the non-settling pile, not lost.
    expect(report.nonSettling.some((e) => e.type === 'submitted')).toBe(true);
  });

  it('nets a return against its settlement instead of counting it twice', async () => {
    const rails: readonly ObservingRail[] = [lithicCardAdapter({ env: {} })];
    const refund = cardEvent([
      { type: 'RETURN', cents: 7340, token: 'evt_return', created: '2026-09-11T12:00:00Z' },
    ]);

    const report = await reportSettlements(rails, [
      { provider: LITHIC_PROVIDER_SLUG, rawBody: CLEARED_7340 },
      { provider: LITHIC_PROVIDER_SLUG, rawBody: refund },
    ]);

    expect(report.settlements.map((s) => s.kind)).toEqual(['settled', 'returned']);
    expect(report.net.get('USD')).toBe(0n);
  });

  it('a chain receipt becomes the same RailSettlement as a webhook does', async () => {
    const usdcRail = stablecoinRailAdapter(stubProvider('confirmed'));
    expect(canOriginate(usdcRail)).toBe(true);

    const origination: RailOrigination = await (
      usdcRail as unknown as { originate(i: unknown): Promise<RailOrigination> }
    ).originate({});

    const settlement = settlementFromOrigination(origination);
    expect(settlement).not.toBeNull();
    expect(settlement?.slot).toBe('usdc');
    expect(settlement?.kind).toBe('settled');
    expect(settlement?.amount).toEqual(usdc(500_000n));
    // Dated by the BLOCK, never by our clock.
    expect(settlement?.at).toBe(new Date(1_757_000_000 * 1000).toISOString());
  });

  it('refuses to call an acknowledgement a settlement', async () => {
    const usdcRail = stablecoinRailAdapter(stubProvider('acknowledged'));
    const origination = await (
      usdcRail as unknown as { originate(i: unknown): Promise<RailOrigination> }
    ).originate({});
    expect(origination.status).toBe('accepted');
    expect(settlementFromOrigination(origination)).toBeNull();
  });

  it('maps a reorg to indeterminate rather than to a word that invites a retry', async () => {
    for (const kind of ['reorged', 'dropped', 'unverified'] as const) {
      const rail = stablecoinRailAdapter(stubProvider(kind));
      const origination = await (
        rail as unknown as { originate(i: unknown): Promise<RailOrigination> }
      ).originate({});
      expect(origination.status).toBe('indeterminate');
      // The hash survives. It is the only handle anyone has on the money.
      expect(origination.ref).toBe('0xdeadbeef');
      expect(settlementFromOrigination(origination)).toBeNull();
    }
  });

  it('keeps two partial captures on one transaction apart', async () => {
    // The opposite identity choice from ACH, and the reason it has to be the
    // adapter's to make. auth 1000, clearing 600, clearing 300: ONE
    // transaction token, TWO settlements, $9.00 total. Keying these by the
    // transaction would report $6.00 and call the rest a duplicate.
    const first = cardEvent([
      { type: 'AUTHORIZATION', cents: 1000, token: 'evt_a', created: '2026-09-08T12:00:00Z' },
      { type: 'CLEARING', cents: 600, token: 'evt_c1', created: '2026-09-09T12:00:00Z' },
    ]);
    const second = cardEvent([
      { type: 'AUTHORIZATION', cents: 1000, token: 'evt_a', created: '2026-09-08T12:00:00Z' },
      { type: 'CLEARING', cents: 600, token: 'evt_c1', created: '2026-09-09T12:00:00Z' },
      { type: 'CLEARING', cents: 300, token: 'evt_c2', created: '2026-09-10T12:00:00Z' },
    ]);

    const report = await reportSettlements([lithicCardAdapter({ env: {} })], [
      { provider: LITHIC_PROVIDER_SLUG, rawBody: first },
      { provider: LITHIC_PROVIDER_SLUG, rawBody: second },
      // ...and the same delivery again, because they will replay it.
      { provider: LITHIC_PROVIDER_SLUG, rawBody: second },
    ]);

    expect(report.settlements.map((s) => s.amount.amount)).toEqual([600n, 300n]);
    expect(report.net.get('USD')).toBe(900n);
    // The replay is one, and it is visible rather than discarded.
    expect(report.duplicates).toHaveLength(1);
  });

  it('routes nothing it cannot address, and says which', async () => {
    const report = await reportSettlements([lithicCardAdapter({ env: {} })], [
      { provider: 'nobody.here', rawBody: '{}' },
    ]);
    expect(report.settlements).toEqual([]);
    expect(report.unroutable).toHaveLength(1);
  });

  it('holds and hold-releases are not settlements', () => {
    // The trap: AUTHORIZATION_REVERSAL reverses the AUTHORISATION, not the
    // settlement. Measured. Reading the word "reversal" as money coming back
    // would leave a settlement report short by the whole clearing.
    const voided = cardEvent([
      { type: 'AUTHORIZATION', cents: 5000, token: 'evt_auth', created: '2026-09-08T12:00:00Z' },
      { type: 'CLEARING', cents: 7340, token: 'evt_clear', created: '2026-09-10T12:00:00Z' },
      {
        type: 'AUTHORIZATION_REVERSAL',
        cents: 7340,
        token: 'evt_void',
        created: '2026-09-10T13:00:00Z',
      },
    ]);
    const event = parseLithicEvent(voided);
    expect(event.type).toBe('canceled');
    expect(settlementFromEvent(event, event.eventId)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* THE PAYOFF, PART TWO: one liveness reporter, every rail                    */
/* -------------------------------------------------------------------------- */

describe('the generic liveness reporter', () => {
  function fetchReturning(status: number): typeof fetch {
    return (() =>
      Promise.resolve(new Response(JSON.stringify({ error_code: 'X' }), { status }))) as typeof fetch;
  }

  it('probes a heterogeneous set without knowing which rail is which', async () => {
    const env = {
      LITHIC_API_KEY: 'k',
      PLAID_CLIENT_ID: 'id',
      PLAID_SECRET: 's',
      INCREASE_API_KEY: 'k',
    };
    const rails = allRailAdapters({ env });
    const probes = await probeRails(rails, { fetchImpl: fetchReturning(200) });

    expect(probes).toHaveLength(rails.length);
    expect(probes.every((p) => p.label === 'LIVE')).toBe(true);
    // Order is stable, so a rendered table does not reshuffle between refreshes.
    expect(probes.map((p) => p.provider)).toEqual(rails.map((r) => r.identity.provider));
    // FOUR, not three: one vendor, two rails. `increase.ach` and
    // `increase.wire` are separate slots behind one credential, and Increase
    // gates features per key — the same key that answers 200 on
    // /wire_transfers answers 403 on /wire_drawdown_requests — so a single
    // Increase row would be one probe standing in for two propositions.
    expect(summariseProbes(probes)).toEqual({ live: 4, simulated: 0, total: 4 });
  });

  it('a rejected credential can never be labelled LIVE', async () => {
    const rails = allRailAdapters({
      env: { LITHIC_API_KEY: 'placeholder', PLAID_CLIENT_ID: 'x', PLAID_SECRET: 'y' },
    });
    const probes = await probeRails(rails, { fetchImpl: fetchReturning(401) });
    for (const probe of probes) {
      if (probe.slot === 'ach') continue; // the simulator; see the next test
      expect(probe.liveness).not.toBe('live');
      expect(probe.label).toBe('SIMULATED');
    }
  });

  it('a simulator that is working reports live AND simulated, never LIVE', async () => {
    // Both halves of the label are required, and this is why. The simulator is
    // in this process, so `liveness` is honestly `live` — and the label is
    // still SIMULATED, because `evidence` is not.
    const probes = await probeRails([achAdapterFor({})]);
    expect(probes[0]?.liveness).toBe('live');
    expect(probes[0]?.evidence).toBe('simulated');
    expect(probes[0]?.label).toBe('SIMULATED');
    expect(summariseProbes(probes).live).toBe(0);
  });

  it('the label is not the adapter’s to write', () => {
    // `makeRailProbe` is the only constructor and it computes `label` itself,
    // so there is no code path by which a simulator claims LIVE.
    for (const liveness of RAIL_LIVENESS_VERDICTS) {
      expect(railProbeLabel('simulated', liveness)).toBe('SIMULATED');
      expect(railProbeLabel('live', liveness)).toBe(liveness === 'live' ? 'LIVE' : 'SIMULATED');
    }
    const probe = makeRailProbe(
      { slot: 'ach', provider: 'p', title: 't', evidence: 'simulated', environment: 'simulator' },
      { liveness: 'live', detail: 'd', ms: 1 },
    );
    expect(probe.label).toBe('SIMULATED');
  });

  it('one rail having a bad afternoon does not take the table down', async () => {
    const exploding: RailAdapter = {
      identity: {
        slot: 'wire',
        provider: 'boom',
        title: 'Boom',
        evidence: 'live',
        environment: 'sandbox',
      },
      supports: plaidOpenBankingAdapter({ env: {} }).supports,
      probe: () => Promise.reject(new Error('socket hang up')),
    };
    const probes = await probeRails([exploding, achAdapterFor({})]);
    expect(probes[0]?.liveness).toBe('unreachable');
    expect(probes[0]?.detail).toMatch(/socket hang up/);
    expect(probes[1]?.liveness).toBe('live');
  });

  it('a missing credential is not_configured, which is not unreachable', async () => {
    const probes = await probeRails(allRailAdapters({ env: {} }));
    const byProvider = new Map(probes.map((p) => [p.provider, p]));
    expect(byProvider.get('lithic.card')?.liveness).toBe('not_configured');
    expect(byProvider.get('plaid')?.liveness).toBe('not_configured');
  });

  it('agrees with probe.ts about what each status means', () => {
    // The five bugs recorded in probe.ts's own comment, restated as a test so
    // the copy in probe-http.ts cannot drift into a second opinion.
    expect(livenessFromStatus(200)).toBe('live');
    expect(livenessFromStatus(400)).toBe('live');
    expect(livenessFromStatus(422)).toBe('live');
    expect(livenessFromStatus(401)).toBe('unauthorised');
    expect(livenessFromStatus(403)).toBe('unauthorised');
    expect(livenessFromStatus(429)).toBe('rate_limited');
    // 404 with a valid key and 404 with no key at all are the same 404.
    expect(livenessFromStatus(404)).toBe('unreachable');
    expect(livenessFromStatus(408)).toBe('unreachable');
    expect(livenessFromStatus(500)).toBe('unreachable');
  });
});

/* -------------------------------------------------------------------------- */
/* The capability matrix, and the doc it generates                            */
/* -------------------------------------------------------------------------- */

describe('the capability matrix', () => {
  it('has a cell for every operation on every rail, with a reason in each', () => {
    const rails = [...allRailAdapters({ env: {} }), stablecoinRailAdapter(stubProvider('confirmed'))];
    const matrix = railCapabilityMatrix(rails);
    // ACH (the simulator, with no key in this env), card, open banking, wire,
    // and the stablecoin rail passed in.
    expect(matrix).toHaveLength(5);
    for (const row of matrix) {
      expect(row.cells.map((c) => c.operation)).toEqual([...RAIL_OPERATIONS]);
      for (const cell of row.cells) expect(cell.note.length).toBeGreaterThan(20);
    }
  });

  it('is the table committed in docs/RAILS.md, character for character', () => {
    // docs/RAILS.md is GENERATED from the adapters. A rail that gains or loses
    // an operation, or whose proof level changes, turns this red until the doc
    // is regenerated — which is the only way a table like this stays true for
    // longer than a week.
    const table = renderRailCapabilityMatrix(documentedRails());
    const doc = readFileSync('docs/RAILS.md', 'utf8');
    expect(doc).toContain(table);
  });

  it('renders the table that docs/RAILS.md carries', () => {
    const rails = [...allRailAdapters({ env: {} }), stablecoinRailAdapter(stubProvider('confirmed'))];
    const table = renderRailCapabilityMatrix(rails);
    // `~` is "supported, and nobody has run it against the provider".
    expect(table).toContain('| ACH simulator |');
    expect(table).toContain('| Lithic card issuing |');
    expect(table).toContain('| Increase wire (Fedwire) |');
    expect(table.split('\n')).toHaveLength(7);
    // The card row: no originate, everything else.
    const cardRow = table.split('\n').find((l) => l.includes('Lithic card issuing'));
    expect(cardRow).toMatch(/\| - \| \+ \| \+ \| \+ \| \+ \|$/);
    // Plaid: probe and nothing else.
    const plaidRow = table.split('\n').find((l) => l.includes('Plaid'));
    expect(plaidRow).toMatch(/\| - \| - \| - \| - \| \+ \|$/);
    // The wire row: everything but `reverse`, and the refusal is the finding.
    // A Fedwire funds transfer is final on receipt — money does sometimes come
    // back, measured, but what comes back is a SECOND payment with its own
    // IMAD and a null return reason code, not our transfer being unwound.
    const wireRow = table.split('\n').find((l) => l.includes('Increase wire'));
    expect(wireRow).toMatch(/\| \+ \| \+ \| \+ \| - \| \+ \|$/);
  });
});

/* -------------------------------------------------------------------------- */

/** A stablecoin provider that returns one chosen outcome. No network. */
function stubProvider(kind: PayoutOutcome['kind']): StablecoinPayoutProvider {
  const base = {
    provider: 'base.usdc' as const,
    evidence: 'live' as const,
    amount: usdc(500_000n),
    from: '0xfrom',
    to: '0xto',
  };
  const outcomes: Record<PayoutOutcome['kind'], PayoutOutcome> = {
    confirmed: {
      ...base,
      kind: 'confirmed',
      txHash: '0xdeadbeef',
      nonce: 1n,
      gas: { gasLimit: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, maxCostWei: 1n },
      receipt: {
        blockNumber: 1n,
        blockHash: '0xblock',
        blockTimestamp: 1_757_000_000n,
        gasUsed: 1n,
        effectiveGasPriceWei: 1n,
        gasCostWei: 1n,
      },
      recovered: false,
    },
    reverted: {
      ...base,
      kind: 'reverted',
      txHash: '0xdeadbeef',
      receipt: {
        blockNumber: 1n,
        blockHash: '0xblock',
        blockTimestamp: 1n,
        gasUsed: 1n,
        effectiveGasPriceWei: 1n,
        gasCostWei: 1n,
      },
    },
    reorged: { ...base, kind: 'reorged', txHash: '0xdeadbeef', detail: 'block dropped' },
    unconfirmed: { ...base, kind: 'unconfirmed', txHash: '0xdeadbeef', waitedMs: 1 },
    dropped: { ...base, kind: 'dropped', txHash: '0xdeadbeef' },
    acknowledged: {
      ...base,
      kind: 'acknowledged',
      providerRef: 'circle_1',
      state: 'INITIATED',
      waitedMs: 1,
      txHash: null,
    },
    unverified: { ...base, kind: 'unverified', txHash: '0xdeadbeef', detail: 'no Transfer log' },
    refused: { ...base, kind: 'refused', reason: 'insufficient_usdc', detail: 'no', txHash: null },
  };

  return {
    id: 'base.usdc',
    label: 'Base Sepolia, signed here',
    health: () =>
      Promise.resolve({
        provider: 'base.usdc' as const,
        label: 'Base Sepolia, signed here',
        liveness: 'live' as const,
        detail: 'stub',
        ms: 0,
      }),
    send: () => Promise.resolve(outcomes[kind]),
  };
}

/**
 * Every adapter in this package, including BOTH ACH options and BOTH
 * stablecoin providers.
 *
 * `allRailAdapters()` deliberately returns only the ACH adapter that is
 * actually serving the slot, because an honesty table for a running deployment
 * must not list a live rail and its simulator side by side. The DOCUMENTATION
 * wants the opposite — every adapter that exists — so this builder is here and
 * not in production code.
 */
function documentedRails(): readonly RailAdapter[] {
  const { engine } = achRig();
  return [
    increaseAchAdapter({ rail: new IncreaseAchRail({}), env: {} }),
    achSimAdapter({ rail: new AchSimRail({ engine }) }),
    lithicCardAdapter({ env: {} }),
    plaidOpenBankingAdapter({ env: {} }),
    stablecoinRailAdapter(stubProvider('confirmed')),
    stablecoinRailAdapter(labelledStub('circle.w3s', 'Circle Web3 Services, Base Sepolia')),
    // THE WIRE RAIL WAS EXCLUDED FROM THIS BUILDER, AND THAT WAS THE BUG.
    //
    // It was left out so that the drift assertion below stayed green while
    // docs/RAILS.md still carried five rows. That is the mechanism built to
    // make the docs true being used as the reason they were incomplete: the
    // rail existed, was measured against Increase's sandbox end to end, and
    // was invisible on the one table this repo points at when it is asked
    // which integrations are real. A generated table that omits a rail to
    // avoid being regenerated is a hand-written table with extra steps.
    increaseWireAdapter({ env: {} }),
  ];
}

/** The Circle half of the pair, for the documentation table only. */
function labelledStub(id: StablecoinProviderId, label: string): StablecoinPayoutProvider {
  const inner = stubProvider('confirmed');
  return {
    id,
    label,
    health: () => Promise.resolve({ provider: id, label, liveness: 'live' as const, detail: 'stub', ms: 0 }),
    send: inner.send,
  };
}
