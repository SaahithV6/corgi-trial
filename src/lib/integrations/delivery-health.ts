/**
 * Webhook DELIVERY FRESHNESS — a different question from liveness.
 *
 * `probe.ts` answers "does this credential still work, and can the slot do the
 * job it claims?" by making an outbound call. That question is answered
 * entirely from our side of the wire, and it stays green while a provider's
 * webhook feed is dead: our Lithic key works perfectly at the exact moment
 * Lithic has stopped telling us about authorisations. DECISIONS 024 recorded
 * that gap as the one live-fire attack left open — "`/api/health` reports
 * credential and capability liveness and nothing about webhook delivery
 * freshness, so a webhook outage is invisible to it."
 *
 * This module closes it, from the data that already exists:
 * `webhook_inbox.received_at`, the instant we accepted a verified delivery.
 *
 * ---------------------------------------------------------------------------
 * THE INVARIANT THIS MUST NOT BREAK (DECISIONS 021, consistency.test.ts)
 * ---------------------------------------------------------------------------
 * `/api/health` once published two answers for the same slot and one of them
 * was wrong. The fix was to stop having two opinions, not to reconcile them.
 * So this module is built so it CANNOT become a second opinion about liveness:
 *
 *   * It is keyed by PROVIDER (the `webhook_inbox.provider` text column), not
 *     by integration slot. It never emits a `slot` or a `status` field.
 *   * Its verdict vocabulary — fresh / stale / quiet / never / unknown — is
 *     DISJOINT from the liveness vocabulary — live / simulated / unauthorised /
 *     unreachable / not_configured. There is no string a reader could mistake
 *     for a liveness verdict, so "live and stale" is readable as the two
 *     independent facts it is, with no contradiction to resolve.
 *
 * A provider can be live and stale at once. That combination is not a
 * contradiction; it is the outage this field exists to show.
 */

import type postgres from 'postgres';

/**
 * The client this module needs. Deliberately the same type `/api/health`
 * already holds, so the health route hands over the connection it has ALREADY
 * opened and warmed with its `select 1` rather than opening a second one.
 */
export type DeliverySql = ReturnType<typeof postgres>;

// ---------------------------------------------------------------------------
// 1. The verdict vocabulary
// ---------------------------------------------------------------------------

/**
 * Five verdicts, and the two pairs that must never be collapsed.
 *
 *   never    No row has EVER arrived from this provider. This is not `stale`,
 *            and the difference is the whole point of separating them: "we
 *            have never heard from this provider" is a wiring fact (the
 *            webhook was never registered, the secret was never set, the slot
 *            was never used) while "this provider has gone quiet" is an
 *            operational one. Collapsing them is how a real outage hides
 *            behind a slot that was never wired — the endpoint reads `stale`
 *            in both cases, everybody learns that `stale` means "eh, that one
 *            is always red", and the day it means an outage nobody looks.
 *
 *   fresh    Heard from within this provider's own staleness threshold.
 *
 *   stale    Silent for longer than its threshold, but not yet so long that
 *            silence has stopped meaning anything (see ALARM_WINDOW_MULTIPLE).
 *            A feed that was delivering and then stopped is a step change, and
 *            a step change is evidence.
 *
 *   quiet    Silent for so long that "the feed is down" and "nobody has used
 *            this integration" are the same observation. Reported, never
 *            alarmed on.
 *
 *   unknown  The query did not run. Stated, never guessed. A health endpoint
 *            that invents a verdict when it could not measure is worse than
 *            one that says it could not measure.
 */
export type DeliveryVerdict = 'fresh' | 'stale' | 'quiet' | 'never' | 'unknown';

/** Exported so a test can prove it is disjoint from the liveness vocabulary. */
export const DELIVERY_VERDICTS: readonly DeliveryVerdict[] = [
  'fresh',
  'stale',
  'quiet',
  'never',
  'unknown',
];

// ---------------------------------------------------------------------------
// 2. Thresholds — per provider, because the cadences are not comparable
// ---------------------------------------------------------------------------

/**
 * Why per-provider and not one number.
 *
 * These five feeds differ by roughly three orders of magnitude in natural
 * cadence. A card authorisation is emitted synchronously with a swipe; a
 * Persona inquiry webhook fires only when a human finishes filling in a form,
 * which may be next week. One shared threshold has to be either short enough
 * to catch a card-rail outage — in which case KYC and the registry are
 * permanently red and the endpoint is noise — or long enough not to false-alarm
 * on KYC, in which case the card rail can be down for half a day unnoticed.
 * Both failures end the same way: nobody reads the health endpoint any more.
 *
 * `gatesDeploymentStatus` is a separate decision from the threshold and is
 * argued in section 4.
 */
