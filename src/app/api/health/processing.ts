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
 *   dropping        Deliveries have been DEAD-LETTERED recently AND nothing
 *                   from this provider has been consumed since. Accepted,
 *                   verified, retried to exhaustion, and abandoned, with no
 *                   evidence that the pipeline has worked since. This is the
 *                   one verdict in this endpoint that describes something we
 *                   did rather than something that failed to happen.
 *
 *                   THE SECOND CLAUSE IS NEW, AND IT IS THE POINT. 167
 *                   Increase deliveries were dead-lettered with "no consumer
 *                   registered for provider 'increase'" inside a 48-minute
 *                   window on 2026-09-11. A consumer was registered
 *                   afterwards; 54 deliveries from the same provider were
 *                   consumed after that, and nothing died again. The
 *                   deployment went on reading `degraded`, quoting the dead
 *                   sentence, for another five hours — because the verdict
 *                   was computed from a timestamp that cannot express "and
 *                   then we fixed it". A degraded status nobody can clear is
 *                   a status people stop reading, which is the same failure
 *                   as a guard that cries wolf; it is also how a REAL drop,
 *                   arriving into a permanently red field, gets missed.
 *
 *                   `MAX(dead_lettered_at) > MAX(processed_at)` is the whole
 *                   test, and it is deliberately a fact about the data rather
 *                   than a flag an operator sets. There is no acknowledge
 *                   button here, no snooze, and no state in this module: the
 *                   alarm clears when the system demonstrably works again,
 *                   and it comes straight back the moment a delivery dies
 *                   after a success.
 *
 *   never_consumed  Deliveries have arrived and not one has ever been
 *                   consumed. Distinct from `idle` for the same reason
 *                   delivery-health keeps `never` and `stale` apart: "the
 *                   consumer was never wired" and "the consumer has gone
 *                   quiet" are different faults with different fixes.
 *
 *   superseded      Deliveries were dead-lettered, and this provider has
 *                   successfully consumed one SINCE the newest of them. The
 *                   fault that killed them is behind us; the rows are still
 *                   there and are still unbooked, and `scripts/redrive.mjs`
 *                   is what clears them. See the note on `dropping` below for
 *                   why this is a different fact and not a softer word for
 *                   the same one.
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
  | 'superseded'
  | 'never_consumed'
  | 'idle'
  | 'unmeasured';

/** Exported so a test can prove it is disjoint from the other two. */
export const PROCESSING_VERDICTS: readonly ProcessingVerdict[] = [
  'consuming',
  'backlogged',
  'dropping',
  'superseded',
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
  /**
   * Dead letters that this provider's own later success has NOT superseded —
   * `state = 'dead' AND dead_lettered_at > MAX(processed_at)`.
   *
   * COUNTED IN SQL rather than inferred from the two maxima already on this
   * row. The two are the same number in every case either can describe, and
   * the count survives the case the comparison cannot: a provider dropping a
   * steady trickle while consuming the rest reads `3` here and would read
   * "superseded, nothing to see" from a comparison of the newest of each.
   */
  readonly deadSinceConsumedCount: number;
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
               order by w.dead_lettered_at desc nulls last limit 1) as dead_reason,
             -- Deaths NO LATER SUCCESS HAS SUPERSEDED. minus-infinity is the
             -- coalesce so that a provider which has never consumed anything
             -- counts every one of its dead letters here rather than none:
             -- "we have never processed one of these" must not read as
             -- "nothing is wrong".
             (select count(*) from webhook_inbox w
               where w.provider = p.provider and w.state = 'dead'
                 and w.dead_lettered_at > coalesce(
                       (select max(d.processed_at) from webhook_inbox d
                         where d.provider = p.provider and d.state = 'done'),
                       '-infinity'::timestamptz)) as dead_since_consumed
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
    deadSinceConsumedCount: toCount(row['dead_since_consumed']),
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
    /**
     * How many of `count` died AFTER the newest delivery this provider
     * successfully consumed. Zero means every one of them predates a later
     * success: they are a backlog to redrive, not evidence of current loss.
     */
    readonly sinceLastConsumed: number;
    /**
     * True when there are dead letters and none of them is `sinceLastConsumed`.
     * Published beside `reason` on purpose: it is the flag that says the
     * quoted sentence is archaeology rather than a live fault, so nobody has
     * to infer that from two timestamps.
     */
    readonly supersededByConsumption: boolean;
    /** What clears them. Null when there is nothing to clear. */
    readonly clearedBy: string | null;
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
      deadLettered: {
        count: 0,
        newestAgeSeconds: null,
        oldestAgeSeconds: null,
        reason: null,
        sinceLastConsumed: 0,
        supersededByConsumption: false,
        clearedBy: null,
      },
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

  // "IS ANYTHING DYING NOW" versus "DID SOMETHING DIE ONCE".
  //
  // `superseded` is the second, and it is a fact about the data: every dead
  // letter on this provider was abandoned BEFORE the newest delivery we
  // successfully consumed from it. That is proof the pipeline works now, so
  // the rows are a backlog with a named remedy rather than an outage — and
  // they still show, in full, in `deadLettered`, because a backlog that stops
  // being counted is a backlog nobody clears.
  const superseded = row.deadCount > 0 && row.deadSinceConsumedCount === 0;

  const verdict: ProcessingVerdict =
    // Recent AND unsuperseded. Either half alone over-alarms: a death from
    // last night is history, and a death that a later success has overtaken is
    // a row to redrive.
    row.deadSinceConsumedCount > 0 && deadNewestAge !== null && deadNewestAge <= alarmWindow
      ? 'dropping'
      : row.lastDeliveryAt !== null && row.lastConsumedAt === null
        ? 'never_consumed'
        : row.parkedCount > 0 && parkedAge !== null && parkedAge > staleAfterSeconds
          ? // Parking is the live state and it outranks a cleared backlog:
            // `backlogged` is the early warning for the next drop, while
            // `superseded` is a receipt for the last one.
            'backlogged'
          : superseded
            ? 'superseded'
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
  //
  // `superseded` does NOT degrade either, and that is the judgement call in
  // this file. The rows are real, unbooked deliveries and they are still
  // counted in full — but the loss they record is in the past tense, the
  // pipeline has demonstrably worked since, and `scripts/redrive.mjs` is the
  // named action that clears them. Degrading on it would leave a red field
  // that nothing this endpoint can observe will ever turn green, which is the
  // condition that trains people to stop reading it. The alarm is not being
  // softened: it comes back the instant `sinceLastConsumed` is non-zero, and
  // that number is on the row for anyone who wants to check.
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
      sinceLastConsumed: row.deadSinceConsumedCount,
      supersededByConsumption: superseded,
      clearedBy: row.deadCount > 0 ? 'node scripts/redrive.mjs --apply' : null,
    },
    verdict,
    degradesDeployment,
    note: noteFor(verdict, row, staleAfterSeconds, deadNewestAge),
  };
}

