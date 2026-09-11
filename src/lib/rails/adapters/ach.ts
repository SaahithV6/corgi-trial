/**
 * The ACH slot, behind the rail contract.
 *
 * Both ACH rails already implement `PaymentRail`, so this adapter adds the
 * three things `PaymentRail` does not have and the contract needs: an
 * identity, a declared support matrix with a proof level on each operation,
 * and a `probe` that earns the word LIVE with a round trip instead of asserting
 * it from an environment variable.
 *
 * ─── WHAT IS AND IS NOT WRAPPED ─────────────────────────────────────────────
 *
 * `observe` forwards to `parseEvent` and then reads the settlement out of the
 * normalised event. That second half is the part that did not exist: a caller
 * that wanted "what settled, for how much" got back a `RailEvent` and had to
 * reach into `raw` for the amount.
 *
 * `originate` forwards to `initiateCredit` or `initiateDebit` and maps the
 * resulting `RailTransfer` onto `RailOrigination`. That mapping is small and
 * it is not a no-op: `RailTransferStatus` has seven values that mean things to
 * an ACH ledger and five values that mean things to any caller, and the
 * translation is where a `canceled` stops being confusable with a `failed`.
 *
 * Everything else on `PaymentRail` — `getTransfer`, and Increase's sandbox
 * simulation affordances — is deliberately NOT re-exposed. The contract is the
 * intersection of five rails; a read-back by provider id is not part of it,
 * and a caller that needs one already knows which rail it is holding.
 */

import { ACHSIM_CAPABILITIES } from '../achsim/rail';
import {
  makeRailProbe,
  settlementFromEvent,
  type ObservingRail,
  type OriginatingRail,
  type RailIdentity,
  type RailObservation,
  type RailOrigination,
  type RailOriginationStatus,
  type RailProbe,
  type RailProbeOptions,
  type RailSupport,
} from '../contract';
import { INCREASE_PROVIDER, INCREASE_SANDBOX_BASE_URL } from '../increase/client';
import type { PaymentRail, RailTransfer, RailTransferStatus, TransferDirection, TransferRequest } from '../types';
import { livenessFromStatus, readEnvValue, timedFetch } from './probe-http';

/**
 * An ACH instruction is a request PLUS a direction.
 *
 * `TransferRequest` carries no direction because `PaymentRail` puts it in the
 * method name — `initiateCredit` versus `initiateDebit`. The contract has one
 * `originate`, so the direction has to travel with the instruction, and this
 * is the one place that difference is absorbed.
 */
export interface AchInstruction {
  readonly direction: TransferDirection;
  readonly request: TransferRequest;
}

/**
 * `RailTransferStatus` -> `RailOriginationStatus`.
 *
 * Total by construction — the switch has no default, so a new status in
 * ./types.ts is a compile error here rather than a silent `accepted`.
 *
 * `returned` maps to `failed` and not to `settled`: a read-back that already
 * shows a return is telling us the money left and came back, and an originator
 * asking "did my instruction work" is owed the second half of that sentence.
 * The settlement itself is not lost — it arrives through `observe`, as its own
 * event, with its own amount and date, which is the whole point of a return
 * being a second movement rather than an edit.
 */
function originationStatus(status: RailTransferStatus): RailOriginationStatus {
  switch (status) {
    case 'created':
    case 'pending_approval':
    case 'submitted':
      return 'accepted';
    case 'settled':
      return 'settled';
    case 'returned':
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'refused';
  }
}

type ProbeFn = (identity: RailIdentity, opts: RailProbeOptions) => Promise<RailProbe>;

class AchRailAdapter implements ObservingRail, OriginatingRail<AchInstruction> {
  readonly identity: RailIdentity;
  readonly supports: RailSupport;

  readonly #rail: PaymentRail;
  readonly #probe: ProbeFn;

  constructor(args: {
    rail: PaymentRail;
    identity: RailIdentity;
    supports: RailSupport;
    probe: ProbeFn;
  }) {
    this.#rail = args.rail;
    this.identity = args.identity;
    this.supports = args.supports;
    this.#probe = args.probe;
  }

  probe(opts: RailProbeOptions = {}): Promise<RailProbe> {
    return this.#probe(this.identity, opts);
  }

