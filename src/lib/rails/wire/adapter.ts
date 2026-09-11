/**
 * The wire slot, behind the rail contract.
 *
 * ─── THE ONE THING THIS ADAPTER PROVES ABOUT THE CONTRACT ───────────────────
 *
 * `docs/RAILS.md` §2 says an unsupported operation is expressed twice over and
 * neither expression is a runtime failure: the method is ABSENT FROM THE TYPE,
 * and `supports[operation]` carries the reason in domain terms. Until now that
 * claim had two witnesses that both refused the same two operations — Lithic
 * cannot originate, Plaid cannot do anything — and one, USDC, that refused
 * `reverse`.
 *
 * This adapter refuses `reverse` for a DIFFERENT reason than USDC does, and
 * the difference is the interesting part. USDC's refusal is a statement about
 * physics: a confirmed chain transfer cannot be unmade. A wire's is a
 * statement about law and network design: the message CAN be followed by money
 * coming back, and we have measured it happening — what we cannot do is CAUSE
 * it, be OWED it, or CLASSIFY it, because there is no wire return-code table
 * and no recall as of right. `reverse` is a capability of the rail, not a
 * description of a thing that sometimes happens near it.
 *
 * So: `supports.reverse.supported === false`, `canObserve()` still narrows,
 * there is no `reverse` method to call, and `observe()` cannot construct a
 * `RailSettlement` with `kind: 'returned'` — there is no branch that builds
 * one. A wire that came back reaches the ledger as `wireReturnOfFunds()`, an
 * INBOUND CREDIT, which is what the measurement says it is.
 *
 * ─── WHAT THE EVIDENCE COLUMN SAYS, AND WHY IT SAYS `measured` ──────────────
 *
 * Four of five operations on this rail are `measured`, which is unusual in
 * this repo and is not a relaxation of the standard. `docs/RAILS.md` holds the
 * Increase ACH row at `~` for four operations on the explicit grounds that
 * `GET /accounts` returning 200 proves a credential and nothing else. The same
 * standard applied here produces the opposite answer for a boring reason: the
 * calls were made. `POST /wire_transfers` returned an id, the simulated submit
 * returned an IMAD and a transaction id, the simulated reversal returned a
 * second IMAD, and the deployed webhook endpoint has thirteen real,
 * signature-verified wire deliveries in its inbox. Each cell below names the
 * call and the object it produced, so any cell can be re-earned in seconds
 * with ./wire.integration.test.ts rather than believed.
 *
 * `observe` is `measured` on a stricter basis than the others: not that a
 * delivery arrived, but that THIS function was run against the exact verified
 * bytes of one, read out of `webhook_inbox`. See the integration test.
 */

import {
  makeRailProbe,
  settlementFromEvent,
  type ObservingRail,
  type OriginatingRail,
  type RailIdentity,
  type RailObservation,
  type RailOrigination,
  type RailProbe,
  type RailProbeOptions,
  type RailSettlement,
  type RailSupport,
} from '../contract';
import { livenessFromStatus, readEnvValue, timedFetch } from '../adapters/probe-http';
import { RailError, usd, type Evidence, type RailEnvironment } from '../types';

import { IncreaseWireClient, INCREASE_WIRE_SANDBOX_BASE_URL } from './client';
import {
  inboundCredit,
  inboundWireEvent,
  outboundWireEvent,
  parseEventPointer,
  returnOfFunds,
  wireSettlementRef,
} from './semantics';
import {
  WIRE_PROVIDER,
  WIRE_TITLE,
  isWireDelivery,
  type IncreaseWireTransfer,
  type InboundWireCredit,
  type WireInstruction,
} from './types';

/* -------------------------------------------------------------------------- */
/* The support matrix                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every cell names a call and, where one exists, the object it produced.
 *
 * The ids are sandbox ids from 2026-09-11 and they are in the file on purpose:
 * "measured" with no object id behind it is a word, and a word decays the
 * moment a key is rotated. An id can be looked up.
 */
