import "server-only";

/**
 * The interest adjustment — the correction for a day that was priced before
 * its own business date closed.
 *
 * ============================================================================
 * WHAT IS BEING CORRECTED, AND WHY IT COULD NOT BE PREVENTED
 * ============================================================================
 *
 * docs/ACCRUAL.md §16 defines the basis as the settled ledger balance at the
 * END of a business date. Until `interestPricingHorizon()` existed, the tick
 * accepted `bookDate = today` — the cron's own default — and a date that has
 * not ended has no end-of-day balance, so what it priced was the balance at
 * the instant it ran. `interest_day` is UNIQUE (schedule_id, accrual_date):
 * the property that makes the tick exactly-once is the property that makes a
 * mid-day guess permanent.
 *
 * Five enrolments were priced that way on 2026-09-11 at watermarks 2262–2266.
 * One of them, `Holds Integration Fixture Co.`, was paid 498¢ of CREDIT
 * interest out of `5400` for a business date it closed $858,941.45 OVERDRAWN
 * — a day that belongs on `4400`, in the other direction. Both the amount and
 * the side are wrong and the posting is immutable.
 *
 * ============================================================================
 * WHY A SECOND `interest_day` IS NOT THE ANSWER, AND WHAT IS
 * ============================================================================
 *
 * A re-price is not expressible as a second claim on the same (enrolment,
 * date): the unique index refuses it, and that index is not an obstacle to
 * route around — loosening it destroys the exactly-once guarantee that made
 * this defect detectable at all.
 *
 * The way through is that an adjustment IS NOT THE SAME KIND OF FACT as a day.
 * `interest_day` says "this enrolment's 11 September has been decided", which
 * is true and stays true — it WAS decided, wrongly. The adjustment says
 * something else: "the decision recorded for that day priced a balance that
 * was not that date's closing balance, and at watermark W the date was worth
 * this instead." Two sentences, two claim spaces, and the day's uniqueness is
 * untouched. `interest_adjustment` (migration 0049 §3) is the second one.
 *
 * ============================================================================
 * THE ORDER OF OPERATIONS, WHICH IS THE WHOLE OF THE ARITHMETIC
 * ============================================================================
 *
 * The corrected basis must be "what the date closed at AS IF THE WRONG ENTRY
 * HAD NEVER HAPPENED". Naively that needs hand arithmetic — read the balance
 * and subtract the wrong entry's effect — and hand arithmetic outside
 * `ledger_settled_cents()` is a fifth private definition of the balance.
 *
 * It is not needed. Post the REVERSAL FIRST, then read the watermark. The
 * original and its reversal are both inside it and cancel exactly, account by
 * account, because `assert_reversal_is_exact()` forces the reversal to be the
 * original's arithmetic negation at the original's value date. So
 *
 *     ledger_settled_cents(account, accrual_date, seq_after_the_reversal)
 *
 * IS the closing balance with the wrong entry removed, computed by the
 * ledger's own function and by nothing else. The re-book is posted after that
 * read and is therefore outside its own basis — which is exactly what
 * `basisAt()` arranges for an ordinary day, for the same reason.
 *
 * ============================================================================
 * IDEMPOTENCY, AND THE ONE PLACE A WATERMARK MUST NOT APPEAR
 * ============================================================================
 *
 * docs/ACCRUAL.md §19 named the key `interest-adj:<enrolment>:<date>:<watermark>`
 * so that a second adjustment for the same repriced watermark is idempotent.
 * That is right for the CLAIM, and `interest_adjustment.idempotency_key` is a
 * GENERATED column spelling exactly it.
 *
 * IT IS WRONG FOR THE MONEY, and the difference is worth stating because it is
 * the same class of error as the defect being repaired. A journal entry's
 * idempotency key is the last line of defence against paying twice. If it
 * contains the watermark, then a replay — which reads a LATER watermark,
 * because the book has moved — derives a DIFFERENT key, collides with nothing,
 * and posts a second re-book. A key built from a moving number is not a key.
 *
 * So the re-book carries `interest-adj:<enrolment>:<date>`, which a replay
 * re-derives byte for byte, and `ledger_append()` hands back the original
 * entry having written nothing. The reversal carries `reversal:<entry id>`,
 * `reverseAndRebook()`'s own, and `journal_entry_one_reversal_idx` makes an
 * entry reversible at most once regardless.
 *
 * On top of both: this module takes `lock_interest_schedule()` and then asks
 * whether an adjustment already exists, before anything is posted. Three
 * layers, and only the first is a convention.
 */

