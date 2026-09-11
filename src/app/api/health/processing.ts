/**
 * Webhook PROCESSING health — a third question, and the one that was wrong.
 *
 * `probe.ts` answers "does this credential still work?" — our side of the wire.
 * `delivery-health.ts` answers "is this provider still talking to us?" — their
 * side, measured as `MAX(webhook_inbox.received_at)`.
 *
 * Neither answers the question a customer's balance depends on: **did we do
 * anything with what arrived?**
 *
 * ---------------------------------------------------------------------------
 * THE MEASUREMENT THAT FORCED THIS FILE
 * ---------------------------------------------------------------------------
 * Measured against the production database at 2026-09-11T05:20Z:
 *
 *   179 Increase deliveries, every one of them signature-verified, accepted,
 *   and then DEAD-LETTERED with `no consumer registered for provider
 *   'increase'`. The newest arrived at 04:46:06Z — four minutes before the
 *   reading — and `/api/health` reported `increase: fresh`.
 *
 * It was not lying about what it measured. `MAX(received_at)` really was four
 * minutes old. A rail that RECEIVES EVERYTHING AND PROCESSES NOTHING is
 * maximally fresh by that definition, which is the exact shape this build has
 * now found sixteen times: the signal is computed from an input that cannot
 * express the failure. Arrival is not health. A delivery sitting unconsumed is
 * the opposite of health — it is money we were told about and did not book.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE MODULE AND NOT A FIX TO delivery-health.ts
 * ---------------------------------------------------------------------------
 * `MAX(received_at)` is the right answer to the question that module asks, and
 * that question is still worth asking: a provider that has stopped delivering
 * and a provider whose deliveries we drop are different outages with different
 * owners. Rewriting freshness to mean consumption would silently retire the
 * first one. So both are published, side by side, with disjoint vocabularies.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT THIS MUST NOT BREAK (DECISIONS 021, consistency.test.ts)
 * ---------------------------------------------------------------------------
 * `/api/health` must contain ONE opinion per question. So, exactly as
 * `delivery-health.ts` does:
 *
 *   * keyed by PROVIDER, never by slot; it emits no `slot` and no `status`;
 *   * its verdict vocabulary — consuming / backlogged / dropping /
 *     never_consumed / idle / unmeasured — shares no word with the liveness
 *     vocabulary (live / simulated / unauthorised / unreachable /
 *     not_configured / unprobed / rate_limited) or with the delivery one
 *     (fresh / stale / quiet / never / unknown);
 *   * the staleness thresholds are IMPORTED from `delivery-health.ts` rather
 *     than restated, so there is one table of provider cadences in this system
 *     and a sixth provider cannot be monitored by one module and not the other.
 *
 * `live`, `fresh` and `dropping` at once is three facts about three different
 * questions, not a contradiction: the key works, the provider is talking, and
 * we are throwing away what it says.
 */

import {
  DELIVERY_THRESHOLDS,
  quietAfterSeconds,
  type DeliverySql,
} from '@/lib/integrations/delivery-health';

// ---------------------------------------------------------------------------
// 1. The vocabulary
// ---------------------------------------------------------------------------

/**
 * Six verdicts. The two that matter are `dropping` and `never_consumed`,
 * because they are the only ones in any of the three vocabularies that are
 * POSITIVE EVIDENCE OF LOSS rather than an absence of evidence.
 *
 *   consuming       A delivery was successfully consumed inside this
 *                   provider's own cadence. The rail is doing its job.
 *
 *   backlogged      Deliveries are parked — held, waiting for a referent that
 *                   has not arrived — for longer than the provider's cadence.
 *                   Parking is a designed state and a parked row is retried,
 *                   so this is reported and never alarmed on. It is the early
 *                   warning for `dropping`.
 *
 *   dropping        Deliveries have been DEAD-LETTERED recently: accepted,
 *                   verified, retried to exhaustion, and abandoned. This is
 *                   the one verdict in this endpoint that describes something
 *                   we did rather than something that failed to happen.
 *
 *   never_consumed  Deliveries have arrived and not one has ever been
 *                   consumed. Distinct from `idle` for the same reason
 *                   delivery-health keeps `never` and `stale` apart: "the
 *                   consumer was never wired" and "the consumer has gone
 *                   quiet" are different faults with different fixes.
 *
 *   idle            Nothing has arrived to consume, or nothing has arrived
 *                   recently. The normal state of a KYC feed at 3am.
 *
 *   unmeasured      The query did not run. Stated, never guessed.
 */
