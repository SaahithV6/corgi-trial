/**
 * The wire adapter, behind the contract.
 *
 * Two things are being argued here, and only one of them is about wires.
 *
 *   1. THE CONTRACT HOLDS FOR A RAIL IT WAS NOT WRITTEN AGAINST. `contract.ts`
 *      was built from five adapters and this is the sixth, written afterwards
 *      by somebody else. If the abstraction is real, `reportSettlements` and
 *      `probeRails` should work on it with no change to either — including
 *      summing a wire and an ACH settlement in one call, which they do below.
 *
 *   2. `reverse` IS REFUSED BY THE TYPE, NOT BY A THROW. There is no `reverse`
 *      method to call; `supports.reverse.supported` is `false` and carries a
 *      reason in domain terms; and no code path can construct a `returned`
 *      settlement on this rail. All three are asserted.
 *
 * Every response the stub client returns is a MEASURED object from
 * ./measured.ts, so "the adapter handles a reversed wire" means it handled the
 * bytes Increase actually sent, not bytes shaped like them.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  canObserve,
  canOriginate,
  probeRails,
  RAIL_OPERATIONS,
  railCapabilityMatrix,
  reportSettlements,
  summariseProbes,
  supportsOperation,
  unsupportedReason,
  type ObservingRail,
  type RailAdapter,
  type RailDelivery,
} from '../contract';
import { usd } from '../types';

import { increaseWireAdapter } from './adapter';
import { IncreaseWireClient, WIRE_CREDITOR_NAME_MAX } from './client';
import {
  MEASURED_INBOUND_DELIVERY,
  MEASURED_INBOUND_WIRE,
  MEASURED_OUTBOUND_DELIVERY,
  MEASURED_OUTBOUND_WIRE,
} from './measured';
import { WIRE_PROVIDER, type IncreaseInboundWireTransfer, type IncreaseWireTransfer } from './types';

const ENV = { INCREASE_API_KEY: 'test-key', INCREASE_BASE_URL: 'https://sandbox.increase.com' };

/**
 * A client that answers with measured objects and makes no network call.
 *
 * Subclassed rather than duck-typed so the adapter is exercised against the
 * real class's surface — if `IncreaseWireClient` grows a method the adapter
 * starts calling, this stub gets it too and the test keeps being about the
 * adapter rather than about the stub.
 */
class StubClient extends IncreaseWireClient {
  constructor(
    private readonly outbound: IncreaseWireTransfer = MEASURED_OUTBOUND_WIRE,
    private readonly inbound: IncreaseInboundWireTransfer = MEASURED_INBOUND_WIRE,
  ) {
    super({ env: ENV, fetchImpl: (() => Promise.reject(new Error('no network in this test'))) as unknown as typeof fetch });
  }
  override getTransfer(): Promise<IncreaseWireTransfer> {
    return Promise.resolve(this.outbound);
  }
  override getInboundTransfer(): Promise<IncreaseInboundWireTransfer> {
    return Promise.resolve(this.inbound);
  }
  override createTransfer(): Promise<IncreaseWireTransfer> {
    return Promise.resolve(this.outbound);
  }
}

function adapter(client: IncreaseWireClient = new StubClient()): ReturnType<typeof increaseWireAdapter> {
  return increaseWireAdapter({ env: ENV, client });
}

/* -------------------------------------------------------------------------- */

