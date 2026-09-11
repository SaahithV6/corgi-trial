/**
 * The rounding rule, as pure integer arithmetic, plus the vocabulary the rest
 * of `src/lib/accrual` speaks.
 *
 * ============================================================================
 * NO FLOAT EVER TOUCHES THIS FILE, INCLUDING THE INTERMEDIATES
 * ============================================================================
 *
 * Every operand and every result is `bigint` cents or a small `number` that
 * counts days. There is no `/` on a `number` anywhere in the allocation, no
 * `Math.round`, no `toFixed`, no `Number(...)` of a money value. `bigint`
 * division in JavaScript truncates toward zero, and every operand here is
 * positive, so `F / N` IS the floor — the same answer Postgres gives for the
 * same expression, which is the whole reason the database can re-derive these
 * numbers and refuse a row that disagrees.
 *
 * ============================================================================
 * THE RULE, AND WHY IT IS THE ONE ALREADY IN THE REPOSITORY
 * ============================================================================
 *
 * research/ledger/DESIGN.md §12 — the rule the T+2h attack plan committed to
 * on the thread ("banker's rounding with the residual penny assigned
 * deterministically") — has two clauses, and the interesting part of daily
 * accrual is knowing which one applies.
 *
 *   §12.2  ONE value -> ONE cent amount: round half to even.
 *   §12.3  ONE amount split across N shares: largest remainder. Floor each
 *          share; distribute the shortfall one penny at a time.
 *          "This guarantees Σ shares = source EXACTLY, always."
 *   §12.4  Ties — and therefore the residual penny — break by ORDINAL
 *          ASCENDING, fixed by the posting template.
 *
 * A monthly fee accrued daily is §12.3, not §12.2, and getting that wrong is
 * the actual bug this feature exists to avoid. Half-even applied per day to a
 * $25.00 plan over 30 days gives 83¢ every day and bills $24.90 for a $25.00
 * product. Every day is individually "correctly rounded" and the month is
 * wrong by a dime. Allocate the month, do not round the days.
 *
 * Because every day's share of F/N has the SAME fractional remainder, §12.3's
 * "largest remainder" comparison is a thirty-way tie and §12.4 decides the
 * entire allocation on its own. The ordinal is the day of the month, so the
 * first `F mod N` days carry the extra cent:
 *
 *     q = F / N (floor)      r = F mod N       0 ≤ r < N
 *     share(d) = q + (d ≤ r ? 1 : 0)
 *     cum(d)   = q·d + min(d, r)
 *     cum(N)   = q·N + r = F          ← exactly, by construction, always
 *
 * ============================================================================
 * THIS IS NOT THE ONLY COPY, AND THAT IS DELIBERATE — BUT IT IS NOT A SECOND
 * DEFINITION EITHER
 * ============================================================================
 *
 * `accrual_daily_share()` in migration 0020 §8 computes the same thing, and
 * `accrual_posting_arithmetic` is a CHECK constraint that calls it. DECISIONS
 * 024's lesson was that two definitions held equal by an invariant cannot be
 * fixed one at a time — so this is not two definitions. This one computes; the
 * database one VERIFIES, and refuses to store any row where they disagree.
 * A computation plus a proof. If this file ever drifts by a cent, no row can
 * be written at all, which is the failure mode you want.
 */

import { z } from "zod";

import type { InterestRunReport } from "./interest-types";

/* -------------------------------------------------------------------------- */
/* Vocabulary — mirrors the enums in 0020_accrual.sql exactly                  */
/* -------------------------------------------------------------------------- */

/** `accrual_product` in 0020. One value today; the enum is the extension point. */
export type AccrualProduct = "platform_fee";

/** `accrual_disposition` in 0020. A claimed day with no row here is undecided. */
export type AccrualDisposition = "posted" | "skipped";

/** The chart account a platform fee is credited to. 4200's own `why` names it. */
export const FEE_INCOME_CODE = "4200";

