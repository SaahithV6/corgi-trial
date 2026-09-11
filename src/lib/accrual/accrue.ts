import "server-only";

/**
 * The accrual tick. One run of end-of-day accrual.
 *
 * ============================================================================
 * WHY RUNNING IT TWICE FOR THE SAME DAY POSTS ONCE
 * ============================================================================
 *
 * THE UNIT IS THE (SCHEDULE, DATE) PAIR. "Accrues once" is meaningless said of
 * a schedule, which is supposed to accrue every day for as long as it runs.
 * What must happen at most once is one day of one schedule.
 *
 * AT MOST ONCE, THE CLAIM. Each pair is processed inside one transaction that
 * opens by taking `lock_accrual_schedule()` — `SELECT … FOR UPDATE` through the
 * SECURITY DEFINER function in 0020 §11, because `corgi_app` holds no UPDATE on
 * that table and therefore cannot write `FOR UPDATE` itself. Two concurrent
 * runs serialise there; the second then finds the claim already made and the
 * outcome already recorded, and does nothing.
 *
 * AT LEAST ONCE, THE EFFECT — AND THE EFFECT IS IDEMPOTENT. The lock is a
 * liveness device: a crashed process releases it, so it is deliberately NOT
 * what makes this safe. What makes it safe is that the idempotency key handed
 * to `postEntry()` is
 *
 *     accrual:<schedule id>:<YYYY-MM-DD>
 *
 * derived by Postgres in a GENERATED ALWAYS column from the two source facts
 * that identify the day, never from a uuid this process made up. It lands on
 * `journal_entry.idempotency_key`, which is UNIQUE (0001 §12). A second tick —
 * from a retry, a restart, a duplicated cron, a second region — re-derives the
 * same string, and `ledger_append()` returns the ORIGINAL entry id having
 * written nothing. Two runs that both get all the way through post one entry
 * because the database says so, not because the scheduler behaved.
 *
 * ============================================================================
 * WHY THE WHOLE DAY IS ONE TRANSACTION — UNLIKE standing/fire.ts
 * ============================================================================
 *
 * `standing/fire.ts` deliberately calls `requestPayment()` on the pooled handle
 * because that function opens its own transaction. `postEntry()` does not: it
 * takes a connection, so the claim, the journal entry and the outcome row all
 * commit together or none of them do. That is strictly better here and it is
 * worth saying why it is available: a payment instruction is a request to a
 * queue that a human will act on later, while an accrual is the whole event.
 * There is nothing to leave half-done, so nothing is left half-done.
 *
 * The recovery path is kept anyway (`entryForKey`, step 4). One transaction
 * means a crash cannot split the claim from the entry, but a hand-run posting
 * or a restored backup could, and the honest response to finding an entry that
 * already carries this day's key is to cite it — not to refuse, and certainly
 * not to post a second one.
 *
 * ============================================================================
 * WHAT IS DELIBERATELY NOT CHECKED: THE BALANCE
 * ============================================================================
 *
 * An accrual is not a payment and it is not funds-checked. The fee accrued
 * because the month passed, not because the account could afford it, and
 * refusing to accrue on a thin balance would mean the customer's statement for
 * that day was wrong and the month no longer summed to the price. So a fee can
 * push a deposit account into a debit balance, which is exactly the condition
 * `v_overdrawn_accounts` exists to surface — and exactly the condition an
 * overdraft-interest product would then price. That is a policy decision and it
 * is written down in docs/ACCRUAL.md §6 rather than being an accident of this
 * function not asking.
 */

import { sql, type Sql } from "@/lib/ledger/db";
import { postEntry } from "@/lib/ledger/post";
import { logger, type Logger } from "@/lib/log";

