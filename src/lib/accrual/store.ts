import "server-only";

/**
 * Every SQL statement the accrual feature issues, in one file.
 *
 * The rule the rest of `src/lib/accrual` depends on: **no date arithmetic
 * happens in TypeScript.** Which dates a schedule still owes is a question
 * answered by `accrual_due_dates()` in migration 0020 §12, and what day it is
 * is answered by the database. DECISIONS 024 is the argument — two definitions
 * of the same rule, held equal by an invariant, cannot be fixed one at a time.
 *
 * The one thing this module does NOT do is write a journal line. Postings go
 * through `postEntry()` and nothing else; what is written here is the claim and
 * the audit of the decision, which are not money rows and are append-only
 * anyway (0020 §14).
 */

import { sql, type Sql } from "@/lib/ledger/db";

import {
  CATCH_UP_WINDOW_DAYS,
  allocateDay,
  type AccrualDisposition,
  type AccrualInvariants,
  type AccrualMonth,
  type AccrualPosting,
  type AccrualProduct,
  type AccrualSchedule,
  type DailyAllocation,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Row shapes                                                                 */
/* -------------------------------------------------------------------------- */

type ScheduleRow = {
  readonly id: string;
  readonly account_id: string;
  readonly account_name: string;
  readonly business_id: string | null;
  readonly business_name: string | null;
  readonly product: AccrualProduct;
  readonly plan_name: string;
  readonly monthly_cents: bigint;
  readonly currency: string;
  readonly start_date: string;
  readonly end_date: string | null;
  readonly schedule_key: string;
  readonly created_at: Date;
  readonly next_due_date: string | null;
};

type PostingRow = {
  readonly accrual_day_id: string;
  readonly schedule_id: string;
  readonly plan_name: string;
  readonly account_id: string;
  readonly business_name: string | null;
  readonly accrual_date: string;
  readonly idempotency_key: string;
  readonly claimed_at: Date;
  readonly claimed_by: string;
  readonly disposition: AccrualDisposition | null;
  readonly entry_id: string | null;
  readonly skip_reason: string | null;
  readonly monthly_cents: bigint | null;
  readonly days_in_month: number | null;
  readonly day_of_month: number | null;
  readonly decided_at: Date | null;
  readonly decided_by_run: string | null;
};

function toSchedule(row: ScheduleRow): AccrualSchedule {
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name,
    businessId: row.business_id,
    businessName: row.business_name,
    product: row.product,
    planName: row.plan_name,
    monthlyCents: row.monthly_cents,
    currency: row.currency,
    startDate: row.start_date,
    endDate: row.end_date,
    scheduleKey: row.schedule_key,
    createdAt: row.created_at.toISOString(),
    nextDueDate: row.next_due_date,
  };
}

/**
 * The stored working, turned back into a `DailyAllocation`.
 *
 * Only the three INPUTS are read back — price, days, day — and the derived
 * fields are recomputed by `allocateDay()`. That is not laziness about the
 * other columns: it means the screen cannot render a base share or a residual
 * that disagrees with the rule, because it renders the rule's own output. The
 * stored columns are still checked, by `accrual_posting_arithmetic`, which is
 * what makes reading only three of them safe.
 */
function toAllocation(row: PostingRow): DailyAllocation | null {
  if (row.monthly_cents === null || row.days_in_month === null || row.day_of_month === null) {
    return null;
  }
  return allocateDay({
    monthlyCents: row.monthly_cents,
    daysInMonth: row.days_in_month,
    dayOfMonth: row.day_of_month,
  });
}