/**
 * How far back one tick will catch up.
 *
 * Unlike a standing order, a missed accrual day is not a conversation: the fee
 * accrued whether or not the job ran, the amount is bounded by the monthly
 * price, and the entry carries the date it accrued FOR. So the window exists
 * only to stop a schedule enrolled last year from trying to backfill a year in
 * one serverless invocation. Anything older stays visible in `v_accrual_gap`.
 */
export const CATCH_UP_WINDOW_DAYS = 45;

/** How many (schedule, date) pairs one tick will process. Bounded: serverless. */
export const DEFAULT_RUN_LIMIT = 400;

/* -------------------------------------------------------------------------- */
/* The allocation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One day's share of one month's fee, with the whole working exposed.
 *
 * Every field is on the screen and every field is a column on `accrual_posting`
 * that the database re-derives. "A number a customer cannot reproduce by hand
 * is a number they will dispute" — so the row carries the hand calculation, not
 * just its answer.
 */
export type DailyAllocation = {
  /** F — the quoted monthly price, integer cents. The only money input. */
  readonly monthlyCents: bigint;
  /** N — days in the calendar month this date belongs to (28–31). */
  readonly daysInMonth: number;
  /** d — day of the month, 1…N. This is the §12.4 ordinal. */
  readonly dayOfMonth: number;
  /** q = F div N. What every day gets before the residual is placed. */
  readonly baseShareCents: bigint;
  /** r = F mod N. How many pennies largest-remainder has to place this month. */
  readonly residualPennies: number;
  /** Whether THIS day is one of the first r and therefore carries one. */
  readonly residualApplied: boolean;
  /** share(d) = q + (d ≤ r). What is posted today. */
  readonly amountCents: bigint;
  /** cum(d) = q·d + min(d, r). Month-to-date INCLUDING today. */
  readonly cumulativeCents: bigint;
  /** F − cum(d). What the rest of the month still owes. Zero on day N. */
  readonly remainingCents: bigint;
};

export class AccrualInputError extends Error {
  override readonly name = "AccrualInputError";
}

/**
 * Days in the calendar month a `YYYY-MM-DD` belongs to.
 *
 * `Date.UTC(y, m, 0)` is the last day of month `m` (1-based), because day 0 of
 * the next month is the last day of this one. UTC throughout: a date-only
 * string is a calendar date, not an instant, and constructing it in local time
 * is how a value date lands on the wrong business day — the same trap
 * `src/lib/format/datetime.ts` documents for rendering.
 */
export function daysInMonth(isoDate: string): number {
  const parts = parseIsoDate(isoDate);
  return new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
}

/** The day-of-month ordinal of a `YYYY-MM-DD`. */
export function dayOfMonth(isoDate: string): number {
  return parseIsoDate(isoDate).day;
}

/** `YYYY-MM` — the month a date belongs to, used to group a screen. */
export function monthOf(isoDate: string): string {
  const { year, month } = parseIsoDate(isoDate);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIsoDate(isoDate: string): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} {
  const match = ISO_DATE.exec(isoDate);
  if (match === null) {
    throw new AccrualInputError(`'${isoDate}' is not a YYYY-MM-DD business date`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) {
    throw new AccrualInputError(`'${isoDate}' has no month ${month}`);
  }
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > last) {
    throw new AccrualInputError(`'${isoDate}' has no day ${day}: that month has ${last}`);
  }
  return { year, month, day };
}

/**
 * The whole rounding rule, for one day.
 *
 * Integer division on `bigint`, truncating toward zero — which is the floor,
 * because `monthlyCents > 0` and `daysInMonth > 0` are both checked first. The
 * comparison `d ≤ r` is §12.4's ordinal-ascending tiebreak and there is nothing
 * else to compare, because a uniform split makes every remainder equal.
 */
