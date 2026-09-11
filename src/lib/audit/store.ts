/**
 * Every query the actor trail issues, in one file.
 *
 * ============================================================================
 * THIS MODULE ONLY READS, AND THAT IS THE DESIGN, NOT A LIMITATION.
 *
 * The trail is a projection over stores that already exist
 * (`db/migrations/0035_audit.sql` §5). It owns no rows of its own, which is
 * the strongest available form of "append-only": there is nothing here to
 * edit. Every row it returns comes out of a table `corgi_app` holds no UPDATE
 * and no DELETE on, and `loadCompleteness()` re-derives that from
 * `information_schema.role_table_grants` and `pg_trigger` on every render
 * rather than asserting it in a comment.
 *
 * The argument for reading rather than writing is in the migration header and
 * in `docs/AUDIT.md`. The short version: a write path is invisible exactly
 * where a surface forgets to call it, and there is no catalog of call sites to
 * check that against — but there IS a catalog of tables, so a projection's one
 * failure mode is detectable and a write path's is not.
 * ============================================================================
 *
 * NO SECRETS LEAVE HERE. The projection never selects `provider_card_token`,
 * a full account number, a raw webhook body or an API key; card identity is
 * `last_four` and beneficiary identity is `account_number_last4` plus the ABA
 * routing number, which the Fed publishes. That is enforced in the view, not
 * here, so a second reader of `v_actor_action` inherits it.
 */

import "server-only";

import { sql as defaultSql, type Queryable } from "@/lib/ledger/db";

import {
  ACTOR_KINDS,
  type ActorAction,
  type ActorKind,
  type Completeness,
  type SourceCoverage,
  type SourceExclusion,
} from "./types";

/** The page size. A business with 2,154 actions is normal on this book. */
export const PAGE_SIZE = 100;

export type TimelineQuery = {
  readonly businessId: string;
  /** Restrict to one kind of actor. The edge state is `agent`. */
  readonly kind?: ActorKind | null;
  /** Restrict to one product surface (`payments`, `cards`, `kyb`, …). */
  readonly surface?: string | null;
  /** Restrict to one source table. Used by the completeness drill-through. */
  readonly source?: string | null;
  /** Include book-wide actions (day close, recon runs, rate cards). */
  readonly includeBookWide?: boolean;
  readonly page?: number;
  /** Which clock to order by. Defaults to the book's own. */
  readonly order?: "recorded" | "occurred";
};

type ActionRow = {
  readonly source: string;
  readonly action_id: string;
  readonly business_id: string | null;
  readonly occurred_at: Date;
  readonly recorded_at: Date;
  readonly value_date: Date | null;
  readonly actor_kind: string;
  readonly actor_id: string | null;
  readonly actor_label: string;
  readonly surface: string | null;
  readonly action: string;
  readonly summary: string | null;
  readonly amount_cents: bigint | null;
  readonly subject_kind: string | null;
  readonly subject_id: string | null;
  readonly entry_id: string | null;
  readonly detail: Record<string, unknown> | null;
  readonly time_axes_differ: boolean;
};

/**
 * A kind the database returned that this build does not know about.
 *
 * Mapped to `unattributed` rather than dropped or crashed: an action whose
 * actor this code cannot classify is still an action, and silently removing it
 * from the timeline is the one behaviour a trail may never have. It also keeps
 * `matched` honest — the count and the rows come from the same rowset.
 */
function toActorKind(raw: string): ActorKind {
  return (ACTOR_KINDS as readonly string[]).includes(raw) ? (raw as ActorKind) : "unattributed";
}

function toAction(row: ActionRow): ActorAction {
  return {
    source: row.source,
    actionId: row.action_id,
    businessId: row.business_id,
    occurredAt: row.occurred_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
    valueDate: row.value_date ? isoDate(row.value_date) : null,
    actorKind: toActorKind(row.actor_kind),
    actorId: row.actor_id,
    actorLabel: row.actor_label,
    surface: row.surface ?? "other",
    action: row.action,
    summary: row.summary ?? row.action,
    amountCents: row.amount_cents === null ? null : BigInt(row.amount_cents),
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    entryId: row.entry_id,
    detail: row.detail,
    timeAxesDiffer: row.time_axes_differ,
  };
}