import { readAccountIdentities } from "@/lib/ledger/readers";
import { sql, type Sql } from "@/lib/ledger/db";
import { postEntry, reverseAndRebook } from "@/lib/ledger/post";
import { logger, type Logger } from "@/lib/log";

import { bookToday, ledgerPosterActorId } from "./store";
import {
  INTEREST_EXPENSE_CODE,
  INTEREST_INCOME_CODE,
  centsToPlainUsd,
  computeDailyInterest,
  explainInterest,
  type DailyInterest,
} from "./interest-types";
import {
  basisAt,
  houseInterestAccountId,
  lockInterestSchedule,
  rateAt,
} from "./interest-store";

/* -------------------------------------------------------------------------- */
/* One postgres.js wrinkle, and the reason it is not worked around            */
/* -------------------------------------------------------------------------- */

type Scoped = {
  savepoint?: <T>(fn: (scoped: unknown) => Promise<T>) => Promise<T>;
  begin?: unknown;
};

/**
 * Give a transaction handle the `.begin()` that `reverseAndRebook()` calls.
 *
 * postgres.js 3.4 puts `begin` on the POOL only; a transaction scope gets
 * `savepoint`, and the two are the same function internally, differing only in
 * whether a savepoint name is issued. `reverseAndRebook()` opens
 * `conn.begin(...)`, so handing it this day's transaction throws
 * `tx.begin is not a function` — which is exactly what happened the first time
 * the repair was exercised end to end.
 *
 * THE ALTERNATIVE WAS WORSE. Either the reversal runs in its own transaction
 * outside this one — and then a crash between the reversal and the re-book
 * leaves a day whose interest has been taken back and not replaced, which is a
 * third wrong number — or this module stops calling `reverseAndRebook()` and
 * writes its own negation, which is a second implementation of the one
 * correction primitive in this system. `src/lib/ledger/ledger.integration.test.ts`
 * already carries this shim for the same reason, with the same note.
 *
 * `Sql(handler)` builds a fresh object per scope, so this adds the property to
 * the handle it is given and to nothing else.
 */
function withBegin(handle: Sql): Sql {
  const scoped = handle as unknown as Scoped;
  if (typeof scoped.begin !== "function" && typeof scoped.savepoint === "function") {
    const savepoint = scoped.savepoint.bind(scoped);
    scoped.begin = (first: unknown, second?: unknown) => {
      const body = (typeof first === "function" ? first : second) as (
        inner: unknown,
      ) => Promise<unknown>;
      return savepoint(body as never);
    };
  }
  return handle;
}

/* -------------------------------------------------------------------------- */
/* What is owed a correction                                                  */
/* -------------------------------------------------------------------------- */

export type MispricedDay = {
  readonly interestDayId: string;
  readonly scheduleId: string;
  readonly accountId: string;
  readonly entityId: string;
  readonly businessName: string | null;
  readonly rateTier: string;
  readonly accrualDate: string;
  /** The watermark the wrong basis was read at, and what it read. */
  readonly pricedAtSeq: bigint;
  readonly pricedBasisCents: bigint;
  readonly pricedSide: "credit" | "overdraft" | "flat";
  readonly pricedAmountCents: bigint;
  readonly pricedEntryId: string;
  /** What the same date stands at now, recomputed by the view on every read. */
  readonly basisNowCents: bigint;
  readonly sideNow: "credit" | "overdraft" | "flat";
  readonly amountNowCents: bigint;
};