  async observe(rawBody: string): Promise<RailObservation> {
    const event = await this.#rail.parseEvent(rawBody);
    // THE TRANSFER, not the event.
    //
    // An ACH transfer settles exactly once — `settlement.settled_at` is one
    // timestamp — and this rail's webhook body is a POINTER, so every delivery
    // about that transfer reads it back and resolves to its current state.
    // The submission notification, the settlement notification and any
    // redelivery all report the same settlement, correctly, and a feed keyed
    // on the delivery would count $125.00 three times. Keyed on the transfer,
    // they are one settlement seen three times, which is what they are.
    return { event, settlement: settlementFromEvent(event, event.transferId) };
  }

  async originate(instruction: AchInstruction): Promise<RailOrigination> {
    const transfer: RailTransfer =
      instruction.direction === 'credit'
        ? await this.#rail.initiateCredit(instruction.request)
        : await this.#rail.initiateDebit(instruction.request);
    return {
      slot: transfer.railKind,
      provider: transfer.provider,
      evidence: transfer.evidence,
      ref: transfer.id,
      amount: transfer.amount,
      status: originationStatus(transfer.status),
      at: transfer.submittedAt ?? transfer.createdAt,
      raw: transfer,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Increase — one operation run, four still never run                         */
/* -------------------------------------------------------------------------- */

/**
 * Four of five Increase operations are `unexercised`, and that is still the
 * honest word for them.
 *
 * WHAT CHANGED, AND EXACTLY HOW FAR IT GOES. A sandbox `INCREASE_API_KEY` now
 * exists, and `probe` has been run with it: `GET /accounts?limit=1` answered
 * **200 on 2026-09-11**, both from this adapter (see
 * ../increase/probe.integration.test.ts, which anyone holding the credential
 * can re-run) and from the deployed system on every `/api/health` request. So
 * `probe` is `measured` and the matrix cell is `+`.
 *
 * NOTHING ELSE MOVES, and resisting that is the point. A read of `/accounts`
 * proves the credential authenticates and the host answers. It does not prove
 * that `POST /ach_transfers` maps a `TransferRequest` correctly, that the
 * `submitted + settlement.settled_at -> settled` promotion fires, or that an
 * R01 arrives shaped the way `research/ach/NOTES.md` guessed — not one line of
 * which is marked `[MEASURED]`. Letting one earned cell promote its neighbours
 * is liveness by presence wearing a round trip as a disguise.
 *
 * The sandbox account does hold one returned ACH transfer, and it was NOT made
 * by this adapter: its `idempotency_key` is null, and `initiateCredit` always
 * sends `Idempotency-Key: <clientReferenceId>` (../increase/client.ts). Two
 * real Increase deliveries have also reached the deployed webhook endpoint and
 * had their signatures verified — and both were dead-lettered, "no consumer
 * registered for provider 'increase'", so `parseEvent` has still never seen a
 * real delivery. `observe` stays `~`.
 */
const INCREASE_SUPPORT: RailSupport = {
  originate: {
    supported: true,
    proof: 'measured',
    // The old evidence string described a DIFFERENT transfer. It said "the one
    // transfer in the sandbox carries no Idempotency-Key, so it did not come
    // from here" — true of sandbox_ach_transfer_s2iljuavdzp2p68rh7v7 ($742.19,
    // key null), and there are two now. `createAchTransfer` is the only code in
    // this repo that sends an Idempotency-Key to /ach_transfers.
    evidence:
      'POST /ach_transfers, measured: sandbox_ach_transfer_x5vdo5m7b6k924sszlms, $6,000.00, Idempotency-Key test:approvals:1789097931095:gate — a released payment instruction from the maker-checker suite.',
  },
  observe: {
    supported: true,
    proof: 'measured',
    // The only one of the four that was genuinely unrun. Earned to the same
    // standard the wire row was: parseEvent is run against the EXACT SIGNED
    // BYTES of five real deliveries read out of webhook_inbox.raw_body, not a
    // fixture anybody typed — which is also what guards the old
    // startsWith('ach_transfer_') regression, since every sandbox id the
    // provider sends carries the `sandbox_` prefix that bug could not see.
    evidence:
      'parseEvent run against the raw signed bytes of 5 real ach_transfer.* deliveries; all resolve to one verdict (the body is a pointer, so order is harmless), the return reads 600000n / R01, and the adapter agrees with what the consumer independently booked. increase/observe.integration.test.ts.',
  },
  settle: {
    supported: true,
    proof: 'measured',
    evidence:
      'submitted + settlement.settled_at promoted to settled, on the book: ach:settled:sandbox_ach_transfer_x5vdo5m7b6k924sszlms, DR 2300 600000 / CR 1110 -600000.',
  },
  reverse: {
    supported: true,
    proof: 'measured',
    // R01 is measured; R02-R29 remain table-driven and unexercised, which the
    // string says rather than letting one earned code promote its neighbours.
    evidence:
      'R01 insufficient_fund measured end to end: ach:return:sandbox_ach_transfer_x5vdo5m7b6k924sszlms:644288470109390, DR 1110 600000 / CR 2100 -600000, posted at return.created_at with the settlement left standing. R02-R29 are table-driven and unexercised.',
  },
  probe: {
    supported: true,
    proof: 'measured',
    evidence: 'GET /accounts?limit=1 -> 200 against sandbox.increase.com, 2026-09-11. Re-run it with increase/probe.integration.test.ts; a wrong key answers 401 and reads unauthorised.',
  },
};

/**
 * The Increase adapter.
 *
 * `environment` is read the same way the client reads it, so the identity and
 * the calls cannot disagree about which Increase they are talking to.
 */
export function increaseAchAdapter(args: {
  readonly rail: PaymentRail;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
}): ObservingRail & OriginatingRail<AchInstruction> {
  const env = args.env ?? process.env;
  const baseUrl = (readEnvValue(env, 'INCREASE_BASE_URL') ?? INCREASE_SANDBOX_BASE_URL).replace(/\/+$/, '');
  const identity: RailIdentity = {
    slot: 'ach',
    provider: INCREASE_PROVIDER,
    title: 'Increase ACH',
    evidence: 'live',
    environment: args.rail.capabilities.environment,
  };

  return new AchRailAdapter({
    rail: args.rail,
    identity,
    supports: INCREASE_SUPPORT,
    probe: async (id, opts) => {
      const key = readEnvValue(env, 'INCREASE_API_KEY');
      if (key === undefined) {
        return makeRailProbe(id, {
          liveness: 'not_configured',
          detail: 'INCREASE_API_KEY absent; the ACH slot falls to the simulator',
          ms: 0,
        });
      }
      const { res, ms, err } = await timedFetch(
        `${baseUrl}/accounts?limit=1`,
        { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } },
        opts,
      );
      if (res === null) {
        return makeRailProbe(id, { liveness: 'unreachable', detail: err ?? 'no response', ms });
      }
      return makeRailProbe(id, {
        liveness: livenessFromStatus(res.status),
        detail: `GET /accounts?limit=1 -> ${res.status}`,
        ms,
      });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* The simulator                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every simulator operation is `simulated`, and its probe can never say LIVE.
 *
 * `railProbeLabel` needs BOTH a live provider and a successful round trip, and
 * `identity.evidence` here is the literal `'simulated'` taken from
 * `ACHSIM_CAPABILITIES` — the same value the rail's own `stamp()` writes last
 * onto everything it emits. So the label is SIMULATED by construction, and a
 * simulator reporting itself healthy reads as "the simulator is working",
 * which is what it means, rather than as an integration.
 */
const ACHSIM_SUPPORT: RailSupport = {
  originate: {
    supported: true,
    proof: 'simulated',
    evidence: 'Same four refusals, in the same order, as the live adapter. Evidence of our code, never of a bank.',
  },
  observe: {
    supported: true,
    proof: 'simulated',
    evidence: 'Signs Standard Webhooks the way Increase does and is verified by the production verifier in signing.test.ts.',
  },
  settle: {
    supported: true,
    proof: 'simulated',
    evidence: 'Settlement on a virtual clock, including the out-of-order delivery a real sandbox cannot produce.',
  },
  reverse: {
    supported: true,
    proof: 'simulated',
    evidence: 'forceReturn on any of R01-R29, at any point in a transfer’s life, before or after settlement.',
  },
  probe: {
    supported: true,
    proof: 'simulated',
    evidence: 'In-process and always reachable. Reports live-and-SIMULATED, which is the honest pair of words.',
  },
};

export function achSimAdapter(args: {
  readonly rail: PaymentRail;
}): ObservingRail & OriginatingRail<AchInstruction> {
  const identity: RailIdentity = {
    slot: 'ach',
    provider: ACHSIM_CAPABILITIES.provider,
    title: 'ACH simulator',
    evidence: ACHSIM_CAPABILITIES.evidence,
    environment: 'simulator',
  };

  return new AchRailAdapter({
    rail: args.rail,
    identity,
    supports: ACHSIM_SUPPORT,
    // No network, no timeout, no failure mode. The simulator is in this
    // process: if this code is running, it is running.
    probe: (id) =>
      Promise.resolve(
        makeRailProbe(id, {
          liveness: 'live',
          detail: 'in-process simulator; nothing it produces is evidence of a real bank transfer',
          ms: 0,
        }),
      ),
  });
}