function toPosting(row: PostingRow): AccrualPosting {
  return {
    accrualDayId: row.accrual_day_id,
    scheduleId: row.schedule_id,
    planName: row.plan_name,
    accountId: row.account_id,
    businessName: row.business_name,
    accrualDate: row.accrual_date,
    idempotencyKey: row.idempotency_key,
    claimedAt: row.claimed_at.toISOString(),
    claimedBy: row.claimed_by,
    disposition: row.disposition,
    entryId: row.entry_id,
    skipReason: row.skip_reason,
    allocation: toAllocation(row),
    decidedAt: row.decided_at === null ? null : row.decided_at.toISOString(),
    decidedByRun: row.decided_by_run,
  };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Today, in book time, asked of the database rather than of the process.
 *
 * Identical to `standing/store.ts` and for its reason: a server running in UTC
 * rolls over five hours early every night, which on the 1st of a month would
 * accrue a day into a month the customer's price does not cover.
 */
export async function bookToday(conn: Sql = sql): Promise<string> {
  const rows = await conn<{ book_date: string }[]>`
    SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS book_date`;
  const row = rows[0];
  if (row === undefined) throw new Error("accrual: the database did not answer what day it is");
  return row.book_date;
}

export async function listSchedules(limit = 50, conn: Sql = sql): Promise<AccrualSchedule[]> {
  const rows = await conn<ScheduleRow[]>`
    SELECT s.id,
           s.account_id,
           a.name          AS account_name,
           a.business_id,
           b.legal_name    AS business_name,
           s.product::text AS product,
           s.plan_name,
           s.monthly_cents,
           s.currency,
           s.start_date::text AS start_date,
           s.end_date::text   AS end_date,
           s.schedule_key,
           s.created_at,
           (SELECT min(d)::text
              FROM accrual_due_dates(
                     s.id, s.start_date,
                     LEAST(COALESCE(s.end_date, (now() AT TIME ZONE 'America/New_York')::date),
                           (now() AT TIME ZONE 'America/New_York')::date)) AS d
           ) AS next_due_date
      FROM accrual_schedule s
      JOIN account  a ON a.id = s.account_id
      LEFT JOIN business b ON b.id = a.business_id
     ORDER BY b.legal_name NULLS LAST, s.plan_name
     LIMIT ${limit}`;
  return rows.map(toSchedule);
}

/** Every claimed day and its decision, newest accrual date first. */
export async function listPostings(limit = 200, conn: Sql = sql): Promise<AccrualPosting[]> {
  const rows = await conn<PostingRow[]>`
    SELECT ad.id            AS accrual_day_id,
           ad.schedule_id,
           s.plan_name,
           s.account_id,
           b.legal_name     AS business_name,
           ad.accrual_date::text AS accrual_date,
           ad.idempotency_key,
           ad.claimed_at,
           ad.claimed_by,
           ap.disposition::text  AS disposition,
           ap.entry_id,
           ap.skip_reason,
           ap.monthly_cents,
           ap.days_in_month,
           ap.day_of_month,
           ap.decided_at,
           ap.decided_by_run
      FROM accrual_day ad
      JOIN accrual_schedule s ON s.id = ad.schedule_id
      JOIN account  a ON a.id = s.account_id
      LEFT JOIN business b ON b.id = a.business_id
      LEFT JOIN accrual_posting ap ON ap.accrual_day_id = ad.id
     ORDER BY ad.accrual_date DESC, b.legal_name NULLS LAST, s.plan_name
     LIMIT ${limit}`;
  return rows.map(toPosting);
}

/** The month roll-ups, newest month first. `v_accrual_month` in 0020 §13. */
export async function listMonths(limit = 60, conn: Sql = sql): Promise<AccrualMonth[]> {
  const rows = await conn<
    {
      schedule_id: string;
      account_id: string;
      business_name: string | null;
      plan_name: string;
      month_start: string;
      days_in_month: number;
      monthly_cents: bigint;
      residual_pennies_in_month: number;
      days_claimed: bigint;
      days_decided: bigint;
      days_posted: bigint;
      days_skipped: bigint;
      residual_pennies_applied: bigint;
      accrued_cents: bigint;
      remaining_cents: bigint;
      month_complete: boolean;
    }[]
  >`
    SELECT m.schedule_id, m.account_id, b.legal_name AS business_name, m.plan_name,
           m.month_start::text AS month_start, m.days_in_month, m.monthly_cents,
           m.residual_pennies_in_month, m.days_claimed, m.days_decided,
           m.days_posted, m.days_skipped, m.residual_pennies_applied,
           m.accrued_cents::bigint AS accrued_cents,
           m.remaining_cents::bigint AS remaining_cents,
           m.month_complete
      FROM v_accrual_month m
      LEFT JOIN business b ON b.id = m.business_id
     ORDER BY m.month_start DESC, b.legal_name NULLS LAST, m.plan_name
     LIMIT ${limit}`;

  return rows.map((r) => ({
    scheduleId: r.schedule_id,
    accountId: r.account_id,
    businessName: r.business_name,
    planName: r.plan_name,
    monthStart: r.month_start,
    daysInMonth: r.days_in_month,
    monthlyCents: r.monthly_cents,
    residualPenniesInMonth: r.residual_pennies_in_month,
    daysClaimed: Number(r.days_claimed),
    daysDecided: Number(r.days_decided),
    daysPosted: Number(r.days_posted),
    daysSkipped: Number(r.days_skipped),
    residualPenniesApplied: Number(r.residual_pennies_applied),
    accruedCents: r.accrued_cents,
    remainingCents: r.remaining_cents,
    monthComplete: r.month_complete,
  }));
}

/**
 * The four invariant counters, in one round trip.
 *
 * Two of them must be zero forever (`monthDrift`, `ledgerDrift`) and the screen
 * says so on its face. A non-zero `monthDrift` would mean the rounding rule is
 * broken; a non-zero `ledgerDrift` would mean a posting and its journal entry
 * disagree, which the lifecycle trigger refuses at insert.
 */
export async function readInvariants(conn: Sql = sql): Promise<AccrualInvariants> {
  const [row] = await conn<
    { month_drift: bigint; ledger_drift: bigint; unresolved: bigint; gap: bigint }[]
  >`
    SELECT (SELECT count(*) FROM v_accrual_month_drift)  AS month_drift,
           (SELECT count(*) FROM v_accrual_ledger_drift) AS ledger_drift,
           (SELECT count(*) FROM v_accrual_unresolved)   AS unresolved,
           -- DELIBERATELY NOT a count over v_accrual_gap.
           --
           -- That view bounds itself with CURRENT_DATE, which is resolved
           -- against the SESSION TimeZone -- UTC on Neon. The book day is
           -- America/New_York, so between 19:00 and midnight Eastern the view
           -- is already on tomorrow and reports every schedule as owing a day
           -- that has not happened yet. Measured: at 22:07 ET it returned 3
           -- against a book that was fully caught up.
           --
           -- Nothing is mis-posted by this — the tick takes its date from
           -- bookToday() and refuses to run ahead of the book (accrue.ts) --
           -- but an indicator that cries wolf every evening is an indicator
           -- nobody reads by the second week. So the count is asked here with
           -- the book date, which is the same question the view meant to ask.
           -- The view itself needs a one-line fix in a later migration; 0020
           -- is applied and a migration is immutable once applied.
           (SELECT count(*)
              FROM accrual_schedule s
              CROSS JOIN LATERAL accrual_due_dates(
                s.id,
                s.start_date,
                LEAST(COALESCE(s.end_date, (now() AT TIME ZONE 'America/New_York')::date),
                      (now() AT TIME ZONE 'America/New_York')::date)
              ) AS d
           ) AS gap`;
  if (row === undefined) throw new Error("accrual: the invariant query returned no row");
  return {
    monthDrift: Number(row.month_drift),
    ledgerDrift: Number(row.ledger_drift),
    unresolved: Number(row.unresolved),
    gap: Number(row.gap),
  };
}

/* -------------------------------------------------------------------------- */
/* What is owed                                                               */
/* -------------------------------------------------------------------------- */

export type DueDay = {
  readonly scheduleId: string;
  readonly accountId: string;
  readonly planName: string;
  readonly monthlyCents: bigint;
  readonly currency: string;
  readonly entityId: string;
  readonly accrualDate: string;
};

/**
 * Every (schedule, date) pair owed and not yet claimed, oldest first.
 *
 * The date set comes from `accrual_due_dates()`; nothing here computes a range.
 * Oldest first is deliberate: a catch-up run should close the oldest gap before
 * today's, so that a tick which hits the limit leaves the NEWEST days undone —
 * those are the ones the next tick will certainly see, because today is always
 * in the window and a month-old date is about to fall out of it.
 */
export async function listDue(
  bookDate: string,
  limit: number,
  conn: Sql = sql,
): Promise<DueDay[]> {
  const rows = await conn<
    {
      schedule_id: string;
      account_id: string;
      plan_name: string;
      monthly_cents: bigint;
      currency: string;
      entity_id: string;
      accrual_date: string;
    }[]
  >`
    SELECT s.id       AS schedule_id,
           s.account_id,
           s.plan_name,
           s.monthly_cents,
           s.currency,
           a.entity_id,
           d::text    AS accrual_date
      FROM accrual_schedule s
      JOIN account a ON a.id = s.account_id
      CROSS JOIN LATERAL accrual_due_dates(
        s.id,
        GREATEST(s.start_date, ${bookDate}::date - ${CATCH_UP_WINDOW_DAYS}::int),
        LEAST(COALESCE(s.end_date, ${bookDate}::date), ${bookDate}::date)
      ) AS d
     ORDER BY d ASC, s.id
     LIMIT ${limit}`;

  return rows.map((r) => ({
    scheduleId: r.schedule_id,
    accountId: r.account_id,
    planName: r.plan_name,
    monthlyCents: r.monthly_cents,
    currency: r.currency,
    entityId: r.entity_id,
    accrualDate: r.accrual_date,
  }));
}

/* -------------------------------------------------------------------------- */
/* The claim                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The row lock, through the SECURITY DEFINER function 0020 §11 defines.
 *
 * `corgi_app` holds no UPDATE on `accrual_schedule`, so it cannot write
 * `FOR UPDATE` itself — 0008's and 0012's construction, unchanged.
 */
export async function lockSchedule(scheduleId: string, conn: Sql): Promise<boolean> {
  const rows = await conn<{ locked: boolean }[]>`
    SELECT lock_accrual_schedule(${scheduleId}::uuid) AS locked`;
  return rows[0]?.locked === true;
}

export type Claim = {
  readonly accrualDayId: string;
  readonly idempotencyKey: string;
  /** False when the row already existed — a concurrent run, or an earlier one. */
  readonly claimedNow: boolean;
};

/**
 * Claim one (schedule, date): at most once, decided by Postgres.
 *
 * `ON CONFLICT DO NOTHING` with a row count, never SELECT-then-INSERT — the
 * latter has a race between its two statements and this has none. The
 * idempotency key is deliberately NOT an argument: it is a GENERATED column, so
 * there is no string here for a caller to get wrong.
 */
export async function claimDay(
  args: {
    readonly scheduleId: string;
    readonly accrualDate: string;
    readonly runId: string;
  },
  conn: Sql,
): Promise<Claim> {
  const inserted = await conn<{ id: string; idempotency_key: string }[]>`
    INSERT INTO accrual_day (schedule_id, accrual_date, claimed_by)
    VALUES (${args.scheduleId}::uuid, ${args.accrualDate}::date, ${args.runId})
    ON CONFLICT (schedule_id, accrual_date) DO NOTHING
    RETURNING id, idempotency_key`;

  const row = inserted[0];
  if (row !== undefined) {
    return { accrualDayId: row.id, idempotencyKey: row.idempotency_key, claimedNow: true };
  }

  const [existing] = await conn<{ id: string; idempotency_key: string }[]>`
    SELECT id, idempotency_key FROM accrual_day
     WHERE schedule_id = ${args.scheduleId}::uuid
       AND accrual_date = ${args.accrualDate}::date`;
  if (existing === undefined) {
    throw new Error(
      `schedule ${args.scheduleId} on ${args.accrualDate}: the claim conflicted but no row exists`,
    );
  }
  return { accrualDayId: existing.id, idempotencyKey: existing.idempotency_key, claimedNow: false };
}

/* -------------------------------------------------------------------------- */
/* The decision                                                               */
/* -------------------------------------------------------------------------- */

export async function postingFor(
  accrualDayId: string,
  conn: Sql,
): Promise<{ disposition: AccrualDisposition; entryId: string | null } | null> {
  const [row] = await conn<{ disposition: AccrualDisposition; entry_id: string | null }[]>`
    SELECT disposition::text AS disposition, entry_id
      FROM accrual_posting WHERE accrual_day_id = ${accrualDayId}::uuid`;
  return row === undefined
    ? null
    : { disposition: row.disposition, entryId: row.entry_id };
}

/**
 * The journal entry this claim's derived key already names, if any.
 *
 * Asked on every recovery, BEFORE anything is posted. If a previous run posted
 * the entry and died before writing the outcome row, the money has already
 * moved; the only thing left to do is record that it did. Posting again would
 * be harmless — `postEntry()` would return the same entry id, because the key
 * is UNIQUE — but reading first makes the report honest about which run did it.
 */
export async function entryForKey(idempotencyKey: string, conn: Sql): Promise<string | null> {
  const [row] = await conn<{ id: string }[]>`
    SELECT id FROM journal_entry WHERE idempotency_key = ${idempotencyKey}`;
  return row?.id ?? null;
}

export type RecordInput = {
  readonly accrualDayId: string;
  readonly runId: string;
  readonly allocation: DailyAllocation;
} & (
  | { readonly disposition: "posted"; readonly entryId: string }
  | { readonly disposition: "skipped"; readonly skipReason: string }
);

/**
 * Write the outcome.
 *
 * Every operand of the allocation is sent, as a decimal string for the bigints
 * — `bigint` does not survive JSON and `Number()` on a cent count is how a cent
 * goes missing. `accrual_posting_arithmetic` re-derives all seven relations and
 * `assert_accrual_posting()` checks them against the claim's date, the
 * schedule's price and the entry's value date. If any of that disagrees, this
 * INSERT fails and the transaction rolls back, taking the claim with it.
 *
 * `ON CONFLICT DO NOTHING` on the primary key, returning a row count: a second
 * run that gets this far writes nothing and says so, rather than raising on a
 * duplicate that is the expected outcome of a replay.
 */
export async function recordPosting(input: RecordInput, conn: Sql): Promise<boolean> {
  const a = input.allocation;
  const rows = await conn<{ accrual_day_id: string }[]>`
    INSERT INTO accrual_posting (
      accrual_day_id, disposition,
      monthly_cents, days_in_month, day_of_month,
      base_share_cents, residual_pennies, residual_applied,
      amount_cents, cumulative_cents,
      entry_id, skip_reason, decided_by_run
    ) VALUES (
      ${input.accrualDayId}::uuid,
      ${input.disposition}::accrual_disposition,
      ${a.monthlyCents.toString()}::bigint,
      ${a.daysInMonth}::int,
      ${a.dayOfMonth}::int,
      ${a.baseShareCents.toString()}::bigint,
      ${a.residualPennies}::int,
      ${a.residualApplied},
      ${a.amountCents.toString()}::bigint,
      ${a.cumulativeCents.toString()}::bigint,
      ${input.disposition === "posted" ? input.entryId : null}::uuid,
      ${input.disposition === "skipped" ? input.skipReason : null},
      ${input.runId}
    )
    ON CONFLICT (accrual_day_id) DO NOTHING
    RETURNING accrual_day_id`;
  return rows.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Account resolution                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The house fee-income account, by chart code.
 *
 * Resolved by query rather than memorised, so that a chart the seed did not
 * create is a loud failure at the posting boundary instead of a foreign-key
 * error three frames down. Scoped to the entity the customer's account belongs
 * to, because 0001 §2.4 forbids an entry crossing entities.
 */
export async function feeIncomeAccountId(
  entityId: string,
  code: string,
  conn: Sql = sql,
): Promise<string> {
  const [row] = await conn<{ id: string }[]>`
    SELECT id FROM account
     WHERE entity_id = ${entityId}::uuid
       AND code = ${code}
       AND business_id IS NULL
       AND closed_at IS NULL`;
  if (row === undefined) {
    throw new Error(
      `no account '${code}' in the chart for entity ${entityId}: accrual cannot post without it`,
    );
  }
  return row.id;
}

/**
 * The system principal every machine-originated entry is attributed to.
 *
 * `journal_entry.actor_id` is NOT NULL, and a cron tick is not a human. Reusing
 * `ledger-poster` rather than minting an `accrual-engine` actor is deliberate:
 * the provenance question a reader asks of an entry is "human or machine", the
 * run id already says which job, and a second system actor would be a second
 * answer to the same question.
 */
export async function ledgerPosterActorId(conn: Sql = sql): Promise<string> {
  const [row] = await conn<{ id: string }[]>`
    SELECT id FROM actor WHERE kind = 'system' AND display_name = 'ledger-poster'`;
  if (row === undefined) {
    throw new Error("no 'ledger-poster' system actor: run the seed before accruing");
  }
  return row.id;
}
