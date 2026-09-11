/**
 * Webhook SILENCE, ATTRIBUTED — the fifth question, and the one that makes the
 * fourth answerable.
 *
 * `probe.ts` answers "does this credential still work?" — our side of the wire.
 * `delivery-health.ts` answers "is this provider still talking to us?", as
 * `MAX(webhook_inbox.received_at)` against a per-provider cadence.
 * `processing.ts` answers "did we do anything with what arrived?".
 *
 * None of them answers the question a `stale` verdict actually implies, which
 * is **are we losing deliveries**.
 *
 * ---------------------------------------------------------------------------
 * THE MEASUREMENT THAT FORCED THIS FILE
 * ---------------------------------------------------------------------------
 * Measured against the production database at 2026-09-11T17:56Z:
 *
 *   {"provider":"lithic","staleAfterSeconds":180,"lastDelivery":
 *    "2026-09-11T17:48:27.752Z","secondsSinceLastDelivery":489,
 *    "verdict":"stale","degradesDeployment":true,
 *    "note":"silent for longer than 180s after recent traffic — treated as an
 *    outage"}
 *
 * There was no outage. The probe read `GET /v1/cards -> 200` in the same
 * response. A burst of test traffic had ended at 17:33 and nobody had swiped a
 * card since. The endpoint said "outage" because the only thing it could see
 * was a clock.
 *
 * `MAX(received_at)` cannot distinguish two different facts:
 *
 *   1. the provider stopped delivering WHILE TRANSACTIONS WERE HAPPENING —
 *      that is loss, and it must degrade the deployment;
 *   2. nobody transacted, so there was nothing to deliver — that is a quiet
 *      Thursday, and it must not.
 *
 * It measures TIME SINCE THE LAST WEBHOOK when the question is ARE WE LOSING
 * DELIVERIES. That is this repository's signature defect: a guard reporting on
 * a population chosen by something other than the capability it stands for.
 * The module's own header already names the failure — a threshold any looser
 * and "this endpoint reports degraded overnight because nobody swiped a card,
 * which trains its readers to ignore it". The threshold was made tight. The
 * question was left wrong.
 *
 * ---------------------------------------------------------------------------
 * THE DECIDING FACT, AND WHY IT IS THIS ONE
 * ---------------------------------------------------------------------------
 * `card_auth_decision WHERE source = 'provider'`.
 *
 * That table is the durable record of Auth Stream Access: Lithic calls
 * `/api/webhooks/lithic-auth` SYNCHRONOUSLY, holding a cardholder's
 * authorisation open at a terminal, and waits for our answer. A row with
 * `source = 'provider'` means a real card was presented at a real terminal at
 * `decided_at`. `source = 'harness'` means we replayed an ASA-shaped payload
 * locally; the column exists precisely so the second can never be presented as
 * the first, and this module reads only the first.
 *
 * IT IS ON A DIFFERENT CHANNEL FROM THE THING IT MEASURES. The ASA path writes
 * no journal entry, no hold, and no `webhook_inbox` row — see the header of
 * `src/app/api/webhooks/lithic-auth/route.ts`, which argues why nothing on the
 * synchronous path may touch the ledger. The money moves later, on the
 * asynchronous `card_transaction.updated` delivery into the inbox. So an ASA
 * decision is evidence of a transaction that is INDEPENDENT of whether the
 * webhook for it ever arrived, which is the only kind of evidence that can
 * settle the question.
 *
 * WHAT WAS REJECTED, AND WHY. `card_authorization.first_seen_at`,
 * `card_auth_event.received_at` and `hold.created_at` all look like records of
 * a transaction and all three are written BY THE CONSUMER OF THE WEBHOOK. None
 * of them can be newer than the delivery whose absence is in question, so
 * asking them "did a transaction happen since the last delivery?" returns
 * "no", always, by construction — the same shape of mistake one layer down.
 *
 * MEASURED, NOT ASSUMED. Every one of the 88 provider-sourced ASA decisions in
 * this database was followed by a `card_transaction.updated` delivery carrying
 * the same transaction token:
 *
 *   matched 88 of 88, lag min 0.384s, p50 0.797s, p95 1.338s, max 1.739s
 *
 * Approvals and declines alike. So an ASA decision with no delivery after it is
 * a delivery we are owed and have not been given, and 88/88 says the inference
 * holds for every outcome rather than only for approvals.
 *
 * ---------------------------------------------------------------------------
 * FAIL CLOSED, IN THREE PLACES
 * ---------------------------------------------------------------------------
 * This module's only power is to TAKE an alarm away, so every path through it
 * that is not positive proof of quiet must leave the alarm exactly where it
 * found it. `processing.ts` argues the same default one module over —
 * "unmeasured means dropping", an absent count falls back to the alarming
 * reading, and a refusal is only ever excluded when the database positively
 * counted it as one.
 *
 *   * A read that did not run is `uncounted`. It narrows nothing.
 *   * A provider with no initiation ledger in this system is `unattributable`.
 *     It narrows nothing. This is why the source table below is an explicit
 *     allow-list and not `Object.keys(DELIVERY_THRESHOLDS)`: a sixth provider
 *     that gates deployment status must keep its alarm until somebody names
 *     the table that records its traffic, rather than inheriting a silent
 *     `dormant` from a count that was zero because nothing was ever counted.
 *   * ANY initiation after the last delivery is `transacting`. Not "any
 *     overdue initiation" — any at all. A grace period would be a second
 *     number to defend, and it would be the wrong shape: the narrowing only
 *     ever runs on a feed that is ALREADY past its staleness threshold, so an
 *     in-flight delivery cannot be mistaken for a lost one without the clock
 *     having already said `stale` on its own.
 *
 * `dormant` — the one verdict that takes the alarm away — requires a counted
 * zero: the query ran, this provider has a named initiation ledger, and that
 * ledger holds nothing at all after the newest delivery.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT TOUCH
 * ---------------------------------------------------------------------------
 * `quiet` and `never` are left exactly as `delivery-health.ts` computes them.
 * They are deliberately different words — "this provider has gone quiet" and
 * "we have never heard from this provider" are different facts with different
 * fixes — and neither degrades anything today, so there is nothing here to
 * narrow. The threshold is not widened either: 180s stays 180s, because with a
 * real outage during a demo that is the right sensitivity. What changes is the
 * POPULATION the verdict is read against, not the clock.
 *
 * Its vocabulary — transacting / dormant / uncounted / unattributable — shares
 * no word with the liveness one (live / simulated / unauthorised / unreachable
 * / not_configured / unprobed / rate_limited), the delivery one (fresh / stale
 * / quiet / never / unknown), the processing one (consuming / backlogged /
 * dropping / refused / superseded / never_consumed / idle / unmeasured) or the
 * item one (healthy / needs_reauth / revoked / orphaned / absent / unread), for
 * the reason DECISIONS 021 records: `/api/health` must hold one opinion per
 * question, and five disjoint vocabularies is how a reader can tell which
 * question each word is answering.
 */

