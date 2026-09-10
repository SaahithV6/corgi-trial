/**
 * The simulator's control API.
 *
 * A TypeScript module first — `AchSimControl` is what tests, seed scripts and
 * the demo drive. The HTTP route in `src/app/api/sim/route.ts` is a thin
 * translation of `handleControlCommand` and is off unless two environment
 * conditions are both met; the module is the interface, the route is a
 * convenience.
 *
 * SIX PRESETS, one per awkward case the brief names. They are named so a demo
 * can say "now the out-of-order one" instead of reciting a config object, and
 * so a regression test has something stable to reference.
 *
 * EVERYTHING HERE IS JSON-SAFE. `Money.amount` is a bigint and
 * `JSON.stringify(1n)` throws, so every response goes through `serializeMoney`.
 * That is not a quirk of the control API — it is the rule for any bigint
 * crossing a JSON boundary, and the control API is simply the first place it
 * bites.
 */

import { days, DEFAULT_EPOCH_MS, hours } from './clock';
import {
  ACH_SIM_RETURN_CODES,
  AchSimEngine,
  isAchSimReturnCode,
  type AchSimReturnCode,
  type AchSimScenario,
  type AchSimTransferRecord,
  type SimulatedDelivery,
} from './engine';
import { AchSimRail } from './rail';
import { WebhookSigner } from './signing';
import { serializeMoney, type Destination, type RailEvent, type TransferRequest } from '../types';

// ---------------------------------------------------------------------------
// Presets — the awkward cases, named
// ---------------------------------------------------------------------------

export const SIM_PRESETS = {
  /** The boring one, for contrast: submitted now, settled tomorrow. */
  happy_path: {
    submitAfterMs: 0,
    settleAfterMs: days(1),
  },

  /** Settlement is LATE. Three business days, not the one everyone assumes. */
  delayed_settlement: {
    submitAfterMs: hours(2),
    settleAfterMs: days(3),
  },

  /**
   * The one that breaks ledgers: it settles, the hold looks releasable, and
   * four days later an R01 arrives and the money goes back out.
   */
  return_after_settlement: {
    submitAfterMs: 0,
    settleAfterMs: days(1),
    return: { code: 'R01', afterSettlementMs: days(4) },
  },

  /** Never settles; comes back as R02 (account closed) two days after submission. */
  return_before_settlement: {
    submitAfterMs: 0,
    settleAfterMs: null,
    return: { code: 'R02', afterSettlementMs: days(2) },
  },

  /** A notification of change: the account details we hold are stale. */
  notification_of_change: {
    submitAfterMs: 0,
    settleAfterMs: days(1),
    notificationOfChange: {
      afterMs: hours(6),
      correctedRoutingNumber: '110000000',
      correctedAccountNumber: '111222333',
    },
  },

  /** The settlement notification overtakes the submission notification. */
  out_of_order: {
    submitAfterMs: 0,
    settleAfterMs: days(1),
    delivery: 'settlement_before_submission',
  },

  /** Every notification delivered twice, same event id, same signature. */
  duplicate_delivery: {
    submitAfterMs: 0,
    settleAfterMs: days(1),
    duplicate: 'all',
  },
} as const satisfies Readonly<Record<string, AchSimScenario>>;

export type SimPresetName = keyof typeof SIM_PRESETS;

export function isPresetName(name: string): name is SimPresetName {
  return Object.prototype.hasOwnProperty.call(SIM_PRESETS, name);
}

/** A destination that is obviously fake, for presets and demos. */
export const SIM_DESTINATION: Extract<Destination, { type: 'ach' }> = {
  type: 'ach',
  routingNumber: '110000000', // Increase's documented "Example Bank" test ABA
  accountNumber: '000123456789',
  accountType: 'checking',
  holderName: 'SIMULATED COUNTERPARTY',
  holderKind: 'individual',
  authorization: 'consumer_online', // -> WEB
};

