/**
 * The accruals screen's data contract.
 *
 * Same seam, and the same rules, as `src/components/standing/data-contract.ts`:
 * nothing under `src/components/**` opens a connection, imports `postgres`, or
 * reaches into `src/lib/accrual/*` for anything but these types. The screen
 * depends on this interface; `src/lib/accrual/screen.ts` implements it against
 * the live database and `./fixtures.ts` implements it without one.
 *
 * Shape notes:
 *
 * - **Every amount is integer minor units (US cents)**, never dollars, never a
 *   float. `number` rather than `bigint` because these cross the server/client
 *   boundary and `bigint` does not survive JSON; the engine works in `bigint`
 *   throughout and narrows once, at the edge, in `screen.ts`.
 * - **`daysInMonth`, `dayOfMonth` and `residualPennies` are counts, not money.**
 *   They are the only plain integers here that are not cents, and they are
 *   named so that is obvious.
 * - **Accrual dates are `YYYY-MM-DD`**; instants are ISO 8601. Different types
 *   because they are different clocks — and on this screen that distinction is
 *   the point, because the whole feature turns on an entry whose value date is
 *   the day it accrued FOR rather than the day the job ran.
 * - **Failure is a value, not a throw**, so the error state is a branch.
 * - **The screen never writes.** Accruing is a cron or an authenticated POST
 *   with a run id attached; a render is not one.
 */

import type { ErrorShape, Result } from "@/lib/result";
import type { AccrualDisposition, AccrualProduct } from "@/lib/accrual/types";
import type {
  InterestDisposition,
  InterestRounding,
  InterestSide,
} from "@/lib/accrual/interest-types";

/** Integer minor units (US cents). Never dollars. */
export type Cents = number;
/** ISO 8601 instant. */
export type Instant = string;
/** `YYYY-MM-DD`. The business-date axis, not an instant. */
export type BusinessDate = string;

export type { AccrualDisposition, AccrualProduct };
export type { InterestDisposition, InterestRounding, InterestSide };

/* -------------------------------------------------------------------------- */
/* Interest — the other half of the ladder                                    */
/* -------------------------------------------------------------------------- */

/**
 * One business date of interest, worked out in full.
 *
 * The fee's `Arithmetic` above is DESIGN §12.3 — one amount split across the
 * days of a month, so the shares must add back up to it. This is §12.2 — one
 * balance, one rate, one day, one cent amount — and the fields are different
 * because the calculation is different. Showing them in the same shape would
 * be the beginning of pretending there is one rule.
 *
 * `numerator` and `denominator` are the exact fraction as the two integers it
 * actually is, so a reader can do the division themselves. They are counts of
 * scaled units, not money, and are named so that is obvious.
 */
export type InterestArithmetic = {
  /** The settled ledger balance at the end of the business date. SIGNED. */
  readonly basisBalanceCents: Cents;
  /** Which side the sign of that balance put the day on. */
  readonly side: InterestSide;
  /** The annual rate for that side, in basis points. 150 = 1.50% a year. */
  readonly rateBps: number;
  /** The day-count denominator. 365 is ACT/365 fixed; see `docs/ACCRUAL.md` §13. */
  readonly dayCount: number;
  /** N = |balance| × rateBps. A count of scaled units, not money. */
  readonly numerator: number;
  /** D = 10000 × dayCount. Likewise. */
  readonly denominator: number;
  /** q = N div D. Whole cents before the rounding decision. */
  readonly wholeCents: Cents;
  /** r = N mod D. The sub-cent fraction that was dropped, out of D. */
  readonly remainderUnits: number;
  /** Which of DESIGN §12.2's four cases this was. */
  readonly rounding: InterestRounding;
  /** The magnitude posted. */
  readonly amountCents: Cents;
  /** The SIGNED effect on the customer's deposit balance. */
  readonly customerEffectCents: Cents;
  /** The hand calculation, built from the same integers. */
  readonly explanation: string;
};

/** One version of the rate card. `v_interest_rate_card`. */
export type RateCardRow = {
  readonly id: string;
  readonly tier: string;
  readonly tierDescription: string;
  readonly effectiveFrom: BusinessDate;
  /** The next version's effective date; `null` while this one is current. */
  readonly supersededOn: BusinessDate | null;
  readonly creditRateBps: number;
  readonly overdraftRateBps: number;
  readonly dayCountDenominator: number;
  readonly note: string;
  readonly createdAt: Instant;
  /** How many days on the book this version priced. */
  readonly daysPriced: number;
};

/** One interest enrolment. */
export type InterestScheduleRow = {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly businessName: string | null;
  readonly rateTier: string;
  readonly currency: string;
  readonly startDate: BusinessDate;
  readonly endDate: BusinessDate | null;
  readonly scheduleKey: string;
  readonly nextDueDate: BusinessDate | null;
  /** The settled balance at the book date. Derived on every read, never stored. */
  readonly currentBalanceCents: Cents;
};