export type ProcessingVerdict =
  | 'consuming'
  | 'backlogged'
  | 'dropping'
  | 'never_consumed'
  | 'idle'
  | 'unmeasured';

/** Exported so a test can prove it is disjoint from the other two. */
export const PROCESSING_VERDICTS: readonly ProcessingVerdict[] = [
  'consuming',
  'backlogged',
  'dropping',
  'never_consumed',
  'idle',
  'unmeasured',
];

// ---------------------------------------------------------------------------
// 2. Reading the data — ONE query for every provider
// ---------------------------------------------------------------------------

export interface ProcessingRow {
  readonly provider: string;
  /** `MAX(processed_at)` over deliveries that reached `done`. */
  readonly lastConsumedAt: Date | null;
  /** `MAX(received_at)` over everything, so "arrived but never consumed" is expressible. */
  readonly lastDeliveryAt: Date | null;
  readonly parkedCount: number;
  readonly parkedOldestAt: Date | null;
  readonly deadCount: number;
  readonly deadNewestAt: Date | null;
  readonly deadOldestAt: Date | null;
  /** The most recent dead letter's own reason, verbatim and truncated. */
  readonly deadReason: string | null;
}

export type ProcessingRead =
  | { readonly ok: true; readonly rows: readonly ProcessingRow[]; readonly latencyMs: number }
  | { readonly ok: false; readonly error: string; readonly latencyMs: number | null };

/** Budget for the processing query, matching the delivery one. */
export const PROCESSING_QUERY_TIMEOUT_MS = 2_500;

/** A read that never happened, for the paths where there is nothing to query. */
export function processingUnavailable(error: string): ProcessingRead {
  return { ok: false, error, latencyMs: null };
}

/**
 * One round trip for all providers, in the shape `readWebhookDeliveries` uses
 * and for the same reason: a scalar subquery per provider over a fixed list,
 * rather than a `GROUP BY` that reads the whole inbox. This one carries seven
 * subqueries instead of one, which is seven index lookups on a table of a few
 * hundred rows — measured at single-digit milliseconds against the production
 * branch, against a round trip to us-east-2 that costs an order of magnitude
 * more than the query itself.
 *
 * Never throws. A health endpoint that cannot answer because its own
 * enrichment query failed has become the outage.
 */