interface DeliveryThreshold {
  readonly label: string;
  readonly staleAfterSeconds: number;
  readonly gatesDeploymentStatus: boolean;
  /** Why this number. Shipped in the response so it can be challenged. */
  readonly rationale: string;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * Keyed by `webhook_inbox.provider`, which is the same string as the
 * `/api/webhooks/<provider>` path segment. `delivery-health.test.ts` asserts
 * this table covers exactly the webhook catalogue, so adding a sixth provider
 * without a threshold fails the suite rather than silently going unmonitored.
 */
export const DELIVERY_THRESHOLDS: Readonly<Record<string, DeliveryThreshold>> = {
  // THE ONE THAT MATTERS. Card authorisations are real time: Lithic emits the
  // webhook while the cardholder is standing at the terminal, and our hold is
  // placed from that event. Silence here is not an inconvenience, it is
  // authorisations we are not recording against balances we are still letting
  // people spend. Lithic's own delivery retry ladder is seconds-to-minutes, so
  // three minutes of complete silence is past every automatic recovery it will
  // attempt on our behalf — after that, someone should be looking. Short
  // enough that a five-minute outage is visible INSIDE the five minutes rather
  // than at its edge, which is the difference between a monitor and an epitaph.
  lithic: {
    label: 'Lithic',
    staleAfterSeconds: 3 * MINUTE,
    gatesDeploymentStatus: true,
    rationale:
      'card authorisations are emitted synchronously with the transaction; 3m is past every retry Lithic makes on our behalf',
  },

  // ACH is a batch rail, not a stream. Increase emits transfer lifecycle events
  // on the banking day's rhythm — submission, settlement, and returns that
  // arrive up to 60 days later by design. A quiet hour on ACH is the normal
  // state of an ACH feed; a quiet business day is worth a look. 6h sits inside
  // one banking day so a whole day of silence is never reported as fresh.
  increase: {
    label: 'Increase',
    staleAfterSeconds: 6 * HOUR,
    gatesDeploymentStatus: false,
    rationale:
      'ACH is batch, not stream: events follow the banking day and returns arrive for weeks; 6h is under one banking day',
  },

  // Plaid item webhooks (DEFAULT_UPDATE, TRANSACTIONS, item errors) fire on
  // Plaid's own refresh schedule — a handful of times a day per linked item,
  // and only for items that exist. With no linked item the feed is correctly
  // silent for ever, which is why this can never gate the deployment.
  plaid: {
    label: 'Plaid',
    staleAfterSeconds: 12 * HOUR,
    gatesDeploymentStatus: false,
    rationale:
      "item webhooks follow Plaid's refresh schedule (a few per day per item) and stop entirely with no linked item",
  },

  // KYC has no background cadence at all. An inquiry webhook exists only
  // because a human completed a step, so between applicants the honest
  // expected delivery rate is zero. 24h is chosen to mean "we have not had an
  // applicant today", which is a fact worth showing and never an alarm.
  persona: {
    label: 'Persona',
    staleAfterSeconds: 24 * HOUR,
    gatesDeploymentStatus: false,
    rationale:
      'inquiry events are human-driven with no background rate; days of silence are the normal state of a KYC feed',
  },

  // Stripe Connect is not enabled on this account (DECISIONS 015 and 017), so
  // the registry leg runs simulated and the only events this endpoint could
  // receive are account-level ones we do not generate. Silence is the expected
  // steady state, and reporting the expected steady state as an outage is
  // exactly the cry-wolf this whole table exists to avoid.
  stripe: {
    label: 'Stripe',
    staleAfterSeconds: 24 * HOUR,
    gatesDeploymentStatus: false,
    rationale:
      'Connect is not enabled, so the registry leg is simulated and this feed has no expected traffic at all',
  },
};

/**
 * How long silence stays EVIDENCE, as a multiple of the feed's own threshold.
 *
 * This is the number that keeps the field from crying wolf, and it deserves the
 * argument rather than the constant.
 *
 * We have no traffic expectation to compare against — nothing here knows that a
 * card "should" be used at 14:03. All we can observe is a STEP CHANGE: a feed
 * that was delivering and has just stopped is a change of state, and a change
 * of state is information. The longer the silence runs with nothing arriving,
 * the weaker that inference gets, until "the feed is down" and "nobody has used
 * this integration since lunch" are the same observation and we cannot tell
 * them apart. Past that point the honest verdict is `quiet`, not an alarm.
 *
 * Five times the threshold, so the window scales with the cadence it is
 * measuring instead of being a second number to defend per provider. For Lithic
 * that is a 3m-to-15m alarm band: an outage is caught inside a quarter of an
 * hour — many monitoring intervals — and a card rail that saw one burst of
 * traffic this morning is not still reported as broken at teatime. A fixed
 * one-hour window was the first version of this and it was wrong in exactly
 * that way: measured against production it reported the deployment degraded 18
 * minutes after the last card event, on a rail nobody was using, which is the
 * mistake `/api/health` already made once with its database timeout (see
 * route.ts: a 1s budget "would report degraded every time the branch woke up,
 * which trains whoever reads this endpoint to ignore it").
 */
export const ALARM_WINDOW_MULTIPLE = 5;

/** Past this, silence is indistinguishable from disuse. */
export function quietAfterSeconds(staleAfterSeconds: number): number {
  return staleAfterSeconds * ALARM_WINDOW_MULTIPLE;
}

/** Budget for the delivery query. See `readWebhookDeliveries`. */
export const DELIVERY_QUERY_TIMEOUT_MS = 2_500;

// ---------------------------------------------------------------------------
// 3. Reading the data — ONE query for all providers
// ---------------------------------------------------------------------------

export interface DeliveryRow {
  readonly provider: string;
  readonly lastDeliveryAt: Date | null;
}

export type DeliveryRead =
  | { readonly ok: true; readonly rows: readonly DeliveryRow[]; readonly latencyMs: number }
  | { readonly ok: false; readonly error: string; readonly latencyMs: number | null };

/** A read that never happened, for the paths where there is nothing to query. */
export function deliveriesUnavailable(error: string): DeliveryRead {
  return { ok: false, error, latencyMs: null };
}

/**
 * One round trip for every provider.
 *
 * Not one query per provider: `/api/health` is polled by uptime monitors and by
 * the deploy pipeline, five sequential round trips to us-east-2 is five times
 * the latency for the same answer, and the route's remaining budget is not
 * generous (vercel.json caps the function at 15s; the database probe may spend
 * 8s of it and the integration probes 4s).
 *
 * The shape is a scalar subquery per provider over a fixed five-element list
 * rather than `GROUP BY provider`, because `MAX(received_at)` filtered to one
 * provider is answered from the tail of `webhook_inbox_provider_received_idx`
 * — the (provider, received_at DESC) index migration 0002 already created for
 * "show me everything Lithic sent us on Tuesday". Measured rather than assumed
 * — EXPLAIN (ANALYZE, BUFFERS) against the production branch:
 *
 *   Function Scan on unnest p  (actual rows=5 loops=1)
 *     SubPlan 2 -> InitPlan 1 -> Limit
 *       -> Index Only Scan using webhook_inbox_provider_received_idx
 *          Index Cond: (provider = p.provider)
 *          Heap Fetches: 0   Index Searches: 5   Buffers: shared hit=6
 *   Execution Time: 0.147 ms
 *
 * Five index searches, zero heap fetches, six buffer hits, and the cost does
 * not grow with the inbox. A GROUP BY would read every row.
 *
 * Never throws. A health endpoint that cannot answer because its own
 * enrichment query failed has become the outage.
 */
export async function readWebhookDeliveries(
  sql: DeliverySql,
  timeoutMs: number = DELIVERY_QUERY_TIMEOUT_MS,
): Promise<DeliveryRead> {
  const providers = Object.keys(DELIVERY_THRESHOLDS);
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`delivery freshness query exceeded ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    const query = sql`
      select p.provider as provider,
             (select max(w.received_at)
                from webhook_inbox w
               where w.provider = p.provider) as last_delivery_at
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
 * Rows arrive as `unknown` on purpose. This runs against a database whose
 * schema this module does not own, and a driver that has previously handed
 * timestamps back as strings; coercing defensively here is cheaper than a
 * health endpoint throwing on a `Date` that turned out to be a string.
 */
function toRow(raw: unknown): DeliveryRow {
  const row = (raw ?? {}) as { provider?: unknown; last_delivery_at?: unknown };
  return {
    provider: typeof row.provider === 'string' ? row.provider : '',
    lastDeliveryAt: toDate(row.last_delivery_at),
  };
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
// 4. The verdict, and what is allowed to change the deployment's status
// ---------------------------------------------------------------------------

/**
 * What `/api/health` already knows about each provider, and this module does
 * not: whether the integration is genuinely live (earned by `probe.ts`) and
 * whether a verifier is registered (so a delivery could be accepted at all).
 *
 * Passed IN rather than recomputed. Recomputing either here would be a second
 * opinion about liveness inside the endpoint DECISIONS 021 fixed for having
 * exactly that.
 */
export interface ProviderDeliveryContext {
  readonly provider: string;
  /** The probe's verdict, not the presence of a key. */
  readonly integrationLive: boolean;
  readonly verifierRegistered: boolean;
}

export interface ProviderDeliveryHealth {
  readonly provider: string;
  readonly label: string;
  /** ISO instant of `MAX(received_at)`, or null when nothing ever arrived. */
  readonly lastDelivery: string | null;
  readonly secondsSinceLastDelivery: number | null;
  readonly staleAfterSeconds: number;
  /** Past this, silence is treated as disuse rather than as an outage. */
  readonly quietAfterSeconds: number;
  readonly verdict: DeliveryVerdict;
  /** Whether this provider is ALLOWED to degrade the deployment. */
  readonly gatesDeploymentStatus: boolean;
  /** Whether it is doing so right now. */
  readonly degradesDeployment: boolean;
  readonly note: string;
  readonly thresholdRationale: string;
}

export interface WebhookDeliveryHealth {
  /** Where the numbers come from. One column, no derived table to drift. */
  readonly source: 'webhook_inbox.received_at';
  readonly measuredAt: string;
  /** False means every verdict below is `unknown` and `error` says why. */
  readonly measured: boolean;
  readonly error: string | null;
  readonly queryLatencyMs: number | null;
  readonly alarmWindowMultiple: number;
  /** Providers currently degrading the deployment. Empty is the normal case. */
  readonly degradedBy: readonly string[];
  readonly providers: readonly ProviderDeliveryHealth[];
}

/**
 * Fold the read and what the route already knows into the published field.
 * Pure: no clock of its own, no database, no network — so every branch below is
 * reachable from a test rather than from an outage.
 */
export function webhookDeliveryHealth(
  read: DeliveryRead,
  context: readonly ProviderDeliveryContext[],
  now: Date,
): WebhookDeliveryHealth {
  const lastByProvider = new Map<string, Date | null>(
    read.ok ? read.rows.map((r) => [r.provider, r.lastDeliveryAt]) : [],
  );
  const contextByProvider = new Map(context.map((c) => [c.provider, c]));

  const providers = Object.entries(DELIVERY_THRESHOLDS).map(([provider, threshold]) =>
    reportFor(provider, threshold, lastByProvider, contextByProvider, read.ok, now),
  );

  return {
    source: 'webhook_inbox.received_at',
    measuredAt: now.toISOString(),
    measured: read.ok,
    error: read.ok ? null : read.error,
    queryLatencyMs: read.latencyMs,
    alarmWindowMultiple: ALARM_WINDOW_MULTIPLE,
    degradedBy: providers.filter((p) => p.degradesDeployment).map((p) => p.provider),
    providers,
  };
}

function reportFor(
  provider: string,
  threshold: DeliveryThreshold,
  lastByProvider: ReadonlyMap<string, Date | null>,
  contextByProvider: ReadonlyMap<string, ProviderDeliveryContext>,
  measured: boolean,
  now: Date,
): ProviderDeliveryHealth {
  const base = {
    provider,
    label: threshold.label,
    staleAfterSeconds: threshold.staleAfterSeconds,
    quietAfterSeconds: quietAfterSeconds(threshold.staleAfterSeconds),
    gatesDeploymentStatus: threshold.gatesDeploymentStatus,
    thresholdRationale: threshold.rationale,
  };

  if (!measured) {
    // Requirement of the whole endpoint: degrade to a STATED unknown. Never to
    // a fabricated verdict — a query we did not run is not evidence that a feed
    // is healthy, and it is not evidence that it is broken either.
    return {
      ...base,
      lastDelivery: null,
      secondsSinceLastDelivery: null,
      verdict: 'unknown',
      degradesDeployment: false,
      note: 'delivery freshness could not be read; this is not a verdict about the feed',
    };
  }

  const last = lastByProvider.get(provider) ?? null;
  if (last === null) {
    // `never`, NOT `stale`. See DELIVERY_VERDICTS.
    return {
      ...base,
      lastDelivery: null,
      secondsSinceLastDelivery: null,
      verdict: 'never',
      degradesDeployment: false,
      note: 'no delivery has ever been recorded from this provider — a wiring fact, not an outage',
    };
  }

  // Clock skew between the database and this function can make a delivery look
  // like it arrived in the future. Floor at zero rather than publishing a
  // negative lag that would read as a corrupted measurement.
  const lagSeconds = Math.max(0, Math.floor((now.getTime() - last.getTime()) / 1000));
  const past = lagSeconds > threshold.staleAfterSeconds;
  const verdict: DeliveryVerdict = !past
    ? 'fresh'
    : lagSeconds <= quietAfterSeconds(threshold.staleAfterSeconds)
      ? 'stale'
      : 'quiet';

  const ctx = contextByProvider.get(provider);
  const integrationLive = ctx?.integrationLive ?? false;
  const verifierRegistered = ctx?.verifierRegistered ?? false;

  // ---------------------------------------------------------------------
  // WHAT IS ALLOWED TO MAKE THE DEPLOYMENT `degraded`
  // ---------------------------------------------------------------------
  // All four, or nothing. A health endpoint that cries wolf gets ignored, and
  // an ignored health endpoint is worse than a silent one — so the bar for
  // changing the top-level status is deliberately high and every clause below
  // exists because dropping it produces a false alarm we can name.
  //
  //  1. The provider is marked as gating. Today that is Lithic alone: it is the
  //     live card rail, its events place holds against money people are
  //     spending right now, and it is the only feed whose silence has a cost
  //     measured in minutes. A quiet KYC or registry feed is a scope decision
  //     showing through, in the same way `not_configured` slots are already
  //     excluded from degrading the deployment two lines up in route.ts.
  //
  //  2. The verdict is `stale` — so `quiet` cannot degrade anything. This is
  //     the clause that answers "a provider nobody has poked in an hour is
  //     normal, not an outage".
  //
  //  3. `never` cannot degrade anything either, which falls out of (2). A
  //     deployment must not be born degraded because a feed has not been used
  //     yet; that would make the alarm permanent from the first boot and
  //     therefore meaningless.
  //
  //  4. The integration is actually live AND a verifier is registered. If the
  //     probe says the credential does not work, or we hold no signing secret,
  //     then silence is OUR configuration rather than THEIR outage — and it is
  //     already reported, once, by the slot table. Degrading on it here would
  //     be the same fact stated twice in different words, which is the shape of
  //     the bug DECISIONS 021 records.
  const degradesDeployment =
    threshold.gatesDeploymentStatus && verdict === 'stale' && integrationLive && verifierRegistered;

  return {
    ...base,
    lastDelivery: last.toISOString(),
    secondsSinceLastDelivery: lagSeconds,
    verdict,
    degradesDeployment,
    note: noteFor(verdict, threshold, degradesDeployment, integrationLive, verifierRegistered),
  };
}

function noteFor(
  verdict: DeliveryVerdict,
  threshold: DeliveryThreshold,
  degrades: boolean,
  integrationLive: boolean,
  verifierRegistered: boolean,
): string {
  switch (verdict) {
    case 'fresh':
      return `delivered within ${threshold.staleAfterSeconds}s`;
    case 'stale':
      if (degrades) {
        return `silent for longer than ${threshold.staleAfterSeconds}s after recent traffic — treated as an outage`;
      }
      if (!threshold.gatesDeploymentStatus) {
        return `silent for longer than ${threshold.staleAfterSeconds}s after recent traffic; reported, but this feed does not gate deployment status`;
      }
      if (!integrationLive) {
        return `silent for longer than ${threshold.staleAfterSeconds}s, but this integration is not live — the slot table already reports that`;
      }
      if (!verifierRegistered) {
        return `silent for longer than ${threshold.staleAfterSeconds}s, but no verifier is registered — deliveries would be refused, so the silence is ours`;
      }
      return `silent for longer than ${threshold.staleAfterSeconds}s`;
    case 'quiet':
      return `silent for longer than ${quietAfterSeconds(threshold.staleAfterSeconds)}s; indistinguishable from nobody using this integration, so not an alarm`;
    case 'never':
      return 'no delivery has ever been recorded from this provider';
    case 'unknown':
      return 'delivery freshness could not be read';
  }
}