export const WIRE_SUPPORT: RailSupport = {
  originate: {
    supported: true,
    proof: 'measured',
    evidence:
      'POST /wire_transfers -> 200, sandbox_wire_transfer_897tmwn18z27tzkqbkhe, $2,500.00 to routing 021000021, 2026-09-11. The first attempt was a 400 naming four fields: Increase moved this endpoint to ISO 20022 (creditor/remittance) while ACH kept beneficiary_name/message_to_recipient.',
  },
  observe: {
    supported: true,
    proof: 'measured',
    evidence:
      'The body is a pointer, like ACH. Run against the exact verified bytes of a real delivery read out of webhook_inbox — 13 signature-verified wire deliveries reached the deployed endpoint on 2026-09-11 — not against a fixture shaped like one.',
  },
  settle: {
    supported: true,
    proof: 'measured',
    evidence:
      'POST /simulations/wire_transfers/{id}/submit -> 200, status pending_creating -> complete with IMAD 20260911sgzamiaa787670 and sandbox_transaction_2ff00n3glfneatkctcl9. There is NO settlement object on a wire: submission.submitted_at IS the settlement time, the mirror of the ACH promotion trap.',
  },
  reverse: {
    supported: false,
    reason:
      'A Fedwire funds transfer is final on receipt: no return window, no return-code table, no recall as of right. Money does sometimes come back — MEASURED, POST /simulations/wire_transfers/{id}/reverse -> 200 — but the object it produces is class_name "inbound_wire_reversal" with its OWN IMAD (20260911apvdjfqt599399, not the original 20260911sgzamiaa787670), its own transaction id, and return_reason_code null. That is a SECOND PAYMENT the beneficiary bank chose to send, not our transfer being unwound. We cannot cause it, are not owed it, and have no code to classify it by, so it is an inbound credit and not a rail capability. See wireReturnOfFunds().',
  },
  probe: {
    supported: true,
    proof: 'measured',
    evidence:
      'GET /wire_transfers?limit=1 -> 200 against sandbox.increase.com, 2026-09-11. The WIRE collection deliberately, not /accounts: an account read would prove the credential and say nothing about whether this deployment may move wires, and /wire_drawdown_requests answers 403 private_feature_error on the same key — so the endpoint chosen is the one whose 200 is evidence of the capability being claimed.',
  },
};

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

export interface WireAdapterOptions {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly client?: IncreaseWireClient | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * The wire adapter.
 *
 * `ObservingRail & OriginatingRail<WireInstruction>` and nothing else. There
 * is no `ReversingRail` to implement, because the contract does not have one:
 * `reverse` is a DECLARATION, and declaring it false is the whole of saying
 * this rail cannot do it. A future caller writing `if (rail.supports.reverse
 * .supported)` gets `false` here and the reason next to it; a caller reaching
 * for a `reverse()` method gets a compile error, which is the point.
 */
export class IncreaseWireAdapter implements ObservingRail, OriginatingRail<WireInstruction> {
  readonly identity: RailIdentity;
  readonly supports: RailSupport = WIRE_SUPPORT;

  readonly #client: IncreaseWireClient;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #baseUrl: string;
  /**
   * The fetch the PROBE uses, separately from the one the client uses.
   *
   * `probe()` does not go through the client: it is one raw authenticated GET
   * with a hard timeout, and `timedFetch` owns that. So a caller that injected
   * a fetch at construction — every unit test does — would otherwise find the
   * probe reaching the real internet with a fake key. It did, once, and the
   * test that caught it was the one asserting `unreachable`: it got
   * `unauthorised` back from the actual sandbox.
   */
  readonly #fetchImpl: typeof fetch | undefined;