// ---------------------------------------------------------------------------
// The control surface
// ---------------------------------------------------------------------------

export interface AchSimControlOptions {
  readonly secret: string;
  readonly seed?: string | number | undefined;
  readonly epochMs?: number | undefined;
  readonly signingTime?: 'virtual' | 'wall' | undefined;
  readonly liveSecret?: string | undefined;
}

/**
 * Engine + rail + the operations a demo or a test wants, in one object.
 *
 * Construction is where the anti-forgery refusal fires: `WebhookSigner` throws
 * if handed `INCREASE_WEBHOOK_SECRET`, so a misconfigured simulator dies at
 * boot rather than at the moment it emits a delivery somebody believes.
 */
export class AchSimControl {
  readonly engine: AchSimEngine;
  readonly rail: AchSimRail;

  constructor(opts: AchSimControlOptions) {
    const signer = new WebhookSigner({
      secret: opts.secret,
      liveSecret: opts.liveSecret,
    });
    this.engine = new AchSimEngine({
      signer,
      seed: opts.seed,
      epochMs: opts.epochMs,
      signingTime: opts.signingTime,
    });
    this.rail = new AchSimRail({ engine: this.engine });
  }

  /** Start a transfer under a named preset. Returns the provider transfer id. */
  async startPreset(
    preset: SimPresetName,
    overrides: Partial<Pick<TransferRequest, 'clientReferenceId' | 'amount' | 'statementDescriptor'>> = {},
    direction: 'credit' | 'debit' = 'debit',
  ): Promise<AchSimTransferRecord> {
    const req: TransferRequest = {
      clientReferenceId: overrides.clientReferenceId ?? `sim-${preset}-${this.engine.clock.nowMs()}`,
      sourceAccountId: 'sim_account_0001',
      destination: SIM_DESTINATION,
      amount: overrides.amount ?? { amount: 125_00n, currency: 'USD' },
      statementDescriptor: overrides.statementDescriptor ?? 'CORGI SIM',
      metadata: { simScenario: JSON.stringify(SIM_PRESETS[preset]) },
    };
    const transfer =
      direction === 'credit' ? await this.rail.initiateCredit(req) : await this.rail.initiateDebit(req);
    const record = this.engine.get(transfer.id);
    if (!record) throw new Error('achsim: transfer disappeared immediately after creation');
    return record;
  }

  /** Move the virtual clock and hand back everything that became due. */
  advance(byMs: number): SimulatedDelivery[] {
    this.engine.advance(byMs);
    return this.engine.drainDue();
  }

  /**
   * Drain and interpret in one step, the way the dispatcher would.
   *
   * This is the loop worth reading: each delivery's body is parsed by the SAME
   * `parseEvent` the live adapter implements, which reads the transfer back —
   * so the resulting events are correct whatever order the deliveries came in.
   */
  async drainAndParse(): Promise<{ delivery: SimulatedDelivery; event: RailEvent }[]> {
    const out: { delivery: SimulatedDelivery; event: RailEvent }[] = [];
    for (const delivery of this.engine.drainDue()) {
      out.push({ delivery, event: await this.rail.parseEvent(delivery.signed.rawBody) });
    }
    return out;
  }

  forceReturn(transferId: string, code: AchSimReturnCode): AchSimTransferRecord {
    return this.engine.forceReturn(transferId, code);
  }

  outage(durationMs: number): { startMs: number; endMs: number } {
    return this.engine.beginOutage(durationMs);
  }

  reset(): void {
    this.engine.reset(DEFAULT_EPOCH_MS);
  }
}

// ---------------------------------------------------------------------------
// Command handling — the shape the HTTP route speaks
// ---------------------------------------------------------------------------

