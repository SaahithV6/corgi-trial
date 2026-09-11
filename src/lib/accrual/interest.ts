import "server-only";

/**
 * The interest leg of the accrual tick.
 *
 * ============================================================================
 * THIS IS NOT A SECOND SCHEDULER
 * ============================================================================
 *
 * `runAccrual()` calls `runInterest()` at the end of its own run, inside the
 * same invocation of `/api/cron/accrual`. There is one cron entry, one
 * endpoint, one run id, one book date and one report. What is separate is the
 * TABLE the claim lands in, and 0024 §2 argues that at length; the short
 * version is that `ALTER TYPE accrual_product ADD VALUE` cannot be used in the
 * transaction that adds it (measured against this database, PostgreSQL 18.6),
 * and that making `accrual_posting`'s seven-relation CHECK hold interest too
 * would have meant weakening a working proof to avoid writing a second one.
 *
 * THE FEE LEG RUNS FIRST, and the ordering is load-bearing enough to state:
 * the fee is a DEBIT dated D, so the end-of-day-D balance that interest is
 * priced on includes it. Reversing the order would move the basis by the fee.
 * That is under a cent of interest on these balances, but an ordering that
 * changes a number should be a decision and not an accident of a loop.
 *
 * ============================================================================
 * WHY RUNNING IT TWICE FOR THE SAME DAY POSTS ONCE
 * ============================================================================
 *
 * `accrue.ts`'s argument, and the same three sentences apply because the same
 * three objects do the work.
 *
 * THE UNIT IS THE (ENROLMENT, DATE) PAIR. "Accrues once" is meaningless said
 * of an enrolment, which is supposed to accrue every day it runs.
 *
 * AT MOST ONCE, THE CLAIM. Each pair is processed inside one transaction that
 * opens by taking `lock_interest_schedule()` — `SELECT … FOR UPDATE` through a
 * SECURITY DEFINER function, because `corgi_app` holds no UPDATE on that table
 * and therefore cannot write `FOR UPDATE` itself. Two concurrent runs
 * serialise there; the second then finds the claim already made and the
 * outcome already recorded, and does nothing.
 *
 * AT LEAST ONCE, AND THE EFFECT IS IDEMPOTENT. The key handed to `postEntry()`
 * is
 *
 *     interest:<enrolment id>:<YYYY-MM-DD>
 *
 * derived by Postgres in a GENERATED ALWAYS column from the two source facts
 * that identify the day, never from a uuid this process made up. It lands on
 * `journal_entry.idempotency_key`, which is UNIQUE. A second tick re-derives
 * the same string and `ledger_append()` returns the ORIGINAL entry id having
 * written nothing. The prefix is `interest:` rather than `accrual:` so a fee
 * day and an interest day for the same account on the same date can never
 * collide in that one namespace — and so a human reading a key knows which
 * product wrote it.
 *
 * THE LOCK IS NOT THE SAFETY DEVICE. It is a liveness device — a crashed
 * process releases it. The unique indexes are what a crashed process cannot
 * release, and they are what the guarantee rests on.
 *
 * ============================================================================
 * WHAT IS DELIBERATELY NOT CHECKED, AND WHAT IS
 * ============================================================================
 *
 * NOT CHECKED: whether the customer can afford it. Interest accrued because
 * the day passed on that balance. Overdraft interest in particular is charged
 * precisely to an account that cannot afford it — that is what an overdraft
 * is — and refusing to charge it would make the day's statement wrong.
 *
 * CHECKED, BY POSTGRES, BEFORE THE ROW WILL STORE: the rate against the policy
 * `interest_rate_at()` resolves for THIS accrual date, the day count against
 * that policy, the basis against `ledger_settled_cents()` at the watermark
 * this run recorded, the eight arithmetic relations, and that the journal
 * entry is exactly two lines on the correct side of the chart. The tick
 * computes; the database verifies.
 */