  constructor(opts: WireAdapterOptions = {}) {
    this.#env = opts.env ?? process.env;
    this.#fetchImpl = opts.fetchImpl;
    this.#client =
      opts.client ??
      new IncreaseWireClient({
        env: this.#env,
        ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
      });
    this.#baseUrl = this.#client.baseUrl;
    this.identity = {
      slot: 'wire',
      provider: WIRE_PROVIDER,
      title: WIRE_TITLE,
      // Sandbox is the provider's own system, so the evidence is `live`.
      // What separates sandbox money from real money is `environment`.
      evidence: 'live' satisfies Evidence,
      environment: environmentFor(this.#baseUrl),
    };
  }

  get client(): IncreaseWireClient {
    return this.#client;
  }

  /* ---- probe ----------------------------------------------------------- */

  /**
   * The cheapest honest answer to "could this rail move a wire right now?".
   *
   * `GET /wire_transfers?limit=1` rather than `/accounts`, and the choice is
   * deliberate. Increase gates features per key: the same credential that
   * answers 200 here answers 403 `private_feature_error` on
   * `/wire_drawdown_requests` (MEASURED). A probe that read `/accounts` would
   * report LIVE for a key with no wire entitlement at all, which is liveness
   * by presence one indirection removed — a real round trip that proves the
   * wrong proposition.
   */
  async probe(opts: RailProbeOptions = {}): Promise<RailProbe> {
    const key = readEnvValue(this.#env, 'INCREASE_API_KEY');
    if (key === undefined) {
      return makeRailProbe(this.identity, {
        liveness: 'not_configured',
        detail: 'INCREASE_API_KEY absent; this deployment cannot move a wire',
        ms: 0,
      });
    }
    const { res, ms, err } = await timedFetch(
      `${this.#baseUrl}/wire_transfers?limit=1`,
      { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } },
      // The caller's options win: a caller passing its own fetch or timeout to
      // `probeRails` is overriding, not being overridden.
      { ...(this.#fetchImpl === undefined ? {} : { fetchImpl: this.#fetchImpl }), ...opts },
    );
    if (res === null) {
      return makeRailProbe(this.identity, {
        liveness: 'unreachable',
        detail: err ?? 'no response',
        ms,
      });
    }
    return makeRailProbe(this.identity, {
      liveness: livenessFromStatus(res.status),
      detail: `GET /wire_transfers?limit=1 -> ${res.status}`,
      ms,
    });
  }

  /* ---- originate ------------------------------------------------------- */

  /**
   * Instruct a wire and report its fate in rail-agnostic terms.
   *
   * The `status` mapping is where a wire stops resembling ACH. There is no
   * `accepted`-then-`settled` day gap to represent: a wire is either not on
   * the network yet, or it is done. `complete` maps straight to `settled`
   * because `submission.input_message_accountability_data` is the network's
   * own receipt, read back off the object rather than inferred from a 200.
   */
  async originate(instruction: WireInstruction): Promise<RailOrigination> {
    const transfer = await this.#client.createTransfer(instruction);
    return this.#origination(transfer);
  }

  /**
   * Re-read an instruction's fate. Not on the contract — a read-back by
   * provider id is not part of the intersection of five rails — but the
   * caller that needs one already knows which rail it is holding, which is
   * exactly the case ../contract.ts §4 describes.
   */
  async readOrigination(transferId: string): Promise<RailOrigination> {
    return this.#origination(await this.#client.getTransfer(transferId));
  }

  #origination(transfer: IncreaseWireTransfer): RailOrigination {
    const amount = usd(BigInt(Math.trunc(transfer.amount)));
    const base = {
      slot: 'wire' as const,
      provider: WIRE_PROVIDER,
      evidence: this.#client.evidence,
      ref: transfer.id,
      amount,
      raw: transfer,
    };

    switch (transfer.status) {
      case 'complete':
      case 'reversed':
        // `reversed` is still `settled`, for the same reason it is in
        // ./semantics.ts: the wire settled and stays settled. The money
        // coming back is a separate arrival, and an originator asking "did my
        // instruction work" is owed "yes, on this day, with this IMAD".
        return {
          ...base,
          status: 'settled',
          at: transfer.submission?.submitted_at ?? transfer.created_at,
        };
      case 'submitted':
        return {
          ...base,
          status: 'accepted',
          at: transfer.submission?.submitted_at ?? transfer.created_at,
        };
      case 'canceled':
      case 'rejected':
        // Both mean it never left us. `refused` and not `failed`: nothing was
        // put on a wire, so there is nothing in flight to have gone missing.
        return {
          ...base,
          status: 'refused',
          at: transfer.cancellation?.canceled_at ?? transfer.created_at,
        };
      case 'requires_attention':
        // A handle exists and the outcome is unknown. Nothing may be posted.
        return { ...base, status: 'indeterminate', at: transfer.created_at };
      case 'pending_approval':
      case 'pending_creating':
      case 'pending_reviewing':
      case 'pending_submission':
        return { ...base, status: 'accepted', at: transfer.created_at };
      default:
        return { ...base, status: 'indeterminate', at: transfer.created_at };
    }
  }

  /* ---- observe --------------------------------------------------------- */

  /**
   * A verified body -> one normalised observation.
   *
   * NEVER THROWS on an unrecognised payload — a throw becomes a 5xx and a
   * provider that collects enough of those disables the subscription. The one
   * exception, allowed by the contract for exactly this reason, is a failed
   * read-back: not knowing the state is not the same as the event being
   * uninteresting, and a silent 200 on "we could not tell" would lose money.
   *
   * The read-back is what makes OUT-OF-ORDER DELIVERY harmless here, exactly
   * as on ACH: whichever of `wire_transfer.created`, the four
   * `wire_transfer.updated` notifications and any redelivery arrives first,
   * the object read back reflects current state. Five deliveries about one
   * transfer therefore report ONE settlement five times, and
   * `reportSettlements` collapses them because they all carry the same
   * `settlementRef` — the IMAD.
   */
  async observe(rawBody: string): Promise<RailObservation> {
    const pointer = parseEventPointer(rawBody);
    if (pointer === null) {
      return {
        event: {
          provider: WIRE_PROVIDER,
          railKind: 'wire',
          evidence: this.#client.evidence,
          eventId: 'unparseable',
          transferId: 'unknown',
          occurredAt: new Date().toISOString(),
          raw: rawBody,
          type: 'unknown',
          providerType: 'unparseable',
          reason: 'unparseable',
        },
        settlement: null,
      };
    }

    if (!isWireDelivery(pointer.category)) {
      // Addressed to this vendor, but not to this rail. An `ach_transfer.*`
      // delivery belongs to the ACH adapter and this one must not answer for
      // it — answering would be a rail claiming a movement it did not see.
      return {
        event: {
          provider: WIRE_PROVIDER,
          railKind: 'wire',
          evidence: this.#client.evidence,
          eventId: pointer.id,
          transferId: pointer.associated_object_id,
          occurredAt: pointer.created_at,
          raw: pointer,
          type: 'unknown',
          providerType: pointer.category,
          reason: 'unmodelled_event',
        },
        settlement: null,
      };
    }

    const event = { id: pointer.id, occurredAt: pointer.created_at };

    if (pointer.associated_object_type === 'inbound_wire_transfer') {
      const inbound = await this.#client.getInboundTransfer(pointer.associated_object_id);
      const normalised = inboundWireEvent(inbound, event);
      return {
        event: normalised,
        settlement: this.#settlement(
          normalised,
          wireSettlementRef(inbound.input_message_accountability_data, inbound.id),
        ),
      };
    }

    const transfer = await this.#client.getTransfer(pointer.associated_object_id);
    const normalised = outboundWireEvent(transfer, event);
    return {
      event: normalised,
      settlement: this.#settlement(
        normalised,
        // THE IMAD, not the transfer id. One Fedwire message, one settlement.
        wireSettlementRef(transfer.submission?.input_message_accountability_data, transfer.id),
      ),
    };
  }

