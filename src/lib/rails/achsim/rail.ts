/**
 * `AchSimRail` — the simulator behind the `PaymentRail` interface.
 *
 * Same four methods as `IncreaseAchRail`. A caller holding a `PaymentRail`
 * cannot tell which one it has except by reading `capabilities.evidence`, and
 * that is deliberate: the point of the simulator is that the code under test is
 * the code that ships.
 *
 * THE STAMP. Every value that leaves this class goes through `stamp()`, which
 * writes `evidence: 'simulated'` AFTER the spread. Not "sets it if absent" —
 * writes it last, so no caller-supplied object, no spread order, no config flag
 * and no future edit that adds a field can produce a value from this class that
 * claims to be live. `rail.test.ts` asserts it on every method, and the type of
 * `capabilities` is narrowed to the literal `'simulated'`, so an attempt to
 * widen it is a compile error rather than a review comment.
 */

import { SEC_CODE_BY_AUTHORIZATION } from '../increase/client';
import {
  RailError,
  type Evidence,
  type Money,
  type PaymentRail,
  type RailCapabilities,
  type RailEvent,
  type RailTransfer,
  type TransferDirection,
  type TransferRequest,
} from '../types';
import {
  ACHSIM_PROVIDER_SLUG,
  type AchSimEngine,
  type AchSimScenario,
  type AchSimTransferRecord,
} from './engine';

/**
 * Narrowed to the literal. `RailCapabilities.evidence` is `Evidence`; here it
 * is `'simulated'` and nothing else, which is a compile-time guarantee rather
 * than a runtime one.
 */
export type SimulatedCapabilities = RailCapabilities & { readonly evidence: 'simulated' };

export const ACHSIM_CAPABILITIES: SimulatedCapabilities = {
  kind: 'ach',
  provider: ACHSIM_PROVIDER_SLUG,
  evidence: 'simulated',
  environment: 'simulator',
  supportsCredit: true,
  supportsDebit: true,
  supportsReturns: true,
  // The same 60 as the live adapter, and for the same reason: the return window
  // outlives settlement and is what drives hold release. A simulator that
  // advertised a shorter window would let a consumer release funds early in
  // testing and late in production, which is the worst possible direction for
  // that error.
  returnWindowDays: 60,
  supportsIdempotency: true,
  supportsAccountCorrection: true,
};

/** The one place `evidence` is written, and it is written last. */
function stamp<T extends object>(value: T): T & { readonly evidence: 'simulated' } {
  return { ...value, evidence: 'simulated' as const };
}

export interface AchSimRailOptions {
  readonly engine: AchSimEngine;
  /** Applied to every transfer that does not carry its own scenario. */
  readonly scenario?: AchSimScenario | undefined;
}

export class AchSimRail implements PaymentRail {
  readonly capabilities: SimulatedCapabilities = ACHSIM_CAPABILITIES;

  private readonly engine: AchSimEngine;
  private readonly scenario: AchSimScenario | undefined;

  constructor(opts: AchSimRailOptions) {
    this.engine = opts.engine;
    this.scenario = opts.scenario;
  }

  initiateCredit(req: TransferRequest): Promise<RailTransfer> {
    return this.create(req, 'credit');
  }

  initiateDebit(req: TransferRequest): Promise<RailTransfer> {
    return this.create(req, 'debit');
  }