/**
 * The sentence a human reads.
 *
 * `deadNewestAge` is passed in rather than recomputed, because the note used
 * to say "the newest just now" unconditionally — on a row whose newest dead
 * letter was two hours and fifteen minutes old. A note that asserts a time it
 * has not measured is the same class of mistake as a verdict computed from an
 * input that cannot express the failure, one layer of prose down.
 */
function noteFor(
  verdict: ProcessingVerdict,
  row: ProcessingRow,
  staleAfterSeconds: number,
  deadNewestAge: number | null,
): string {
  /** Appended wherever a cleared backlog would otherwise be invisible. */
  const supersededClause =
    row.deadCount > 0 && row.deadSinceConsumedCount === 0
      ? ` ${row.deadCount} dead letter(s) remain from an earlier fault, all of them older than the newest delivery consumed here` +
        `${row.deadReason === null ? '' : ` ("${row.deadReason}")`} — history, not a live drop; clear them with scripts/redrive.mjs.`
      : '';

  switch (verdict) {
    case 'dropping':
      return (
        `${row.deadSinceConsumedCount} of ${row.deadCount} dead letter(s) were abandoned AFTER the last delivery this provider consumed` +
        `${deadNewestAge === null ? '' : `, the newest ${deadNewestAge}s ago`} — ` +
        `arrival is not processing, and these were never booked` +
        (row.deadReason === null ? '' : `: ${row.deadReason}`)
      );
    case 'superseded':
      return (
        `${row.deadCount} delivery(ies) were dead-lettered and NONE since the newest one this provider consumed: ` +
        `the fault that killed them is behind us and the consumer is working` +
        `${row.deadReason === null ? '' : ` (their recorded reason was "${row.deadReason}")`}. ` +
        `They are still unbooked — redrive them with scripts/redrive.mjs — and they do not degrade the deployment, ` +
        `because a red field nobody can clear is one nobody reads.`
      );
    case 'never_consumed':
      return 'deliveries have arrived from this provider and not one has ever been consumed — the consumer is missing, not the feed';
    case 'backlogged':
      return `${row.parkedCount} delivery(ies) parked waiting for a referent for longer than ${staleAfterSeconds}s; retried, not lost — the early warning for a drop.${supersededClause}`;
    case 'consuming':
      return `a delivery was consumed within ${staleAfterSeconds}s.${supersededClause}`;
    case 'idle':
      return (
        (row.lastDeliveryAt === null
          ? 'nothing has ever arrived from this provider, so there is nothing to consume'
          : `nothing consumed within ${staleAfterSeconds}s, and nothing is parked that is overdue — the feed is quiet, not broken`) +
        `.${supersededClause}`
      );
    case 'unmeasured':
      return 'webhook processing could not be read';
  }
}