export function allocateDay(args: {
  readonly monthlyCents: bigint;
  readonly daysInMonth: number;
  readonly dayOfMonth: number;
}): DailyAllocation {
  const { monthlyCents } = args;
  const n = args.daysInMonth;
  const d = args.dayOfMonth;

  if (monthlyCents <= 0n) {
    throw new AccrualInputError(`a monthly price must be positive cents, got ${monthlyCents}`);
  }
  if (!Number.isInteger(n) || n < 28 || n > 31) {
    throw new AccrualInputError(`${n} is not a number of days in a calendar month`);
  }
  if (!Number.isInteger(d) || d < 1 || d > n) {
    throw new AccrualInputError(`day ${d} is not in a month of ${n} days`);
  }

  const nBig = BigInt(n);
  const dBig = BigInt(d);

  const baseShareCents = monthlyCents / nBig; // floor: both operands positive
  const residualPennies = Number(monthlyCents % nBig); // 0 ≤ r < N ≤ 31
  const residualApplied = d <= residualPennies;
  const amountCents = baseShareCents + (residualApplied ? 1n : 0n);
  const cumulativeCents =
    baseShareCents * dBig + (dBig < BigInt(residualPennies) ? dBig : BigInt(residualPennies));

  return {
    monthlyCents,
    daysInMonth: n,
    dayOfMonth: d,
    baseShareCents,
    residualPennies,
    residualApplied,
    amountCents,
    cumulativeCents,
    remainingCents: monthlyCents - cumulativeCents,
  };
}

/** `allocateDay` for a business date, which knows its own month length. */
export function allocateForDate(monthlyCents: bigint, isoDate: string): DailyAllocation {
  return allocateDay({
    monthlyCents,
    daysInMonth: daysInMonth(isoDate),
    dayOfMonth: dayOfMonth(isoDate),
  });
}

/**
 * The sentence a customer reads, built from the same integers the ledger used.
 *
 * Deliberately arithmetic and not prose: `$25.00 ÷ 30 = 83¢ with 10¢ left over;
 * day 10 is one of the first 10, so it carries one of them → 84¢`. Somebody
 * with a calculator can check it, which is the entire requirement.
 */
export function explainAllocation(a: DailyAllocation): string {
  const price = centsToPlainUsd(a.monthlyCents);
  const base = `${a.baseShareCents}¢`;
  const head = `${price} ÷ ${a.daysInMonth} days = ${base} per day, with ${a.residualPennies}¢ left over`;
  const tail = a.residualApplied
    ? `day ${a.dayOfMonth} is one of the first ${a.residualPennies}, so it carries one of those pennies: ${base} + 1¢ = ${a.amountCents}¢`
    : `day ${a.dayOfMonth} is past the first ${a.residualPennies}, so it carries none: ${a.amountCents}¢`;
  return `${head}. ${tail}.`;
}

/** `2500n` → `"$25.00"`, by integer division. Never `/ 100`. */
function centsToPlainUsd(cents: bigint): string {
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  return `${negative ? "-" : ""}$${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, "0")}`;
}

/* -------------------------------------------------------------------------- */
/* Rows, as the store hands them back                                         */
/* -------------------------------------------------------------------------- */

export type AccrualSchedule = {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly businessId: string | null;
  readonly businessName: string | null;
  readonly product: AccrualProduct;
  readonly planName: string;
  readonly monthlyCents: bigint;
  readonly currency: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly scheduleKey: string;
  readonly createdAt: string;
  /** The oldest date this schedule owes and nothing has claimed. */
  readonly nextDueDate: string | null;
};

export type AccrualPosting = {
  readonly accrualDayId: string;
  readonly scheduleId: string;
  readonly planName: string;
  readonly accountId: string;
  readonly businessName: string | null;
  /** The business date this accrued FOR. The entry's value date. */
  readonly accrualDate: string;
  /** `accrual:<schedule>:<YYYY-MM-DD>`, generated by Postgres. */
  readonly idempotencyKey: string;
  readonly claimedAt: string;
  readonly claimedBy: string;

  readonly disposition: AccrualDisposition | null;
  readonly entryId: string | null;
  readonly skipReason: string | null;
  /** Null while the day is claimed and undecided — nothing was computed yet. */
  readonly allocation: DailyAllocation | null;
  readonly decidedAt: string | null;
  readonly decidedByRun: string | null;
};