  private async create(req: TransferRequest, direction: TransferDirection): Promise<RailTransfer> {
    const d = req.destination;
    // The same four refusals, in the same order, as the live adapter. A
    // validation error a caller only meets in production is a validation error
    // the simulator failed to simulate.
    if (d.type !== 'ach') {
      throw this.error(`${ACHSIM_PROVIDER_SLUG} cannot pay a '${d.type}' destination`, {
        code: 'unsupported_destination',
        retryable: false,
      });
    }
    if (req.amount.currency !== 'USD') {
      throw this.error(`${ACHSIM_PROVIDER_SLUG} is USD-only, got ${req.amount.currency}`, {
        code: 'unsupported_currency',
        retryable: false,
      });
    }
    if (req.amount.amount <= 0n) {
      throw this.error('amount must be a positive integer number of cents', {
        code: 'invalid_amount',
        retryable: false,
      });
    }
    if (!d.externalAccountId && !(d.routingNumber && d.accountNumber)) {
      throw this.error(
        'ach destination needs externalAccountId, or routingNumber and accountNumber',
        { code: 'invalid_destination', retryable: false },
      );
    }

    const scenarioFromMetadata = readScenarioOverride(req);
    const record = this.engine.create({
      clientReferenceId: req.clientReferenceId,
      sourceAccountId: req.sourceAccountId,
      direction,
      amount: req.amount,
      statementDescriptor: req.statementDescriptor,
      destination: d,
      // Imported from the live adapter rather than copied, so the simulator
      // cannot drift from the thing it simulates.
      secCode: SEC_CODE_BY_AUTHORIZATION[d.authorization],
      scenario: { ...(this.scenario ?? {}), ...(scenarioFromMetadata ?? {}) },
    });
    return this.toRailTransfer(record);
  }

  async getTransfer(transferId: string): Promise<RailTransfer> {
    this.engine.assertUp(`read ${transferId}`);
    const record = this.engine.get(transferId);
    if (!record) {
      throw this.error(`no simulated transfer ${transferId}`, {
        code: 'not_found',
        httpStatus: 404,
        retryable: false,
      });
    }
    return this.toRailTransfer(record);
  }

  /**
   * Parse a simulated delivery.
   *
   * Byte-for-byte the same algorithm as `IncreaseAchRail.parseEvent`, because
   * the body is byte-for-byte the same shape: a pointer, no state, resolved by
   * read-back. THAT is what makes out-of-order delivery a non-event — the
   * settlement notification and the late submission notification both read back
   * the same current transfer, so the second one is a no-op and the ledger
   * converges regardless of arrival order.
   *
   * Never throws on an unrecognised body. A read-back failure (outage) does
   * throw, on purpose: not knowing the state is not the same as the event being
   * uninteresting, and the dispatcher should retry rather than mark it done.
   */
  async parseEvent(rawBody: string): Promise<RailEvent> {
    let ev: {
      id?: string;
      category?: string;
      associated_object_id?: string;
      created_at?: string;
    };
    try {
      ev = JSON.parse(rawBody) as typeof ev;
    } catch {
      return this.unknownEvent('', '', 'unparseable', 'unparseable', rawBody);
    }
    if (!ev || typeof ev !== 'object' || !ev.id || !ev.category) {
      return this.unknownEvent('', '', 'malformed', 'unparseable', ev);
    }
    const transferId = ev.associated_object_id ?? '';
    if (!transferId.startsWith('ach_sim_')) {
      return this.unknownEvent(ev.id, transferId, ev.category, 'unmodelled_event', ev);
    }

    const occurredAt = ev.created_at ?? this.engine.clock.nowIso();
    const transfer = await this.getTransfer(transferId);
    const base = {
      provider: ACHSIM_PROVIDER_SLUG,
      railKind: 'ach' as const,
      eventId: ev.id,
      transferId: transfer.id,
      occurredAt,
      raw: { event: ev, transfer: transfer.raw },
    };

    if (transfer.corrections && transfer.corrections.length > 0) {
      return stamp({ ...base, type: 'correction' as const, corrections: transfer.corrections });
    }

    switch (transfer.status) {
      case 'returned':
        return stamp({
          ...base,
          type: 'returned' as const,
          returnedAt: transfer.returnedAt ?? occurredAt,
          reason:
            transfer.returnReason ??
            { category: 'unknown' as const, code: null, providerCode: null, retryable: false },
          // A return is a SECOND MOVEMENT. The amount travels with the event so
          // the ledger has everything it needs to post a new entry rather than
          // reach back and edit the old one.
          amount: transfer.amount,
        });
      case 'settled':
        return stamp({
          ...base,
          type: 'settled' as const,
          settledAt: transfer.settledAt ?? occurredAt,
          // Same face amount, same reason as the live adapter: ACH has no
          // partial settlement, and the amount travels with the event so one
          // settlement reporter covers every rail. See ../contract.ts.
          amount: transfer.amount,
        });
      case 'submitted':
        return stamp({
          ...base,
          type: 'submitted' as const,
          submittedAt: transfer.submittedAt ?? occurredAt,
        });
      case 'canceled':
        return stamp({ ...base, type: 'canceled' as const, canceledAt: occurredAt });
      case 'failed':
        return stamp({
          ...base,
          type: 'failed' as const,
          reason:
            transfer.returnReason ??
            { category: 'provider_error' as const, code: null, providerCode: null, retryable: false },
        });
      case 'created':
      case 'pending_approval':
        return stamp({
          ...base,
          type: 'unknown' as const,
          providerType: ev.category,
          reason: 'no_state_change' as const,
        });
    }
  }

