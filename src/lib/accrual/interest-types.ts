/**
 * Daily interest: the rounding rule as pure integer arithmetic, plus the
 * vocabulary the rest of the interest leg speaks.
 *
 * ============================================================================
 * NO FLOAT EVER TOUCHES THIS FILE, INCLUDING THE INTERMEDIATES
 * ============================================================================
 *
 * Every operand and every result is `bigint` cents, `bigint` scaled units, or
 * a small `number` that counts basis points or days. There is no `/` on a
 * `number` anywhere in the calculation, no `Math.round`, no `toFixed`, no
 * `Number(...)` of a money value. `bigint` division in JavaScript truncates
 * toward zero and every operand here is non-negative by construction — the
 * magnitude is taken first — so `N / D` IS the floor, which is the same answer
 * Postgres gives for the same expression. That is what lets migration 0024's
 * `interest_posting_arithmetic` CHECK re-derive these numbers and refuse a row
 * that disagrees.
 *
 * ============================================================================
 * WHICH CLAUSE OF DESIGN §12 GOVERNS, AND WHY IT IS NOT THE FEE'S CLAUSE
 * ============================================================================
 *
 * `research/ledger/DESIGN.md` §12 has two rounding rules and the whole skill
 * is knowing which one a given calculation is:
 *
 *   §12.2  ONE value -> ONE cent amount: round HALF TO EVEN.
 *   §12.3  ONE amount split across N shares: LARGEST REMAINDER — floor each
 *          share, distribute the shortfall one penny at a time, so that
 *          "Σ shares = source EXACTLY, always".
 *
 * `types.ts` argues — correctly — that a MONTHLY FEE ACCRUED DAILY is §12.3.
 * The month has a total, the days are shares of it, and rounding each day
 * independently bills $24.90 for a $25.00 plan.
 *
 * **DAILY INTEREST IS §12.2, and §12.3 is not merely worse here — it is
 * UNDEFINED.** Largest-remainder needs a SOURCE AMOUNT to distribute. Daily
 * interest has none: there is no month-total to allocate, because the balance
 * changes every day and the month's interest is not a known number until the
 * month has happened. You cannot floor N shares of a number you do not have,
 * and you cannot distribute a shortfall against a total that does not exist.
 *
 * What daily interest IS, exactly, is one value — a balance, a rate and one
 * day — becoming one cent amount. That is §12.2's sentence with nothing left
 * to interpret.
 *
 *     amount = round_half_even( |balance| × rate_bps / (10000 × dayCount) )
 *
 * HALF TO EVEN AND NOT HALF UP, for §12.2's own stated reason: "half-up biases
 * every tie in one direction, and over a year of interchange that bias is a
 * real number." Here the tie is the exact half cent, and half-up would hand it
 * to the same party every single time — to us on an overdraft, to the customer
 * on a credit balance.
 *
 * ROUNDING IS SYMMETRIC IN THE SIGN. `sideOf()` takes the sign and
 * `computeDailyInterest()` rounds the MAGNITUDE. Rounding a signed number with
 * truncating division would round every overdraft charge away from zero and
 * every credit payment toward it — a systematic bias in the bank's favour that
 * no line of code would have had to state out loud.
 *
 * NOBODY EATS A RESIDUAL PENNY, AND THAT IS NOT A CONTRADICTION OF §12.3.
 * §12.3's residual is a real penny that has to land somewhere, because the
 * shares must sum to a source. §12.2 has no residual to place: the sub-cent
 * fraction never existed as money, no party was ever credited with it, and the
 * entry is two equal and opposite lines summing to zero. It is also why
 * §12.6's dust clearing (`2900`) is not engaged — 2900 exists for dust that
 * ARRIVED as a real external amount, such as a USDC transfer with six
 * decimals, where truncating would break the identity between customer
 * balances and our obligation. A fraction of a cent of interest is not money
 * that arrived; it is precision that was never claimed. The bound is half a
 * cent per account per day and it is unbiased by construction.
 *
 * So there are still exactly TWO rounding rules in this ledger, they are the
 * two DESIGN §12 already had, and each accrual product uses the one whose
 * precondition it actually meets. `remainderUnits` is on the row and on the
 * screen so the fraction that was dropped is visible rather than merely absent.
 *
 * ============================================================================
 * DAY COUNT: ACT/365 FIXED
 * ============================================================================
 *
 * A rate is per annum and a day is a fraction of a year; the convention is
 * which fraction. It is `dayCount` here, it is a COLUMN on the rate policy in
 * the database, and it is argued in full in `docs/ACCRUAL.md` §13 and in
 * migration 0024 §4. In one line: 12 CFR 1030 (Reg DD) Appendix A computes the
 * daily periodic rate as the annual rate over 365, so a deposit product whose
 * disclosed APY divides by 365 and whose ledger divides by 360 discloses one
 * number and pays another.
 *
 * ============================================================================
 * THIS IS NOT THE ONLY COPY, AND IT IS NOT A SECOND DEFINITION EITHER
 * ============================================================================
 *
 * `interest_round_half_even()` in migration 0024 §9 computes the same thing,
 * and `interest_posting_arithmetic` is a CHECK constraint that calls it. This
 * one COMPUTES; the database one VERIFIES, and refuses to store any row where
 * they disagree. A computation plus a proof, not two computations that can
 * drift — DECISIONS 024's lesson, and 0020's bargain, kept.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary — mirrors the enums in 0024_interest.sql exactly                */