import { sql, type Sql } from "@/lib/ledger/db";
import { postEntry } from "@/lib/ledger/post";
import { findEntryByIdempotencyKey } from "@/lib/ledger/queries";
import { logger, type Logger } from "@/lib/log";

import { DEFAULT_RUN_LIMIT } from "./types";
import {
  INTEREST_EXPENSE_CODE,
  INTEREST_INCOME_CODE,
  centsToPlainUsd,
  computeDailyInterest,
  explainInterest,
  type DailyInterest,
  type InterestDayReport,
  type InterestRunReport,
} from "./interest-types";
import {
  basisAt,
  claimInterestDay,
  houseInterestAccountId,
  interestPostingFor,
  listInterestDue,
  lockInterestSchedule,
  rateAt,
  recordInterestPosting,
  type DueInterestDay,
} from "./interest-store";

export type InterestRunOptions = {
  readonly bookDate: string;
  readonly limit?: number;
  readonly runId: string;
  readonly actorId: string;
  readonly logger?: Logger;
};

type Context = {
  readonly runId: string;
  readonly log: Logger;
  readonly actorId: string;
};

function reportOf(
  due: DueInterestDay,
  claim: {
    readonly interestDayId: string;
    readonly idempotencyKey: string;
    readonly claimedNow: boolean;
  },
  rest: Pick<InterestDayReport, "action" | "side" | "entryId" | "replayed" | "reason"> & {
    readonly interest?: DailyInterest | null;
  },
): InterestDayReport {
  const i = rest.interest ?? null;
  return {
    scheduleId: due.scheduleId,
    accountId: due.accountId,
    businessName: due.businessName,
    accrualDate: due.accrualDate,
    interestDayId: claim.interestDayId,
    idempotencyKey: claim.idempotencyKey,
    claimedNow: claim.claimedNow,
    action: rest.action,
    side: rest.side,
    entryId: rest.entryId,
    replayed: rest.replayed,
    // Narrowed to decimal strings, once, here. The cron route serialises this
    // object with JSON.stringify and a bigint throws; a `number` would be
    // worse, because it would not.
    basisBalanceCents: i === null ? null : i.basisBalanceCents.toString(),
    rateBps: i === null ? null : i.rateBps,
    dayCount: i === null ? null : i.dayCount,
    amountCents: i === null ? null : i.amountCents.toString(),
    rounding: i === null ? null : i.rounding,
    explanation: i === null ? null : explainInterest(i),
    reason: rest.reason,
  };
}

/**
 * Post one day's interest.
 *
 * THE SIGNS, which are the thing to get right and the thing chart.ts opens by
 * warning about. A customer's deposit balance is OUR LIABILITY and it is
 * credit-normal:
 *
 *   credit interest — we PAY the customer for holding a balance
 *       5400 Interest expense    +amount   debit   (a cost to us)
 *       the deposit account      -amount   credit  (we owe them more)
 *
 *   overdraft interest — we CHARGE a customer who is in debit
 *       4400 Interest income     -amount   credit  (we earned it)
 *       the deposit account      +amount   debit   (we owe them less)
 *
 * Getting this backwards would show a customer their balance going UP every
 * time we charged them overdraft interest. `assert_interest_posting()` refuses
 * an entry whose two lines are not exactly this for the recorded side, so it
 * cannot be got wrong by accident.
 *
 * LINE ORDER IS THE §12.5 TEMPLATE: the house's own income or expense line
 * sits at ordinal 0, which is the arrangement DESIGN §12.5 prescribes so that
 * any residual penny in an allocation lands on us. This entry has no residual
 * to assign — two equal and opposite lines, and §12.2 leaves no residual to
 * place at all — and it is written that way anyway, because the rule is one
 * rule and not "the rule, except where it does not currently matter".
 */