import {
  bookToday,
  claimDay,
  entryForKey,
  feeIncomeAccountId,
  ledgerPosterActorId,
  listDue,
  lockSchedule,
  postingFor,
  recordPosting,
  type DueDay,
} from "./store";
import {
  DEFAULT_RUN_LIMIT,
  FEE_INCOME_CODE,
  allocateForDate,
  explainAllocation,
  type AccrualRunResult,
  type DailyAllocation,
  type DayReport,
} from "./types";

export type AccrualRunOptions = {
  /** Overrides the book date. Operators and tests only; production asks the database. */
  readonly bookDate?: string;
  readonly limit?: number;
  readonly runId?: string;
  readonly logger?: Logger;
};

/** `accrual-1757548800000-9f3c1a`. Recorded on every row this run writes. */
function newRunId(): string {
  return `accrual-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`;
}

/* -------------------------------------------------------------------------- */
/* One day of one schedule                                                    */
/* -------------------------------------------------------------------------- */

type Context = {
  readonly runId: string;
  readonly log: Logger;
  readonly actorId: string;
};

function reportOf(
  due: DueDay,
  claim: { readonly accrualDayId: string; readonly idempotencyKey: string; readonly claimedNow: boolean },
  rest: Pick<DayReport, "action" | "entryId" | "replayed" | "allocation" | "reason">,
): DayReport {
  return {
    scheduleId: due.scheduleId,
    planName: due.planName,
    accountId: due.accountId,
    accrualDate: due.accrualDate,
    accrualDayId: claim.accrualDayId,
    idempotencyKey: claim.idempotencyKey,
    claimedNow: claim.claimedNow,
    ...rest,
  };
}

/**
 * Post one day's fee: debit the customer, credit fee income.
 *
 * A customer's deposit balance is our LIABILITY and it is credit-normal, so
 * charging them a fee is a DEBIT to their account — we owe them less. Getting
 * this backwards is the error `chart.ts` opens by warning about, and it is the
 * one that would show a customer their balance going UP every time we billed
 * them.
 *
 * LINE ORDER IS THE §12.5 TEMPLATE. The house's own income line sits at ordinal
 * 0, which is the arrangement DESIGN §12.5 prescribes so that any residual
 * penny in an allocation lands on us and not on the customer. This particular
 * entry is two equal and opposite lines and has no residual to assign, so the
 * ordering changes nothing here — and it is written this way anyway, because
 * the rule is one rule and not "the rule, except where it does not currently
 * matter". The residual penny in daily accrual is placed ACROSS DAYS rather
 * than across lines; that is §12.3/§12.4 and it happens in `allocateForDate`.
 */
async function postFee(
  due: DueDay,
  allocation: DailyAllocation,
  idempotencyKey: string,
  ctx: Context,
  tx: Sql,
): Promise<string> {
  const incomeAccountId = await feeIncomeAccountId(due.entityId, FEE_INCOME_CODE, tx);
  const memo = explainAllocation(allocation);

  return await postEntry(
    {
      entityId: due.entityId,
      // THE DATE IT ACCRUED FOR, NOT THE DATE THE JOB RAN. A tick catching up
      // three days posts three entries dated those three days, all carrying
      // today's booking_seq. assert_accrual_posting() refuses anything else.
      valueDate: due.accrualDate,
      book: "financial",
      description:
        `Platform fee — ${due.planName} — day ${allocation.dayOfMonth} of ${allocation.daysInMonth}`,
      // Generated by Postgres from the schedule and the date. Nothing in this
      // process computed this string.
      idempotencyKey,
      actorId: ctx.actorId,
      lines: [
        // Ordinal 0: the house line. See the note above.
        {
          accountId: incomeAccountId,
          amountCents: -allocation.amountCents,
          memo,
        },
        // Ordinal 1: the customer. A debit — we owe them less.
        {
          accountId: due.accountId,
          amountCents: allocation.amountCents,
          memo: `${due.planName} platform fee, ${allocation.dayOfMonth}/${allocation.daysInMonth} of the month`,
        },
      ],
      // Not a rail movement at all: no external party, no settlement, nothing
      // for reconciliation to match against a file. `internal` is the enum
      // value that says "this money never left our book".
      rail: "internal",
    },
    tx,
  );
}