export type SimCommand =
  | { readonly action: 'status' }
  | { readonly action: 'reset' }
  | { readonly action: 'presets' }
  | { readonly action: 'start'; readonly preset: string; readonly direction?: 'credit' | 'debit'; readonly amountCents?: string }
  | { readonly action: 'advance'; readonly ms: number }
  | { readonly action: 'drain' }
  | { readonly action: 'force_return'; readonly transferId: string; readonly code: string }
  | {
      readonly action: 'force_noc';
      readonly transferId: string;
      readonly correctedRoutingNumber?: string;
      readonly correctedAccountNumber?: string;
    }
  | { readonly action: 'outage'; readonly durationMs: number }
  | { readonly action: 'clear_outage' };

export interface SimCommandResult {
  readonly httpStatus: number;
  readonly body: Record<string, unknown>;
}

/**
 * EVERY response says `evidence: 'simulated'` and `label: 'SIMULATED'` at the
 * top level, on success and on failure alike. Not because a consumer of this
 * route is likely to be confused, but because the rule is "no result from this
 * package is ever presentable as live", and a rule with an exception for
 * error responses is a rule with a hole in it.
 */
function envelope(body: Record<string, unknown>, httpStatus = 200): SimCommandResult {
  return {
    httpStatus,
    body: { ...body, evidence: 'simulated', label: 'SIMULATED' },
  };
}

export async function handleControlCommand(
  control: AchSimControl,
  command: SimCommand,
): Promise<SimCommandResult> {
  switch (command.action) {
    case 'status':
      return envelope({
        nowIso: control.engine.clock.nowIso(),
        nowMs: control.engine.clock.nowMs(),
        outage: control.engine.currentOutage(),
        down: control.engine.isDown(),
        transfers: control.engine.list().map(describeTransfer),
        pendingDeliveries: control.engine.pendingDeliveries().map(describeDelivery),
      });

    case 'presets':
      return envelope({
        presets: Object.keys(SIM_PRESETS),
        returnCodes: Object.keys(ACH_SIM_RETURN_CODES),
      });

    case 'reset':
      control.reset();
      return envelope({ reset: true, nowIso: control.engine.clock.nowIso() });

    case 'start': {
      if (!isPresetName(command.preset)) {
        return envelope(
          { error: { code: 'UNKNOWN_PRESET', message: `no preset '${command.preset}'`, presets: Object.keys(SIM_PRESETS) } },
          400,
        );
      }
      const record = await control.startPreset(
        command.preset,
        command.amountCents === undefined
          ? {}
          : { amount: { amount: BigInt(command.amountCents), currency: 'USD' } },
        command.direction ?? 'debit',
      );
      return envelope({ preset: command.preset, transfer: describeTransfer(record) });
    }

    case 'advance': {
      if (!Number.isFinite(command.ms) || command.ms < 0) {
        return envelope({ error: { code: 'BAD_ARGUMENT', message: 'ms must be a non-negative number' } }, 400);
      }
      const deliveries = control.advance(command.ms);
      return envelope({
        nowIso: control.engine.clock.nowIso(),
        delivered: deliveries.map(describeDelivery),
      });
    }

    case 'drain':
      return envelope({ delivered: control.engine.drainDue().map(describeDelivery) });

    case 'force_return': {
      if (!isAchSimReturnCode(command.code)) {
        return envelope(
          {
            error: {
              code: 'UNKNOWN_RETURN_CODE',
              message: `no return code '${command.code}'`,
              codes: Object.keys(ACH_SIM_RETURN_CODES),
            },
          },
          400,
        );
      }
      const record = control.forceReturn(command.transferId, command.code);
      return envelope({ transfer: describeTransfer(record) });
    }

    case 'force_noc': {
      const record = control.engine.forceNotificationOfChange(command.transferId, {
        ...(command.correctedRoutingNumber === undefined
          ? {}
          : { correctedRoutingNumber: command.correctedRoutingNumber }),
        ...(command.correctedAccountNumber === undefined
          ? {}
          : { correctedAccountNumber: command.correctedAccountNumber }),
      });
      return envelope({ transfer: describeTransfer(record) });
    }

    case 'outage':
      return envelope({ outage: control.outage(command.durationMs) });

    case 'clear_outage':
      control.engine.clearOutage();
      return envelope({ outage: null });
  }
}