describe('identity and the support matrix', () => {
  it('names the RAIL, not the vendor', () => {
    // `increase.ach` and `increase.wire` are one vendor and two rails. The
    // webhook inbox keys on the vendor because that is what signs the request;
    // a ledger row says which network moved the money.
    const id = adapter().identity;
    expect(id.provider).toBe(WIRE_PROVIDER);
    expect(id.provider).toBe('increase.wire');
    expect(id.slot).toBe('wire');
    expect(id.evidence).toBe('live');
    expect(id.environment).toBe('sandbox');
  });

  it('declares every one of the five operations', () => {
    const supports = adapter().supports;
    for (const op of RAIL_OPERATIONS) {
      expect(supports[op], `missing declaration for ${op}`).toBeDefined();
    }
  });

  it('REFUSES reverse, in domain terms, with the measurement in the reason', () => {
    const rail = adapter();
    expect(supportsOperation(rail, 'reverse')).toBe(false);

    const reason = unsupportedReason(rail, 'reverse');
    expect(reason).not.toBeNull();
    // Not "TODO", not "unimplemented". The reason has to say what is true of
    // the NETWORK, and cite what was measured.
    expect(reason).toMatch(/final on receipt/i);
    expect(reason).toMatch(/inbound_wire_reversal/);
    expect(reason).toMatch(/return_reason_code null/);
  });

  it('has no `reverse` method to call at all', () => {
    // Belt to the type-level braces: `RailAdapter` has no `reverse` in its
    // type, so a caller writing `rail.reverse(...)` is a compile error. This
    // asserts the runtime object agrees, so a `in`-check or a dynamic caller
    // cannot find one either.
    expect('reverse' in adapter()).toBe(false);
  });

  it('narrows as observing and originating, and both halves agree', () => {
    const rail: RailAdapter = adapter();
    // `canObserve`/`canOriginate` check the DECLARATION and the METHOD. A
    // predicate trusting only the declaration would narrow a lying adapter
    // into a crash; one trusting only the method would let an undeclared
    // capability in the back door.
    expect(canObserve(rail)).toBe(true);
    expect(canOriginate(rail)).toBe(true);
  });

  it('renders four `+` and one `-` on the capability matrix', () => {
    const [row] = railCapabilityMatrix([adapter()]);
    expect(row).toBeDefined();
    const cells = Object.fromEntries((row?.cells ?? []).map((c) => [c.operation, c]));
    for (const op of ['originate', 'observe', 'settle', 'probe'] as const) {
      expect(cells[op]?.supported, op).toBe(true);
      // `measured` and not `unexercised`: every one of these was run against
      // Increase, and the evidence sentence names the call.
      expect(cells[op]?.proof, op).toBe('measured');
      expect(cells[op]?.note.length ?? 0).toBeGreaterThan(40);
    }
    expect(cells['reverse']?.supported).toBe(false);
    expect(cells['reverse']?.proof).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

describe('observe', () => {
  it('reads the object back, because the body is a pointer', async () => {
    const client = new StubClient();
    const spy = vi.spyOn(client, 'getTransfer');
    const observation = await adapter(client).observe(MEASURED_OUTBOUND_DELIVERY);

    expect(spy).toHaveBeenCalledWith('sandbox_wire_transfer_897tmwn18z27tzkqbkhe');
    expect(observation.event.type).toBe('settled');
  });

  it('keys the settlement on the IMAD, not on the transfer id', async () => {
    const observation = await adapter().observe(MEASURED_OUTBOUND_DELIVERY);
    expect(observation.settlement?.settlementRef).toBe('20260911sgzamiaa787670');
    expect(observation.settlement?.ref).toBe('sandbox_wire_transfer_897tmwn18z27tzkqbkhe');
    expect(observation.settlement?.kind).toBe('settled');
    expect(observation.settlement?.amount).toEqual(usd(250000));
  });

  it('credits an inbound wire at its acceptance, keyed on its own IMAD', async () => {
    const observation = await adapter().observe(MEASURED_INBOUND_DELIVERY);
    expect(observation.event.type).toBe('settled');
    expect(observation.settlement?.settlementRef).toBe('20260911conbtmwu493867');
    expect(observation.settlement?.at).toBe('2026-09-11T03:59:29Z');
  });

  it('never returns a settlement of kind `returned` — there is no branch that builds one', async () => {
    // The measured outbound wire is REVERSED. A rail that modelled a wire
    // reversal as a return would produce `kind: 'returned'` here and net
    // -$2,500 out of a feed. It reports the settlement that happened.
    expect(MEASURED_OUTBOUND_WIRE.status).toBe('reversed');
    const observation = await adapter().observe(MEASURED_OUTBOUND_DELIVERY);
    expect(observation.settlement?.kind).toBe('settled');
    expect(observation.settlement?.returnCode).toBeUndefined();
    expect(observation.settlement?.returnCategory).toBeUndefined();
  });

  it('refuses an ACH delivery rather than answering for another rail', async () => {
    // Addressed to this VENDOR, not to this rail. Answering would be a rail
    // claiming a movement it did not see.
    const achDelivery = JSON.stringify({
      id: 'sandbox_event_ach',
      type: 'event',
      category: 'ach_transfer.updated',
      created_at: '2026-09-11T03:58:51Z',
      associated_object_id: 'sandbox_ach_transfer_x',
      associated_object_type: 'ach_transfer',
    });
    const observation = await adapter().observe(achDelivery);
    expect(observation.event.type).toBe('unknown');
    expect(observation.settlement).toBeNull();
  });

  it('never throws on an unparseable body', async () => {
    // A throw becomes a 5xx and a provider that collects enough of those
    // disables the subscription.
    for (const body of ['', 'not json', '{}', '[]', 'null']) {
      const observation = await adapter().observe(body);
      expect(observation.event.type).toBe('unknown');
      expect(observation.settlement).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('originate', () => {
  it('maps a complete wire to a SETTLED origination — there is no day in between', async () => {
    const client = new StubClient({ ...MEASURED_OUTBOUND_WIRE, status: 'complete' });
    const origination = await adapter(client).originate({
      clientReferenceId: 'payment:test',
      sourceAccountId: 'sandbox_account_x',
      beneficiary: {
        name: 'Ridgeline Robotics Inc',
        wireRoutingNumber: '021000021',
        accountNumber: '1111222233330000',
      },
      amount: usd(250000),
      remittance: 'CORGI TEST',
    });

    expect(origination.status).toBe('settled');
    expect(origination.ref).toBe('sandbox_wire_transfer_897tmwn18z27tzkqbkhe');
    expect(origination.amount).toEqual(usd(250000));
    // Proven by a read-back off the object, never by the 200 that returned it.
    expect(origination.at).toBe('2026-09-11T03:58:34Z');
  });

  it('calls a reversed wire settled too, because the originator asked a different question', async () => {
    const origination = await adapter().originate({
      clientReferenceId: 'payment:test',
      sourceAccountId: 'sandbox_account_x',
      beneficiary: { name: 'X', wireRoutingNumber: '021000021', accountNumber: '1' },
      amount: usd(250000),
      remittance: 'CORGI TEST',
    });
    expect(origination.status).toBe('settled');
  });

  it('calls a cancelled or rejected wire REFUSED — nothing was put on a wire', async () => {
    for (const status of ['canceled', 'rejected'] as const) {
      const client = new StubClient({ ...MEASURED_OUTBOUND_WIRE, status });
      const origination = await adapter(client).originate({
        clientReferenceId: 'payment:test',
        sourceAccountId: 'sandbox_account_x',
        beneficiary: { name: 'X', wireRoutingNumber: '021000021', accountNumber: '1' },
        amount: usd(1),
        remittance: 'X',
      });
      expect(origination.status, status).toBe('refused');
    }
  });

  it('calls requires_attention INDETERMINATE — a handle with no answer attached', async () => {
    const client = new StubClient({ ...MEASURED_OUTBOUND_WIRE, status: 'requires_attention' });
    const origination = await adapter(client).originate({
      clientReferenceId: 'payment:test',
      sourceAccountId: 'sandbox_account_x',
      beneficiary: { name: 'X', wireRoutingNumber: '021000021', accountNumber: '1' },
      amount: usd(1),
      remittance: 'X',
    });
    // Nothing may be posted against this. It is not `accepted` and it is not
    // `failed`, and saying either would be a lie chosen for an enum's comfort.
    expect(origination.status).toBe('indeterminate');
  });
});

describe('the request is guarded before it is sent', () => {
  const instruction = (name: string) => ({
    clientReferenceId: 'payment:test',
    sourceAccountId: 'sandbox_account_x',
    beneficiary: { name, wireRoutingNumber: '021000021', accountNumber: '1' },
    amount: usd(100),
    remittance: 'X',
  });

  it('refuses a beneficiary name over the MEASURED 140, rather than truncating it', async () => {
    // 140 -> 200, 141 -> 400 `creditor.name: Maximum length is 140.`, measured
    // against the sandbox. The payee book allows 200, so the gap is reachable.
    // Refused and not truncated: shortening a beneficiary on an irrevocable
    // payment changes who it is addressed to, after two humans approved the
    // instruction that named them.
    const client = new IncreaseWireClient({
      env: ENV,
      fetchImpl: (() => Promise.reject(new Error('must not reach the network'))) as unknown as typeof fetch,
    });
    await expect(
      client.createTransfer(instruction('N'.repeat(WIRE_CREDITOR_NAME_MAX + 1))),
    ).rejects.toThrow(/at most 140/);
  });

  it('lets exactly 140 through — the boundary is the measured one', async () => {
    let sentName: unknown = null;
    const fetchImpl = ((_url: string, init: RequestInit) => {
      sentName = JSON.parse(String(init.body)).creditor.name;
      return Promise.resolve(new Response(JSON.stringify(MEASURED_OUTBOUND_WIRE), { status: 200 }));
    }) as unknown as typeof fetch;
    const client = new IncreaseWireClient({ env: ENV, fetchImpl });
    await client.createTransfer(instruction('N'.repeat(WIRE_CREDITOR_NAME_MAX)));
    expect(String(sentName)).toHaveLength(140);
  });

  it('refuses a non-USD or non-positive amount before any call', async () => {
    const client = new IncreaseWireClient({
      env: ENV,
      fetchImpl: (() => Promise.reject(new Error('must not reach the network'))) as unknown as typeof fetch,
    });
    await expect(
      client.createTransfer({ ...instruction('X'), amount: { amount: 100n, currency: 'USDC' } }),
    ).rejects.toThrow(/USD/);
    await expect(
      client.createTransfer({ ...instruction('X'), amount: { amount: 0n, currency: 'USD' } }),
    ).rejects.toThrow(/positive/);
  });
});

/* -------------------------------------------------------------------------- */

describe('the generic reporters do not know this is a wire', () => {
  it('sums a wire settlement and dedupes the four deliveries about it', async () => {
    const rail = adapter() as unknown as ObservingRail;
    // One transfer, five real deliveries: created, and four updated. Every one
    // resolves to the same object, so every one reports the same settlement —
    // which is a feature, and is why the dedupe key is the IMAD.
    const deliveries: RailDelivery[] = Array.from({ length: 5 }, () => ({
      provider: WIRE_PROVIDER,
      rawBody: MEASURED_OUTBOUND_DELIVERY,
    }));

    const report = await reportSettlements([rail], deliveries);
    expect(report.settlements).toHaveLength(1);
    expect(report.duplicates).toHaveLength(4);
    expect(report.net.get('USD')).toBe(250000n);
  });

  it('sums an inbound and an outbound wire in one call, with no `if` about either', async () => {
    const rail = adapter() as unknown as ObservingRail;
    const report = await reportSettlements(
      [rail],
      [
        { provider: WIRE_PROVIDER, rawBody: MEASURED_OUTBOUND_DELIVERY },
        { provider: WIRE_PROVIDER, rawBody: MEASURED_INBOUND_DELIVERY },
      ],
    );
    expect(report.settlements).toHaveLength(2);
    // $2,500.00 + $12,500.00. NOTE, and it is a finding rather than a bug in
    // this rail: `RailSettlement` carries no DIRECTION, so the generic
    // reporter adds an outbound payment and an inbound receipt with the same
    // sign. It nets `returned` negative and nothing else. See docs/WIRES.md §6.
    expect(report.net.get('USD')).toBe(1500000n);
  });

  it('reports a delivery for another provider as unroutable rather than guessing', async () => {
    const rail = adapter() as unknown as ObservingRail;
    const report = await reportSettlements([rail], [
      { provider: 'increase.ach', rawBody: MEASURED_OUTBOUND_DELIVERY },
    ]);
    expect(report.unroutable).toHaveLength(1);
    expect(report.settlements).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('probe', () => {
  it('asks the WIRE collection, because that is the capability being claimed', async () => {
    const calls: string[] = [];
    const fetchImpl = ((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response('{"data":[]}', { status: 200 }));
    }) as unknown as typeof fetch;

    const probe = await increaseWireAdapter({ env: ENV, fetchImpl }).probe();

    // NOT /accounts. Increase gates features per key — the same credential
    // that answers 200 here answers 403 private_feature_error on
    // /wire_drawdown_requests — so a probe reading /accounts would report LIVE
    // for a key with no wire entitlement at all.
    expect(calls[0]).toBe('https://sandbox.increase.com/wire_transfers?limit=1');
    expect(probe.liveness).toBe('live');
    expect(probe.label).toBe('LIVE');
    expect(probe.detail).toBe('GET /wire_transfers?limit=1 -> 200');
  });

  it('reads a rejected key as unauthorised and never as live', async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response('{}', { status: 401 }))) as unknown as typeof fetch;
    const probe = await increaseWireAdapter({ env: ENV, fetchImpl }).probe();
    expect(probe.liveness).toBe('unauthorised');
    expect(probe.label).toBe('SIMULATED');
  });

  it('says not_configured, not unreachable, when there is no credential', async () => {
    const probe = await increaseWireAdapter({ env: {} }).probe();
    expect(probe.liveness).toBe('not_configured');
    expect(probe.detail).toMatch(/cannot move a wire/);
  });

  it('cannot take the honesty table down when the network fails', async () => {
    const fetchImpl = (() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;
    const probes = await probeRails([increaseWireAdapter({ env: ENV, fetchImpl })]);
    expect(probes[0]?.liveness).toBe('unreachable');
    expect(summariseProbes(probes)).toEqual({ live: 0, simulated: 1, total: 1 });
  });
});
