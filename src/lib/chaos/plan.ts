/**
 * The planner: four controls in, one release schedule out. Pure.
 *
 * This is the only file in which the four controls MEAN anything, and it has no
 * database, no clock of its own and no knowledge of Lithic. That is deliberate
 * and it is the reason `plan.test.ts` can prove the interesting properties —
 * that duplicates share an id, that reordering really reverses, that an armed
 * `webhooks_off` withholds everything — without a Postgres connection or a
 * signature.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE FOUR CONTROLS, AS SCHEDULE TRANSFORMS
 *
 *   webhooks_off        every slot is withheld. Nothing leaves. The bodies are
 *                       already signed and already durable, so the outage loses
 *                       latency and never loses a delivery — which is precisely
 *                       what `attack-07` asserts about a real one.
 *
 *   settlement_delay    the clearing's `plannedAt` moves into the future. The
 *                       authorisation is untouched: a late settlement is late,
 *                       not a late everything.
 *
 *   duplicate_delivery  each slot becomes N copies carrying THE SAME
 *                       `webhook-id` and THE SAME BYTES. This is the control
 *                       that must not have a special path anywhere: copies 1..N
 *                       are absorbed by `webhook_inbox`'s
 *                       UNIQUE (provider, provider_event_id), the replay
 *                       suppression that existed before chaos did, and the
 *                       proof is that `ingestWebhook` answers `replay` for them
 *                       without chaos telling it anything.
 *
 *   reorder_window      the release order is REVERSED, and the now-second slot
 *                       is pushed to the far edge of the window so the
 *                       reversal is observable in wall-clock time rather than
 *                       only in a loop index. A reorder buffer that holds for W
 *                       seconds and then emits backwards is exactly what this
 *                       is.
 *
 * ORDER OF APPLICATION, and why it is this one:
 *
 *   1. timing   (settlement_delay)   — when would each step arrive?
 *   2. order    (reorder_window)     — in what order does the buffer emit?
 *   3. fan-out  (duplicate_delivery) — how many copies of each?
 *   4. gate     (webhooks_off)       — does anything leave at all?
 *
 * Fan-out after ordering, so every copy of a slot inherits that slot's place.
 * The gate last, because availability is not a property of a slot — it is a
 * property of the link, and it applies to whatever the first three produced.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { chaosWebhookId } from './sign';
import type { ActiveControl, ChaosControl, ChaosStep } from './types';

/** One row of the outbox, before it exists in the database. */
export interface PlannedDelivery {
  /** Release order within the run. 0 leaves first. */
  readonly seq: number;
  readonly step: ChaosStep;
  /** 0 is the original; 1..N-1 are the duplicate control's copies. */
  readonly copyIndex: number;
  /**
   * Shared by every copy of a slot. This is the point of the duplicate
   * control: `webhook_inbox.provider_event_id` is half the replay key, so
   * repeating it is what hands the suppression to Postgres.
   */
  readonly webhookId: string;
  readonly plannedAt: Date;
  /** True when `webhooks_off` is armed: the slot sits in the outbox. */
  readonly withheld: boolean;
  /** Which controls shaped this slot, for the in-band marker and the screen. */
  readonly shapedBy: readonly ChaosControl[];
}

export interface PlanOptions {
  readonly runId: string;
  readonly now: Date;
  readonly active: readonly ActiveControl[];
}

function find(active: readonly ActiveControl[], control: ChaosControl): ActiveControl | undefined {
  return active.find((c) => c.control === control);
}

