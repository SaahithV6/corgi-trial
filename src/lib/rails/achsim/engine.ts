/**
 * The ACH simulator's engine: a virtual ODFI/RDFI that can be told to misbehave.
 *
 * WHAT THIS IS FOR. A sandbox proves the happy path. What breaks a real ACH
 * integration is the other six cases, and no sandbox will produce them on
 * demand: settlement four days late, an R01 that arrives *after* the money
 * looked settled, a notification of change nobody handles, a settlement webhook
 * that overtakes its own submission webhook, the same delivery twice, and the
 * provider going dark for ninety seconds and then dumping everything at once.
 * Every one of those is scriptable here, deterministically, in microseconds.
 *
 * WHAT THIS IS NOT. It is not evidence. Nothing it produces is `evidence:
 * 'live'`; see ./rail.ts, where that literal is written after the spread so no
 * caller can override it, and ./signing.ts, where the marker lives inside the
 * signed bytes.
 *
 * SHAPE FIDELITY. The bodies it emits are Increase Event objects — a pointer
 * (`id`, `category`, `associated_object_id`) and no transfer state — because
 * that shape is what forces the consumer to read back, and reading back is what
 * makes out-of-order delivery survivable. A simulator that emitted a
 * convenient, state-carrying payload would be simulating an easier provider
 * than the one we are integrating, which is worse than not simulating at all.
 *
 * DETERMINISM. No `Math.random()`, no timers, and exactly one `Date.now()` —
 * the transport timestamp under `signingTime: 'wall'`, which exists because the
 * inbox's replay window is enforced against real time and is documented at the
 * option. Everything the simulation itself is made of comes from ./clock.ts.
 * The same seed and the same script produce the same ids, the same bodies, the
 * same order and (under the default `signingTime: 'virtual'`) the same
 * signature bytes, every run.
 */

import { IdMinter, VirtualClock, days, DEFAULT_EPOCH_MS } from './clock';
import { SIMULATED_MARKER, type SignedDelivery, type WebhookSigner } from './signing';
import {
  RailError,
  type AccountCorrection,
  type AuthorizationKind,
  type Destination,
  type Money,
  type RailReturnReason,
  type RailTransferStatus,
  type ReturnCategory,
  type TransferDirection,
} from '../types';

export const ACHSIM_PROVIDER_SLUG = 'achsim.ach';

// ---------------------------------------------------------------------------
// Return codes
// ---------------------------------------------------------------------------

/**
 * The return codes the simulator can produce on demand.
 *
 * `providerCode` mirrors Increase's enum NAME rather than inventing one, so a
 * consumer written against the simulator sees the same untidy strings it will
 * see in production — including `insufficient_fund`, which is singular, and
 * which is exactly the kind of detail a friendlier simulator would quietly fix
 * and thereby hide.
 */
export interface AchSimReturnCodeSpec {
  readonly code: string;
  readonly providerCode: string;
  readonly category: ReturnCategory;
  readonly retryable: boolean;
  readonly description: string;
}

export const ACH_SIM_RETURN_CODES = {
  R01: {
    code: 'R01',
    providerCode: 'insufficient_fund',
    category: 'insufficient_funds',
    retryable: true,
    description: 'insufficient funds',
  },
  R02: {
    code: 'R02',
    providerCode: 'account_closed',
    category: 'account_invalid',
    retryable: false,
    description: 'account closed',
  },
  R03: {
    code: 'R03',
    providerCode: 'no_account',
    category: 'account_invalid',
    retryable: false,
    description: 'no account / unable to locate account',
  },
  R05: {
    code: 'R05',
    providerCode: 'unauthorized_debit_to_consumer_account_using_corporate_sec_code',
    category: 'unauthorized',
    retryable: false,
    description: 'unauthorised debit to a consumer account using a corporate SEC code',
  },
  R07: {
    code: 'R07',
    providerCode: 'authorization_revoked_by_customer',
    category: 'unauthorized',
    retryable: false,
    description: 'authorisation revoked by customer',
  },
  R08: {
    code: 'R08',
    providerCode: 'payment_stopped',
    category: 'unauthorized',
    retryable: false,
    description: 'payment stopped',
  },
  R09: {
    code: 'R09',
    providerCode: 'uncollected_funds',
    category: 'insufficient_funds',
    retryable: true,
    description: 'uncollected funds',
  },
  R10: {
    code: 'R10',
    providerCode: 'customer_advised_unauthorized_improper_ineligible_or_incomplete',
    category: 'unauthorized',
    retryable: false,
    description: 'customer advised the entry was unauthorised',
  },
  R16: {
    code: 'R16',
    providerCode: 'account_frozen_entry_returned_per_ofac_instruction',
    category: 'blocked',
    retryable: false,
    description: 'account frozen / returned per OFAC instruction',
  },
  R29: {
    code: 'R29',
    providerCode: 'corporate_customer_advised_not_authorized',
    category: 'unauthorized',
    retryable: false,
    description: 'corporate customer advised the entry was not authorised',
  },
} as const satisfies Readonly<Record<string, AchSimReturnCodeSpec>>;