/** `date` columns come back as a Date at UTC midnight; keep the calendar day. */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function listBusinessesWithActions(
  sql: Queryable = defaultSql,
): Promise<readonly { readonly id: string; readonly legalName: string; readonly actions: number }[]> {
  const rows = await sql<{ id: string; legal_name: string; n: bigint }[]>`
    SELECT b.id, b.legal_name, count(t.action_id) AS n
      FROM business b
      LEFT JOIN v_actor_action t ON t.business_id = b.id
     GROUP BY b.id, b.legal_name
     ORDER BY count(t.action_id) DESC, b.legal_name`;
  return rows.map((r) => ({ id: r.id, legalName: r.legal_name, actions: Number(r.n) }));
}

export async function findBusiness(
  businessId: string,
  sql: Queryable = defaultSql,
): Promise<{ readonly id: string; readonly legalName: string } | null> {
  const rows = await sql<{ id: string; legal_name: string }[]>`
    SELECT id, legal_name FROM business WHERE id = ${businessId}`;
  const row = rows[0];
  return row ? { id: row.id, legalName: row.legal_name } : null;
}

/**
 * The timeline itself.
 *
 * ORDERED BY AN AXIS THE CALLER NAMES, never by a blend of the two.
 *
 * `recorded` walks the book's own clock — the most recently LEARNED fact
 * first, which is what an incident review does. `occurred` walks the world's
 * clock, which is what "what happened on Tuesday" means. The view also carries
 * a `sort_at = GREATEST(occurred_at, recorded_at)` column and this query
 * deliberately does NOT use it: on this book 1,026 of one business's actions
 * have two clocks that disagree, and a single blended order answers the two
 * questions at once by answering neither — it puts a live-fire entry
 * value-dated 2027-12-07 above everything that actually happened today.
 * Keeping two columns is only worth anything if the screen will commit to one
 * of them at a time and say which.
 *
 * The tie-break is `action_id`, so a page boundary is stable when a hundred
 * rows share a timestamp.
 */
export async function listActions(
  query: TimelineQuery,
  sql: Queryable = defaultSql,
): Promise<readonly ActorAction[]> {
  const page = Math.max(0, query.page ?? 0);
  const rows = await sql<ActionRow[]>`
    SELECT source, action_id, business_id, occurred_at, recorded_at, value_date,
           actor_kind, actor_id, actor_label, surface, action, summary,
           amount_cents, subject_kind, subject_id, entry_id, detail, time_axes_differ
      FROM v_business_timeline
     WHERE ${scope(query, sql)}
     ORDER BY ${
       query.order === "occurred"
         ? sql`occurred_at DESC, recorded_at DESC`
         : sql`recorded_at DESC, occurred_at DESC`
     }, action_id
     LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`;
  return rows.map(toAction);
}

export async function countActions(
  query: TimelineQuery,
  sql: Queryable = defaultSql,
): Promise<number> {
  const rows = await sql<{ n: bigint }[]>`
    SELECT count(*) AS n FROM v_business_timeline WHERE ${scope(query, sql)}`;
  return Number(rows[0]?.n ?? 0n);
}

/**
 * The filter, built once and shared by the page query and the count query.
 *
 * They MUST be the same predicate. `/breaks` prints "showing 7 of 7, the
 * engine reported 7, this screen hides none", and a count computed from a
 * different WHERE clause than the rows is how that line starts lying.
 */
function scope(query: TimelineQuery, sql: Queryable) {
  const business = query.includeBookWide
    ? sql`(business_id = ${query.businessId} OR business_id IS NULL)`
    : sql`business_id = ${query.businessId}`;
  return sql`${business}
    ${query.kind ? sql`AND actor_kind = ${query.kind}` : sql``}
    ${query.surface ? sql`AND surface = ${query.surface}` : sql``}
    ${query.source ? sql`AND source = ${query.source}` : sql``}`;
}