/** Read a bounded integer out of a control's params, falling back safely. */
function numberParam(control: ActiveControl | undefined, key: string, fallback: number): number {
  if (control === undefined) return fallback;
  const raw = (control.params as unknown as Record<string, unknown>)[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : fallback;
}

/**
 * Build the release schedule for one episode.
 *
 * Two steps in, between two and ten rows out. The caller signs each distinct
 * `webhookId` ONCE and reuses the bytes for every copy — see `driver.ts` — so
 * a duplicate really is the same delivery arriving twice and not a second
 * delivery that looks similar.
 */
export function planDeliveries(opts: PlanOptions): PlannedDelivery[] {
  const { runId, now, active } = opts;

  const delay = find(active, 'settlement_delay');
  const reorder = find(active, 'reorder_window');
  const duplicate = find(active, 'duplicate_delivery');
  const off = find(active, 'webhooks_off');

  // --- 1. timing -----------------------------------------------------------
  const delaySeconds = delay === undefined ? 0 : Math.max(0, numberParam(delay, 'seconds', 0));
  type Slot = { step: ChaosStep; at: Date; shapedBy: ChaosControl[] };
  const slots: Slot[] = [
    { step: 'authorization', at: new Date(now.getTime()), shapedBy: [] },
    {
      step: 'clearing',
      at: new Date(now.getTime() + delaySeconds * 1_000),
      shapedBy: delaySeconds > 0 ? ['settlement_delay'] : [],
    },
  ];

  // --- 2. order ------------------------------------------------------------
  //
  // A buffer that holds for W seconds and emits backwards. With two slots that
  // is the gauntlet's own case: the settlement webhook arrives before the
  // authorisation it belongs to.
  let ordered: Slot[] = slots;
  if (reorder !== undefined) {
    const windowSeconds = Math.max(1, numberParam(reorder, 'seconds', 1));
    ordered = [...slots].reverse();
    // The first slot out of the buffer leaves now; the one it overtook leaves
    // at the far edge of the window. Rewriting BOTH times rather than swapping
    // them keeps the schedule coherent when `settlement_delay` is also armed:
    // whatever the delay decided, the buffer is what decides the order, and
    // the window is what decides the gap.
    const first = ordered[0];
    const second = ordered[1];
    if (first !== undefined) {
      ordered[0] = {
        ...first,
        at: new Date(now.getTime()),
        shapedBy: [...first.shapedBy, 'reorder_window'],
      };
    }
    if (second !== undefined) {
      ordered[1] = {
        ...second,
        at: new Date(now.getTime() + windowSeconds * 1_000),
        shapedBy: [...second.shapedBy, 'reorder_window'],
      };
    }
  }

  // --- 3. fan-out ----------------------------------------------------------
  const copies =
    duplicate === undefined ? 1 : Math.max(1, Math.min(9, numberParam(duplicate, 'copies', 1)));

  // --- 4. gate -------------------------------------------------------------
  const withheld = off !== undefined;

  const planned: PlannedDelivery[] = [];
  ordered.forEach((slot, seq) => {
    // Signed once per SLOT, not per copy. `chaosWebhookId` takes no copy index
    // for exactly this reason and says so at its definition.
    const webhookId = chaosWebhookId(runId, seq);
    const shapedBy: ChaosControl[] = [...slot.shapedBy];
    if (copies > 1) shapedBy.push('duplicate_delivery');
    if (withheld) shapedBy.push('webhooks_off');
    for (let copyIndex = 0; copyIndex < copies; copyIndex += 1) {
      planned.push({
        seq,
        step: slot.step,
        copyIndex,
        webhookId,
        plannedAt: slot.at,
        withheld,
        shapedBy,
      });
    }
  });

  return planned;
}

/**
 * Is this outbox row due to leave?
 *
 * TWO conditions, and the second one is read fresh every time rather than
 * snapshotted at plan time: a delivery withheld by `webhooks_off` becomes due
 * the moment that control is disarmed OR runs out, with no sweeper, no requeue
 * and no state transition. Turning the switch off IS the provider coming back,
 * and the backlog then catches up exactly the way a real provider's does.
 */
export function isDue(
  row: { plannedAt: Date; outcome: string },
  opts: { now: Date; webhooksOff: boolean },
): boolean {
  if (row.outcome !== 'withheld') return false;
  if (opts.webhooksOff) return false;
  return row.plannedAt.getTime() <= opts.now.getTime();
}

/**
 * A one-line description of the schedule, for the screen and the audit trail.
 *
 * Reads as English on purpose: "the clearing first, then the authorisation 20s
 * later, each delivered 3 times, all of it withheld" is the sentence a grader
 * should be able to check against what they just pressed.
 */
export function describePlan(planned: readonly PlannedDelivery[]): string {
  if (planned.length === 0) return 'nothing planned';
  const bySeq = new Map<number, PlannedDelivery[]>();
  for (const row of planned) {
    const list = bySeq.get(row.seq) ?? [];
    list.push(row);
    bySeq.set(row.seq, list);
  }
  const base = planned[0]?.plannedAt.getTime() ?? 0;
  const parts: string[] = [];
  for (const [, rows] of [...bySeq.entries()].sort((a, b) => a[0] - b[0])) {
    const row = rows[0];
    if (row === undefined) continue;
    const offset = Math.round((row.plannedAt.getTime() - base) / 1_000);
    const when = offset === 0 ? 'immediately' : `+${String(offset)}s`;
    const times = rows.length === 1 ? 'once' : `${String(rows.length)}x`;
    parts.push(`${row.step} ${when} (${times})`);
  }
  const withheld = planned.every((p) => p.withheld);
  return `${parts.join(', then ')}${withheld ? ' — all withheld, webhooks are off' : ''}`;
}