export type AchSimReturnCode = keyof typeof ACH_SIM_RETURN_CODES;

export function isAchSimReturnCode(code: string): code is AchSimReturnCode {
  return Object.prototype.hasOwnProperty.call(ACH_SIM_RETURN_CODES, code);
}

export function returnReasonFor(code: AchSimReturnCode): RailReturnReason {
  const spec = ACH_SIM_RETURN_CODES[code];
  return {
    category: spec.category,
    code: spec.code,
    providerCode: spec.providerCode,
    description: spec.description,
    retryable: spec.retryable,
  };
}

// ---------------------------------------------------------------------------
// Scenarios — the control surface, as data
// ---------------------------------------------------------------------------

export interface AchSimNocSpec {
  /** Milliseconds after submission. */
  readonly afterMs: number;
  readonly correctedRoutingNumber?: string | undefined;
  readonly correctedAccountNumber?: string | undefined;
  readonly correctedAccountType?: 'checking' | 'savings' | undefined;
  readonly correctedIndividualId?: string | undefined;
}

export interface AchSimReturnSpec {
  readonly code: AchSimReturnCode;
  /**
   * How long after SETTLEMENT the return arrives. This is the case that breaks
   * naive ledgers: the money looked settled, the hold was released, and days
   * later it comes back. Defaults to 4 days, inside the 2-banking-day
   * commercial window's ugly cousin and well inside the 60-day consumer one.
   *
   * If the transfer never settles (`settleAfterMs: null`) this is measured from
   * submission instead, which is the "returned before it ever settled" case.
   */
  readonly afterSettlementMs?: number | undefined;
}

/**
 * How a transfer behaves. Everything is optional; the defaults are a boring,
 * well-behaved next-day ACH credit.
 */
export interface AchSimScenario {
  /** Delay from creation to submission. Default 0 — handed straight to the network. */
  readonly submitAfterMs?: number | undefined;
  /**
   * Delay from submission to settlement. Default 1 day.
   * `null` means it never settles — for the "return before settlement" and
   * "stuck in flight" cases.
   */
  readonly settleAfterMs?: number | null | undefined;
  /** A return, with a code you choose. */
  readonly return?: AchSimReturnSpec | undefined;
  /** A notification of change (COR) carrying corrected bank details. */
  readonly notificationOfChange?: AchSimNocSpec | undefined;
  /** Cancel before submission (only takes effect if it precedes submission). */
  readonly cancelAfterMs?: number | undefined;
  /**
   * Pre-network failure — Increase's `rejected`. Milliseconds after creation.
   * Notably, Increase's own sandbox CANNOT produce this; the simulator can.
   */
  readonly failAfterMs?: number | undefined;
  /**
   * DELIVERY ORDER.
   *   'natural'                      notifications arrive in the order events happened.
   *   'settlement_before_submission' the settlement notification overtakes the
   *                                  submission notification.
   *
   * Note what the second one does NOT do: it does not move the settlement
   * earlier in time. Both state changes still happen when they happen; it is
   * the SUBMISSION NOTIFICATION that is held back until after the settlement
   * notification has gone out — which is what a real redelivery-after-timeout
   * looks like. Making settlement itself arrive early would be time travel, not
   * out-of-order delivery, and a consumer that "handled" it would be handling
   * something that cannot occur.
   */
  readonly delivery?: 'natural' | 'settlement_before_submission' | undefined;
  /**
   * Redeliver notifications. A duplicate is the SAME event id, the SAME body
   * and the SAME signature bytes — a genuine redelivery, not a second event —
   * so the inbox's `UNIQUE (provider, provider_event_id)` is what has to catch
   * it. Anything the simulator changed would be testing a different property.
   */
  readonly duplicate?: 'none' | 'all' | 'settlement' | undefined;
  /** Emit the `ach_transfer.created` notification. Default true. */
  readonly emitCreatedEvent?: boolean | undefined;
}