async function postInterest(
  due: DueInterestDay,
  interest: DailyInterest,
  idempotencyKey: string,
  ctx: Context,
  tx: Sql,
): Promise<string> {
  const paying = interest.side === "credit";
  const houseCode = paying ? INTEREST_EXPENSE_CODE : INTEREST_INCOME_CODE;
  const houseAccountId = await houseInterestAccountId(due.entityId, houseCode, tx);

  const memo = explainInterest(interest);
  const balance = centsToPlainUsd(interest.basisBalanceCents);

  return await postEntry(
    {
      entityId: due.entityId,
      // THE DATE IT ACCRUED FOR, NOT THE DATE THE JOB RAN. A tick catching up
      // three days posts three entries dated those three days, all carrying
      // today's booking_seq. assert_interest_posting() refuses anything else.
      valueDate: due.accrualDate,
      book: "financial",
      description: paying
        ? `Credit interest — ${interest.rateBps} bps ACT/${interest.dayCount} on ${balance}`
        : `Overdraft interest — ${interest.rateBps} bps ACT/${interest.dayCount} on ${balance}`,
      // Generated by Postgres from the enrolment and the date. Nothing in this
      // process computed this string.
      idempotencyKey,
      actorId: ctx.actorId,
      lines: [
        // Ordinal 0: the house line. See the note above.
        {
          accountId: houseAccountId,
          amountCents: paying ? interest.amountCents : -interest.amountCents,
          memo,
        },
        // Ordinal 1: the customer.
        {
          accountId: due.accountId,
          amountCents: paying ? -interest.amountCents : interest.amountCents,
          memo: paying
            ? `Interest earned on ${balance} at ${interest.rateBps} bps a year`
            : `Interest charged on an overdrawn balance of ${balance} at ${interest.rateBps} bps a year`,
        },
      ],
      // Not a rail movement: no external party, no settlement, nothing for
      // reconciliation to match against a file.
      rail: "internal",
    },
    tx,
  );
}