/**
 * Every day owed a correction, oldest first.
 *
 * Sourced from `v_interest_mispriced_uncorrected` and NOT from a predicate
 * written here. 0048's rule: a repair that ranges over its own query can touch
 * a row the guard cannot see, and then the guard is green while the repair has
 * been somewhere nobody is looking. The view is the population; this reads it.
 *
 * The view's own WHERE already carries the three conditions that matter — the
 * date has CLOSED, the closed figure genuinely differs from what was posted,
 * and no `interest_adjustment` names the day — so there is nothing to filter
 * again here.
 */
export async function listMispricedInterestDays(
  limit = 200,
  conn: Sql = sql,
): Promise<MispricedDay[]> {
  const rows = await conn<
    {
      interest_day_id: string;
      schedule_id: string;
      account_id: string;
      business_name: string | null;
      rate_tier: string;
      accrual_date: string;
      priced_at_seq: bigint;
      priced_basis_cents: bigint;
      priced_side: "credit" | "overdraft" | "flat";
      priced_amount_cents: bigint;
      priced_entry_id: string;
      basis_now_cents: bigint;
      side_now: "credit" | "overdraft" | "flat";
      amount_now_cents: bigint;
    }[]
  >`
    SELECT m.interest_day_id,
           m.schedule_id,
           m.account_id,
           m.business_name,
           s.rate_tier,
           m.accrual_date::text AS accrual_date,
           m.priced_at_seq,
           m.priced_basis_cents,
           m.priced_side::text  AS priced_side,
           m.priced_amount_cents,
           m.priced_entry_id,
           m.basis_now_cents,
           m.side_now::text     AS side_now,
           m.amount_now_cents
      FROM v_interest_mispriced_uncorrected m
      JOIN interest_schedule s ON s.id = m.schedule_id
     ORDER BY m.accrual_date ASC, m.priced_at_seq ASC
     LIMIT ${limit}`;

  // `entity_id` USED TO COME FROM A `JOIN account` HERE, and that is a direct
  // reach into a ledger table from outside `src/lib/ledger/` — caught by
  // `boundary.test.ts`, which is a ratchet rather than a style preference.
  //
  // The join was for a FOREIGN KEY, not for a definition of money, which is
  // exactly the case `readAccountIdentities()` exists for. Routing through it
  // costs one extra round trip on a path that runs once per tick and touches
  // at most a handful of days, and it keeps the rule that a module outside the
  // ledger never learns the shape of its tables.
  const identities = await readAccountIdentities(
    rows.map((r) => r.account_id),
    conn,
  );

  return rows.map((r) => ({
    interestDayId: r.interest_day_id,
    scheduleId: r.schedule_id,
    accountId: r.account_id,
    entityId: identities.get(r.account_id)?.entityId ?? "",
    businessName: r.business_name,
    rateTier: r.rate_tier,
    accrualDate: r.accrual_date,
    pricedAtSeq: r.priced_at_seq,
    pricedBasisCents: r.priced_basis_cents,
    pricedSide: r.priced_side,
    pricedAmountCents: r.priced_amount_cents,
    pricedEntryId: r.priced_entry_id,
    basisNowCents: r.basis_now_cents,
    sideNow: r.side_now,
    amountNowCents: r.amount_now_cents,
  }));
}

/* -------------------------------------------------------------------------- */
/* The correction                                                             */
/* -------------------------------------------------------------------------- */

export type AdjustmentAction = "adjusted" | "replayed" | "held" | "failed";

export type AdjustmentReport = {
  readonly interestDayId: string;
  readonly accrualDate: string;
  readonly businessName: string | null;
  readonly action: AdjustmentAction;
  readonly adjustmentId: string | null;
  readonly idempotencyKey: string | null;
  readonly originalEntryId: string;
  readonly reversalEntryId: string | null;
  readonly rebookEntryId: string | null;
  readonly correctionGroupId: string | null;
  /** Decimal strings: bigint does not survive JSON.stringify and a number loses cents. */
  readonly pricedSide: string;
  readonly pricedAmountCents: string;
  readonly correctedSide: string | null;
  readonly correctedAmountCents: string | null;
  readonly basisBalanceCents: string | null;
  readonly repricedAtSeq: string | null;
  readonly explanation: string | null;
  readonly reason: string | null;
};