import {
  DELIVERY_THRESHOLDS,
  quietAfterSeconds,
  type DeliverySql,
  type ProviderDeliveryHealth,
  type WebhookDeliveryHealth,
} from '@/lib/integrations/delivery-health';

// ---------------------------------------------------------------------------
// 1. The vocabulary
// ---------------------------------------------------------------------------

/**
 * Four verdicts, and only one of them is allowed to quieten anything.
 *
 *   transacting     At least one transaction was initiated against this
 *                   provider AFTER its newest delivery. Something was owed and
 *                   has not arrived. Silence here is loss, and the deployment
 *                   stays degraded.
 *
 *   dormant         A counted zero: nothing has been initiated since the newest
 *                   delivery. There is nothing for the provider to have sent,
 *                   so its silence is the expected state and not an outage.
 *                   THE ONLY VERDICT THAT REMOVES AN ALARM.
 *
 *   uncounted       The initiation query did not run. Stated, never guessed,
 *                   and it narrows nothing — an unmeasured silence is still an
 *                   outage until something proves otherwise.
 *
 *   unattributable  This system records no initiation ledger for this provider,
 *                   so its silence cannot be attributed either way. Narrows
 *                   nothing, for the same reason.
 */
export type InitiationVerdict = 'transacting' | 'dormant' | 'uncounted' | 'unattributable';