/** JSON-safe view of a transfer. Note `serializeMoney`: bigint out, string in. */
export function describeTransfer(record: AchSimTransferRecord): Record<string, unknown> {
  return {
    id: record.id,
    clientReferenceId: record.clientReferenceId,
    direction: record.direction,
    status: record.status,
    amount: serializeMoney(record.amount),
    secCode: record.secCode,
    createdAt: new Date(record.createdAtMs).toISOString(),
    submittedAt: record.submittedAtMs === null ? null : new Date(record.submittedAtMs).toISOString(),
    settledAt: record.settledAtMs === null ? null : new Date(record.settledAtMs).toISOString(),
    returnedAt: record.returnedAtMs === null ? null : new Date(record.returnedAtMs).toISOString(),
    returnReason: record.returnReason,
    corrections: record.corrections,
    evidence: 'simulated',
  };
}

export function describeDelivery(delivery: SimulatedDelivery): Record<string, unknown> {
  return {
    eventId: delivery.eventId,
    transferId: delivery.transferId,
    intent: delivery.intent,
    category: delivery.category,
    deliverAt: new Date(delivery.deliverAtMs).toISOString(),
    isDuplicate: delivery.isDuplicate,
    // The exact bytes and headers, so an operator can `curl` them at the real
    // webhook route and watch them go through the real verifier.
    rawBody: delivery.signed.rawBody,
    headers: delivery.signed.headers,
  };
}

/**
 * Parse an untrusted JSON body into a `SimCommand`.
 *
 * Deliberately hand-written and total: this route only exists outside
 * production, but "only exists outside production" is not a reason to accept a
 * shape you have not checked.
 */
export function parseCommand(input: unknown): SimCommand | { error: string } {
  if (typeof input !== 'object' || input === null) return { error: 'body must be a JSON object' };
  const body = input as Record<string, unknown>;
  const action = body['action'];
  if (typeof action !== 'string') return { error: 'body.action must be a string' };

  switch (action) {
    case 'status':
    case 'reset':
    case 'presets':
    case 'drain':
    case 'clear_outage':
      return { action } as SimCommand;
    case 'start': {
      const preset = body['preset'];
      if (typeof preset !== 'string') return { error: 'start needs a preset name' };
      const direction = body['direction'];
      const amountCents = body['amountCents'];
      return {
        action: 'start',
        preset,
        ...(direction === 'credit' || direction === 'debit' ? { direction } : {}),
        ...(typeof amountCents === 'string' ? { amountCents } : {}),
      };
    }
    case 'advance': {
      const ms = body['ms'];
      if (typeof ms !== 'number') return { error: 'advance needs a numeric ms' };
      return { action: 'advance', ms };
    }
    case 'force_return': {
      const transferId = body['transferId'];
      const code = body['code'];
      if (typeof transferId !== 'string' || typeof code !== 'string') {
        return { error: 'force_return needs transferId and code' };
      }
      return { action: 'force_return', transferId, code };
    }
    case 'force_noc': {
      const transferId = body['transferId'];
      if (typeof transferId !== 'string') return { error: 'force_noc needs a transferId' };
      const routing = body['correctedRoutingNumber'];
      const account = body['correctedAccountNumber'];
      return {
        action: 'force_noc',
        transferId,
        ...(typeof routing === 'string' ? { correctedRoutingNumber: routing } : {}),
        ...(typeof account === 'string' ? { correctedAccountNumber: account } : {}),
      };
    }
    case 'outage': {
      const durationMs = body['durationMs'];
      if (typeof durationMs !== 'number') return { error: 'outage needs a numeric durationMs' };
      return { action: 'outage', durationMs };
    }
    default:
      return { error: `unknown action '${action}'` };
  }
}