async function accrueOne(due: DueDay, ctx: Context): Promise<DayReport> {
  return await sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;

    // 1. Serialise every processor of THIS schedule. Held to commit.
    await lockSchedule(due.scheduleId, tx);

    // 2. The claim. At most one row per (schedule, date); the unique
    //    constraint decides, and there is no SELECT-then-INSERT to race.
    const claim = await claimDay(
      { scheduleId: due.scheduleId, accrualDate: due.accrualDate, runId: ctx.runId },
      tx,
    );

    // 3. Already decided? Then this is a duplicate tick, and the honest report
    //    is what the database already holds — not a second decision.
    const settled = await postingFor(claim.accrualDayId, tx);
    if (settled !== null) {
      return reportOf(due, claim, {
        action: settled.disposition,
        entryId: settled.entryId,
        replayed: true,
        allocation: null,
        reason: "already accrued for this date; nothing posted",
      });
    }

    // 4. THE ARITHMETIC. Pure, integer, and about to be re-derived by Postgres.
    const allocation = allocateForDate(due.monthlyCents, due.accrualDate);

    // 5. A day whose share is legitimately zero cents. postEntry() refuses a
    //    zero-amount line ("always an allocation bug") and it is right to, so
    //    the day is recorded as decided-with-no-entry rather than posted as an
    //    entry that says nothing. Only reachable on a plan priced below one
    //    cent a day, e.g. $0.20 a month over 31 days.
    if (allocation.amountCents === 0n) {
      await recordPosting(
        {
          accrualDayId: claim.accrualDayId,
          runId: ctx.runId,
          allocation,
          disposition: "skipped",
          skipReason:
            `This day's share of ${due.planName} is zero cents: ` +
            `${allocation.monthlyCents}¢ ÷ ${allocation.daysInMonth} days = 0 with ` +
            `${allocation.residualPennies}¢ to place, and day ${allocation.dayOfMonth} is past the ` +
            `first ${allocation.residualPennies}. The month still sums to the full price.`,
        },
        tx,
      );
      return reportOf(due, claim, {
        action: "skipped",
        entryId: null,
        replayed: false,
        allocation,
        reason: "zero-cent share; the month still sums to the price",
      });
    }

    // 6. RECOVERY, ASKED BEFORE ANYTHING IS POSTED.
    //
    //    One transaction means a crash cannot split the claim from the entry,
    //    but a hand-run posting or a restored backup could. If this day's key
    //    already names an entry, that entry IS this accrual — cite it.
    const existing = await entryForKey(claim.idempotencyKey, tx);
    if (existing !== null) {
      await recordPosting(
        {
          accrualDayId: claim.accrualDayId,
          runId: ctx.runId,
          allocation,
          disposition: "posted",
          entryId: existing,
        },
        tx,
      );
      return reportOf(due, claim, {
        action: "posted",
        entryId: existing,
        replayed: true,
        allocation,
        reason: "an entry already carried this day's key; recorded against it",
      });
    }

    // 7. Post it, through the one path, with the key the database derived.
    const entryId = await postFee(due, allocation, claim.idempotencyKey, ctx, tx);

    // 8. Record the working. The CHECK re-derives all seven relations and the
    //    trigger checks them against this claim's date, this schedule's price
    //    and this entry's value date. A cent of disagreement rolls step 7 back.
    await recordPosting(
      {
        accrualDayId: claim.accrualDayId,
        runId: ctx.runId,
        allocation,
        disposition: "posted",
        entryId,
      },
      tx,
    );

    ctx.log.info("accrual.posted", {
      scheduleId: due.scheduleId,
      accrualDate: due.accrualDate,
      idempotencyKey: claim.idempotencyKey,
      entryId,
      amountCents: allocation.amountCents.toString(),
      residualApplied: allocation.residualApplied,
      cumulativeCents: allocation.cumulativeCents.toString(),
    });

    return reportOf(due, claim, {
      action: "posted",
      entryId,
      replayed: false,
      allocation,
      reason: null,
    });
  });
}