/* -------------------------------------------------------------------------- */

/**
 * `interest_side` in 0024. Which side of the book a day lands on.
 *
 * NOT a product and not a customer choice: it is `interest_side_of(balance)`,
 * a function of the sign of the balance on that business date. A business
 * current account has a credit rate and an arranged-overdraft rate; the
 * balance decides which one is in play, and the day an account crosses zero
 * the same enrolment prices the day before on 5400 and the day after on 4400
 * with nothing reconfigured.
 */
export type InterestSide = "credit" | "overdraft" | "flat";

/** `interest_rounding` in 0024. Which way §12.2 went, recorded not inferred. */
export type InterestRounding = "exact" | "down" | "up" | "tie_to_even";

/** `accrual_disposition` in 0020, reused. A claimed day with no row is undecided. */
export type InterestDisposition = "posted" | "skipped";

/** Credit-normal. What we EARN when a customer is overdrawn. */
export const INTEREST_INCOME_CODE = "4400";
/** Debit-normal. What we PAY a customer for holding a credit balance. */
export const INTEREST_EXPENSE_CODE = "5400";

/**
 * Basis points are per ten-thousand, so a rate is scaled by 10,000.
 *
 * Integer-scaled for the reason money is: 150 bps is 1.50% a year and is the
 * integer `150`, never `0.015`. The only place this constant is used is the
 * denominator, and the denominator is built by the database too.
 */
export const BPS_SCALE = 10_000n;

/** ACT/365 fixed. The default; the policy row states the one actually used. */
export const DEFAULT_DAY_COUNT = 365;

/* -------------------------------------------------------------------------- */
/* The calculation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One business date of interest, with the whole working exposed.
 *
 * Every field is a column on `interest_posting` that the database re-derives.
 * "A number a customer cannot reproduce by hand is a number they will
 * dispute" — so the row carries the hand calculation, not just its answer.
 */
export type DailyInterest = {
  /** The settled ledger balance at the end of the business date. SIGNED. */
  readonly basisBalanceCents: bigint;
  /** Which side the sign puts this day on. */
  readonly side: InterestSide;
  /** The annual rate for that side, in basis points. */
  readonly rateBps: number;
  /** The day-count denominator — 365 (ACT/365 fixed) or 360. */
  readonly dayCount: number;
  /** N = |balance| × rateBps. The numerator of the exact fraction. */
  readonly numerator: bigint;
  /** D = 10000 × dayCount. The denominator of the exact fraction. */
  readonly denominator: bigint;
  /** q = N div D. Whole cents before the rounding decision. */
  readonly wholeCents: bigint;
  /** r = N mod D. The sub-cent fraction, as scaled units out of D. */
  readonly remainderUnits: bigint;
  /** Which of §12.2's four cases this was. */
  readonly rounding: InterestRounding;
  /** The MAGNITUDE posted, in cents. The side says who pays whom. */
  readonly amountCents: bigint;
  /** The SIGNED effect on the customer's deposit balance. */
  readonly customerEffectCents: bigint;
};