async function accrueOneInterestDay(
  due: DueInterestDay,
  ctx: Context,
): Promise<InterestDayReport> {
  return await sql.begin(async (raw) => {
    const tx = raw as unknown as Sql;

    // 1. Serialise every processor of THIS enrolment. Held to commit.
    await lockInterestSchedule(due.scheduleId, tx);

    // 2. The claim. At most one row per (enrolment, date); the unique
    //    constraint decides, and there is no SELECT-then-INSERT to race.
    const claim = await claimInterestDay(
      { scheduleId: due.scheduleId, accrualDate: due.accrualDate, runId: ctx.runId },
      tx,
    );

    // 3. Already decided? Then this is a duplicate tick, and the honest report
    //    is what the database already holds — not a second decision.
    const settled = await interestPostingFor(claim.interestDayId, tx);
    if (settled !== null) {
      return reportOf(due, claim, {
        action: settled.disposition,
        side: settled.side,
        entryId: settled.entryId,
        replayed: true,
        interest: null,
        reason: "already accrued for this date; nothing posted",
      });
    }

    // 4. THE RATE, RESOLVED ON THE ACCRUAL DATE AND NOT ON TODAY.
    //
    //    This is the whole of "a rate change must not retroactively re-price
    //    yesterday", and it is one argument to one function: a replay of an
    //    old date passes that old date and gets the old card back. The
    //    lifecycle trigger resolves it independently before it will store the
    //    row, so the two cannot disagree.
    const card = await rateAt(due.rateTier, due.accrualDate, tx);
    if (card === null) {
      throw new Error(
        `rate card '${due.rateTier}' has no version effective on or before ${due.accrualDate}`,
      );
    }

    // 5. THE BASIS: the settled ledger balance at the end of that business
    //    date, with the booking watermark it was true at, read in one
    //    statement. Read BEFORE anything is posted, so the entry this tick is
    //    about to write is not part of its own basis.
    const basis = await basisAt(due.accountId, due.accrualDate, tx);

    // 6. THE ARITHMETIC. Pure, integer, half-even, about to be re-derived by
    //    Postgres. The side comes from the sign of the balance and the side
    //    picks the rate — one enrolment, one rate card, two sides.
    const side = basis.balanceCents > 0n ? "credit" : basis.balanceCents < 0n ? "overdraft" : "flat";
    const interest = computeDailyInterest({
      balanceCents: basis.balanceCents,
      rateBps: side === "credit" ? card.creditRateBps : card.overdraftRateBps,
      dayCount: card.dayCount,
    });

    // 7. A day that prices at zero cents. `postEntry()` refuses a zero-amount
    //    line ("always an allocation bug") and it is right to, so the day is
    //    recorded as decided-with-no-entry rather than posted as an entry that
    //    says nothing. Two ways to get here and they are different facts:
    //    a balance of exactly zero, and a balance so small that a day of it
    //    rounds to nothing — which is §12.2 doing its job, not failing.
    if (interest.amountCents === 0n) {
      const balance = centsToPlainUsd(interest.basisBalanceCents);
      const reason =
        interest.side === "flat"
          ? `The balance was exactly ${balance} at the end of ${due.accrualDate}, so there is nothing to price on either side.`
          : `A day of ${interest.rateBps} bps on ${balance} is ${interest.numerator}/${interest.denominator} of a cent, which is less than half a cent, so DESIGN §12.2 rounds it to nothing. Nothing is posted and nothing is owed.`;

      await recordInterestPosting(
        {
          interestDayId: claim.interestDayId,
          runId: ctx.runId,
          policyId: card.policyId,
          interest,
          observedBookingSeq: basis.bookingSeq,
          disposition: "skipped",
          skipReason: reason,
        },
        tx,
      );
      return reportOf(due, claim, {
        action: "skipped",
        side: interest.side,
        entryId: null,
        replayed: false,
        interest,
        reason: interest.side === "flat" ? "zero balance" : "rounds to zero cents",
      });
    }

    // 8. RECOVERY, ASKED BEFORE ANYTHING IS POSTED. One transaction means a
    //    crash cannot split the claim from the entry, but a hand-run posting
    //    or a restored backup could. If this day's key already names an entry,
    //    that entry IS this accrual — cite it rather than posting a second.
    const existing = await findEntryByIdempotencyKey(claim.idempotencyKey, tx);
    if (existing !== null) {
      await recordInterestPosting(
        {
          interestDayId: claim.interestDayId,
          runId: ctx.runId,
          policyId: card.policyId,
          interest,
          observedBookingSeq: basis.bookingSeq,
          disposition: "posted",
          entryId: existing.entryId,
        },
        tx,
      );
      return reportOf(due, claim, {
        action: "posted",
        side: interest.side,
        entryId: existing.entryId,
        replayed: true,
        interest,
        reason: "an entry already carried this day's key; recorded against it",
      });
    }

    // 9. Post it, through the one path, with the key the database derived.
    const entryId = await postInterest(due, interest, claim.idempotencyKey, ctx, tx);

    // 10. Record the working. The CHECK re-derives all eight relations and the
    //     trigger checks the rate against the policy, the basis against the
    //     ledger and the entry against the side. A cent of disagreement rolls
    //     step 9 back.
    await recordInterestPosting(
      {
        interestDayId: claim.interestDayId,
        runId: ctx.runId,
        policyId: card.policyId,
        interest,
        observedBookingSeq: basis.bookingSeq,
        disposition: "posted",
        entryId,
      },
      tx,
    );

    ctx.log.info("interest.posted", {
      scheduleId: due.scheduleId,
      accrualDate: due.accrualDate,
      idempotencyKey: claim.idempotencyKey,
      entryId,
      side: interest.side,
      policyId: card.policyId,
      rateBps: interest.rateBps,
      dayCount: interest.dayCount,
      basisBalanceCents: interest.basisBalanceCents.toString(),
      observedBookingSeq: basis.bookingSeq.toString(),
      numerator: interest.numerator.toString(),
      denominator: interest.denominator.toString(),
      rounding: interest.rounding,
      amountCents: interest.amountCents.toString(),
    });

    return reportOf(due, claim, {
      action: "posted",
      side: interest.side,
      entryId,
      replayed: false,
      interest,
      reason: null,
    });
  });
}