type Context = {
  readonly runId: string;
  readonly log: Logger;
  readonly actorId: string;
};

/**
 * Post the corrected day.
 *
 * `postInterest()`'s two lines and `postInterest()`'s signs, deliberately
 * identical — this is the same product on the same accounts and the same
 * `§12.5` template with the house line at ordinal 0. What differs is
 * `entryType: "rebook"` and the correction group, which is how the journal
 * already ties an original, its reversal and its replacement together.
 *
 * `assert_interest_adjustment()` re-derives all of it — the basis at the
 * recorded watermark, the side from the sign of that basis, the rate from the
 * card effective on the ACCRUAL date, the rounding direction and the cents —
 * and refuses the adjustment row if the entry is not exactly this shape for
 * the corrected side. A repair that got the sign backwards rolls back whole.
 */
async function postRebook(
  day: MispricedDay,
  interest: DailyInterest,
  correctionGroupId: string,
  ctx: Context,
  tx: Sql,
): Promise<string> {
  const paying = interest.side === "credit";
  const houseCode = paying ? INTEREST_EXPENSE_CODE : INTEREST_INCOME_CODE;
  const houseAccountId = await houseInterestAccountId(day.entityId, houseCode, tx);

  const memo = explainInterest(interest);
  const balance = centsToPlainUsd(interest.basisBalanceCents);

  return await postEntry(
    {
      entityId: day.entityId,
      // THE ORIGINAL DAY'S VALUE DATE. The whole bitemporal requirement: 11
      // September's statement must show 11 September's corrected number, and
      // the book must still be able to say what it believed on the 11th and
      // when it learned better. Value date and booking date are different
      // columns and this is the row that shows it.
      valueDate: day.accrualDate,
      book: "financial",
      entryType: "rebook",
      correctionGroupId,
      description: paying
        ? `Credit interest, re-booked at the closing balance — ${interest.rateBps} bps ACT/${interest.dayCount} on ${balance}`
        : `Overdraft interest, re-booked at the closing balance — ${interest.rateBps} bps ACT/${interest.dayCount} on ${balance}`,
      // NO WATERMARK IN THIS KEY. See the header: a key containing a number
      // that moves collides with nothing on a replay and pays twice.
      idempotencyKey: `interest-adj:${day.scheduleId}:${day.accrualDate}`,
      actorId: ctx.actorId,
      lines: [
        { accountId: houseAccountId, amountCents: paying ? interest.amountCents : -interest.amountCents, memo },
        {
          accountId: day.accountId,
          amountCents: paying ? -interest.amountCents : interest.amountCents,
          memo: paying
            ? `Interest earned on ${balance} at ${interest.rateBps} bps a year — the balance ${day.accrualDate} actually closed at`
            : `Interest charged on an overdrawn balance of ${balance} at ${interest.rateBps} bps a year — the balance ${day.accrualDate} actually closed at`,
        },
      ],
      rail: "internal",
    },
    tx,
  );
}

/**
 * Correct one day, in one transaction.
 *
 * The claim, the reversal, the re-book and the adjustment row commit together
 * or not at all. A crash cannot leave money moved with nothing saying why, and
 * `assert_interest_adjustment()` disagreeing by one cent takes the two entries
 * back with it.
 */
