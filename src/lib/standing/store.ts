/**
 * Every SQL statement standing orders issue, in one file.
 *
 * The rule the rest of `src/lib/standing` depends on: no calendar arithmetic
 * happens here or anywhere else in TypeScript. When a mandate is due is a
 * question answered by `standing_order_due_dates()` in migration 0012, and this
 * module's job is to ask it. DECISIONS 024 is the argument — two definitions of
 * the same rule, held equal by an invariant, cannot be fixed one at a time.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { destinationSchema, type PayoutRail } from "@/lib/approvals/types";

import {
  CATCH_UP_WINDOW_DAYS,
  type StandingOrder,
  type StandingOrderCadence,
  type StandingOrderDisposition,
  type StandingOrderOccurrence,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Row shapes                                                                 */
/* -------------------------------------------------------------------------- */

type ScheduleRow = {
  readonly id: string;
  readonly reference: string;
  readonly account_id: string;
  readonly account_name: string;
  readonly business_id: string | null;
  readonly business_name: string | null;
  readonly rail: PayoutRail;
  readonly amount_cents: bigint;
  readonly currency: string;
  readonly counterparty: unknown;
  readonly cadence: StandingOrderCadence;
  readonly day_of_month: number | null;
  readonly day_of_week: number | null;
  readonly start_date: string;
  readonly end_date: string | null;
  readonly mandate_key: string;
  readonly created_at: Date;
  readonly created_by: string;
  readonly created_by_name: string;
  readonly cancelled: boolean;
  readonly cancelled_at: Date | null;
  readonly cancellation_reason: string | null;
  readonly next_due_date: string | null;
};

type HistoryRow = {
  readonly occurrence_id: string;
  readonly standing_order_id: string;
  readonly reference: string;
  readonly scheduled_date: string;
  readonly idempotency_key: string;
  readonly claimed_at: Date;
  readonly claimed_by: string;
  readonly amount_cents: bigint;
  readonly currency: string;
  readonly rail: PayoutRail;
  readonly disposition: StandingOrderDisposition | null;
  readonly instruction_id: string | null;
  readonly refusal_code: string | null;
  readonly refusal_reason: string | null;
  readonly observed_ledger_cents: bigint | null;
  readonly observed_holds_cents: bigint | null;
  readonly observed_uncleared_cents: bigint | null;
  readonly observed_available_cents: bigint | null;
  readonly shortfall_cents: bigint | null;
  readonly decided_at: Date | null;
  readonly decided_by_run: string | null;
};

/**
 * The stored destination is jsonb. Re-validated on the way out rather than
 * trusted — the same treatment `instructions.ts` gives
 * `payment_instruction.counterparty`, and for the same reason: a row that no
 * longer parses must not be rendered as if it were understood, and must never
 * be paid.
 */