/** Exported so a test can prove it is disjoint from the other four. */
export const INITIATION_VERDICTS: readonly InitiationVerdict[] = [
  'transacting',
  'dormant',
  'uncounted',
  'unattributable',
];

// ---------------------------------------------------------------------------
// 2. Which providers this system can attribute silence for
// ---------------------------------------------------------------------------

/**
 * The initiation ledger for each provider, named in the response so the claim
 * can be challenged rather than taken on trust.
 *
 * AN EXPLICIT ALLOW-LIST, NOT A DERIVATION. Every provider missing from here is
 * `unattributable` and keeps whatever alarm `delivery-health.ts` gave it. That
 * is the difference between "we counted, and it was zero" and "we counted
 * nothing, and zero fell out", which is exactly the inversion that made the
 * first draft of the dead-letter narrowing wrong one module over.
 *
 * Lithic is the only entry, and it is also the only provider whose
 * `gatesDeploymentStatus` is true, so this table covers every silence that can
 * currently degrade the deployment. The other four rails have no synchronous
 * channel: an ACH transfer, a Plaid item refresh and a KYC inquiry are all
 * first heard of through the webhook itself, so nothing outside the inbox
 * records that they were initiated.
 */
export const INITIATION_SOURCES: Readonly<Record<string, string>> = {
  lithic: "card_auth_decision (source = 'provider')",
};

// ---------------------------------------------------------------------------
// 3. Reading the data — ONE round trip, and no clock of its own in the fold
// ---------------------------------------------------------------------------

export interface InitiationRow {
  readonly provider: string;
  /**
   * `MAX(webhook_inbox.received_at)` as this query saw it. Published, not
   * judged: `delivery-health.ts` owns the freshness verdict and this module
   * must not become a second opinion about it. It is here so a reader can see
   * the exact instant the counts below were taken against.
   */
  readonly lastDeliveryAt: Date | null;
  /**
   * Transactions initiated against this provider strictly AFTER
   * `lastDeliveryAt`. The number the whole module turns on. Non-zero means a
   * delivery is owed.
   */
  readonly initiatedSinceDeliveryCount: number;
  /** The oldest of those — the one that has been owed the longest. */
  readonly oldestInitiatedSinceDeliveryAt: Date | null;
  /** The newest initiation of any age, so "when did traffic last happen" is answerable. */
  readonly newestInitiatedAt: Date | null;
  /** Initiations inside the read horizon, for context in the note. */
  readonly initiatedInHorizonCount: number;
}

export type InitiationRead =
  | { readonly ok: true; readonly rows: readonly InitiationRow[]; readonly latencyMs: number }
  | { readonly ok: false; readonly error: string; readonly latencyMs: number | null };

/** Budget for the initiation query, matching the other two enrichment reads. */
export const INITIATION_QUERY_TIMEOUT_MS = 2_500;

/** A read that never happened, for the paths where there is nothing to query. */
export function initiationUnavailable(error: string): InitiationRead {
  return { ok: false, error, latencyMs: null };
}