/** One (schedule, month) roll-up, from `v_accrual_month`. */
export type AccrualMonth = {
  readonly scheduleId: string;
  readonly accountId: string;
  readonly businessName: string | null;
  readonly planName: string;
  readonly monthStart: string;
  readonly daysInMonth: number;
  readonly monthlyCents: bigint;
  readonly residualPenniesInMonth: number;
  readonly daysClaimed: number;
  readonly daysDecided: number;
  readonly daysPosted: number;
  readonly daysSkipped: number;
  readonly residualPenniesApplied: number;
  readonly accruedCents: bigint;
  readonly remainingCents: bigint;
  readonly monthComplete: boolean;
};

/**
 * The four questions 0020 §13 says the database can be asked at any moment.
 *
 * On the screen rather than only in a test, because a test proves a thing once
 * and a screen proves it while somebody is watching.
 */
export type AccrualInvariants = {
  /** Complete months whose postings do not sum to the price. MUST be 0. */
  readonly monthDrift: number;
  /** Postings that disagree with the entry they cite. MUST be 0. */
  readonly ledgerDrift: number;
  /** Claimed, never decided. Safe — nothing posted — but never invisible. */
  readonly unresolved: number;
  /** Owed days nothing has claimed. Non-zero means the tick is behind. */
  readonly gap: number;
};

/* -------------------------------------------------------------------------- */
/* What one tick reports                                                      */
/* -------------------------------------------------------------------------- */

export type DayReport = {
  readonly scheduleId: string;
  readonly planName: string;
  readonly accountId: string;
  readonly accrualDate: string;
  readonly accrualDayId: string;
  readonly idempotencyKey: string;
  /** False when the claim row already existed — a duplicate tick, or a retry. */
  readonly claimedNow: boolean;
  readonly action: AccrualDisposition | "deferred";
  readonly entryId: string | null;
  /**
   * True when this tick found the work already done.
   *
   * THE DOUBLE-RUN PROOF, as a field: the second run of the same day reports
   * `replayed: true` and the SAME `entryId` as the first, because the key is
   * derived from the schedule and the date and `journal_entry.idempotency_key`
   * is UNIQUE.
   */
  readonly replayed: boolean;
  readonly allocation: DailyAllocation | null;
  readonly reason: string | null;
};

export type AccrualRunResult = {
  readonly runId: string;
  readonly asOf: string;
  /** Today in book time, as the database answers it. Never a Node `Date`. */
  readonly bookDate: string;
  readonly considered: number;
  readonly posted: number;
  readonly skipped: number;
  readonly deferred: number;
  readonly replayed: number;
  /** Total cents posted by this tick. Zero on a pure replay. */
  readonly postedCents: bigint;
  readonly days: readonly DayReport[];
  /**
   * The interest leg of the SAME tick — see `interest.ts`.
   *
   * A separate field rather than more `days`, because they are different
   * arithmetic on different tables with different exactly-once keys, and a
   * reader of this report should not have to guess which rule produced a row.
   *
   * EVERY MONEY FIELD INSIDE IT IS A DECIMAL STRING, not a `bigint`.
   * `/api/cron/accrual` serialises this whole object with `NextResponse.json`,
   * `JSON.stringify` throws on a `bigint`, and that route hand-narrows exactly
   * the four bigint fields it knows about. A new one would have been a 500 on
   * the cron path — so the interest report crosses that boundary already
   * narrowed, as decimal strings and never as `number`.
   */
  readonly interest: InterestRunReport;
  readonly durationMs: number;
};

/* -------------------------------------------------------------------------- */
/* Input validation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The one operator-supplied input the tick takes.
 *
 * A business date can be overridden — that is how the debrief replays a
 * specific day — but it is validated as a calendar date first, because it ends
 * up as a `::date` cast and as half of an idempotency key.
 */
export const accrualRunInputSchema = z.object({
  bookDate: z
    .string()
    .regex(ISO_DATE, "a business date is YYYY-MM-DD")
    .optional(),
  limit: z.number().int().min(1).max(2000).optional(),
});

export type AccrualRunInput = z.infer<typeof accrualRunInputSchema>;