/** Unfiltered per-kind counts, for the facet bar and the "of N" line. */
export async function countByKind(
  businessId: string,
  includeBookWide: boolean,
  sql: Queryable = defaultSql,
): Promise<Record<ActorKind, number>> {
  const rows = await sql<{ actor_kind: string; n: bigint }[]>`
    SELECT actor_kind, count(*) AS n
      FROM v_business_timeline
     WHERE ${
       includeBookWide
         ? sql`(business_id = ${businessId} OR business_id IS NULL)`
         : sql`business_id = ${businessId}`
     }
     GROUP BY actor_kind`;
  const out = Object.fromEntries(ACTOR_KINDS.map((k) => [k, 0])) as Record<ActorKind, number>;
  for (const r of rows) out[toActorKind(r.actor_kind)] += Number(r.n);
  return out;
}

/** Counts per source for one business — the drill-through on the panel. */
export async function countBySource(
  businessId: string,
  includeBookWide: boolean,
  sql: Queryable = defaultSql,
): Promise<Readonly<Record<string, number>>> {
  const rows = await sql<{ source: string; n: bigint }[]>`
    SELECT source, count(*) AS n
      FROM v_business_timeline
     WHERE ${
       includeBookWide
         ? sql`(business_id = ${businessId} OR business_id IS NULL)`
         : sql`business_id = ${businessId}`
     }
     GROUP BY source`;
  return Object.fromEntries(rows.map((r) => [r.source, Number(r.n)]));
}

/**
 * The completeness report.
 *
 * Five queries, four of which are invariants rather than data:
 *
 *   v_audit_coverage           stored rows vs projected rows, per source
 *   v_audit_source_unclaimed   base tables nobody has classified  (must be 0)
 *   v_audit_source_mutable     projected sources the app can UPDATE (must be 0)
 *   v_audit_source_weak        projected sources with no UPDATE/DELETE trigger
 *   v_audit_source             the exclusions, with the argument for each
 *
 * None of it is cached. A completeness figure computed at build time is a
 * completeness figure that was true once.
 */
export async function loadCompleteness(sql: Queryable = defaultSql): Promise<Completeness> {
  const [coverage, exclusions, unclaimed, mutable, weak] = await Promise.all([
    sql<
      {
        source: string;
        disposition: string;
        surface: string | null;
        stored_rows: bigint;
        projected_rows: bigint;
        attributed_rows: bigint;
        dropped_rows: bigint;
        first_at: Date | null;
        last_at: Date | null;
        reason: string;
      }[]
    >`SELECT source, disposition, surface, stored_rows, projected_rows, attributed_rows,
             dropped_rows, first_at, last_at, reason
        FROM v_audit_coverage ORDER BY source`,
    sql<{ table_name: string; surface: string | null; reason: string }[]>`
      SELECT table_name, surface, reason FROM v_audit_source
       WHERE disposition = 'excluded' ORDER BY table_name`,
    sql<{ table_name: string }[]>`SELECT table_name FROM v_audit_source_unclaimed ORDER BY table_name`,
    sql<{ table_name: string; privileges: string }[]>`
      SELECT table_name, privileges FROM v_audit_source_mutable ORDER BY table_name`,
    sql<{ table_name: string; surface: string | null }[]>`
      SELECT table_name, surface FROM v_audit_source_weak ORDER BY table_name`,
  ]);

  const sources: SourceCoverage[] = coverage.map((r) => ({
    source: r.source,
    disposition: r.disposition === "awaiting_wiring" ? "awaiting_wiring" : "projected",
    surface: r.surface,
    storedRows: BigInt(r.stored_rows),
    projectedRows: BigInt(r.projected_rows),
    attributedRows: BigInt(r.attributed_rows),
    droppedRows: BigInt(r.dropped_rows),
    firstAt: r.first_at ? r.first_at.toISOString() : null,
    lastAt: r.last_at ? r.last_at.toISOString() : null,
    reason: r.reason,
  }));

  const excl: SourceExclusion[] = exclusions.map((r) => ({
    source: r.table_name,
    surface: r.surface,
    reason: r.reason,
    isHole: r.reason.startsWith("HOLE."),
  }));

  return {
    sources,
    exclusions: excl,
    unclaimed: unclaimed.map((r) => r.table_name),
    mutable: mutable.map((r) => ({ source: r.table_name, privileges: r.privileges })),
    weak: weak.map((r) => ({ source: r.table_name, surface: r.surface })),
  };
}

/** Whether a database is configured at all. Must be a renderable state. */
export function hasDatabase(): boolean {
  const url = process.env["APP_DATABASE_URL"];
  return typeof url === "string" && url.trim() !== "";
}