  /**
   * The settlement half, and the one assertion that keeps the type honest.
   *
   * `settlementFromEvent` can in principle return `kind: 'returned'`, because
   * it serves every rail. Nothing in ./semantics.ts constructs a `returned`
   * event, so it cannot happen here — and this is the belt to that braces. A
   * `returned` settlement on a rail whose `supports.reverse` is `false` would
   * be the adapter contradicting its own declaration, which is the precise
   * failure `canObserve`'s two-halves check exists to prevent one level up.
   */
  #settlement(
    event: Parameters<typeof settlementFromEvent>[0],
    settlementRef: string,
  ): RailSettlement | null {
    const settlement = settlementFromEvent(event, settlementRef);
    if (settlement !== null && settlement.kind === 'returned') {
      throw new RailError(
        'the wire rail produced a `returned` settlement, which contradicts supports.reverse === false',
        {
          provider: WIRE_PROVIDER,
          code: 'reverse_not_supported',
          retryable: false,
          evidence: this.#client.evidence,
          raw: settlement,
        },
      );
    }
    return settlement;
  }

  /* ---- the thing `reverse` is not ------------------------------------- */

  /**
   * Money a beneficiary's bank sent back, read as the arrival it is.
   *
   * On the adapter's own surface, never on the contract — ../types.ts:
   * "Anything a specific rail can do beyond that belongs on that adapter's own
   * surface and NOT here. Widening this interface for one rail is how an
   * adapter rots back into a schema."
   *
   * Returns null for every wire that has not been reversed, which is almost
   * all of them. What comes out is the SAME `InboundWireCredit` type an
   * ordinary receipt produces, and `creditInboundWire()` books it with the
   * same posting, the same hold, the same policy and the same availability —
   * because it is the same event.
   */
  async wireReturnOfFunds(transferId: string): Promise<InboundWireCredit | null> {
    return returnOfFunds(await this.#client.getTransfer(transferId));
  }

  /**
   * An accepted inbound wire, read as a credit the ledger can book.
   *
   * Null until acceptance. A wire that has not been accepted is not our money,
   * and booking it would invent a receivable on a rail that has none —
   * the 1130 "ACH receivable, inbound in transit" account has no wire
   * equivalent for exactly this reason. See ./ledger.ts.
   */
  async readInboundCredit(inboundTransferId: string): Promise<InboundWireCredit | null> {
    return inboundCredit(await this.#client.getInboundTransfer(inboundTransferId));
  }
}

/**
 * Sandbox unless the base URL says otherwise.
 *
 * Read from the URL the CLIENT will actually call, so the identity and the
 * calls cannot disagree about which Increase they are talking to — the same
 * rule `increaseAchAdapter` follows, and the drift `docs/RAILS.md` §7 records
 * for `integrations/probe.ts` (which hardcodes the sandbox host and ignores
 * `INCREASE_BASE_URL`) is the reason it is worth following.
 */
function environmentFor(baseUrl: string): RailEnvironment {
  return baseUrl === INCREASE_WIRE_SANDBOX_BASE_URL || baseUrl.includes('sandbox')
    ? 'sandbox'
    : 'production';
}

/** The constructor a caller uses. Free: no network, no key read at import. */
export function increaseWireAdapter(opts: WireAdapterOptions = {}): IncreaseWireAdapter {
  return new IncreaseWireAdapter(opts);
}
