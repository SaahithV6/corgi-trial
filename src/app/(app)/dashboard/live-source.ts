import "server-only";

import { listQueue } from "@/lib/approvals/instructions";
import { loadCompleteness } from "@/lib/audit/store";
import { readInvariants, readParkedByKind } from "@/lib/chaos/observe";
import { ledgerConnection, readSnapshot, type Sql } from "@/lib/ledger/queries";
import { AGE_BUCKET_ORDER } from "@/lib/recon/aging";
import { loadReconView } from "@/lib/recon/screen";
import { SEVERITIES } from "@/lib/recon/types";
import { fail, ok } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import {
  readWebhookProcessing,
  webhookProcessingHealth,
  type WebhookProcessingHealth,
} from "@/app/api/health/processing";

import type {
  DeadLetterGroup,
  InvariantCard,
  MachineAction,
  OutboundState,
  ParkedGroup,
  Refusal,
  ScheduledJob,
  SweepWriter,
  Triage,
  TriageDataSource,
  UnattributedCredit,
  Witness,
  WitnessGroup,
} from "@/components/dashboard/data-contract";
import { headline, rank, tally } from "@/components/dashboard/decided";

/**
 * The triage screen's live read.
 *
 * ============================================================================
 * This is the ONLY file behind `/dashboard` that knows a database exists.
 * Everything under `src/components/dashboard/**` renders the contract and
 * could not open a connection if it wanted to.
 * ============================================================================
 *
 * FOUR RULES IT IS BUILT TO
 *
 * 1. **Compose, do not re-derive.** Almost nothing here is a new question.
 *    `readInvariants()` is the chaos dashboard's read and the gate's list.
 *    `listQueue()` is the approvals queue and defines "pending" as the ABSENCE
 *    of a closing event, in SQL, once. `loadReconView()` is the breaks screen.
 *    `readWebhookProcessing()` + `webhookProcessingHealth()` is the published
 *    `webhookProcessing` field of `/api/health`, verbatim. `loadCompleteness()`
 *    is the audit trail reconciling itself against its own stores. A triage
 *    screen that computed its own answer to any of these would eventually
 *    disagree with the screen it links to, and "the dashboard said 4 breaks
 *    and reconciliation says 2" is a support ticket nobody can close.
 *
 * 2. **The SQL that is left is evidence, not arithmetic.** Every statement
 *    below is a `SELECT` against a VIEW the schema already defines — the ones
 *    with no named reader yet — and its job is to fetch the rows behind a
 *    number so the number can be drilled through. None of them computes a
 *    balance, a severity or an age; where a policy exists it is imported
 *    (`recon/aging.ts`) rather than restated. Nothing here touches
 *    `journal_entry`, `journal_line` or `account`; `src/lib/ledger/boundary.test.ts`
 *    is the ratchet that would catch it if it did.
 *
 * 3. **A throw becomes a value.** Every path returns a `Result` carrying the
 *    driver's own code, so the page renders the failure instead of a 500 —
 *    and a failed read is never rendered as an all-clear.
 *
 * 4. **Nothing here writes.** The application role holds SELECT and INSERT and
 *    nothing else on the money tables, and this issues only SELECTs, so a
 *    failure on this path cannot have moved anything. In particular it never
 *    calls a cron route: those routes SWEEP, and a dashboard that ran the
 *    machinery it reports on would be manufacturing the evidence it prints.
 */

/* -------------------------------------------------------------------------- */
/* Failure, as a value                                                        */
/* -------------------------------------------------------------------------- */