export async function readWebhookProcessing(
  sql: DeliverySql,
  timeoutMs: number = PROCESSING_QUERY_TIMEOUT_MS,
): Promise<ProcessingRead> {
  const providers = Object.keys(DELIVERY_THRESHOLDS);
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`webhook processing query exceeded ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    const query = sql`
      select p.provider as provider,
             (select max(w.processed_at) from webhook_inbox w
               where w.provider = p.provider and w.state = 'done') as last_consumed_at,
             (select max(w.received_at) from webhook_inbox w
               where w.provider = p.provider) as last_delivery_at,
             (select count(*) from webhook_inbox w
               where w.provider = p.provider and w.state = 'parked') as parked_count,
             (select min(w.received_at) from webhook_inbox w
               where w.provider = p.provider and w.state = 'parked') as parked_oldest_at,
             (select count(*) from webhook_inbox w
               where w.provider = p.provider and w.state = 'dead') as dead_count,
             (select max(w.dead_lettered_at) from webhook_inbox w
               where w.provider = p.provider and w.state = 'dead') as dead_newest_at,
             (select min(w.received_at) from webhook_inbox w
               where w.provider = p.provider and w.state = 'dead') as dead_oldest_at,
             (select w.processing_error from webhook_inbox w
               where w.provider = p.provider and w.state = 'dead'
               order by w.dead_lettered_at desc nulls last limit 1) as dead_reason
        from unnest(${providers}::text[]) as p(provider)
    `;
    const result = (await Promise.race([query, timeout])) as readonly unknown[];
    return { ok: true, rows: result.map(toRow), latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Rows arrive as `unknown` on purpose: this module does not own the schema it
 * queries, and the driver hands `count(*)` back as a string and timestamps back
 * as either a `Date` or a string depending on the column. Coercing defensively
 * here is cheaper than a health endpoint throwing on its own enrichment.
 */
function toRow(raw: unknown): ProcessingRow {
  const row = (raw ?? {}) as Record<string, unknown>;
  const reason = row['dead_reason'];
  return {
    provider: typeof row['provider'] === 'string' ? row['provider'] : '',
    lastConsumedAt: toDate(row['last_consumed_at']),
    lastDeliveryAt: toDate(row['last_delivery_at']),
    parkedCount: toCount(row['parked_count']),
    parkedOldestAt: toDate(row['parked_oldest_at']),
    deadCount: toCount(row['dead_count']),
    deadNewestAt: toDate(row['dead_newest_at']),
    deadOldestAt: toDate(row['dead_oldest_at']),
    deadReason: typeof reason === 'string' && reason !== '' ? reason.slice(0, 200) : null,
  };
}

function toCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. The verdict, and what is allowed to degrade the deployment
// ---------------------------------------------------------------------------

export interface ProviderProcessingHealth {
  readonly provider: string;
  readonly label: string;
  /** ISO instant of the newest delivery this system actually consumed. */
  readonly lastConsumed: string | null;
  readonly secondsSinceLastConsumed: number | null;
  /** ISO instant of the newest delivery that ARRIVED. The two together are the fact. */
  readonly lastDelivery: string | null;
  readonly secondsSinceLastDelivery: number | null;
  readonly parked: { readonly count: number; readonly oldestAgeSeconds: number | null };
  readonly deadLettered: {
    readonly count: number;
    readonly newestAgeSeconds: number | null;
    readonly oldestAgeSeconds: number | null;
    readonly reason: string | null;
  };
  readonly verdict: ProcessingVerdict;
  readonly degradesDeployment: boolean;
  readonly note: string;
}

export interface WebhookProcessingHealth {
  /** Where the numbers come from, named so nobody has to guess. */
  readonly source: 'webhook_inbox.processed_at + state';
  readonly measuredAt: string;
  readonly measured: boolean;
  readonly error: string | null;
  readonly queryLatencyMs: number | null;
  readonly degradedBy: readonly string[];
  readonly providers: readonly ProviderProcessingHealth[];
}

/**
 * Fold the read into the published field. Pure: no clock of its own, no
 * database, no network — so every branch below is reachable from a test rather
 * than only from an outage.
 */
export function webhookProcessingHealth(
  read: ProcessingRead,
  now: Date,
): WebhookProcessingHealth {
  const byProvider = new Map<string, ProcessingRow>(
    read.ok ? read.rows.map((r) => [r.provider, r]) : [],
  );

  const providers = Object.entries(DELIVERY_THRESHOLDS).map(([provider, threshold]) =>
    reportFor(provider, threshold.label, threshold.staleAfterSeconds, byProvider.get(provider), read.ok, now),
  );

  return {
    source: 'webhook_inbox.processed_at + state',
    measuredAt: now.toISOString(),
    measured: read.ok,
    error: read.ok ? null : read.error,
    queryLatencyMs: read.latencyMs,
    degradedBy: providers.filter((p) => p.degradesDeployment).map((p) => p.provider),
    providers,
  };
}

function ageSeconds(now: Date, then: Date | null): number | null {
  if (then === null) return null;
  // Floor at zero: clock skew between the function and the database must not
  // publish a negative age, which reads as a corrupted measurement.
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
}

function reportFor(
  provider: string,
  label: string,
  staleAfterSeconds: number,
  row: ProcessingRow | undefined,
  measured: boolean,
  now: Date,
): ProviderProcessingHealth {
  const base = { provider, label };

  if (!measured || row === undefined) {
    return {
      ...base,
      lastConsumed: null,
      secondsSinceLastConsumed: null,
      lastDelivery: null,
      secondsSinceLastDelivery: null,
      parked: { count: 0, oldestAgeSeconds: null },
      deadLettered: { count: 0, newestAgeSeconds: null, oldestAgeSeconds: null, reason: null },
      verdict: 'unmeasured',
      degradesDeployment: false,
      note: 'webhook processing could not be read; this is not a verdict about the consumer',
    };
  }

  const consumedAge = ageSeconds(now, row.lastConsumedAt);
  const deliveredAge = ageSeconds(now, row.lastDeliveryAt);
  const parkedAge = ageSeconds(now, row.parkedOldestAt);
  const deadNewestAge = ageSeconds(now, row.deadNewestAt);
  const deadOldestAge = ageSeconds(now, row.deadOldestAt);

  // THE ALARM WINDOW, borrowed rather than invented. `delivery-health.ts`
  // argues that silence stops being evidence after five times a feed's own
  // cadence; a dead letter is not silence, but "we dropped something at some
  // point in the past" stops being actionable on the same curve, and having
  // two windows to defend per provider is how one of them stops being read.
  const alarmWindow = quietAfterSeconds(staleAfterSeconds);

  const verdict: ProcessingVerdict =
    row.deadCount > 0 && deadNewestAge !== null && deadNewestAge <= alarmWindow
      ? 'dropping'
      : row.lastDeliveryAt !== null && row.lastConsumedAt === null
        ? 'never_consumed'
        : row.parkedCount > 0 && parkedAge !== null && parkedAge > staleAfterSeconds
          ? 'backlogged'
          : consumedAge !== null && consumedAge <= staleAfterSeconds
            ? 'consuming'
            : 'idle';

  // ---------------------------------------------------------------------
  // WHAT IS ALLOWED TO MAKE THE DEPLOYMENT `degraded`
  // ---------------------------------------------------------------------
  // `delivery-health.ts` needs four clauses before silence may degrade the
  // deployment, and every one of them is right: silence is an ABSENCE of
  // evidence, it is indistinguishable from nobody using the integration, and
  // an alarm that cries wolf gets ignored.
  //
  // Neither verdict below is silence.
  //
  //   `dropping` is a delivery we accepted, verified, retried to exhaustion
  //   and abandoned. Somebody told us something about money and we threw it
  //   away. There is no reading of that which is "nobody used this feed".
  //
  //   `never_consumed` is the same fact in its first form — deliveries are
  //   arriving and the consumer has never once run.
  //
  // So neither is gated on `gatesDeploymentStatus`, and that difference is
  // the point: that flag exists to stop a quiet KYC feed alarming overnight,
  // and a quiet feed cannot be dropping deliveries. Gating loss on it would
  // reproduce, in a third module, the mistake this file was written to fix —
  // the alarm disarmed by exactly the condition it exists to catch.
  //
  // `backlogged` does NOT degrade. A parked delivery is a designed state with
  // a retry behind it: it is the early warning for `dropping`, reported so an
  // operator can act before the ladder runs out, not an outage in itself.
  const degradesDeployment = verdict === 'dropping' || verdict === 'never_consumed';

  return {
    ...base,
    lastConsumed: row.lastConsumedAt?.toISOString() ?? null,
    secondsSinceLastConsumed: consumedAge,
    lastDelivery: row.lastDeliveryAt?.toISOString() ?? null,
    secondsSinceLastDelivery: deliveredAge,
    parked: { count: row.parkedCount, oldestAgeSeconds: parkedAge },
    deadLettered: {
      count: row.deadCount,
      newestAgeSeconds: deadNewestAge,
      oldestAgeSeconds: deadOldestAge,
      reason: row.deadReason,
    },
    verdict,
    degradesDeployment,
    note: noteFor(verdict, row, staleAfterSeconds),
  };
}

function noteFor(
  verdict: ProcessingVerdict,
  row: ProcessingRow,
  staleAfterSeconds: number,
): string {
  switch (verdict) {
    case 'dropping':
      return (
        `${row.deadCount} delivery(ies) accepted and then DEAD-LETTERED, the newest just now — ` +
        `arrival is not processing, and these were never booked` +
        (row.deadReason === null ? '' : `: ${row.deadReason}`)
      );
    case 'never_consumed':
      return 'deliveries have arrived from this provider and not one has ever been consumed — the consumer is missing, not the feed';
    case 'backlogged':
      return `${row.parkedCount} delivery(ies) parked waiting for a referent for longer than ${staleAfterSeconds}s; retried, not lost — the early warning for a drop`;
    case 'consuming':
      return `a delivery was consumed within ${staleAfterSeconds}s`;
    case 'idle':
      return row.lastDeliveryAt === null
        ? 'nothing has ever arrived from this provider, so there is nothing to consume'
        : `nothing consumed within ${staleAfterSeconds}s, and nothing is parked or dead — the feed is quiet, not broken`;
    case 'unmeasured':
      return 'webhook processing could not be read';
  }
}