/** One claimed interest day and what happened to it. */
export type InterestDayRow = {
  readonly interestDayId: string;
  readonly scheduleId: string;
  readonly accountId: string;
  readonly businessName: string | null;
  readonly rateTier: string;
  readonly accrualDate: BusinessDate;
  /** `interest:<enrolment>:<YYYY-MM-DD>` — generated by Postgres, not by us. */
  readonly idempotencyKey: string;
  readonly claimedAt: Instant;
  readonly claimedBy: string;
  readonly disposition: InterestDisposition | null;
  readonly entryId: string | null;
  readonly skipReason: string | null;
  readonly arithmetic: InterestArithmetic | null;
  /** Which rate card version priced it, and from when it was effective. */
  readonly policyId: string | null;
  readonly policyEffectiveFrom: BusinessDate | null;
  /** The booking watermark the basis was read at. Without it, not reproducible. */
  readonly observedBookingSeq: string | null;
  readonly decidedAt: Instant | null;
  readonly decidedByRun: string | null;
};

/** One (enrolment, month) roll-up. No target: daily interest has no monthly total. */
export type InterestMonthRow = {
  readonly scheduleId: string;
  readonly businessName: string | null;
  readonly rateTier: string;
  readonly monthStart: BusinessDate;
  readonly daysClaimed: number;
  readonly daysPosted: number;
  readonly daysSkipped: number;
  readonly daysCredit: number;
  readonly daysOverdraft: number;
  readonly daysRoundedUp: number;
  readonly daysRoundedDown: number;
  readonly daysTieToEven: number;
  readonly daysExact: number;
  readonly creditInterestCents: Cents;
  readonly overdraftInterestCents: Cents;
  readonly minBasisCents: Cents | null;
  readonly maxBasisCents: Cents | null;
};

/**
 * What the database says about overdrafts, measured on every render.
 *
 * On the screen because the honest state of this feature is that ONE of its
 * two sides has rows and the other does not, and a screen that showed only the
 * side with rows would be quietly claiming a capability. `daysInWindow` is the
 * strong form of the question — not "is anybody overdrawn right now" but "has
 * any deposit leaf been in debit on any value date in the catch-up window" —
 * because a feature that has never fired is not the same as one that is not
 * firing this minute.
 */
export type InterestInvariantsView = {
  /** `v_interest_ledger_drift` — a posting that disagrees with its entry. MUST be 0. */
  readonly ledgerDrift: number;
  /** `v_interest_rate_drift` — a day re-priced by a later rate. MUST be 0. */
  readonly rateDrift: number;
  /** `v_interest_unresolved` — claimed, never decided. Safe, never invisible. */
  readonly unresolved: number;
  /** `v_interest_gap` — owed days nothing has claimed. */
  readonly gap: number;
  /** `v_overdrawn_accounts` — deposit leaves in debit right now. */
  readonly overdrawnAccounts: number;
  /** Deposit leaves in debit on any value date in the catch-up window. */
  readonly overdrawnDaysInWindow: number;
};

export type InterestPanelView = {
  readonly rateCard: readonly RateCardRow[];
  readonly schedules: readonly InterestScheduleRow[];
  readonly days: readonly InterestDayRow[];
  readonly months: readonly InterestMonthRow[];
  readonly invariants: InterestInvariantsView;
  /** Present when an interest day is selected in the URL. */
  readonly selected: InterestDayRow | null;
};

/* -------------------------------------------------------------------------- */
/* The arithmetic, as the screen renders it                                   */
/* -------------------------------------------------------------------------- */

/**
 * One day's working, in full.
 *
 * This is the requirement rendered as a type: "Show the arithmetic on screen:
 * rate, basis, days, the exact fraction, and where the residual landed." Every
 * field here is a column on `accrual_posting` that migration 0020's CHECK
 * constraint re-derives, so the screen is not paraphrasing the calculation —
 * it is showing the operands the database verified.
 */
export type Arithmetic = {
  /** F — the quoted monthly price. The basis, and the only money input. */
  readonly monthlyCents: Cents;
  /** N — days in this calendar month. A count, not money. */
  readonly daysInMonth: number;
  /** d — day of the month. The ordinal that breaks the tie (DESIGN §12.4). */
  readonly dayOfMonth: number;
  /** q = F div N. What every day of the month gets before the residual. */
  readonly baseShareCents: Cents;
  /** r = F mod N. How many pennies the month has to place. A count. */
  readonly residualPennies: number;
  /** Whether THIS day is one of the first r and therefore carries one. */
  readonly residualApplied: boolean;
  /** share(d). What was posted on this date. */
  readonly amountCents: Cents;
  /** cum(d) = q·d + min(d, r). Month-to-date including this day. */
  readonly cumulativeCents: Cents;
  /** F − cum(d). Zero on the last day of the month, exactly. */
  readonly remainingCents: Cents;
  /** The one-sentence hand calculation, built from the same integers. */
  readonly explanation: string;
};

/* -------------------------------------------------------------------------- */
/* A schedule                                                                 */
/* -------------------------------------------------------------------------- */