function driverCode(thrown: unknown): string | null {
  if (typeof thrown !== "object" || thrown === null) return null;
  const code: unknown = (thrown as { code?: unknown }).code;
  if (typeof code !== "string" || code.length === 0) return null;
  return code.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function messageOf(thrown: unknown): string {
  const raw = thrown instanceof Error ? thrown.message : String(thrown ?? "unknown error");
  const firstLine = raw.split("\n")[0] ?? raw;
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

/** `TRIAGE_42P01`, `TRIAGE_ECONNREFUSED` — the vocabulary every other panel uses. */
function readFailure(operation: string, thrown: unknown): Result<never, ErrorShape> {
  return fail(`TRIAGE_${driverCode(thrown) ?? "READ_FAILED"}`, `${operation} could not be read: ${messageOf(thrown)}`, {
    retryable: true,
    source: "dashboard.triage",
    operation,
  });
}

function iso(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

function cents(value: string | number | bigint | null): bigint | null {
  if (value === null) return null;
  return typeof value === "bigint" ? value : BigInt(value);
}

/* -------------------------------------------------------------------------- */
/* 1. The reds, with the rows behind them                                     */
/* -------------------------------------------------------------------------- */

/**
 * WHY THE DRILL-THROUGH IS FOUR BESPOKE QUERIES AND NOT ONE GENERIC ONE.
 *
 * The four views on the register do not share a shape. `v_refused_auth_hold`
 * classifies by `verdict` and names a hold; `v_advice_delta_unsound`
 * classifies by `finding` and names an EVENT, with no hold anywhere on the
 * row; `v_hold_closure_unexplained` classifies by the writer the closure
 * declares. Selecting `*` and guessing which column is the identifier would be
 * the screen inventing a taxonomy for rows it did not write.
 *
 * So each one is read on its own terms, with its own classifying column, which
 * is the same breakdown `dbcheck`'s `explain()` prints and for the same
 * reason: a count is enough to fail on and never enough to act on.
 *
 * A view NOT on this list gets no drill-through, and the screen says exactly
 * that rather than linking somewhere the row is not. That is the honest state
 * for a red nobody has seen before — which is precisely when it happens.
 */
const WITNESS_LIMIT = 5;

type RawWitness = {
  readonly group: string | null;
  readonly provider_auth_id: string | null;
  readonly hold_id: string | null;
  readonly cents_a: string | null;
  readonly cents_b: string | null;
  readonly detail: string | null;
};

type RawGroup = {
  readonly group: string | null;
  readonly n: number;
  readonly holds: number | null;
  readonly cents: string | null;
};

type WitnessSpec = {
  /** Labels for the two money columns the witness query selects, in order. */
  readonly figures: readonly [string, string];
  readonly centsLabel: string;
  readonly rows: (conn: Sql) => Promise<readonly RawWitness[]>;
  readonly groups: (conn: Sql) => Promise<readonly RawGroup[]>;
};

const WITNESSES: Readonly<Record<string, WitnessSpec>> = {
  v_refused_auth_hold: {
    figures: ["withheld now", "refused"],
    centsLabel: "active_hold_cents",
    rows: (conn) => conn<RawWitness[]>`
      SELECT verdict            AS group,
             provider_auth_id,
             hold_id::text      AS hold_id,
             active_hold_cents::text AS cents_a,
             refused_cents::text     AS cents_b,
             result_source      AS detail
        FROM v_refused_auth_hold
       ORDER BY active_hold_cents DESC, provider_auth_id
       LIMIT ${WITNESS_LIMIT}`,
    groups: (conn) => conn<RawGroup[]>`
      SELECT verdict AS group,
             count(*)::int              AS n,
             count(DISTINCT hold_id)::int AS holds,
             COALESCE(SUM(active_hold_cents), 0)::text AS cents
        FROM v_refused_auth_hold
       GROUP BY verdict ORDER BY 2 DESC`,
  },
  v_hold_expiry_drift: {
    figures: ["withheld now", ""],
    centsLabel: "active_hold_cents",
    rows: (conn) => conn<RawWitness[]>`
      SELECT CASE WHEN is_released THEN 'released' ELSE 'open' END AS group,
             provider_auth_id,
             hold_id::text           AS hold_id,
             active_hold_cents::text AS cents_a,
             NULL::text              AS cents_b,
             'the two clocks differ by ' || gap::text AS detail
        FROM v_hold_expiry_drift
       ORDER BY active_hold_cents DESC, provider_auth_id
       LIMIT ${WITNESS_LIMIT}`,
    groups: (conn) => conn<RawGroup[]>`
      SELECT CASE WHEN is_released THEN 'released' ELSE 'open' END AS group,
             count(*)::int              AS n,
             count(DISTINCT hold_id)::int AS holds,
             COALESCE(SUM(active_hold_cents), 0)::text AS cents
        FROM v_hold_expiry_drift
       GROUP BY 1 ORDER BY 2 DESC`,
  },
  v_advice_delta_unsound: {
    figures: ["derived delta", "base it converted against"],
    centsLabel: "signed_delta_cents",
    rows: (conn) => conn<RawWitness[]>`
      SELECT finding          AS group,
             provider_auth_id,
             NULL::text       AS hold_id,
             signed_delta_cents::text AS cents_a,
             base_cents::text         AS cents_b,
             provider_step || ' · event ' || provider_event_id AS detail
        FROM v_advice_delta_unsound
       ORDER BY ABS(signed_delta_cents) DESC, provider_auth_id
       LIMIT ${WITNESS_LIMIT}`,
    groups: (conn) => conn<RawGroup[]>`
      SELECT finding AS group,
             count(*)::int AS n,
             NULL::int     AS holds,
             COALESCE(SUM(signed_delta_cents), 0)::text AS cents
        FROM v_advice_delta_unsound
       GROUP BY finding ORDER BY 2 DESC`,
  },
  v_hold_closure_unexplained: {
    figures: ["the fold says is authorised", "captured"],
    centsLabel: "target_hold_cents",
    rows: (conn) => conn<RawWitness[]>`
      SELECT closure_source  AS group,
             provider_auth_id,
             hold_id::text   AS hold_id,
             target_hold_cents::text AS cents_a,
             captured_cents::text    AS cents_b,
             closure_reason  AS detail
        FROM v_hold_closure_unexplained
       ORDER BY target_hold_cents DESC, provider_auth_id
       LIMIT ${WITNESS_LIMIT}`,
    groups: (conn) => conn<RawGroup[]>`
      SELECT closure_source AS group,
             count(*)::int              AS n,
             count(DISTINCT hold_id)::int AS holds,
             COALESCE(SUM(target_hold_cents), 0)::text AS cents
        FROM v_hold_closure_unexplained
       GROUP BY closure_source ORDER BY 2 DESC`,
  },
};

const NO_WITNESS_UNWIRED =
  "No drill-through is wired for this view. It was not red when this screen was written, so nothing here knows which of its columns identifies a row — and guessing would be the screen inventing a taxonomy for rows it did not produce. Read it directly: SELECT * FROM ";

const NO_WITNESS_UNREADABLE =
  "The view could not be read at all, so there are no rows to show. An unreadable guard is not a satisfied one.";

async function buildCards(conn: Sql): Promise<readonly InvariantCard[]> {
  const readings = await readInvariants(conn);
  const ranked = rank(readings);

  const cards: InvariantCard[] = [];
  for (const classified of ranked) {
    if (classified.error !== null) {
      cards.push({ classified, witnesses: [], groups: [], noWitnessReason: NO_WITNESS_UNREADABLE });
      continue;
    }
    if (classified.rows === 0) {
      cards.push({ classified, witnesses: [], groups: [], noWitnessReason: null });
      continue;
    }

    const spec = WITNESSES[classified.view];
    if (spec === undefined) {
      cards.push({
        classified,
        witnesses: [],
        groups: [],
        noWitnessReason: `${NO_WITNESS_UNWIRED}${classified.view};`,
      });
      continue;
    }

    const [rawRows, rawGroups] = await Promise.all([spec.rows(conn), spec.groups(conn)]);

    const witnesses: Witness[] = rawRows.map((row) => {
      const figures: { label: string; cents: bigint }[] = [];
      const a = cents(row.cents_a);
      const b = cents(row.cents_b);
      if (a !== null && spec.figures[0] !== "") figures.push({ label: spec.figures[0], cents: a });
      if (b !== null && spec.figures[1] !== "") figures.push({ label: spec.figures[1], cents: b });
      return {
        group: row.group,
        providerAuthId: row.provider_auth_id,
        holdId: row.hold_id,
        figures,
        detail: row.detail,
      };
    });

    const groups: WitnessGroup[] = rawGroups.map((g) => ({
      group: g.group ?? "(undeclared)",
      rows: g.n,
      holds: g.holds,
      cents: cents(g.cents),
      centsLabel: spec.centsLabel,
    }));

    cards.push({ classified, witnesses, groups, noWitnessReason: null });
  }

  return cards;
}

/* -------------------------------------------------------------------------- */
/* 2. What is waiting on a human                                              */
/* -------------------------------------------------------------------------- */

/** `listQueue` caps itself at 200. Reading the page and reporting whether it
 *  was full is honest in both directions: below the cap the count is exact. */
const QUEUE_PAGE = 200;

type DisputeCountRow = { readonly needing: number; readonly open: number; readonly closed: number };

async function readDisputes(conn: Sql): Promise<DisputeCountRow> {
  // `v_dispute_state` is the schema's own answer to what a dispute's position
  // is. Every predicate below is one of its own boolean columns; none of them
  // is this screen deciding what "needs a decision" means.
  const rows = await conn<DisputeCountRow[]>`
    SELECT count(*) FILTER (WHERE needs_authorization
                              AND NOT granted AND NOT declined
                              AND NOT is_closed)::int AS needing,
           count(*) FILTER (WHERE NOT is_closed)::int  AS open,
           count(*) FILTER (WHERE is_closed)::int      AS closed
      FROM v_dispute_state`;
  return rows[0] ?? { needing: 0, open: 0, closed: 0 };
}

async function readDeadLetters(conn: Sql): Promise<readonly DeadLetterGroup[]> {
  const rows = await conn<
    {
      provider: string;
      parked_on_kind: string | null;
      n: number;
      oldest: Date | null;
      newest: Date | null;
      age: number | null;
      reason: string | null;
    }[]
  >`
    SELECT provider,
           parked_on_kind,
           count(*)::int      AS n,
           min(dead_lettered_at) AS oldest,
           max(dead_lettered_at) AS newest,
           max(age_days)::int    AS age,
           -- The NEWEST dead letter's own words. Ordered inside the aggregate
           -- so the sentence belongs to the row the timestamps describe.
           (array_agg(processing_error ORDER BY dead_lettered_at DESC NULLS LAST))[1] AS reason
      FROM v_webhook_dead_letter
     GROUP BY provider, parked_on_kind
     ORDER BY count(*) DESC
     LIMIT 12`;

  return rows.map((r) => ({
    provider: r.provider,
    kind: r.parked_on_kind,
    count: r.n,
    oldestAt: iso(r.oldest),
    newestAt: iso(r.newest),
    reason: r.reason,
    oldestAgeDays: r.age,
  }));
}

async function readUnattributed(conn: Sql): Promise<readonly UnattributedCredit[]> {
  const rows = await conn<
    {
      inbound_transfer_id: string;
      first_seen_at: Date;
      age_days: number;
      deliveries: number;
      still_parked: number;
      dead_lettered: number;
      attributed: boolean;
      last_reason: string | null;
    }[]
  >`
    SELECT inbound_transfer_id, first_seen_at, age_days, deliveries,
           still_parked, dead_lettered, attributed, last_reason
      FROM v_inbound_ach_unattributed
     ORDER BY first_seen_at DESC
     LIMIT 10`;

  return rows.map((r) => ({
    transferId: r.inbound_transfer_id,
    firstSeenAt: r.first_seen_at.toISOString(),
    ageDays: r.age_days,
    deliveries: r.deliveries,
    stillParked: r.still_parked,
    deadLettered: r.dead_lettered,
    attributed: r.attributed,
    reason: r.last_reason,
  }));
}

/* -------------------------------------------------------------------------- */
/* 3. What the machine did                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The five jobs in `vercel.json`, and the store each one writes into.
 *
 * The paths and cron expressions are copied from `vercel.json` verbatim. The
 * `tracedBy` store is what a tick that DID something leaves behind, and it is
 * the only evidence this screen has — see `TRACE_LIMIT` on the section header
 * for the three things that fact cannot tell you.
 */
type JobSpec = {
  readonly path: string;
  readonly schedule: string;
  readonly what: string;
  readonly tracedBy: string;
  readonly traceNote: string;
};

const JOBS: readonly JobSpec[] = [
  {
    path: "/api/drain",
    schedule: "17 4 * * *",
    what: "Drains the webhook inbox: dispatches verified deliveries to their consumers, re-checks parked ones, dead-letters the ones that ran out of retries.",
    tracedBy: "webhook_inbox.processed_at",
    traceNote: "the newest delivery that reached `done`",
  },
  {
    path: "/api/cron/standing",
    schedule: "23 5 * * *",
    what: "Ticks the standing-order schedule. Never moves money itself — each occurrence raises an instruction into the approvals queue.",
    tracedBy: "standing_order_outcome.decided_at",
    traceNote: "the newest occurrence it decided, raised or refused",
  },
  {
    path: "/api/cron/accrual",
    schedule: "41 6 * * *",
    what: "Prices a day of fee accrual and a day of interest, and posts both to the ledger.",
    tracedBy: "accrual_posting.decided_at + interest_posting.decided_at",
    traceNote: "the newest priced day, fee or interest",
  },
  {
    path: "/api/cron/outbound",
    schedule: "53 7 * * *",
    what: "Generates outbound events from new ledger entries and delivers them to registered endpoints, with retries and dead-lettering.",
    tracedBy: "outbound_delivery.last_attempt_at",
    traceNote: "the newest delivery attempt",
  },
  {
    path: "/api/cron/holds",
    schedule: "23 14 * * *",
    what: "Three hold sweeps: completes incomplete postings, releases expired card holds, and releases uncleared credits that have matured.",
    tracedBy: "hold_closure.closed_at, source in (expiry_sweep, availability_sweep)",
    traceNote: "the newest closure either sweep declared",
  },
];

type TraceRow = {
  readonly drain_at: Date | null;
  readonly drain_n: number;
  readonly standing_at: Date | null;
  readonly standing_n: number;
  readonly accrual_at: Date | null;
  readonly accrual_n: number;
  readonly outbound_at: Date | null;
  readonly outbound_n: number;
  readonly holds_at: Date | null;
  readonly holds_n: number;
};

async function readTraces(conn: Sql): Promise<TraceRow> {
  const rows = await conn<TraceRow[]>`
    SELECT (SELECT max(processed_at) FROM webhook_inbox WHERE state = 'done')   AS drain_at,
           (SELECT count(*) FROM webhook_inbox WHERE state = 'done')::int       AS drain_n,
           (SELECT max(decided_at) FROM standing_order_outcome)                 AS standing_at,
           (SELECT count(*) FROM standing_order_outcome)::int                   AS standing_n,
           (SELECT GREATEST(
                     (SELECT max(decided_at) FROM accrual_posting),
                     (SELECT max(decided_at) FROM interest_posting)))           AS accrual_at,
           (SELECT (SELECT count(*) FROM accrual_posting)
                 + (SELECT count(*) FROM interest_posting))::int                AS accrual_n,
           (SELECT max(last_attempt_at) FROM outbound_delivery)                 AS outbound_at,
           (SELECT count(*) FROM outbound_delivery)::int                        AS outbound_n,
           (SELECT max(closed_at) FROM hold_closure
             WHERE source IN ('expiry_sweep', 'availability_sweep'))            AS holds_at,
           (SELECT count(*) FROM hold_closure
             WHERE source IN ('expiry_sweep', 'availability_sweep'))::int       AS holds_n`;

  const row = rows[0];
  if (row === undefined) {
    // Unreachable against Postgres — a SELECT with no FROM returns one row —
    // but a driver returning nothing must not become "no job has ever run" on
    // a screen whose job is to say what the machine did.
    throw new Error("the scheduled-job trace query returned no row");
  }
  return row;
}

function jobsFrom(trace: TraceRow): readonly ScheduledJob[] {
  const pairs: readonly (readonly [Date | null, number])[] = [
    [trace.drain_at, trace.drain_n],
    [trace.standing_at, trace.standing_n],
    [trace.accrual_at, trace.accrual_n],
    [trace.outbound_at, trace.outbound_n],
    [trace.holds_at, trace.holds_n],
  ];
  return JOBS.map((job, i) => {
    const pair = pairs[i] ?? [null, 0];
    return {
      path: job.path,
      schedule: job.schedule,
      what: job.what,
      tracedBy: job.tracedBy,
      traceNote: job.traceNote,
      lastTraceAt: iso(pair[0]),
      traceCount: pair[1],
    };
  });
}

async function readMachineActions(conn: Sql): Promise<readonly MachineAction[]> {
  // `v_actor_action` IS the audit trail — one projection over every action
  // store the trail covers. Filtering to non-human actors is the whole query:
  // "what happened while nobody was here" is a fact about the actor, and the
  // trail already classifies that.
  //
  // Ordered by `recorded_at` — when this book LEARNED — and not by
  // `occurred_at`, which for a ledger entry is its value date and can be in
  // the future. Two clocks, and this section is about the second one.
  const rows = await conn<
    { source: string; surface: string; actor_kind: string; n: number; newest: Date | null }[]
  >`
    SELECT source, surface, actor_kind,
           count(*)::int     AS n,
           max(recorded_at)  AS newest
      FROM v_actor_action
     WHERE actor_kind <> 'human'
     GROUP BY source, surface, actor_kind
     ORDER BY max(recorded_at) DESC NULLS LAST
     LIMIT 14`;

  return rows.map((r) => ({
    source: r.source,
    surface: r.surface,
    actorKind: r.actor_kind,
    count: r.n,
    newestAt: iso(r.newest),
  }));
}

async function readRefusals(conn: Sql): Promise<readonly Refusal[]> {
  // What the standing-order tick REFUSED, with the availability terms it
  // observed at the moment it refused. `standing_order_outcome` records all
  // five, which is what makes a decline re-derivable rather than believed.
  //
  // `decided_by_run` is grouped on its prefix because that is the one thing
  // that says WHO ran it: `standing-<requestId>` is the cron route, `test-…`
  // is a harness. A refusal on this book that was never decided by a cron tick
  // is a fact worth being able to read off the screen.
  const rows = await conn<
    {
      refusal_code: string | null;
      refusal_reason: string | null;
      run_prefix: string;
      n: number;
      newest: Date | null;
      available: string | null;
      shortfall: string | null;
    }[]
  >`
    SELECT refusal_code,
           refusal_reason,
           split_part(decided_by_run, '-', 1) AS run_prefix,
           count(*)::int                      AS n,
           max(decided_at)                    AS newest,
           max(observed_available_cents)::text AS available,
           max(shortfall_cents)::text          AS shortfall
      FROM standing_order_outcome
     WHERE disposition = 'refused'
     GROUP BY refusal_code, refusal_reason, split_part(decided_by_run, '-', 1)
     ORDER BY max(decided_at) DESC NULLS LAST
     LIMIT 8`;

  return rows.map((r) => ({
    code: r.refusal_code ?? "(none recorded)",
    reason: r.refusal_reason ?? "",
    count: r.n,
    newestAt: iso(r.newest),
    observedAvailableCents: cents(r.available),
    shortfallCents: cents(r.shortfall),
    runPrefix: r.run_prefix,
  }));
}

async function readSweeps(conn: Sql): Promise<readonly SweepWriter[]> {
  // Every hold closure, grouped by the writer it DECLARES. This is the same
  // partition `dbcheck`'s GUARD REACH block prints for
  // `v_hold_closure_not_terminal`, and it is the only way to read "which of
  // these was the machine and which was a person or a repair" off one table.
  const rows = await conn<
    { source: string | null; n: number; oldest: Date | null; newest: Date | null }[]
  >`
    SELECT source, count(*)::int AS n, min(closed_at) AS oldest, max(closed_at) AS newest
      FROM hold_closure
     GROUP BY source
     ORDER BY count(*) DESC`;

  return rows.map((r) => ({
    source: r.source,
    count: r.n,
    oldestAt: iso(r.oldest),
    newestAt: iso(r.newest),
  }));
}

async function readOutbound(conn: Sql): Promise<readonly OutboundState[]> {
  const rows = await conn<
    { state: string; n: number; newest: Date | null; last_status: number | null }[]
  >`
    SELECT state::text AS state,
           count(*)::int AS n,
           max(last_attempt_at) AS newest,
           max(last_status)::int AS last_status
      FROM outbound_delivery
     GROUP BY state
     ORDER BY count(*) DESC`;

  return rows.map((r) => ({
    state: r.state,
    count: r.n,
    newestAt: iso(r.newest),
    lastStatus: r.last_status,
  }));
}

/**
 * The published `webhookProcessing` field, computed exactly as `/api/health`
 * computes it.
 *
 * `readWebhookProcessing` is typed against `DeliverySql`, which is
 * `ReturnType<typeof postgres>` — the driver with no custom type handlers. The
 * ledger's handle is the same driver with a bigint parser registered, so the
 * two differ in a type parameter and in nothing the function uses: it issues
 * one tagged template and reads the row. The cast is here, once, named, rather
 * than opening a SECOND pool on a page that already holds one.
 */
async function readProcessing(conn: Sql, now: Date): Promise<WebhookProcessingHealth> {
  const read = await readWebhookProcessing(conn as unknown as Parameters<typeof readWebhookProcessing>[0]);
  return webhookProcessingHealth(read, now);
}

/* -------------------------------------------------------------------------- */
/* The source                                                                 */
/* -------------------------------------------------------------------------- */

export function hasDatabase(): boolean {
  const url = process.env["APP_DATABASE_URL"];
  return typeof url === "string" && url.length > 0;
}

export type LiveTriageOptions = { readonly conn?: Sql };

export function createLiveTriageSource(options: LiveTriageOptions = {}): TriageDataSource {
  return {
    async read(): Promise<Result<Triage, ErrorShape>> {
      try {
        const conn = options.conn ?? (await ledgerConnection());
        const snapshot = await readSnapshot(conn);

        const [
          cards,
          queue,
          disputes,
          parkedByKind,
          deadLetters,
          unattributed,
          recon,
          bookWideBreaks,
          trace,
          actions,
          refusals,
          sweeps,
          outbound,
          processing,
          completeness,
        ] = await Promise.all([
          buildCards(conn),
          listQueue({ pendingOnly: true, limit: QUEUE_PAGE }, conn),
          readDisputes(conn),
          readParkedByKind(conn),
          readDeadLetters(conn),
          readUnattributed(conn),
          loadReconView({}),
          conn<{ n: number }[]>`SELECT count(*)::int AS n FROM v_recon_break`,
          readTraces(conn),
          readMachineActions(conn),
          readRefusals(conn),
          readSweeps(conn),
          readOutbound(conn),
          readProcessing(conn, snapshot.asOf),
          loadCompleteness(),
        ]);

        // A failed queue read is a failed panel, not a queue of zero. The whole
        // claim of section 2 is "this is what is waiting on you", and a silent
        // zero there is the worst thing this screen could print.
        if (!queue.ok) return queue;

        const pending = queue.value;
        const above = pending.filter((p) => p.aboveThreshold);
        const oldest = pending.length === 0 ? null : pending[pending.length - 1];

        const parked: readonly ParkedGroup[] = parkedByKind.map((p) => ({
          kind: p.kind,
          ref: p.ref,
          count: p.count,
          reason: p.reason,
        }));

        // Recon: the module's own view, the module's own aging. A failed recon
        // read degrades ONE panel rather than the page — the breaks screen is
        // one click away and says so itself.
        const reconOk = recon.ok ? recon.value : null;
        const breaks = reconOk?.breaks ?? [];
        const bySeverity = SEVERITIES.map((severity) => ({
          severity,
          count: breaks.filter((b) => b.severity === severity).length,
        })).filter((row) => row.count > 0);
        const byAge = AGE_BUCKET_ORDER.map((bucket) => ({
          bucket,
          count: breaks.filter((b) => b.ageBucket === bucket).length,
        })).filter((row) => row.count > 0);

        const classified = cards.map((c) => c.classified);
        const counted = tally(classified);

        return ok({
          readAt: snapshot.asOf.toISOString(),
          bookingWatermark: snapshot.bookingWatermark.toString(),
          live: true,
          invariants: {
            cards,
            tally: counted,
            headline: headline(counted),
            readAt: snapshot.asOf.toISOString(),
          },
          human: {
            approvals: {
              pending: pending.length,
              aboveThreshold: above.length,
              capped: pending.length >= QUEUE_PAGE,
              oldestAt: oldest?.instruction.requestedAt ?? null,
              totalCents: pending.reduce((sum, p) => sum + p.instruction.amountCents, 0n),
              aboveThresholdCents: above.reduce((sum, p) => sum + p.instruction.amountCents, 0n),
            },
            disputes: {
              needingDecision: disputes.needing,
              open: disputes.open,
              closed: disputes.closed,
            },
            parked,
            parkedTotal: parked.reduce((sum, p) => sum + p.count, 0),
            deadLetters,
            deadLetterTotal: deadLetters.reduce((sum, d) => sum + d.count, 0),
            unattributed,
            breaks: {
              run: reconOk?.run ?? null,
              breaks: breaks.slice(0, 8),
              bySeverity,
              byAge,
              bookWide: bookWideBreaks[0]?.n ?? 0,
            },
          },
          machine: {
            jobs: jobsFrom(trace),
            actions,
            refusals,
            sweeps,
            outbound,
            processing: {
              measured: processing.measured,
              error: processing.error,
              measuredAt: processing.measuredAt,
              providers: processing.providers.map((p) => ({
                provider: p.provider,
                label: p.label,
                verdict: p.verdict,
                note: p.note,
                lastConsumed: p.lastConsumed,
                lastDelivery: p.lastDelivery,
                parked: { count: p.parked.count },
                deadLettered: {
                  count: p.deadLettered.count,
                  sinceLastConsumed: p.deadLettered.sinceLastConsumed,
                  supersededByConsumption: p.deadLettered.supersededByConsumption,
                  reason: p.deadLettered.reason,
                  clearedBy: p.deadLettered.clearedBy,
                },
                degradesDeployment: p.degradesDeployment,
              })),
              degradedBy: processing.degradedBy,
            },
            completeness,
          },
        } satisfies Triage);
      } catch (thrown) {
        return readFailure("the triage board", thrown);
      }
    },
  };
}