function parseDestination(raw: unknown) {
  const parsed = destinationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function toStandingOrder(row: ScheduleRow): StandingOrder {
  return {
    id: row.id,
    reference: row.reference,
    accountId: row.account_id,
    accountName: row.account_name,
    businessId: row.business_id,
    businessName: row.business_name,
    rail: row.rail,
    amountCents: row.amount_cents,
    currency: row.currency,
    destination: parseDestination(row.counterparty),
    cadence: row.cadence,
    dayOfMonth: row.day_of_month,
    dayOfWeek: row.day_of_week,
    startDate: row.start_date,
    endDate: row.end_date,
    mandateKey: row.mandate_key,
    createdAt: row.created_at.toISOString(),
    createdByActorId: row.created_by,
    createdByName: row.created_by_name,
    cancelled: row.cancelled,
    cancelledAt: row.cancelled_at === null ? null : row.cancelled_at.toISOString(),
    cancellationReason: row.cancellation_reason,
    nextDueDate: row.next_due_date,
  };
}

function toOccurrence(row: HistoryRow): StandingOrderOccurrence {
  return {
    occurrenceId: row.occurrence_id,
    standingOrderId: row.standing_order_id,
    reference: row.reference,
    scheduledDate: row.scheduled_date,
    idempotencyKey: row.idempotency_key,
    claimedAt: row.claimed_at.toISOString(),
    claimedBy: row.claimed_by,
    amountCents: row.amount_cents,
    currency: row.currency,
    rail: row.rail,
    disposition: row.disposition,
    instructionId: row.instruction_id,
    refusalCode: row.refusal_code,
    refusalReason: row.refusal_reason,
    observedLedgerCents: row.observed_ledger_cents,
    observedHoldsCents: row.observed_holds_cents,
    observedUnclearedCents: row.observed_uncleared_cents,
    observedAvailableCents: row.observed_available_cents,
    shortfallCents: row.shortfall_cents,
    decidedAt: row.decided_at === null ? null : row.decided_at.toISOString(),
    decidedByRun: row.decided_by_run,
  };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** Every mandate, with its next unclaimed occurrence. Newest first. */
export async function listStandingOrders(
  limit = 50,
  conn: Sql = sql,
): Promise<readonly StandingOrder[]> {
  const rows = await conn<ScheduleRow[]>`
    SELECT s.id, s.reference, s.account_id, s.account_name, s.business_id, s.business_name,
           s.rail::text AS rail, s.amount_cents, s.currency, s.counterparty,
           s.cadence::text AS cadence, s.day_of_month, s.day_of_week,
           s.start_date::text AS start_date, s.end_date::text AS end_date,
           s.mandate_key, s.created_at, s.created_by, s.created_by_name,
           s.cancelled, s.cancelled_at, s.cancellation_reason,
           n.next_due_date::text AS next_due_date
      FROM v_standing_order_schedule s
      LEFT JOIN v_standing_order_next n ON n.standing_order_id = s.id
     ORDER BY s.cancelled, s.created_at DESC
     LIMIT ${limit}`;
  return rows.map(toStandingOrder);
}

/** Every occurrence, decided or not, newest scheduled date first. */
export async function listOccurrences(
  limit = 100,
  conn: Sql = sql,
): Promise<readonly StandingOrderOccurrence[]> {
  const rows = await conn<HistoryRow[]>`
    SELECT occurrence_id, standing_order_id, reference,
           scheduled_date::text AS scheduled_date, idempotency_key,
           claimed_at, claimed_by, amount_cents, currency, rail::text AS rail,
           disposition::text AS disposition, instruction_id,
           refusal_code, refusal_reason,
           observed_ledger_cents, observed_holds_cents,
           observed_uncleared_cents, observed_available_cents, shortfall_cents,
           decided_at, decided_by_run
      FROM v_standing_order_history
     ORDER BY scheduled_date DESC, claimed_at DESC
     LIMIT ${limit}`;
  return rows.map(toOccurrence);
}

/** Claimed but never decided. Must normally be empty; see migration 0012 §14. */
export async function countUnresolved(conn: Sql = sql): Promise<number> {
  const rows = await conn<{ n: number }[]>`
    SELECT count(*)::int AS n FROM v_standing_order_unresolved`;
  return rows[0]?.n ?? 0;
}

/** The double-fire invariant. Zero rows, always, or the ledger has a problem. */
export async function countDoubleFires(conn: Sql = sql): Promise<number> {
  const rows = await conn<{ n: number }[]>`
    SELECT count(*)::int AS n FROM v_standing_order_double_fire`;
  return rows[0]?.n ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Writing a mandate                                                          */
/* -------------------------------------------------------------------------- */

export type CreateStandingOrderInput = {
  readonly accountId: string;
  readonly reference: string;
  readonly rail: PayoutRail;
  readonly amountCents: bigint;
  readonly currency?: string;
  readonly destination: unknown;
  readonly cadence: StandingOrderCadence;
  readonly dayOfMonth?: number | null;
  readonly dayOfWeek?: number | null;
  readonly startDate: string;
  readonly endDate?: string | null;
  readonly createdByActorId: string;
  /** From the fact that created the mandate. UNIQUE; replay is a no-op. */
  readonly mandateKey: string;
};

/**
 * Create a mandate. Replaying `mandateKey` returns the existing one and writes
 * nothing — the unique index decides, not an `if`.
 *
 * The destination is validated here on the way IN as well as on the way out.
 * A mandate is a standing authority to move money on a schedule with nobody
 * watching; a counterparty that does not parse must never become one.
 */
export async function createStandingOrder(
  input: CreateStandingOrderInput,
  conn: Sql = sql,
): Promise<{ id: string; created: boolean }> {
  const destination = destinationSchema.safeParse(input.destination);
  if (!destination.success) {
    throw new Error(
      `standing order ${input.mandateKey}: the destination does not describe a payee this bank can pay`,
    );
  }

  const inserted = await conn<{ id: string }[]>`
    INSERT INTO standing_order
      (account_id, reference, rail, amount_cents, currency, counterparty,
       cadence, day_of_month, day_of_week, start_date, end_date, created_by, mandate_key)
    VALUES
      (${input.accountId}::uuid, ${input.reference}, ${input.rail}::rail,
       ${input.amountCents.toString()}::bigint, ${input.currency ?? "USD"},
       ${conn.json(destination.data)},
       ${input.cadence}::standing_order_cadence,
       ${input.dayOfMonth ?? null}::smallint,
       ${input.dayOfWeek ?? null}::smallint,
       ${input.startDate}::date,
       ${input.endDate ?? null}::date,
       ${input.createdByActorId}::uuid,
       ${input.mandateKey})
    ON CONFLICT (mandate_key) DO NOTHING
    RETURNING id`;

  const row = inserted[0];
  if (row !== undefined) return { id: row.id, created: true };

  const [existing] = await conn<{ id: string }[]>`
    SELECT id FROM standing_order WHERE mandate_key = ${input.mandateKey}`;
  if (existing === undefined) {
    throw new Error(`standing order ${input.mandateKey}: insert conflicted but no row exists`);
  }
  return { id: existing.id, created: false };
}

/** Stop a mandate. One row, PRIMARY KEY on the order id, so it happens once. */
export async function cancelStandingOrder(
  args: { readonly standingOrderId: string; readonly actorId: string; readonly reason: string },
  conn: Sql = sql,
): Promise<boolean> {
  const rows = await conn<{ standing_order_id: string }[]>`
    INSERT INTO standing_order_cancellation (standing_order_id, cancelled_by, reason)
    VALUES (${args.standingOrderId}::uuid, ${args.actorId}::uuid, ${args.reason})
    ON CONFLICT (standing_order_id) DO NOTHING
    RETURNING standing_order_id`;
  return rows.length === 1;
}

/* -------------------------------------------------------------------------- */
/* The work queue                                                             */
/* -------------------------------------------------------------------------- */

export type DueItem = {
  readonly standingOrderId: string;
  readonly reference: string;
  readonly accountId: string;
  readonly businessId: string | null;
  readonly rail: PayoutRail;
  readonly amountCents: bigint;
  readonly currency: string;
  readonly counterparty: unknown;
  readonly createdByActorId: string;
  readonly scheduledDate: string;
  /** Set when a previous run already claimed this occurrence and did not finish. */
  readonly occurrenceId: string | null;
  readonly idempotencyKey: string | null;
};

type DueRow = {
  readonly standing_order_id: string;
  readonly reference: string;
  readonly account_id: string;
  readonly business_id: string | null;
  readonly rail: PayoutRail;
  readonly amount_cents: bigint;
  readonly currency: string;
  readonly counterparty: unknown;
  readonly created_by: string;
  readonly scheduled_date: string;
  readonly occurrence_id: string | null;
  readonly idempotency_key: string | null;
};

/**
 * Everything owed and not yet decided, in two parts that must both be there.
 *
 *   (a) DUE DATES WITH NO OCCURRENCE ROW — work that has never been claimed.
 *       Bounded three ways, because an unbounded generator over a mandate that
 *       started in 2019 would materialise two thousand occurrences on its first
 *       tick: not before the mandate's own start date, not before the mandate
 *       was created (a schedule cannot have fired before it existed), and not
 *       more than CATCH_UP_WINDOW_DAYS ago.
 *
 *   (b) OCCURRENCE ROWS WITH NO OUTCOME — work that WAS claimed and never
 *       finished, at any age whatsoever. This is the recovery path and it is
 *       deliberately unbounded: a claim is a durable statement that this
 *       (order, date) is owed, and a claim must never age out of the queue,
 *       because that is precisely how "it never fired and nobody knows why"
 *       happens.
 *
 * Cancellation is applied here rather than in a trigger for dates in the past:
 * a mandate cancelled at 4pm did not un-happen that morning's payment, so
 * occurrences on or before the cancellation's book date still count and later
 * ones do not. The trigger in 0012 §9 enforces the same line on the way in.
 */
export async function listDue(
  bookToday: string,
  limit: number,
  conn: Sql = sql,
): Promise<readonly DueItem[]> {
  const rows = await conn<DueRow[]>`
    WITH live AS (
      SELECT so.*, acc.business_id,
             (c.cancelled_at AT TIME ZONE 'America/New_York')::date AS cancelled_on
        FROM standing_order so
        JOIN account acc ON acc.id = so.account_id
        LEFT JOIN standing_order_cancellation c ON c.standing_order_id = so.id
    ),
    fresh AS (
      SELECT live.id AS standing_order_id, d.due_date AS scheduled_date
        FROM live
        CROSS JOIN LATERAL standing_order_due_dates(
          live.id,
          GREATEST(
            live.start_date,
            (live.created_at AT TIME ZONE 'America/New_York')::date,
            ${bookToday}::date - ${CATCH_UP_WINDOW_DAYS}::int
          ),
          ${bookToday}::date
        ) AS d(due_date)
       WHERE NOT EXISTS (
         SELECT 1 FROM standing_order_occurrence o
          WHERE o.standing_order_id = live.id AND o.scheduled_date = d.due_date
       )
    ),
    stranded AS (
      SELECT o.standing_order_id, o.scheduled_date
        FROM standing_order_occurrence o
       WHERE NOT EXISTS (
         SELECT 1 FROM standing_order_outcome ou WHERE ou.occurrence_id = o.id
       )
    ),
    work AS (
      SELECT standing_order_id, scheduled_date FROM fresh
      UNION
      SELECT standing_order_id, scheduled_date FROM stranded
    )
    SELECT live.id                    AS standing_order_id,
           live.reference,
           live.account_id,
           live.business_id,
           live.rail::text            AS rail,
           live.amount_cents,
           live.currency,
           live.counterparty,
           live.created_by,
           work.scheduled_date::text  AS scheduled_date,
           o.id                       AS occurrence_id,
           o.idempotency_key
      FROM work
      JOIN live ON live.id = work.standing_order_id
      LEFT JOIN standing_order_occurrence o
             ON o.standing_order_id = work.standing_order_id
            AND o.scheduled_date = work.scheduled_date
     WHERE live.cancelled_on IS NULL OR work.scheduled_date <= live.cancelled_on
     ORDER BY work.scheduled_date, live.id
     LIMIT ${limit}`;

  return rows.map((row) => ({
    standingOrderId: row.standing_order_id,
    reference: row.reference,
    accountId: row.account_id,
    businessId: row.business_id,
    rail: row.rail,
    amountCents: row.amount_cents,
    currency: row.currency,
    counterparty: row.counterparty,
    createdByActorId: row.created_by,
    scheduledDate: row.scheduled_date,
    occurrenceId: row.occurrence_id,
    idempotencyKey: row.idempotency_key,
  }));
}

/* -------------------------------------------------------------------------- */
/* The claim                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The row lock, through the SECURITY DEFINER function migration 0012 §11
 * defines. corgi_app holds no UPDATE on `standing_order`, so it cannot write
 * `FOR UPDATE` itself — the same construction 0008 uses for card
 * authorisations, and for the same reason.
 */
export async function lockStandingOrder(standingOrderId: string, conn: Sql): Promise<boolean> {
  const rows = await conn<{ locked: boolean }[]>`
    SELECT lock_standing_order(${standingOrderId}::uuid) AS locked`;
  return rows[0]?.locked === true;
}

export type Claim = {
  readonly occurrenceId: string;
  readonly idempotencyKey: string;
  /** False when the row already existed — a concurrent run or an earlier one. */
  readonly claimedNow: boolean;
};

/**
 * Claim one occurrence: at most once, decided by Postgres.
 *
 * `ON CONFLICT ... DO NOTHING` with a row count, exactly as the webhook inbox
 * ingests a delivery. There is no SELECT-then-INSERT here, because that has a
 * race between its two statements and this has none. A caller that gets
 * `claimedNow: false` is looking at a row somebody else wrote and must not
 * assume it is undecided.
 *
 * The idempotency key is NOT passed in. It is a GENERATED column, so the
 * database derives it from the two source facts and there is no argument for a
 * caller to get wrong.
 */
export async function claimOccurrence(
  args: {
    readonly standingOrderId: string;
    readonly scheduledDate: string;
    readonly runId: string;
  },
  conn: Sql,
): Promise<Claim> {
  const inserted = await conn<{ id: string; idempotency_key: string }[]>`
    INSERT INTO standing_order_occurrence (standing_order_id, scheduled_date, claimed_by)
    VALUES (${args.standingOrderId}::uuid, ${args.scheduledDate}::date, ${args.runId})
    ON CONFLICT (standing_order_id, scheduled_date) DO NOTHING
    RETURNING id, idempotency_key`;

  const row = inserted[0];
  if (row !== undefined) {
    return { occurrenceId: row.id, idempotencyKey: row.idempotency_key, claimedNow: true };
  }

  const [existing] = await conn<{ id: string; idempotency_key: string }[]>`
    SELECT id, idempotency_key FROM standing_order_occurrence
     WHERE standing_order_id = ${args.standingOrderId}::uuid
       AND scheduled_date = ${args.scheduledDate}::date`;
  if (existing === undefined) {
    throw new Error(
      `standing order ${args.standingOrderId} on ${args.scheduledDate}: the claim conflicted but no row exists`,
    );
  }
  return { occurrenceId: existing.id, idempotencyKey: existing.idempotency_key, claimedNow: false };
}

/* -------------------------------------------------------------------------- */
/* The decision                                                               */
/* -------------------------------------------------------------------------- */

export async function outcomeFor(
  occurrenceId: string,
  conn: Sql,
): Promise<{ disposition: StandingOrderDisposition; instructionId: string | null } | null> {
  const [row] = await conn<
    { disposition: StandingOrderDisposition; instruction_id: string | null }[]
  >`
    SELECT disposition::text AS disposition, instruction_id
      FROM standing_order_outcome WHERE occurrence_id = ${occurrenceId}::uuid`;
  return row === undefined
    ? null
    : { disposition: row.disposition, instructionId: row.instruction_id };
}

/**
 * The instruction this occurrence's derived key already names, if any.
 *
 * Asked BEFORE the funds check on every recovery, and that ordering is the
 * whole of the crash-safety argument. If a previous run raised the instruction
 * and died before writing the outcome, the money question has already been
 * answered; re-asking it against today's balance could refuse a payment that is
 * already in the approvals queue.
 */
export async function instructionForKey(
  idempotencyKey: string,
  conn: Sql,
): Promise<string | null> {
  const [row] = await conn<{ id: string }[]>`
    SELECT id FROM payment_instruction WHERE idempotency_key = ${idempotencyKey}`;
  return row?.id ?? null;
}

export type OutcomeInput = {
  readonly occurrenceId: string;
  readonly runId: string;
} & (
  | { readonly disposition: "raised"; readonly instructionId: string }
  | {
      readonly disposition: "refused";
      readonly code: string;
      readonly reason: string;
      readonly ledgerCents?: bigint;
      readonly holdsCents?: bigint;
      readonly unclearedCents?: bigint;
      /**
       * The fifth term: debits already booked for a future value date
       * (migration 0022). Recorded since 0023, and the CHECK constraint
       * `standing_order_outcome_availability_identity` refuses a row that
       * carries it and does not add up — so this is not four figures plus a
       * remainder any more, it is the decomposition of the number the
       * payment was refused against.
       */
      readonly pendingOutboundCents?: bigint;
      readonly availableCents?: bigint;
      readonly shortfallCents?: bigint;
    }
);

function centsOrNull(value: bigint | undefined): string | null {
  return value === undefined ? null : value.toString();
}

/**
 * Record the outcome. One per occurrence, by PRIMARY KEY.
 *
 * `ON CONFLICT DO NOTHING` so a concurrent run that reached the same decision
 * writes nothing and raises nothing. The return value says whether this call
 * was the one that decided — which is information the report wants and no
 * caller may branch on for correctness.
 */
export async function recordOutcome(input: OutcomeInput, conn: Sql): Promise<boolean> {
  // Flattened up front rather than inline in the template: the discriminated
  // union narrows on `input.disposition`, and a boolean held in a variable does
  // not narrow it, so every branch has to be taken here where the compiler can
  // see it. The alternative — two near-identical INSERTs — is two places to
  // forget a column.
  const flat =
    input.disposition === "raised"
      ? {
          instructionId: input.instructionId as string | null,
          code: null as string | null,
          reason: null as string | null,
          ledger: null as string | null,
          holds: null as string | null,
          uncleared: null as string | null,
          pendingOutbound: null as string | null,
          available: null as string | null,
          shortfall: null as string | null,
        }
      : {
          instructionId: null as string | null,
          code: input.code as string | null,
          reason: input.reason as string | null,
          ledger: centsOrNull(input.ledgerCents),
          holds: centsOrNull(input.holdsCents),
          uncleared: centsOrNull(input.unclearedCents),
          pendingOutbound: centsOrNull(input.pendingOutboundCents),
          available: centsOrNull(input.availableCents),
          shortfall: centsOrNull(input.shortfallCents),
        };

  const rows = await conn<{ occurrence_id: string }[]>`
    INSERT INTO standing_order_outcome
      (occurrence_id, disposition, instruction_id, refusal_code, refusal_reason,
       observed_ledger_cents, observed_holds_cents, observed_uncleared_cents,
       observed_pending_outbound_cents, observed_available_cents,
       shortfall_cents, decided_by_run)
    VALUES
      (${input.occurrenceId}::uuid,
       ${input.disposition}::standing_order_disposition,
       ${flat.instructionId}::uuid,
       ${flat.code},
       ${flat.reason},
       ${flat.ledger}::bigint,
       ${flat.holds}::bigint,
       ${flat.uncleared}::bigint,
       ${flat.pendingOutbound}::bigint,
       ${flat.available}::bigint,
       ${flat.shortfall}::bigint,
       ${input.runId})
    ON CONFLICT (occurrence_id) DO NOTHING
    RETURNING occurrence_id`;
  return rows.length === 1;
}

/* -------------------------------------------------------------------------- */
/* The clock                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Today, in book time, asked of the database rather than of the process.
 *
 * The same reason the calendar lives in SQL: `v_standing_order_next`,
 * `listDue()` and the occurrence trigger all resolve "today" as
 * `(now() AT TIME ZONE 'America/New_York')::date`, and a second definition
 * computed from a Node `Date` would be a second definition — one that a server
 * running in UTC rolls over five hours early every night, quietly firing a
 * mandate on the wrong side of a month end.
 */
export async function bookToday(conn: Sql = sql): Promise<string> {
  const rows = await conn<{ book_date: string }[]>`
    SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS book_date`;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("standing orders: the database did not answer what day it is");
  }
  return row.book_date;
}