export class InterestInputError extends Error {
  override readonly name = "InterestInputError";
}

/** `interest_side_of()` in 0024 §9. The sign, and nothing else. */
export function sideOf(balanceCents: bigint): InterestSide {
  if (balanceCents > 0n) return "credit";
  if (balanceCents < 0n) return "overdraft";
  return "flat";
}

/**
 * DESIGN §12.2, in integers.
 *
 *   2r > D  -> past the half: round up
 *   2r < D  -> short of the half: round down
 *   2r = D  -> EXACTLY the half: round to the EVEN cent, i.e. up iff q is odd
 *
 * Comparing `2r` against `D` rather than `r` against `D / 2` is deliberate and
 * not a micro-optimisation: `D / 2` on integers truncates for an odd `D` and
 * would silently classify some genuine ties as "down", which is precisely the
 * bias half-even exists to remove.
 */
export function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new InterestInputError(`a denominator must be positive, got ${denominator}`);
  }
  if (numerator < 0n) {
    throw new InterestInputError(
      `roundHalfEven takes a magnitude; ${numerator} is signed. Take abs() and carry the sign in the side.`,
    );
  }
  const q = numerator / denominator;
  const r = numerator % denominator;
  const twice = 2n * r;
  if (twice > denominator) return q + 1n;
  if (twice < denominator) return q;
  // The tie. `q % 2` is 1 for odd q and 0 for even q, so this is the whole
  // half-even tiebreak with no branch: odd rounds up to the next even cent,
  // even stays where it is.
  return q + (q % 2n);
}

/** Which of the four cases `roundHalfEven` took. Recorded, never re-inferred. */
export function roundingOf(numerator: bigint, denominator: bigint): InterestRounding {
  const r = numerator % denominator;
  if (r === 0n) return "exact";
  const twice = 2n * r;
  if (twice === denominator) return "tie_to_even";
  return twice > denominator ? "up" : "down";
}

/**
 * One business date of interest on one balance at one rate.
 *
 * The magnitude is rounded and the sign is carried separately, so the rule is
 * symmetric between the two sides. A zero balance is `flat`: it prices at
 * nothing, which is a decided day with no entry rather than an error.
 */
export function computeDailyInterest(args: {
  readonly balanceCents: bigint;
  readonly rateBps: number;
  readonly dayCount: number;
}): DailyInterest {
  const { balanceCents, rateBps, dayCount } = args;

  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new InterestInputError(
      `${rateBps} is not a rate in basis points between 0 and 10000 (0%–100% a year)`,
    );
  }
  if (!Number.isInteger(dayCount) || (dayCount !== 360 && dayCount !== 365)) {
    throw new InterestInputError(
      `${dayCount} is not a day-count denominator; this ledger allows ACT/365 fixed or ACT/360`,
    );
  }

  const side = sideOf(balanceCents);
  const magnitude = balanceCents < 0n ? -balanceCents : balanceCents;

  // A flat account is priced at zero rather than at the credit rate, so the
  // stored rate matches what the lifecycle trigger expects for the side.
  const effectiveRate = side === "flat" ? 0 : rateBps;

  const numerator = magnitude * BigInt(effectiveRate);
  const denominator = BPS_SCALE * BigInt(dayCount);
  const wholeCents = numerator / denominator;
  const remainderUnits = numerator % denominator;
  const amountCents = roundHalfEven(numerator, denominator);

  return {
    basisBalanceCents: balanceCents,
    side,
    rateBps: effectiveRate,
    dayCount,
    numerator,
    denominator,
    wholeCents,
    remainderUnits,
    rounding: roundingOf(numerator, denominator),
    amountCents,
    customerEffectCents:
      side === "credit" ? amountCents : side === "overdraft" ? -amountCents : 0n,
  };
}