/* -------------------------------------------------------------------------- */
/* The tick                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Accrue everything owed and not yet decided.
 *
 * Sequential rather than concurrent, on purpose. Days of one schedule would
 * contend on the same row lock anyway, `ledger_append()` serialises on its own
 * advisory lock regardless, the work is tiny, and a serverless function with a
 * pool of five is not the place to fan out transactions that each hold two
 * locks across a round trip.
 *
 * One day that throws does not stop the tick. Its transaction rolls back — so
 * the claim, the entry and the outcome all go with it — it is reported as
 * `deferred`, and the next tick re-derives the same date from the calendar and
 * the same key from the database.
 */
export async function runAccrual(options: AccrualRunOptions = {}): Promise<AccrualRunResult> {
  const started = Date.now();
  const runId = options.runId ?? newRunId();
  const log = (options.logger ?? logger({ requestId: runId })).child({ runId });

  const today = await bookToday();
  const bookDate = options.bookDate ?? today;

  // ACCRUAL NEVER RUNS AHEAD OF THE BOOK.
  //
  // The date is an operator input on this path — that is how a debrief replays
  // a specific day — and an input that can be typed can be typed wrong. A
  // bookDate in the future would post a fee for a day that has not happened,
  // dated that day, and no later run could ever take it back: the ledger is
  // append-only, so the only remedy would be a reversal plus a re-book for a
  // charge that never should have existed. Cheaper to refuse.
  //
  // Backwards is fine and is the normal case — that is catch-up, and the entry
  // carries the date it accrued FOR.
  if (bookDate > today) {
    throw new Error(
      `refusing to accrue for ${bookDate}: the book is on ${today} and a fee cannot accrue for a day that has not happened`,
    );
  }

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_RUN_LIMIT, 1), 2000);

  const actorId = await ledgerPosterActorId();
  const due = await listDue(bookDate, limit);
  const days: DayReport[] = [];

  for (const item of due) {
    try {
      days.push(await accrueOne(item, { runId, log, actorId }));
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : "the day could not be accrued";
      log.error("accrual.failed", {
        scheduleId: item.scheduleId,
        accrualDate: item.accrualDate,
        error: thrown,
      });
      days.push({
        scheduleId: item.scheduleId,
        planName: item.planName,
        accountId: item.accountId,
        accrualDate: item.accrualDate,
        // The transaction rolled back, so no claim row exists to name. The
        // empty string says that rather than inventing an id.
        accrualDayId: "",
        idempotencyKey: "",
        claimedNow: false,
        action: "deferred",
        entryId: null,
        replayed: false,
        allocation: null,
        reason: message,
      });
    }
  }

  const postedCents = days.reduce(
    (total, day) =>
      day.action === "posted" && !day.replayed && day.allocation !== null
        ? total + day.allocation.amountCents
        : total,
    0n,
  );

  const result: AccrualRunResult = {
    runId,
    asOf: new Date(started).toISOString(),
    bookDate,
    considered: due.length,
    posted: days.filter((d) => d.action === "posted").length,
    skipped: days.filter((d) => d.action === "skipped").length,
    deferred: days.filter((d) => d.action === "deferred").length,
    replayed: days.filter((d) => d.replayed).length,
    postedCents,
    days,
    durationMs: Date.now() - started,
  };

  log.info("accrual.complete", {
    bookDate,
    considered: result.considered,
    posted: result.posted,
    skipped: result.skipped,
    deferred: result.deferred,
    replayed: result.replayed,
    postedCents: postedCents.toString(),
    durationMs: result.durationMs,
  });

  return result;
}