/**
 * How far back the counts look.
 *
 * The bound exists so the count cannot grow without limit as the decision log
 * does, and it is SAFE rather than merely convenient, which is worth the proof:
 * the narrowing below only ever runs on a provider whose verdict is `stale`,
 * and `stale` means the last delivery is no older than `quietAfterSeconds`
 * (past that the verdict is `quiet`, which degrades nothing and is never
 * narrowed). So every initiation that could be "after the last delivery" on a
 * degrading provider is inside this horizon by construction. Doubled anyway,
 * because a bound that is exactly tight is a bound that clips the first time
 * somebody changes a threshold.
 */
export function initiationHorizonSeconds(): number {
  const windows = Object.keys(INITIATION_SOURCES).map((provider) =>
    quietAfterSeconds(DELIVERY_THRESHOLDS[provider]?.staleAfterSeconds ?? 0),
  );
  return 2 * Math.max(0, ...windows);
}

/**
 * One round trip for every attributable provider, in the shape the other two
 * enrichment reads use: scalar subqueries over a fixed list rather than a
 * `GROUP BY` that reads the whole table.
 *
 * Never throws. A health endpoint that cannot answer because its own
 * enrichment query failed has become the outage.
 */
export async function readTransactionInitiation(
  sql: DeliverySql,
  timeoutMs: number = INITIATION_QUERY_TIMEOUT_MS,
): Promise<InitiationRead> {
  const providers = Object.keys(INITIATION_SOURCES);
  const horizonSeconds = initiationHorizonSeconds();
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`transaction initiation query exceeded ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    // `source = 'provider'` throughout: a harness replay is not a cardholder,
    // and letting one stand in for the other here would let a local test run
    // hold an outage alarm open — or, worse, a missing harness run take one
    // away. The column exists to keep those apart; see migration 0014.
    const query = sql`
      select p.provider as provider,
             (select max(w.received_at) from webhook_inbox w
               where w.provider = p.provider) as last_delivery_at,
             (select count(*) from card_auth_decision d
               where d.provider = p.provider and d.source = 'provider'
                 and d.decided_at >= now() - (${horizonSeconds} * interval '1 second')
                 and d.decided_at > coalesce(
                       (select max(w.received_at) from webhook_inbox w
                         where w.provider = p.provider),
                       '-infinity'::timestamptz)) as initiated_since_delivery,
             (select min(d.decided_at) from card_auth_decision d
               where d.provider = p.provider and d.source = 'provider'
                 and d.decided_at >= now() - (${horizonSeconds} * interval '1 second')
                 and d.decided_at > coalesce(
                       (select max(w.received_at) from webhook_inbox w
                         where w.provider = p.provider),
                       '-infinity'::timestamptz)) as oldest_initiated_since_delivery,
             (select max(d.decided_at) from card_auth_decision d
               where d.provider = p.provider and d.source = 'provider') as newest_initiated_at,
             (select count(*) from card_auth_decision d
               where d.provider = p.provider and d.source = 'provider'
                 and d.decided_at >= now() - (${horizonSeconds} * interval '1 second')) as initiated_in_horizon
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
 * Rows arrive as `unknown` on purpose, for the reason the other two readers
 * give: this module does not own the schema it queries, the driver hands
 * `count(*)` back as a string, and a health endpoint throwing on its own
 * enrichment is worse than one coercing defensively.
 */
function toRow(raw: unknown): InitiationRow {
  const row = (raw ?? {}) as Record<string, unknown>;
  return {
    provider: typeof row['provider'] === 'string' ? row['provider'] : '',
    lastDeliveryAt: toDate(row['last_delivery_at']),
    initiatedSinceDeliveryCount: toCount(row['initiated_since_delivery']),
    oldestInitiatedSinceDeliveryAt: toDate(row['oldest_initiated_since_delivery']),
    newestInitiatedAt: toDate(row['newest_initiated_at']),
    initiatedInHorizonCount: toCount(row['initiated_in_horizon']),
  };
}

/**
 * A count this module could not read is NOT zero.
 *
 * Zero is the one value that takes an alarm away, so it may only ever come
 * from the database having actually counted. An unreadable count returns null
 * and the fold treats it as `uncounted`. Coalescing to 0 here would turn
 * "absent evidence of traffic" into "proven quiet", which is the exact
 * inversion `processing.ts` records as the first draft of its own narrowing.
 */
function toCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
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
// 4. The verdict, and the narrowing it is allowed to perform
// ---------------------------------------------------------------------------

export interface ProviderInitiationHealth {
  readonly provider: string;
  readonly label: string;
  /** The table this verdict was read from, or null when there is none. */
  readonly source: string | null;
  readonly verdict: InitiationVerdict;
  /** Transactions initiated after the newest delivery. Null when not counted. */
  readonly initiatedSinceLastDelivery: number | null;
  /** How long the oldest of those has been owed a delivery. */
  readonly oldestUnansweredAgeSeconds: number | null;
  readonly newestInitiated: string | null;
  readonly secondsSinceNewestInitiated: number | null;
  /**
   * Whether this verdict actually removed a `degraded` from the delivery field.
   * Published so a reader never has to infer a narrowing from two other fields.
   */
  readonly narrowedDeliveryAlarm: boolean;
  readonly note: string;
}

export interface TransactionInitiationHealth {
  /** Where the numbers come from, named so nobody has to guess. */
  readonly source: "card_auth_decision.decided_at (source = 'provider')";
  readonly measuredAt: string;
  readonly measured: boolean;
  readonly error: string | null;
  readonly queryLatencyMs: number | null;
  readonly horizonSeconds: number;
  /** Providers whose delivery alarm this field took away. Usually empty. */
  readonly narrowed: readonly string[];
  readonly providers: readonly ProviderInitiationHealth[];
}

/**
 * The narrowed delivery field and the evidence behind it, together.
 *
 * Returned as one value on purpose. If the route computed the attribution and
 * applied it in two steps, the published `webhookHealth.degradesDeployment` and
 * the published reason for it could drift apart, and `/api/health` would once
 * again hold two opinions about one question — the bug DECISIONS 021 records.
 */
export interface AttributedDeliveryHealth {
  readonly delivery: WebhookDeliveryHealth;
  readonly initiation: TransactionInitiationHealth;
}

function ageSeconds(now: Date, then: Date | null): number | null {
  if (then === null) return null;
  // Floor at zero: clock skew between the function and the database must not
  // publish a negative age, which reads as a corrupted measurement.
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
}

/**
 * Fold the initiation read together with the delivery verdicts, and return both
 * the (possibly narrowed) delivery field and the evidence.
 *
 * Pure: no clock of its own, no database, no network — so every branch below is
 * reachable from a test rather than only from an outage.
 */
export function attributeDeliverySilence(
  delivery: WebhookDeliveryHealth,
  read: InitiationRead,
  now: Date,
): AttributedDeliveryHealth {
  const byProvider = new Map<string, InitiationRow>(
    read.ok ? read.rows.map((r) => [r.provider, r]) : [],
  );

  const narrowed: string[] = [];
  const reports: ProviderInitiationHealth[] = [];
  const providers = delivery.providers.map((p) => {
    const report = reportFor(p, byProvider.get(p.provider), read.ok, now);
    // ONLY EVER SUBTRACTS. A provider this field says nothing useful about
    // keeps the verdict, the flag and the sentence `delivery-health.ts` gave
    // it, byte for byte. There is no path here that can make something degrade
    // that was not already degrading.
    if (report.verdict !== 'dormant' || !p.degradesDeployment) {
      reports.push(report);
      return p;
    }
    narrowed.push(p.provider);
    reports.push({ ...report, narrowedDeliveryAlarm: true });
    return {
      ...p,
      degradesDeployment: false,
      // The verdict itself is UNTOUCHED. `stale` is a true statement about
      // `MAX(received_at)` and it stays on the record; what changes is whether
      // that silence is read as an outage. `delivery-health.ts` already
      // publishes four other stale-but-not-degrading sentences for exactly
      // this shape — not gating, not live, no verifier — and this is the
      // fifth.
      note:
        `silent for longer than ${p.staleAfterSeconds}s, and NOTHING WAS INITIATED in that silence: ` +
        `${INITIATION_SOURCES[p.provider] ?? 'the initiation ledger'} holds no transaction after the newest delivery, ` +
        `so there is nothing this provider owed us and did not send. ` +
        `Silence with no traffic behind it is disuse, not an outage — see transactionInitiation`,
    };
  });

  return {
    delivery: {
      ...delivery,
      degradedBy: providers.filter((p) => p.degradesDeployment).map((p) => p.provider),
      providers,
    },
    initiation: {
      source: "card_auth_decision.decided_at (source = 'provider')",
      measuredAt: now.toISOString(),
      measured: read.ok,
      error: read.ok ? null : read.error,
      queryLatencyMs: read.latencyMs,
      horizonSeconds: initiationHorizonSeconds(),
      narrowed,
      providers: reports,
    },
  };
}

function reportFor(
  p: ProviderDeliveryHealth,
  row: InitiationRow | undefined,
  measured: boolean,
  now: Date,
): ProviderInitiationHealth {
  const source = INITIATION_SOURCES[p.provider] ?? null;
  const base = { provider: p.provider, label: p.label, source, narrowedDeliveryAlarm: false };

  if (source === null) {
    return {
      ...base,
      verdict: 'unattributable',
      initiatedSinceLastDelivery: null,
      oldestUnansweredAgeSeconds: null,
      newestInitiated: null,
      secondsSinceNewestInitiated: null,
      note:
        'this system records no channel on which a transaction against this provider is initiated ' +
        'independently of the webhook itself, so its silence cannot be attributed — ' +
        'whatever the delivery field decided about it stands unchanged',
    };
  }

  // Unmeasured means the alarm stays. See the header: this module's only power
  // is to take an alarm away, and it may not use it on a guess.
  if (!measured || row === undefined || !Number.isFinite(row.initiatedSinceDeliveryCount)) {
    return {
      ...base,
      verdict: 'uncounted',
      initiatedSinceLastDelivery: null,
      oldestUnansweredAgeSeconds: null,
      newestInitiated: null,
      secondsSinceNewestInitiated: null,
      note:
        'transaction initiation could not be read, so this deployment cannot tell a provider outage ' +
        'from a quiet card rail; the silence keeps whatever the delivery field made of it, which is the alarming reading',
    };
  }

  const newestAge = ageSeconds(now, row.newestInitiatedAt);
  const oldestUnansweredAge = ageSeconds(now, row.oldestInitiatedSinceDeliveryAt);
  const measuredBase = {
    ...base,
    initiatedSinceLastDelivery: row.initiatedSinceDeliveryCount,
    oldestUnansweredAgeSeconds: oldestUnansweredAge,
    newestInitiated: row.newestInitiatedAt?.toISOString() ?? null,
    secondsSinceNewestInitiated: newestAge,
  };

  if (row.initiatedSinceDeliveryCount > 0) {
    return {
      ...measuredBase,
      verdict: 'transacting',
      note:
        `${row.initiatedSinceDeliveryCount} transaction(s) were initiated after the newest delivery from this provider` +
        `${oldestUnansweredAge === null ? '' : `, the oldest ${oldestUnansweredAge}s ago`} — ` +
        'a delivery was owed for each and none arrived. This silence is loss, not disuse',
    };
  }

  return {
    ...measuredBase,
    verdict: 'dormant',
    note:
      `no transaction has been initiated since the newest delivery from this provider` +
      `${newestAge === null ? ' (none has ever been initiated)' : `; the last one was ${newestAge}s ago, before that delivery`}` +
      `. ${row.initiatedInHorizonCount} initiation(s) in the last ${initiationHorizonSeconds()}s. ` +
      'There is nothing outstanding for this provider to have sent',
  };
}