/**
 * The sentence a customer reads, built from the same integers the ledger used.
 *
 * Deliberately arithmetic and not prose. Somebody with a calculator can check
 * it, which is the entire requirement.
 */
export function explainInterest(a: DailyInterest): string {
  const balance = centsToPlainUsd(a.basisBalanceCents);
  const rate = bpsToPercent(a.rateBps);

  if (a.side === "flat") {
    return `The balance was exactly ${balance} at the end of the day, so there is nothing to price on either side and nothing is posted.`;
  }

  const who =
    a.side === "credit"
      ? `we pay ${rate} a year on a credit balance`
      : `we charge ${rate} a year on an overdrawn balance`;

  const head =
    `${balance} × ${a.rateBps} bps ÷ (10000 × ${a.dayCount} days) = ` +
    `${a.numerator} ÷ ${a.denominator} = ${a.wholeCents} whole cents with ` +
    `${a.remainderUnits}/${a.denominator} of a cent left over`;

  const tail = roundingSentence(a);

  return `${who}: ${head}. ${tail}`;
}

function roundingSentence(a: DailyInterest): string {
  switch (a.rounding) {
    case "exact":
      return `It divided exactly, so there was nothing to round: ${a.amountCents}¢.`;
    case "up":
      return `Twice the remainder (${2n * a.remainderUnits}) is more than ${a.denominator}, so the fraction is past a half cent and rounds up: ${a.amountCents}¢.`;
    case "down":
      return `Twice the remainder (${2n * a.remainderUnits}) is less than ${a.denominator}, so the fraction is short of a half cent and rounds down: ${a.amountCents}¢.`;
    case "tie_to_even":
      return (
        `Twice the remainder (${2n * a.remainderUnits}) is exactly ${a.denominator}, so the fraction is exactly half a cent. ` +
        `DESIGN §12.2 breaks that tie to the EVEN cent — ${a.wholeCents} is ${a.wholeCents % 2n === 0n ? "even, so it stays" : "odd, so it goes up"}: ${a.amountCents}¢. ` +
        `Half-up would have given ${a.wholeCents + 1n}¢ every time, always to the same party.`
      );
  }
}