export type ScheduleRow = {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly businessName: string | null;
  readonly product: AccrualProduct;
  readonly planName: string;
  readonly monthlyCents: Cents;
  readonly currency: string;
  readonly startDate: BusinessDate;
  readonly endDate: BusinessDate | null;
  /** Derived from the fact that created the enrolment. UNIQUE in the database. */
  readonly scheduleKey: string;
  readonly createdAt: Instant;
  /** The oldest owed date nothing has claimed. `null` when fully caught up. */
  readonly nextDueDate: BusinessDate | null;
};

/* -------------------------------------------------------------------------- */
/* A day                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One (schedule, date) pair and what happened to it.
 *
 * `disposition === null` is not an error and not a pending flag: it is a claim
 * with no outcome row, which means a process took the day and did not finish.
 * Nothing posted. The next tick re-drives it to the same entry through the same
 * derived key. The screen shows it, because the failure mode worth fearing in a
 * nightly job is a MISSING row, and the cure is that the claim is a presence
 * rather than an absence somebody has to notice.
 */
export type DayRow = {
  readonly accrualDayId: string;
  readonly scheduleId: string;
  readonly planName: string;
  readonly accountId: string;
  readonly businessName: string | null;
  /** The business date this accrued FOR — the journal entry's value date. */
  readonly accrualDate: BusinessDate;
  /** `accrual:<schedule id>:<YYYY-MM-DD>` — generated by Postgres, not by us. */
  readonly idempotencyKey: string;
  readonly claimedAt: Instant;
  readonly claimedBy: string;

  readonly disposition: AccrualDisposition | null;
  /** The journal entry. `null` on a skipped day and on an undecided one. */
  readonly entryId: string | null;
  readonly skipReason: string | null;
  /** `null` only while the day is claimed and undecided. */
  readonly arithmetic: Arithmetic | null;
  readonly decidedAt: Instant | null;
  readonly decidedByRun: string | null;
};

/* -------------------------------------------------------------------------- */
/* A month                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One (schedule, month) roll-up, from `v_accrual_month`.
 *
 * `accruedCents === monthlyCents` on a complete month is the single claim the
 * rounding rule makes, and this row is where a viewer checks it.
 */
export type MonthRow = {
  readonly scheduleId: string;
  readonly planName: string;
  readonly businessName: string | null;
  readonly monthStart: BusinessDate;
  readonly daysInMonth: number;
  readonly monthlyCents: Cents;
  readonly residualPenniesInMonth: number;
  readonly residualPenniesApplied: number;
  readonly daysClaimed: number;
  readonly daysDecided: number;
  readonly daysPosted: number;
  readonly daysSkipped: number;
  readonly accruedCents: Cents;
  readonly remainingCents: Cents;
  readonly monthComplete: boolean;
};

/* -------------------------------------------------------------------------- */
/* Invariants                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The four questions migration 0020 §13 says the database can be asked at any
 * moment, asked on every render.
 *
 * The first two must be zero forever. They are on the screen rather than only
 * in a test because a test proves a thing once and a screen proves it while
 * somebody is watching.
 */
export type AccrualInvariants = {
  /** `v_accrual_month_drift` — a complete month that does not sum to the price. */
  readonly monthDrift: number;
  /** `v_accrual_ledger_drift` — a posting that disagrees with its journal entry. */
  readonly ledgerDrift: number;
  /** `v_accrual_unresolved` — claimed, never decided. Safe, never invisible. */
  readonly unresolved: number;
  /** `v_accrual_gap` — owed days nothing has claimed. The tick is behind. */
  readonly gap: number;
};

/* -------------------------------------------------------------------------- */
/* The view                                                                   */
/* -------------------------------------------------------------------------- */

/** Where the numbers came from. Rendered always — a figure without provenance is a rumour. */
export type AccrualSource = "live" | "fixture";

export type AccrualView = {
  readonly source: AccrualSource;
  /** The instant the read was taken. Every age on screen is measured to this. */
  readonly asOf: Instant;
  /** Today in book time (America/New_York), as the database answers it. */
  readonly bookDate: BusinessDate;
  readonly schedules: readonly ScheduleRow[];
  /** Newest accrual date first. Every claimed day, decided or not. */
  readonly days: readonly DayRow[];
  readonly months: readonly MonthRow[];
  readonly invariants: AccrualInvariants;
  /** Present when a day is selected in the URL. */
  readonly selected: DayRow | null;
  /**
   * The interest half of the ladder: the rate card, who is enrolled, what each
   * day was priced on, and the two invariants that must stay at zero.
   *
   * A sibling of the fee fields rather than merged into them, because they are
   * different arithmetic under different clauses of DESIGN §12 — §12.3 for the
   * fee, §12.2 for interest — and a screen that put them in one table would be
   * inviting a reader to add a column that does not add up.
   */
  readonly interest: InterestPanelView;
};

export type AccrualQuery = {
  /** Show only this schedule's days. Omit for all of them. */
  readonly scheduleId?: string | undefined;
  /** Drill into one day's arithmetic. */
  readonly accrualDayId?: string | undefined;
  /** Drill into one interest day's arithmetic. */
  readonly interestDayId?: string | undefined;
};

export interface AccrualDataSource {
  load(query: AccrualQuery): Promise<Result<AccrualView, ErrorShape>>;
}