export async function adjustOneMispricedDay(
  day: MispricedDay,
  ctx: Context,
  // Injectable for the same reason every function in `interest-store.ts` takes
  // one: a correction path that can only be exercised by committing to the
  // live book is a correction path nobody dares exercise. Given a transaction
  // handle this opens a SAVEPOINT inside it, so the whole reversal, re-book
  // and claim can be run against the real database and rolled back.
  conn: Sql = sql,
): Promise<AdjustmentReport> {
  const base = {
    interestDayId: day.interestDayId,
    accrualDate: day.accrualDate,
    businessName: day.businessName,
    originalEntryId: day.pricedEntryId,
    pricedSide: day.pricedSide,
    pricedAmountCents: day.pricedAmountCents.toString(),
  };

  return await withBegin(conn).begin(async (raw) => {
    // Shimmed on the way in as well: `reverseAndRebook()` below opens its own
    // scope on whatever it is handed, and inside a transaction that scope must
    // be a SAVEPOINT so the reversal, the re-book and the claim commit or roll
    // back together.
    const tx = withBegin(raw as unknown as Sql);

    // 1. Serialise every processor of THIS enrolment, exactly as the tick
    //    does. Held to commit.
    await lockInterestSchedule(day.scheduleId, tx);

    // 2. THE REPLAY GUARD, ASKED AFTER THE LOCK AND BEFORE ANY MONEY MOVES.
    //    `v_interest_mispriced_uncorrected` already excludes adjusted days,
    //    but a view read outside the lock is a SELECT-then-INSERT race, and
    //    the thing on the other side of this race is a second payment.
    const [existing] = await tx<{ id: string; idempotency_key: string; rebook_entry_id: string | null; reversal_entry_id: string; correction_group_id: string }[]>`
      SELECT id, idempotency_key, rebook_entry_id, reversal_entry_id, correction_group_id
        FROM interest_adjustment
       WHERE interest_day_id = ${day.interestDayId}::uuid`;
    if (existing !== undefined) {
      return {
        ...base,
        action: "replayed" as const,
        adjustmentId: existing.id,
        idempotencyKey: existing.idempotency_key,
        reversalEntryId: existing.reversal_entry_id,
        rebookEntryId: existing.rebook_entry_id,
        correctionGroupId: existing.correction_group_id,
        correctedSide: null,
        correctedAmountCents: null,
        basisBalanceCents: null,
        repricedAtSeq: null,
        explanation: null,
        reason: "this day has already been adjusted; nothing posted",
      };
    }

    // 3. THE CLOSURE RULE, ASKED IN TYPESCRIPT TOO.
    //
    //    `interest_adjustment_after_close` is a CHECK and
    //    `assert_interest_adjustment()` raises, so the database refuses this
    //    anyway. It is asked here as well so the operator gets a sentence
    //    rather than a constraint name, and so the reversal is never posted
    //    for a correction that cannot complete.
    const today = await bookToday(tx);
    if (day.accrualDate >= today) {
      return {
        ...base,
        action: "held" as const,
        adjustmentId: null,
        idempotencyKey: null,
        reversalEntryId: null,
        rebookEntryId: null,
        correctionGroupId: null,
        correctedSide: null,
        correctedAmountCents: null,
        basisBalanceCents: null,
        repricedAtSeq: null,
        explanation: null,
        reason:
          `${day.accrualDate} has not closed — the book is on ${today}. ` +
          `The corrected basis is the settled balance at the END of that date, and correcting a ` +
          `mid-day price with a second mid-day price is the same defect twice. The correction waits.`,
      };
    }

    // 4. THE REVERSAL, FIRST AND ALONE.
    //
    //    Un-says the wrong money at the ORIGINAL value date.
    //    `assert_reversal_is_exact()` forces both of those at ledger_append
    //    time. No re-book is passed: it cannot be computed yet, because its
    //    basis is only correct once this reversal is inside the watermark.
    const { reversalEntryId, correctionGroupId } = await reverseAndRebook(
      {
        originalEntryId: day.pricedEntryId,
        reason:
          `the basis was read at booking watermark ${day.pricedAtSeq} on ${day.accrualDate} itself, ` +
          `while the business date was still open, so it is not that date's closing balance ` +
          `(docs/ACCRUAL.md §20)`,
        actorId: ctx.actorId,
      },
      tx,
    );

    // 5. THE CORRECTED BASIS, READ AFTER THE REVERSAL.
    //
    //    The wrong entry and its reversal are both at or below this watermark
    //    and cancel account by account, so this IS the closing balance with
    //    the wrong entry removed — through `ledger_settled_cents()`, with no
    //    arithmetic of our own. See the header.
    const basis = await basisAt(day.accountId, day.accrualDate, tx);

    // 6. THE RATE, RESOLVED ON THE ACCRUAL DATE AND NOT ON TODAY. A
    //    correction re-prices the day with the card that was in force on the
    //    day, which is the same sentence §15 makes about a replay.
    const card = await rateAt(day.rateTier, day.accrualDate, tx);
    if (card === null) {
      throw new Error(
        `rate card '${day.rateTier}' has no version effective on or before ${day.accrualDate}`,
      );
    }

    // 7. The arithmetic, through the SAME pure function the tick uses. There
    //    is no second implementation of DESIGN §12.2 in this file.
    const side =
      basis.balanceCents > 0n ? "credit" : basis.balanceCents < 0n ? "overdraft" : "flat";
    const interest = computeDailyInterest({
      balanceCents: basis.balanceCents,
      rateBps: side === "credit" ? card.creditRateBps : card.overdraftRateBps,
      dayCount: card.dayCount,
    });

    // 8. A day that closed at nothing, or at less than half a cent, has no
    //    re-book. `postEntry()` refuses a zero-amount line and is right to.
    //    The reversal still stands: the wrong money is taken back, and the
    //    correct answer is that nothing was owed.
    const rebookEntryId =
      interest.amountCents === 0n
        ? null
        : await postRebook(day, interest, correctionGroupId, ctx, tx);

    // 9. The claim, last, so that everything it cites exists. The trigger
    //    re-derives the basis at the watermark below, the side from its sign,
    //    the rate from the card effective on the accrual date, the rounding
    //    and the cents — and checks the two entries are the reversal and the
    //    re-book it says they are, on the right side of the chart.
    const [row] = await tx<{ id: string; idempotency_key: string }[]>`
      INSERT INTO interest_adjustment (
        interest_day_id, schedule_id, accrual_date, repriced_at_seq,
        side, policy_id, rate_bps, day_count, rounding, amount_cents,
        original_entry_id, reversal_entry_id, rebook_entry_id, correction_group_id,
        adjusted_by_run, reason
      ) VALUES (
        ${day.interestDayId}::uuid,
        ${day.scheduleId}::uuid,
        ${day.accrualDate}::date,
        ${basis.bookingSeq.toString()}::bigint,
        ${interest.side}::interest_side,
        ${card.policyId}::uuid,
        ${interest.rateBps}::int,
        ${interest.dayCount}::int,
        ${interest.rounding}::interest_rounding,
        ${interest.amountCents.toString()}::bigint,
        ${day.pricedEntryId}::uuid,
        ${reversalEntryId}::uuid,
        ${rebookEntryId}::uuid,
        ${correctionGroupId}::uuid,
        ${ctx.runId},
        ${
          `priced at watermark ${day.pricedAtSeq} on ${day.accrualDate} itself, while the business ` +
          `date was still open; re-priced at watermark ${basis.bookingSeq} on the settled balance that ` +
          `date actually closed at. docs/ACCRUAL.md §20, §21.`
        }
      )
      RETURNING id, idempotency_key`;

    if (row === undefined) {
      throw new Error(`interest adjustment for day ${day.interestDayId} wrote no row`);
    }

    ctx.log.info("interest.adjusted", {
      interestDayId: day.interestDayId,
      accrualDate: day.accrualDate,
      adjustmentId: row.id,
      idempotencyKey: row.idempotency_key,
      originalEntryId: day.pricedEntryId,
      reversalEntryId,
      rebookEntryId,
      correctionGroupId,
      pricedSide: day.pricedSide,
      pricedAmountCents: day.pricedAmountCents.toString(),
      correctedSide: interest.side,
      correctedAmountCents: interest.amountCents.toString(),
      basisBalanceCents: basis.balanceCents.toString(),
      repricedAtSeq: basis.bookingSeq.toString(),
    });

    return {
      ...base,
      action: "adjusted" as const,
      adjustmentId: row.id,
      idempotencyKey: row.idempotency_key,
      reversalEntryId,
      rebookEntryId,
      correctionGroupId,
      correctedSide: interest.side,
      correctedAmountCents: interest.amountCents.toString(),
      basisBalanceCents: basis.balanceCents.toString(),
      repricedAtSeq: basis.bookingSeq.toString(),
      explanation: explainInterest(interest),
      reason: null,
    };
  });
}