/** `2500n` → `"$25.00"`, `-180000n` → `"-$1,800.00"`. By integer division. */
export function centsToPlainUsd(cents: bigint): string {
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  const dollars = (magnitude / 100n).toString();
  const grouped = dollars.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${(magnitude % 100n).toString().padStart(2, "0")}`;
}

/** `150` → `"1.50%"`. Integer arithmetic; basis points are per ten-thousand. */
export function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = Math.abs(bps % 100);
  return `${whole}.${String(frac).padStart(2, "0")}%`;
}

/* -------------------------------------------------------------------------- */
/* Rows, as the store hands them back                                         */
/* -------------------------------------------------------------------------- */

/** One version of the rate card. `interest_rate_policy` in 0024 §10. */
export type InterestRatePolicy = {
  readonly id: string;
  readonly tier: string;
  readonly tierDescription: string;
  readonly effectiveFrom: string;
  /** The next version's effective date, or `null` while this one is current. */
  readonly supersededOn: string | null;
  readonly creditRateBps: number;
  readonly overdraftRateBps: number;
  readonly dayCountDenominator: number;
  readonly note: string;
  readonly createdAt: string;
  /** How many days on the book were priced by this version. */
  readonly daysPriced: number;
};

/** One enrolment. `interest_schedule` in 0024 §11. */
export type InterestSchedule = {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly businessId: string | null;
  readonly businessName: string | null;
  readonly rateTier: string;
  readonly currency: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly scheduleKey: string;
  readonly createdAt: string;
  /** The oldest date this enrolment owes and nothing has claimed. */
  readonly nextDueDate: string | null;
  /** The settled balance at the book date, for context on the enrolment row. */
  readonly currentBalanceCents: bigint;
};

/** One claimed day and what happened to it. `v_interest_daily` in 0024 §16. */
export type InterestPosting = {
  readonly interestDayId: string;
  readonly scheduleId: string;
  readonly accountId: string;
  readonly businessName: string | null;
  readonly rateTier: string;
  /** The business date this is interest FOR. The entry's value date. */
  readonly accrualDate: string;
  /** `interest:<schedule>:<YYYY-MM-DD>`, generated by Postgres. */
  readonly idempotencyKey: string;
  readonly claimedAt: string;
  readonly claimedBy: string;

  readonly disposition: InterestDisposition | null;
  readonly entryId: string | null;
  readonly skipReason: string | null;
  /** Null while the day is claimed and undecided — nothing was computed yet. */
  readonly interest: DailyInterest | null;
  /** Which rate card version priced it, and from when it was effective. */
  readonly policyId: string | null;
  readonly policyEffectiveFrom: string | null;
  /** The booking watermark the basis balance was read at. */
  readonly observedBookingSeq: bigint | null;
  readonly decidedAt: string | null;
  readonly decidedByRun: string | null;
};

/** One (enrolment, month) roll-up. `v_interest_month` in 0024 §16. */
export type InterestMonth = {
  readonly scheduleId: string;
  readonly accountId: string;
  readonly businessName: string | null;
  readonly rateTier: string;
  readonly monthStart: string;
  readonly daysClaimed: number;
  readonly daysDecided: number;
  readonly daysPosted: number;
  readonly daysSkipped: number;
  readonly daysCredit: number;
  readonly daysOverdraft: number;
  readonly daysRoundedUp: number;
  readonly daysRoundedDown: number;
  readonly daysTieToEven: number;
  readonly daysExact: number;
  readonly creditInterestCents: bigint;
  readonly overdraftInterestCents: bigint;
  readonly minBasisCents: bigint | null;
  readonly maxBasisCents: bigint | null;
};

/**
 * The questions 0024 §16 says the database can be asked at any moment.
 *
 * On the screen rather than only in a test, because a test proves a thing once
 * and a screen proves it while somebody is watching.
 */
export type InterestInvariants = {
  /** `v_interest_ledger_drift` — a posting that disagrees with its entry. MUST be 0. */
  readonly ledgerDrift: number;
  /** `v_interest_rate_drift` — a day no longer priced by its own date's rate. MUST be 0. */
  readonly rateDrift: number;
  /** `v_interest_unresolved` — claimed, never decided. Safe; never invisible. */
  readonly unresolved: number;
  /** `v_interest_gap` — owed days nothing has claimed. The tick is behind. */
  readonly gap: number;
  /** `v_overdrawn_accounts` — how many deposit leaves are in debit RIGHT NOW. */
  readonly overdrawnAccounts: number;
  /**
   * Deposit leaves that were in debit on ANY value date inside the catch-up
   * window, at the live watermark.
   *
   * The strong form of the same question, and the one that says whether
   * overdraft interest has ever had anything to price. Asked because the live
   * count answers only "today", and a feature that has never fired is not the
   * same as a feature that is not firing this minute.
   */
  readonly overdrawnDaysInWindow: number;
  /**
   * How much is overdrawn right now, in cents, summed across
   * `v_overdrawn_accounts`. The count alone reads as a boolean and a boolean
   * is not a measurement.
   */
  readonly overdrawnCents: number;
  /**
   * Posted `interest_day` rows CLAIMED ON OR BEFORE THEIR OWN ACCRUAL DATE —
   * i.e. priced while the business date was still open, on a balance that was
   * not that date's closing balance.
   *
   * MUST be 0 going forward: `interestPricingHorizon()` holds the open date
   * back. It is not 0 on this book, because five rows were written before that
   * guard existed and `interest_day` is UNIQUE (schedule, date), so they can
   * never be taken again. docs/ACCRUAL.md §20.
   */
  readonly pricedBeforeClose: number;
  /** What those rows moved, in cents — the size of what cannot be taken back. */
  readonly pricedBeforeCloseCents: number;
  /**
   * `v_interest_mispriced_uncorrected` — of those rows, the ones whose date
   * HAS now closed, whose closed figure genuinely differs from what was
   * posted, and which no `interest_adjustment` has corrected. THE WORK QUEUE,
   * not an invariant.
   *
   * Zero while the mispriced dates are still open, which is not health: it is
   * the calendar. It goes non-empty by itself at midnight and back to zero
   * when `scripts/repair-0049-mispriced-interest.mjs --apply` has run.
   */
  readonly mispricedUncorrected: number;
  /** `interest_adjustment` rows: days corrected by a reversal and a re-book. */
  readonly adjustments: number;
  /**
   * `v_interest_adjustment_drift` — an adjustment whose stored decision no
   * longer re-derives from `ledger_settled_cents()` at its own watermark, or
   * from the rate card effective on its own accrual date. MUST be 0. It is
   * dbcheck check 5b's question asked of `interest_adjustment`.
   */
  readonly adjustmentDrift: number;
};

/* -------------------------------------------------------------------------- */
/* What one interest leg of a tick reports                                    */
/* -------------------------------------------------------------------------- */

/**
 * One (enrolment, date) pair's outcome, as the tick reports it.
 *
 * EVERY MONEY FIELD HERE IS A DECIMAL STRING, not a `bigint`, and that is not
 * laziness. `/api/cron/accrual` serialises the whole run result with
 * `NextResponse.json`, `JSON.stringify` throws on a `bigint`, and that route
 * is not this work's to edit. Narrowing at the boundary of the report — as a
 * decimal string, never as a `number`, which is how a cent goes missing — is
 * the same discipline `postEntry()` uses when it sends amounts to Postgres.
 */
export type InterestDayReport = {
  readonly scheduleId: string;
  readonly accountId: string;
  readonly businessName: string | null;
  readonly accrualDate: string;
  readonly interestDayId: string;
  readonly idempotencyKey: string;
  /** False when the claim row already existed — a duplicate tick, or a retry. */
  readonly claimedNow: boolean;
  readonly action: InterestDisposition | "deferred";
  readonly side: InterestSide | null;
  readonly entryId: string | null;
  /**
   * True when this tick found the work already done.
   *
   * THE DOUBLE-RUN PROOF, as a field: the second run of the same day reports
   * `replayed: true` and the SAME `entryId` as the first, because the key is
   * derived from the enrolment and the date and
   * `journal_entry.idempotency_key` is UNIQUE.
   */
  readonly replayed: boolean;
  readonly basisBalanceCents: string | null;
  readonly rateBps: number | null;
  readonly dayCount: number | null;
  readonly amountCents: string | null;
  readonly rounding: InterestRounding | null;
  readonly explanation: string | null;
  readonly reason: string | null;
};

export type InterestRunReport = {
  readonly considered: number;
  readonly posted: number;
  readonly skipped: number;
  readonly deferred: number;
  readonly replayed: number;
  /** Interest PAID to customers this tick, in cents, as a decimal string. */
  readonly creditInterestCents: string;
  /** Interest CHARGED on overdrafts this tick, in cents, as a decimal string. */
  readonly overdraftInterestCents: string;
  /**
   * The LAST BUSINESS DATE THIS TICK WAS ALLOWED TO PRICE, which is never the
   * open one. See `interestPricingHorizon()`: interest is priced on the
   * settled balance at the END of a business date, and a date that has not
   * ended has no such balance. `null` when the horizon is before every
   * enrolment and there was nothing this tick could have looked at.
   */
  readonly pricedThrough: string | null;
  /**
   * `true` when the caller asked for a date the horizon refused — i.e. the
   * current book date. Not an error: the tick reports it and prices up to the
   * last closed date instead, and the next tick takes the day once it closes.
   */
  readonly openDateHeld: boolean;
  readonly days: readonly InterestDayReport[];
};

/** An empty report, for a tick that could not run the interest leg at all. */
export const NO_INTEREST: InterestRunReport = {
  considered: 0,
  posted: 0,
  skipped: 0,
  deferred: 0,
  replayed: 0,
  creditInterestCents: "0",
  overdraftInterestCents: "0",
  pricedThrough: null,
  openDateHeld: false,
  days: [],
};