export interface AchSimScenarioDefaults {
  readonly submitAfterMs: number;
  readonly settleAfterMs: number | null;
  readonly delivery: 'natural' | 'settlement_before_submission';
  readonly duplicate: 'none' | 'all' | 'settlement';
  readonly emitCreatedEvent: boolean;
}

export const DEFAULT_SCENARIO: AchSimScenarioDefaults = {
  submitAfterMs: 0,
  settleAfterMs: days(1),
  delivery: 'natural',
  duplicate: 'none',
  emitCreatedEvent: true,
};

/** A provider outage: API calls fail and webhooks stop, then catch up. */
export interface AchSimOutage {
  readonly startMs: number;
  readonly endMs: number;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface AchSimTransferRecord {
  readonly id: string;
  readonly clientReferenceId: string;
  readonly sourceAccountId: string;
  readonly direction: TransferDirection;
  readonly amount: Money;
  readonly statementDescriptor: string;
  readonly authorization: AuthorizationKind;
  readonly secCode: string;
  readonly routingNumber: string | null;
  readonly accountNumber: string | null;
  readonly status: RailTransferStatus;
  readonly createdAtMs: number;
  readonly submittedAtMs: number | null;
  readonly settledAtMs: number | null;
  readonly returnedAtMs: number | null;
  readonly returnReason: RailReturnReason | null;
  readonly traceNumber: string | null;
  readonly corrections: readonly AccountCorrection[];
  readonly scenario: AchSimScenario;
}

/** What the notification is *about*. Not part of the wire body — the wire body
 *  is a pointer, exactly like Increase's. Exposed so tests and the control API
 *  can assert on delivery ORDER without decoding and reading back. */
export type DeliveryIntent =
  | 'created'
  | 'submitted'
  | 'settled'
  | 'returned'
  | 'correction'
  | 'canceled'
  | 'failed';

export interface SimulatedDelivery {
  readonly eventId: string;
  readonly transferId: string;
  readonly intent: DeliveryIntent;
  readonly category: string;
  /** Virtual-clock ms at which the provider sent it. */
  readonly deliverAtMs: number;
  /** True when this is a redelivery of an event already sent. */
  readonly isDuplicate: boolean;
  /** Signed exactly the way Increase signs. Feed straight to `ingestWebhook`. */
  readonly signed: SignedDelivery;
}

interface QueuedDelivery {
  eventId: string;
  transferId: string;
  intent: DeliveryIntent;
  category: string;
  /** The virtual time the underlying event happened — goes in `created_at`. */
  occurredAtMs: number;
  /** The virtual time the notification leaves the provider. */
  deliverAtMs: number;
  isDuplicate: boolean;
  seq: number;
  delivered: boolean;
}

type TransitionKind = 'submit' | 'settle' | 'return' | 'noc' | 'cancel' | 'fail';

interface ScheduledTransition {
  atMs: number;
  seq: number;
  transferId: string;
  kind: TransitionKind;
  returnCode?: AchSimReturnCode;
  noc?: AchSimNocSpec;
  applied: boolean;
}

interface MutableTransfer {
  record: AchSimTransferRecord;
}

export interface AchSimEngineOptions {
  readonly signer: WebhookSigner;
  readonly seed?: string | number | undefined;
  readonly epochMs?: number | undefined;
  readonly defaultScenario?: AchSimScenario | undefined;
  /**
   * Which clock stamps `webhook-timestamp`.
   *
   * 'virtual' (default) makes the signature bytes reproducible, which is what a
   * test wants. But the inbox's Standard Webhooks verifier enforces a 300s
   * tolerance against real wall-clock time, so a delivery signed with a virtual
   * timestamp two months in the future is REJECTED over real HTTP — correctly.
   * Anything that POSTs to the running app must therefore use 'wall'.
   * The body's `created_at` is always the virtual clock either way: the
   * narrative is virtual, the transport is not.
   */
  readonly signingTime?: 'virtual' | 'wall' | undefined;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export class AchSimEngine {
  readonly clock: VirtualClock;

  private readonly ids: IdMinter;
  private readonly signer: WebhookSigner;
  private readonly defaultScenario: AchSimScenario;
  private readonly signingTime: 'virtual' | 'wall';

  private readonly transfers = new Map<string, MutableTransfer>();
  private readonly byClientRef = new Map<string, string>();
  private readonly transitions: ScheduledTransition[] = [];
  private readonly outbox: QueuedDelivery[] = [];
  private outage: AchSimOutage | null = null;
  private seq = 0;

  constructor(opts: AchSimEngineOptions) {
    this.signer = opts.signer;
    this.clock = new VirtualClock(opts.epochMs ?? DEFAULT_EPOCH_MS);
    this.ids = new IdMinter(opts.seed ?? 'achsim');
    this.defaultScenario = opts.defaultScenario ?? {};
    this.signingTime = opts.signingTime ?? 'virtual';
  }

  // -- creation -------------------------------------------------------------

  /**
   * Create a transfer and schedule its whole life.
   *
   * IDEMPOTENT ON `clientReferenceId`, mirroring Increase's `Idempotency-Key`:
   * a replay returns the ORIGINAL record rather than creating a second transfer
   * or raising a 409. If a consumer's retry logic is wrong, it should be wrong
   * against the same semantics it will meet in production.
   */
  create(input: {
    clientReferenceId: string;
    sourceAccountId: string;
    direction: TransferDirection;
    amount: Money;
    statementDescriptor: string;
    destination: Extract<Destination, { type: 'ach' }>;
    secCode: string;
    scenario?: AchSimScenario | undefined;
  }): AchSimTransferRecord {
    this.assertUp('create a transfer');
    this.sync();

    const existingId = this.byClientRef.get(input.clientReferenceId);
    if (existingId !== undefined) {
      const existing = this.transfers.get(existingId);
      if (existing) return existing.record;
    }

    const scenario: AchSimScenario = { ...this.defaultScenario, ...(input.scenario ?? {}) };
    const now = this.clock.nowMs();
    const id = this.ids.transferId();

    const record: AchSimTransferRecord = {
      id,
      clientReferenceId: input.clientReferenceId,
      sourceAccountId: input.sourceAccountId,
      direction: input.direction,
      amount: input.amount,
      statementDescriptor: input.statementDescriptor,
      authorization: input.destination.authorization,
      secCode: input.secCode,
      routingNumber: input.destination.routingNumber ?? null,
      // Never store more than the last four of an account number, even in a
      // simulator: a simulator is where people paste real-looking test data,
      // and a habit formed here is a habit carried into the live adapter.
      accountNumber: maskAccountNumber(input.destination.accountNumber ?? null),
      status: 'created',
      createdAtMs: now,
      submittedAtMs: null,
      settledAtMs: null,
      returnedAtMs: null,
      returnReason: null,
      traceNumber: null,
      corrections: [],
      scenario,
    };

    this.transfers.set(id, { record });
    this.byClientRef.set(input.clientReferenceId, id);

    if (scenario.emitCreatedEvent ?? DEFAULT_SCENARIO.emitCreatedEvent) {
      this.enqueue(id, 'created', 'ach_transfer.created', now, now, scenario);
    }
    this.schedule(record, scenario);
    // Anything due immediately (submitAfterMs: 0) applies now, so the caller
    // sees the state the provider would already be in.
    this.sync();
    return this.mustGet(id);
  }

  /** Lay out the whole life of a transfer as scheduled transitions. */
  private schedule(record: AchSimTransferRecord, scenario: AchSimScenario): void {
    const created = record.createdAtMs;

    if (scenario.failAfterMs !== undefined) {
      this.addTransition({ atMs: created + scenario.failAfterMs, transferId: record.id, kind: 'fail' });
      return;
    }

    const submitAt = created + (scenario.submitAfterMs ?? DEFAULT_SCENARIO.submitAfterMs);

    if (scenario.cancelAfterMs !== undefined && created + scenario.cancelAfterMs <= submitAt) {
      // A cancellation that beats submission wins; after submission an ACH
      // entry is irrevocable, which the transition applier enforces too.
      this.addTransition({
        atMs: created + scenario.cancelAfterMs,
        transferId: record.id,
        kind: 'cancel',
      });
      return;
    }

    this.addTransition({ atMs: submitAt, transferId: record.id, kind: 'submit' });

    const settleAfter = scenario.settleAfterMs === undefined ? DEFAULT_SCENARIO.settleAfterMs : scenario.settleAfterMs;
    const settleAt = settleAfter === null ? null : submitAt + settleAfter;
    if (settleAt !== null) {
      this.addTransition({ atMs: settleAt, transferId: record.id, kind: 'settle' });
    }

    if (scenario.notificationOfChange) {
      this.addTransition({
        atMs: submitAt + scenario.notificationOfChange.afterMs,
        transferId: record.id,
        kind: 'noc',
        noc: scenario.notificationOfChange,
      });
    }

    if (scenario.return) {
      const base = settleAt ?? submitAt;
      const after = scenario.return.afterSettlementMs ?? days(4);
      this.addTransition({
        atMs: base + after,
        transferId: record.id,
        kind: 'return',
        returnCode: scenario.return.code,
      });
    }
  }

  private addTransition(t: Omit<ScheduledTransition, 'seq' | 'applied'>): void {
    this.seq += 1;
    this.transitions.push({ ...t, seq: this.seq, applied: false });
  }

  // -- time -----------------------------------------------------------------

  advance(byMs: number): void {
    this.clock.advance(byMs);
    this.sync();
  }

  advanceTo(absoluteMs: number): void {
    this.clock.advanceTo(absoluteMs);
    this.sync();
  }

  /**
   * Apply every transition whose time has come, oldest first.
   *
   * Called on every read as well as on every advance, so a caller can never
   * observe a state the clock has already passed. Idempotent: `applied` is a
   * flag on the transition, not a cursor over the list, so a re-entrant call
   * cannot double-apply.
   */
  private sync(): void {
    const now = this.clock.nowMs();
    const due = this.transitions
      .filter((t) => !t.applied && t.atMs <= now)
      .sort((a, b) => a.atMs - b.atMs || a.seq - b.seq);
    for (const t of due) {
      t.applied = true;
      this.apply(t);
    }
  }

  private apply(t: ScheduledTransition): void {
    const entry = this.transfers.get(t.transferId);
    if (!entry) return;
    const r = entry.record;
    const scenario = r.scenario;

    switch (t.kind) {
      case 'submit': {
        if (r.status !== 'created') return;
        entry.record = {
          ...r,
          status: 'submitted',
          submittedAtMs: t.atMs,
          traceNumber: this.ids.traceNumber(),
        };
        this.enqueue(r.id, 'submitted', 'ach_transfer.updated', t.atMs, this.submissionDeliveryAt(r, t.atMs), scenario);
        return;
      }

      case 'settle': {
        if (r.status !== 'submitted') return;
        // THE INCREASE SHAPE, REPRODUCED ON PURPOSE. In the raw object below
        // (`rawTransfer`) the status stays "submitted" and a `settlement`
        // sub-object appears. Our own normalised status becomes 'settled' — the
        // promotion the live adapter has to make explicitly. A consumer that
        // reads the raw status instead of the normalised one fails here in
        // exactly the way it would fail in production.
        entry.record = { ...r, status: 'settled', settledAtMs: t.atMs };
        this.enqueue(r.id, 'settled', 'ach_transfer.updated', t.atMs, t.atMs, scenario);
        return;
      }

      case 'return': {
        // A return is valid from submission onward, and is the ONLY transition
        // that may follow settlement. That asymmetry is the whole reason the
        // ledger models a return as a second movement rather than an edit.
        if (r.status !== 'submitted' && r.status !== 'settled') return;
        const code = t.returnCode ?? 'R01';
        entry.record = {
          ...r,
          status: 'returned',
          returnedAtMs: t.atMs,
          returnReason: returnReasonFor(code),
        };
        this.enqueue(r.id, 'returned', 'ach_transfer.updated', t.atMs, t.atMs, scenario);
        return;
      }

      case 'noc': {
        if (r.status === 'canceled' || r.status === 'failed') return;
        const spec = t.noc;
        if (!spec) return;
        entry.record = { ...r, corrections: [...r.corrections, ...correctionsFrom(spec, t.atMs)] };
        this.enqueue(r.id, 'correction', 'ach_transfer.updated', t.atMs, t.atMs, scenario);
        return;
      }

      case 'cancel': {
        // Irrevocable once submitted. A cancel that arrives late is a no-op,
        // not an error: that is what the network does.
        if (r.status !== 'created') return;
        entry.record = { ...r, status: 'canceled' };
        this.enqueue(r.id, 'canceled', 'ach_transfer.updated', t.atMs, t.atMs, scenario);
        return;
      }

      case 'fail': {
        if (r.status !== 'created') return;
        entry.record = {
          ...r,
          status: 'failed',
          returnReason: {
            category: 'invalid_request',
            code: null,
            providerCode: 'rejected',
            description: 'rejected before submission',
            retryable: false,
          },
        };
        this.enqueue(r.id, 'failed', 'ach_transfer.updated', t.atMs, t.atMs, scenario);
        return;
      }
    }
  }

  /**
   * OUT-OF-ORDER DELIVERY, IN ONE FUNCTION.
   *
   * Under `delivery: 'settlement_before_submission'` the submission
   * notification is held until 1ms AFTER the settlement notification goes out.
   * Both state changes still happen at their true times; only the notification
   * is late. Draining then yields [settled, submitted] — the settlement webhook
   * arriving before the submission webhook, which is precisely the redelivery
   * pattern that breaks a consumer that trusts arrival order.
   */
  private submissionDeliveryAt(record: AchSimTransferRecord, submittedAtMs: number): number {
    if ((record.scenario.delivery ?? DEFAULT_SCENARIO.delivery) !== 'settlement_before_submission') {
      return submittedAtMs;
    }
    const settle = this.transitions.find((t) => t.transferId === record.id && t.kind === 'settle');
    if (!settle) return submittedAtMs;
    return settle.atMs + 1;
  }

  private enqueue(
    transferId: string,
    intent: DeliveryIntent,
    category: string,
    occurredAtMs: number,
    deliverAtMs: number,
    scenario: AchSimScenario,
  ): void {
    const eventId = this.ids.eventId();
    this.seq += 1;
    this.outbox.push({
      eventId,
      transferId,
      intent,
      category,
      occurredAtMs,
      deliverAtMs,
      isDuplicate: false,
      seq: this.seq,
      delivered: false,
    });

    const mode = scenario.duplicate ?? DEFAULT_SCENARIO.duplicate;
    const duplicated = mode === 'all' || (mode === 'settlement' && intent === 'settled');
    if (!duplicated) return;

    // A REAL redelivery: same event id, same occurrence time, therefore the
    // same body and the same signature bytes. The only difference is that it is
    // second in the queue. Nothing downstream can distinguish it from the
    // provider's own retry, which is the point — the inbox's unique index has
    // to be what stops it.
    this.seq += 1;
    this.outbox.push({
      eventId,
      transferId,
      intent,
      category,
      occurredAtMs,
      deliverAtMs,
      isDuplicate: true,
      seq: this.seq,
      delivered: false,
    });
  }

  // -- outage ---------------------------------------------------------------

  /**
   * Take the provider down for a window.
   *
   * While it is down: every API call throws a retryable `RailError`, and
   * `drainDue()` returns nothing — webhooks stop, they do not fail. When the
   * window ends, the next drain returns EVERYTHING that came due during it, in
   * order, in one burst. That burst is the case worth testing: it is when a
   * consumer's per-request assumptions (rate limits, "one event at a time",
   * "the previous event has already been processed") all break at once.
   */
  scheduleOutage(outage: AchSimOutage): void {
    if (outage.endMs < outage.startMs) {
      throw new RangeError('outage endMs must not precede startMs');
    }
    this.outage = outage;
  }

  /** Start an outage now, lasting `durationMs`. */
  beginOutage(durationMs: number): AchSimOutage {
    const start = this.clock.nowMs();
    const outage = { startMs: start, endMs: start + durationMs };
    this.scheduleOutage(outage);
    return outage;
  }

  clearOutage(): void {
    this.outage = null;
  }

  currentOutage(): AchSimOutage | null {
    return this.outage;
  }

  isDown(atMs: number = this.clock.nowMs()): boolean {
    const o = this.outage;
    return o !== null && atMs >= o.startMs && atMs < o.endMs;
  }

  /** Throw the way a provider outage looks to a caller: retryable, and labelled. */
  assertUp(action: string): void {
    if (!this.isDown()) return;
    throw new RailError(`simulated provider outage: cannot ${action}`, {
      provider: ACHSIM_PROVIDER_SLUG,
      code: 'provider_outage',
      httpStatus: 503,
      // Retryable is the honest answer and the dangerous one: the caller SHOULD
      // retry with the same idempotency key, and a caller that instead treats a
      // 503 as a failed payment is the bug this case exists to find.
      retryable: true,
      evidence: 'simulated',
    });
  }

  // -- reads ----------------------------------------------------------------

  get(transferId: string): AchSimTransferRecord | undefined {
    this.sync();
    return this.transfers.get(transferId)?.record;
  }

  getByClientReference(clientReferenceId: string): AchSimTransferRecord | undefined {
    const id = this.byClientRef.get(clientReferenceId);
    return id === undefined ? undefined : this.get(id);
  }

  list(): AchSimTransferRecord[] {
    this.sync();
    return [...this.transfers.values()].map((t) => t.record);
  }

  private mustGet(id: string): AchSimTransferRecord {
    const r = this.get(id);
    if (!r) throw new Error(`achsim: transfer ${id} vanished`);
    return r;
  }

  // -- deliveries -----------------------------------------------------------

  /**
   * Every notification due at or before now, in delivery order, signed.
   *
   * Marks them delivered, so a second call returns only what is newly due — the
   * same contract a provider's outbox has. Sorted by `(deliverAtMs, seq)`, and
   * `seq` is mint order, so the ordering is total and reproducible.
   */
  drainDue(): SimulatedDelivery[] {
    this.sync();
    const now = this.clock.nowMs();
    // Webhooks stop during an outage. They are not dropped: they stay queued
    // and come out together on the far side.
    if (this.isDown(now)) return [];

    const due = this.outbox
      .filter((d) => !d.delivered && d.deliverAtMs <= now)
      .sort((a, b) => a.deliverAtMs - b.deliverAtMs || a.seq - b.seq);

    return due.map((d) => {
      d.delivered = true;
      return this.render(d);
    });
  }

  /** Peek without consuming. Used by the control API's status view. */
  pendingDeliveries(): readonly SimulatedDelivery[] {
    return this.outbox
      .filter((d) => !d.delivered)
      .sort((a, b) => a.deliverAtMs - b.deliverAtMs || a.seq - b.seq)
      .map((d) => this.render(d));
  }

  private render(d: QueuedDelivery): SimulatedDelivery {
    const body = this.eventBody(d);
    const rawBody = JSON.stringify(body);
    const timestampSeconds =
      this.signingTime === 'wall' ? Math.floor(Date.now() / 1000) : Math.floor(d.deliverAtMs / 1000);
    return {
      eventId: d.eventId,
      transferId: d.transferId,
      intent: d.intent,
      category: d.category,
      deliverAtMs: d.deliverAtMs,
      isDuplicate: d.isDuplicate,
      signed: this.signer.sign(d.eventId, timestampSeconds, rawBody),
    };
  }

  /**
   * The wire body: an Increase Event object, plus the marker.
   *
   * A POINTER, NOT A PAYLOAD — no transfer state, exactly like the real thing,
   * so a consumer has to read back and therefore cannot be broken by ordering.
   * `simulated: true` is a top-level key INSIDE the signed bytes; see
   * ./signing.ts on why that is the layer that cannot be stripped.
   */
  private eventBody(d: QueuedDelivery): Record<string, unknown> {
    return {
      id: d.eventId,
      type: 'event',
      category: d.category,
      associated_object_id: d.transferId,
      associated_object_type: 'ach_transfer',
      created_at: new Date(d.occurredAtMs).toISOString(),
      [SIMULATED_MARKER]: true,
    };
  }

  /**
   * The Increase-shaped raw transfer, for `RailTransfer.raw` and for the
   * control API's read-back view.
   *
   * NOTE `status`: a settled transfer reads `"submitted"` here, with the
   * settlement expressed as a timestamp in a sub-object — Increase's actual
   * behaviour, reproduced so that a consumer reading the raw status instead of
   * the normalised one is wrong in the simulator too. And `simulated: true` is
   * on this object as well, so even the audit blob carries the label.
   */
  rawTransfer(record: AchSimTransferRecord): Record<string, unknown> {
    const providerStatus =
      record.status === 'settled'
        ? 'submitted'
        : record.status === 'created'
          ? 'pending_submission'
          : record.status === 'failed'
            ? 'rejected'
            : record.status;
    const magnitude = record.amount.amount;
    return {
      id: record.id,
      type: 'ach_transfer',
      [SIMULATED_MARKER]: true,
      account_id: record.sourceAccountId,
      // Increase's sign convention: negative pulls funds. Number, not bigint,
      // because this object is JSON-serialised into an audit blob and
      // `JSON.stringify(1n)` throws — and because Increase's own JSON is a
      // number. Safe: USD cents are nowhere near 2^53.
      amount: Number(record.direction === 'debit' ? -magnitude : magnitude),
      currency: record.amount.currency,
      status: providerStatus,
      created_at: new Date(record.createdAtMs).toISOString(),
      idempotency_key: record.clientReferenceId,
      routing_number: record.routingNumber,
      account_number: record.accountNumber,
      standard_entry_class_code: record.secCode,
      statement_descriptor: record.statementDescriptor,
      submission:
        record.submittedAtMs === null
          ? null
          : {
              submitted_at: new Date(record.submittedAtMs).toISOString(),
              trace_number: record.traceNumber,
            },
      settlement:
        record.settledAtMs === null
          ? null
          : { settled_at: new Date(record.settledAtMs).toISOString() },
      return:
        record.returnedAtMs === null || record.returnReason === null
          ? null
          : {
              created_at: new Date(record.returnedAtMs).toISOString(),
              return_reason_code: record.returnReason.providerCode,
              raw_return_reason_code: record.returnReason.code,
              transfer_id: record.id,
              trace_number: record.traceNumber,
            },
      notifications_of_change: record.corrections.map((c) => ({
        created_at: c.receivedAt ?? null,
        change_code: c.code ?? null,
        corrected_data: c.correctedValue,
      })),
    };
  }

  // -- operator affordances -------------------------------------------------

  /** Force a return on an existing transfer, right now, with a chosen code. */
  forceReturn(transferId: string, code: AchSimReturnCode, afterMs = 0): AchSimTransferRecord {
    this.requireTransfer(transferId);
    this.addTransition({
      atMs: this.clock.nowMs() + afterMs,
      transferId,
      kind: 'return',
      returnCode: code,
    });
    this.sync();
    return this.mustGet(transferId);
  }

  /** Force a notification of change on an existing transfer. */
  forceNotificationOfChange(
    transferId: string,
    spec: Omit<AchSimNocSpec, 'afterMs'> & { afterMs?: number | undefined },
  ): AchSimTransferRecord {
    this.requireTransfer(transferId);
    this.addTransition({
      atMs: this.clock.nowMs() + (spec.afterMs ?? 0),
      transferId,
      kind: 'noc',
      noc: { ...spec, afterMs: spec.afterMs ?? 0 },
    });
    this.sync();
    return this.mustGet(transferId);
  }

  private requireTransfer(transferId: string): AchSimTransferRecord {
    const r = this.get(transferId);
    if (!r) {
      throw new RailError(`no simulated transfer ${transferId}`, {
        provider: ACHSIM_PROVIDER_SLUG,
        code: 'not_found',
        httpStatus: 404,
        retryable: false,
        evidence: 'simulated',
      });
    }
    return r;
  }

  /** Wipe everything. The control route's "start again" button. */
  reset(epochMs: number = DEFAULT_EPOCH_MS): void {
    this.transfers.clear();
    this.byClientRef.clear();
    this.transitions.length = 0;
    this.outbox.length = 0;
    this.outage = null;
    this.seq = 0;
    this.clock.advanceTo(Math.max(epochMs, this.clock.nowMs()));
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function correctionsFrom(spec: AchSimNocSpec, atMs: number): AccountCorrection[] {
  const receivedAt = new Date(atMs).toISOString();
  const out: AccountCorrection[] = [];
  if (spec.correctedAccountNumber !== undefined) {
    out.push({
      field: 'account_number',
      correctedValue: spec.correctedAccountNumber,
      code: 'C01',
      receivedAt,
    });
  }
  if (spec.correctedRoutingNumber !== undefined) {
    out.push({
      field: 'routing_number',
      correctedValue: spec.correctedRoutingNumber,
      code: 'C02',
      receivedAt,
    });
  }
  if (spec.correctedAccountType !== undefined) {
    out.push({
      field: 'account_type',
      correctedValue: spec.correctedAccountType,
      code: 'C05',
      receivedAt,
    });
  }
  if (spec.correctedIndividualId !== undefined) {
    out.push({
      field: 'individual_id',
      correctedValue: spec.correctedIndividualId,
      code: 'C09',
      receivedAt,
    });
  }
  return out;
}

/** Last four only. A simulator is not a reason to keep a full account number. */
function maskAccountNumber(accountNumber: string | null): string | null {
  if (accountNumber === null) return null;
  return accountNumber.length <= 4 ? accountNumber : `****${accountNumber.slice(-4)}`;
}