export type AdjustmentRunReport = {
  readonly bookDate: string;
  readonly considered: number;
  readonly adjusted: number;
  readonly replayed: number;
  readonly held: number;
  readonly failed: number;
  /** Magnitudes taken back and re-booked, as decimal strings. */
  readonly reversedCents: string;
  readonly creditRebookedCents: string;
  readonly overdraftRebookedCents: string;
  readonly days: readonly AdjustmentReport[];
};

/**
 * Correct every day owed a correction.
 *
 * NOT ON THE CRON, and that is a decision rather than an omission. The nightly
 * tick prices days; this un-says a posting and books a different one, which is
 * an operator's act with a name against it. `v_interest_mispriced_uncorrected`
 * is the queue and it surfaces on `/accruals`; the operator runs
 * `scripts/repair-0049-mispriced-interest.mjs --apply`.
 *
 * Sequential, for `interest.ts`'s reasons: days of one enrolment contend on the
 * same row lock anyway and `ledger_append()` serialises on its own advisory
 * lock regardless. One day that throws does not stop the run — its transaction
 * rolls back whole, taking the reversal with it, and it is reported as failed.
 */
export async function runInterestAdjustments(
  options: {
    readonly runId: string;
    readonly limit?: number;
    readonly logger?: Logger;
    readonly actorId?: string;
  },
  conn: Sql = sql,
): Promise<AdjustmentRunReport> {
  const log = (options.logger ?? logger({ requestId: options.runId })).child({
    runId: options.runId,
    leg: "interest-adjust",
  });
  const actorId = options.actorId ?? (await ledgerPosterActorId(conn));
  const ctx: Context = { runId: options.runId, log, actorId };

  const bookDate = await bookToday(conn);
  const due = await listMispricedInterestDays(
    Math.min(Math.max(options.limit ?? 200, 1), 2000),
    conn,
  );

  const days: AdjustmentReport[] = [];
  for (const day of due) {
    try {
      days.push(await adjustOneMispricedDay(day, ctx, conn));
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : "the day could not be adjusted";
      log.error("interest.adjust_failed", {
        interestDayId: day.interestDayId,
        accrualDate: day.accrualDate,
        error: thrown,
      });
      days.push({
        interestDayId: day.interestDayId,
        accrualDate: day.accrualDate,
        businessName: day.businessName,
        action: "failed",
        adjustmentId: null,
        idempotencyKey: null,
        originalEntryId: day.pricedEntryId,
        reversalEntryId: null,
        rebookEntryId: null,
        correctionGroupId: null,
        pricedSide: day.pricedSide,
        pricedAmountCents: day.pricedAmountCents.toString(),
        correctedSide: null,
        correctedAmountCents: null,
        basisBalanceCents: null,
        repricedAtSeq: null,
        explanation: null,
        reason: message,
      });
    }
  }

  let reversed = 0n;
  let credit = 0n;
  let overdraft = 0n;
  for (const d of days) {
    if (d.action !== "adjusted") continue;
    reversed += BigInt(d.pricedAmountCents);
    if (d.correctedAmountCents === null) continue;
    if (d.correctedSide === "credit") credit += BigInt(d.correctedAmountCents);
    if (d.correctedSide === "overdraft") overdraft += BigInt(d.correctedAmountCents);
  }

  const report: AdjustmentRunReport = {
    bookDate,
    considered: due.length,
    adjusted: days.filter((d) => d.action === "adjusted").length,
    replayed: days.filter((d) => d.action === "replayed").length,
    held: days.filter((d) => d.action === "held").length,
    failed: days.filter((d) => d.action === "failed").length,
    reversedCents: reversed.toString(),
    creditRebookedCents: credit.toString(),
    overdraftRebookedCents: overdraft.toString(),
    days,
  };

  log.info("interest.adjust_complete", {
    bookDate,
    considered: report.considered,
    adjusted: report.adjusted,
    replayed: report.replayed,
    held: report.held,
    failed: report.failed,
    reversedCents: report.reversedCents,
    creditRebookedCents: report.creditRebookedCents,
    overdraftRebookedCents: report.overdraftRebookedCents,
  });

  return report;
}