/**
 * Accrue every day of interest owed and not yet decided.
 *
 * Sequential rather than concurrent, for `accrue.ts`'s reasons: days of one
 * enrolment would contend on the same row lock anyway, `ledger_append()`
 * serialises on its own advisory lock regardless, the work is tiny, and a
 * serverless function with a pool of five is not the place to fan out
 * transactions that each hold two locks across a round trip.
 *
 * One day that throws does not stop the leg. Its transaction rolls back — so
 * the claim, the entry and the outcome all go with it — it is reported as
 * `deferred`, and the next tick re-derives the same date from the calendar and
 * the same key from the database.
 *
 * The interesting deferral is the one that cannot be avoided and is SAFE:
 * `assert_interest_posting()` re-derives the basis at the recorded watermark,
 * and if a concurrent transaction commits an entry whose booking sequence was
 * assigned before this run read the maximum, the two answers differ and the
 * INSERT is refused. Nothing is posted, the day rolls back whole, and the next
 * tick prices it against a watermark that has settled. A wrong number is never
 * the outcome; a retry is.
 */
export async function runInterest(options: InterestRunOptions): Promise<InterestRunReport> {
  const log = (options.logger ?? logger({ requestId: options.runId })).child({
    runId: options.runId,
    leg: "interest",
  });
  const ctx: Context = { runId: options.runId, log, actorId: options.actorId };

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_RUN_LIMIT, 1), 2000);
  const due = await listInterestDue(options.bookDate, limit);
  const days: InterestDayReport[] = [];

  for (const item of due) {
    try {
      days.push(await accrueOneInterestDay(item, ctx));
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : "the day could not be accrued";
      log.error("interest.failed", {
        scheduleId: item.scheduleId,
        accrualDate: item.accrualDate,
        error: thrown,
      });
      days.push({
        scheduleId: item.scheduleId,
        accountId: item.accountId,
        businessName: item.businessName,
        accrualDate: item.accrualDate,
        // The transaction rolled back, so no claim row exists to name. The
        // empty string says that rather than inventing an id.
        interestDayId: "",
        idempotencyKey: "",
        claimedNow: false,
        action: "deferred",
        side: null,
        entryId: null,
        replayed: false,
        basisBalanceCents: null,
        rateBps: null,
        dayCount: null,
        amountCents: null,
        rounding: null,
        explanation: null,
        reason: message,
      });
    }
  }

  // Only days this run actually posted count toward the totals: a replay
  // reports the entry it found and adds nothing, which is what makes
  // `creditInterestCents === "0"` on a second run the proof it is.
  let creditCents = 0n;
  let overdraftCents = 0n;
  for (const day of days) {
    if (day.action !== "posted" || day.replayed || day.amountCents === null) continue;
    if (day.side === "credit") creditCents += BigInt(day.amountCents);
    if (day.side === "overdraft") overdraftCents += BigInt(day.amountCents);
  }

  const report: InterestRunReport = {
    considered: due.length,
    posted: days.filter((d) => d.action === "posted").length,
    skipped: days.filter((d) => d.action === "skipped").length,
    deferred: days.filter((d) => d.action === "deferred").length,
    replayed: days.filter((d) => d.replayed).length,
    creditInterestCents: creditCents.toString(),
    overdraftInterestCents: overdraftCents.toString(),
    days,
  };

  log.info("interest.complete", {
    bookDate: options.bookDate,
    considered: report.considered,
    posted: report.posted,
    skipped: report.skipped,
    deferred: report.deferred,
    replayed: report.replayed,
    creditInterestCents: report.creditInterestCents,
    overdraftInterestCents: report.overdraftInterestCents,
  });

  return report;
}