  // -- mapping --------------------------------------------------------------

  private toRailTransfer(record: AchSimTransferRecord): RailTransfer {
    const amount: Money = record.amount;
    return stamp({
      provider: ACHSIM_PROVIDER_SLUG,
      railKind: 'ach' as const,
      id: record.id,
      clientReferenceId: record.clientReferenceId,
      direction: record.direction,
      // Already promoted: the engine's raw view keeps `status: "submitted"`
      // with a `settlement` sub-object, exactly like Increase, and the
      // normalisation to 'settled' happens once, here, in the adapter.
      status: record.status,
      amount,
      createdAt: new Date(record.createdAtMs).toISOString(),
      submittedAt: record.submittedAtMs === null ? undefined : new Date(record.submittedAtMs).toISOString(),
      settledAt: record.settledAtMs === null ? undefined : new Date(record.settledAtMs).toISOString(),
      returnedAt: record.returnedAtMs === null ? undefined : new Date(record.returnedAtMs).toISOString(),
      returnReason: record.returnReason ?? undefined,
      corrections: record.corrections,
      raw: this.engine.rawTransfer(record),
    });
  }

  private unknownEvent(
    eventId: string,
    transferId: string,
    providerType: string,
    reason: 'unmodelled_event' | 'no_state_change' | 'unparseable',
    raw: unknown,
  ): RailEvent {
    return stamp({
      provider: ACHSIM_PROVIDER_SLUG,
      railKind: 'ach' as const,
      eventId,
      transferId,
      occurredAt: this.engine.clock.nowIso(),
      type: 'unknown' as const,
      providerType,
      reason,
      raw,
    });
  }

  private error(
    message: string,
    opts: { code: string; retryable: boolean; httpStatus?: number },
  ): RailError {
    return new RailError(message, {
      provider: ACHSIM_PROVIDER_SLUG,
      // Same stamp discipline: a failure from the simulator is not evidence
      // that a bank refused anything.
      evidence: 'simulated' satisfies Evidence,
      ...opts,
    });
  }
}

/**
 * Per-request scenario override, carried in `metadata`.
 *
 * A demo needs to say "this one returns R02" without a second API. `metadata`
 * is the interface's opaque-string bag, so this stays inside the interface
 * rather than widening it — and it is read ONLY by the simulator, so a live
 * adapter given the same request ignores it entirely.
 *
 *   metadata: { simScenario: '{"settleAfterMs":0,"return":{"code":"R02"}}' }
 */
function readScenarioOverride(req: TransferRequest): AchSimScenario | undefined {
  const raw = req.metadata?.['simScenario'];
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as AchSimScenario) : undefined;
  } catch {
    return undefined;
  }
}
