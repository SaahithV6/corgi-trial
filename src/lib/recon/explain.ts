/**
 * Why a break exists — the correction-group classifier, as pure functions.
 *
 * ===========================================================================
 * THE ARGUMENT
 * ===========================================================================
 *
 * `v_recon_break` answers "these two numbers differ". That is a true sentence
 * and it is not an operational object. Two rows can carry the same category,
 * the same reference and the same difference and be entirely different jobs:
 *
 *   A. The provider settled $259.59, we booked $309.59, and nobody has
 *      touched it. Somebody has to work out which number is right.
 *   B. The provider settled $259.59, we booked $309.59, and forty minutes
 *      later we reversed our entry and re-booked it at $259.59. The
 *      difference on the screen is the record of a mistake we have already
 *      corrected.
 *
 * An operator who cannot tell A from B at a glance will, within a week, treat
 * every row as B — because most rows are B on a healthy book — and that is how
 * a real break gets signed off. So the distinction is a FIRST-CLASS FIELD, not
 * a footnote in a drill-through.
 *
 * This module is the classifier. It is pure: no `server-only`, no connection,
 * no clock. It takes the facts of a break and the entries of its correction
 * group and returns what class of thing it is, what is still outstanding, and
 * which time axis its age should be measured on. `explain-read.ts` is the part
 * that goes to the database.
 *
 * MONEY IS `bigint` CENTS. There is no division and no `Number` anywhere in
 * this file; the only arithmetic is `+` and `-` on `bigint`.
 *
 * ===========================================================================
 * THE FOUR CLASSES, AND WHAT EACH ONE COSTS IF IT IS WRONG
 * ===========================================================================
 *
 *   not_a_correction    No reversal behind this break. Either a genuine
 *                       discrepancy or an adjudicated one; either way the
 *                       system cannot explain it from its own rows.
 *
 *   correction_open     A reversal with no re-book yet. THE DANGEROUS ONE.
 *                       We have un-booked something and not yet booked what
 *                       replaces it, so the book is currently carrying
 *                       nothing where the provider is carrying money. It is
 *                       explainable and it is emphatically not resolved.
 *
 *   correction_closed   Reversal AND re-book, and the group now nets to the
 *                       file's number EXACTLY. This is the only class that
 *                       may read as answered.
 *
 *   correction_residual Reversal and re-book happened, and the group still
 *                       does not net to the file. The correction is part of
 *                       the story and it is not the whole story: there is
 *                       money left over and somebody still has to work it.
 *
 * The fourth class exists because of the failure this build has hit repeatedly
 * — a guard whose exclusion is shaped exactly like the thing it should catch.
 * "There is a correction group behind this" is NOT "this is fine", and
 * collapsing `correction_residual` into `correction_closed` would be exactly
 * that mistake: it would hide a real shortfall behind the fact that somebody
 * touched the reference at some point. Every classification below therefore
 * carries an `exclusionRisk` string saying, in the product and not only in the
 * documentation, what believing it could hide.
 */

import { BANKING_TIME_ZONE } from "@/lib/format/datetime";

import type { BreakKind, ExplainedBy, Severity } from "./types";
import { severityOf } from "./aging";

/* -------------------------------------------------------------------------- */
/* 1. Vocabulary                                                              */
/* -------------------------------------------------------------------------- */

export const CORRECTION_CLASSES = [
  "not_a_correction",
  "correction_open",
  "correction_closed",
  "correction_residual",
] as const;

export type CorrectionClass = (typeof CORRECTION_CLASSES)[number];

export const CORRECTION_CLASS_LABELS: Record<CorrectionClass, string> = {
  not_a_correction: "Unexplained",
  correction_open: "Correction in flight",
  correction_closed: "Corrected",
  correction_residual: "Corrected, still short",
};

/**
 * One sentence an operator can act on. Written as what to DO, because
 * "Corrected" on its own tells somebody nothing about whether to close the
 * ticket.
 */
export const CORRECTION_CLASS_MEANINGS: Record<CorrectionClass, string> = {
  not_a_correction:
    "Nothing in the book explains this. No entry under this reference has been reversed. Work it.",
  correction_open:
    "We reversed the entry behind this and have not re-booked yet. The book is carrying nothing where the provider is carrying money. This is explainable and it is not resolved.",
  correction_closed:
    "Reversed and re-booked. The correction group now nets to exactly the file's amount, so the difference on this row is the record of a mistake already fixed.",
  correction_residual:
    "Reversed and re-booked, and the book still does not agree with the file. The correction is part of the story; the remainder is a live break.",
};

/**
 * WHAT BELIEVING THIS CLASSIFICATION COULD HIDE.
 *
 * On the screen, not only in the docs. A classification that cannot state its
 * own blind spot is an opinion wearing a badge.
 */
export const CORRECTION_CLASS_EXCLUSION_RISK: Record<CorrectionClass, string> = {
  not_a_correction:
    "Nothing is excluded: this class is the default and every break that is not provably a correction lands here. It over-reports rather than under-reports, which is the safe direction.",
  correction_open:
    "Nothing is suppressed — this class is strictly louder than the engine's own verdict. What it CAN get wrong is the other way: a group whose re-book was posted under a different reference looks incomplete here, because the classifier follows correction_group_id and not intent.",
  correction_closed:
    "This is the one class that reads as answered, and the exclusion is exact equality between the group's net and the file's amount, in cents, with no tolerance. A re-book that lands a penny out stays in correction_residual by construction. What it can still hide: a group corrected to the file's number for the WRONG reason — two offsetting errors that happen to net to the provider's figure — which no amount check can distinguish from a correct re-book.",
  correction_residual:
    "Nothing is suppressed: this class keeps the full severity ladder on the value-date axis, exactly as if no correction had happened. It exists so that 'there is a correction group here' can never be read as 'this is handled'.",
};

/** Which clock a break's age is measured on. */
export type AgingAxis = "value_date" | "booking_time";

export const AGING_AXIS_LABELS: Record<AgingAxis, string> = {
  value_date: "value date",
  booking_time: "when we learned",
};

/* -------------------------------------------------------------------------- */
/* 2. Inputs                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One entry of a correction group, reduced to the facts this module needs.
 *
 * `railCents` is the entry's signed effect on the rail-control leg — the
 * single number the reconciliation compares against the file. Debit positive,
 * same axis as `scheme_file_row.amount_cents`, so an inbound settlement is
 * positive and its reversal is negative and they sum without a `CASE`.
 *
 * BOTH TIME AXES ARE MANDATORY AND NEITHER IS DERIVED FROM THE OTHER.
 * `valueDate` is the day the money belongs to; `bookingSeq` / `bookingTime`
 * are when the book learned. A reversal carries the ORIGINAL's value date —
 * that is the whole point of the bitemporal model, and it is the fact the
 * timeline exists to make visible.
 */
export interface CorrectionEntryFacts {
  readonly entryId: string;
  readonly entryType: "original" | "reversal" | "rebook";
  /** `YYYY-MM-DD`. The business day the money belongs to. */
  readonly valueDate: string;
  /** Monotonic booking position. The "when we learned" axis. */
  readonly bookingSeq: bigint;
  /** ISO instant of the booking. */
  readonly bookingTime: string;
  /** `YYYY-MM-DD` of `bookingTime` in the book's timezone. */
  readonly bookingDate: string;
  /** Signed cents on the rail-control leg. Debit positive. */
  readonly railCents: bigint;
  readonly description: string;
  readonly reversesEntryId: string | null;
}

/** The break's own numbers, plus its group. Everything the classifier reads. */
export interface CorrectionInput {
  readonly breakKind: BreakKind;
  /** `null` when the file does not carry this reference at all. */
  readonly fileAmountCents: bigint | null;
  /** What the ANCHOR entry booked — the number the provider disagreed with. */
  readonly ledgerAnchorCents: bigint | null;
  /** Where the whole correction group stands NOW. */
  readonly ledgerNetCents: bigint | null;
  /** Oldest booking first. Empty when the break has no ledger side. */
  readonly entries: readonly CorrectionEntryFacts[];
}

/* -------------------------------------------------------------------------- */
/* 3. The classifier                                                          */
/* -------------------------------------------------------------------------- */

function hasType(
  entries: readonly CorrectionEntryFacts[],
  type: CorrectionEntryFacts["entryType"],
): boolean {
  return entries.some((e) => e.entryType === type);
}

/**
 * Which of the four this break is.
 *
 * The test for "this belongs to a correction group" is the presence of a
 * `reversal` entry in the group, and NOT `entries.length > 1`. A group of one
 * is an ordinary posting; a group of two or more without a reversal is not a
 * shape `reverseAndRebook` can produce, and treating it as a correction would
 * be inferring an explanation from a row count.
 *
 * `correction_closed` additionally requires a FILE SIDE and EXACT equality in
 * cents. Both halves matter:
 *
 *   - No file side means `in_ledger_not_file`: the provider omits the
 *     reference entirely. A correction cannot explain an omission, so such a
 *     break can never be classed `correction_closed` however tidy its group
 *     is. It lands in `correction_residual` and keeps full severity.
 *   - Exact equality, no tolerance band. A tolerance is where "explainable"
 *     becomes "suppressed": a one-cent rounding rule is also a one-cent theft
 *     rule, and pro-rata maths in this system already leaves pennies
 *     deterministically rather than absorbing them.
 */
export function classifyCorrection(input: CorrectionInput): CorrectionClass {
  const reversed = hasType(input.entries, "reversal");
  if (!reversed) return "not_a_correction";

  if (!hasType(input.entries, "rebook")) return "correction_open";

  if (input.fileAmountCents === null) return "correction_residual";
  if (input.ledgerNetCents === null) return "correction_residual";

  return input.ledgerNetCents === input.fileAmountCents
    ? "correction_closed"
    : "correction_residual";
}

/**
 * What is still outstanding, in cents, signed on the file's axis.
 *
 * This is NOT `break_amount_cents`. The engine's break amount is measured
 * against the ANCHOR entry — what we had booked when the file was produced —
 * because that is the number the provider was disagreeing with, and it is the
 * right number for "was this file right about us". The residual is measured
 * against the group's NET — where the book stands now — because that is the
 * right number for "is there still money to chase".
 *
 * On a `correction_closed` break the two differ and the pair is the whole
 * story: the file disagreed with us by -$50.00, and $0.00 is outstanding.
 */
export function residualCentsOf(input: CorrectionInput): bigint {
  const net = input.ledgerNetCents ?? 0n;
  if (input.fileAmountCents === null) {
    // `in_ledger_not_file`: the file omits it, so the whole net position is
    // the shortfall. Sign already matches the file's axis.
    return net;
  }
  return input.fileAmountCents - net;
}

/* -------------------------------------------------------------------------- */
/* 4. The timeline                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One step of the causal history, with both axes and the running position.
 *
 * `backdatedDays` is the gap between the two axes: how long after the money
 * happened we learned about it. It is zero for an entry booked on its own
 * value date and positive for a correction, which is the number that makes
 * the bitemporal claim concrete instead of abstract — the reversal's value
 * date is the ORIGINAL's, not the day we found out.
 */
export interface CorrectionStep {
  readonly entryId: string;
  readonly entryType: CorrectionEntryFacts["entryType"];
  readonly valueDate: string;
  readonly bookingSeq: bigint;
  readonly bookingTime: string;
  readonly bookingDate: string;
  /** `bookingDate - valueDate` in whole days. Never negative in practice. */
  readonly backdatedDays: number;
  readonly railCents: bigint;
  /** The group's net position on the rail after this step. */
  readonly runningNetCents: bigint;
  readonly description: string;
  readonly reversesEntryId: string | null;
}

/**
 * `YYYY-MM-DD` of an instant, on the book's clock.
 *
 * The book's day boundary is `book_tz()` in db/migrations/0001_ledger.sql,
 * which is `America/New_York`. This function must agree with `book_date()` in
 * Postgres or the two axes would be measured on two calendars: a correction
 * booked at 23:40 ET on a Tuesday would be a Wednesday event to the screen and
 * a Tuesday event to the view, and the disagreement would only ever show up
 * after 20:00 ET — which is to say, during a demo.
 *
 * `BANKING_TIME_ZONE` is the same string, exported once from the formatting
 * layer, so there is one timezone literal in the codebase and not two.
 */
const BOOK_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: BANKING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function bookDateOf(instant: string): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return instant.slice(0, 10);
  return BOOK_DATE_FORMAT.format(at);
}

/** Whole days between two `YYYY-MM-DD` dates. Integer arithmetic, UTC noon. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T12:00:00Z`);
  const b = Date.parse(`${to}T12:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * The steps, oldest booking first, with the running net after each.
 *
 * Ordered by `bookingSeq` and not by value date, deliberately: this is the
 * order the book LEARNED things, and three entries that all share one value
 * date have no other order. Sorting by value date would render a correction
 * group as a flat list of simultaneous events, which is the opposite of the
 * point.
 */
export function buildTimeline(
  entries: readonly CorrectionEntryFacts[],
): readonly CorrectionStep[] {
  const ordered = [...entries].sort((a, b) =>
    a.bookingSeq === b.bookingSeq ? 0 : a.bookingSeq < b.bookingSeq ? -1 : 1,
  );

  let running = 0n;
  const steps: CorrectionStep[] = [];
  for (const e of ordered) {
    running += e.railCents;
    steps.push({
      entryId: e.entryId,
      entryType: e.entryType,
      valueDate: e.valueDate,
      bookingSeq: e.bookingSeq,
      bookingTime: e.bookingTime,
      bookingDate: e.bookingDate,
      backdatedDays: daysBetween(e.valueDate, e.bookingDate),
      railCents: e.railCents,
      runningNetCents: running,
      description: e.description,
      reversesEntryId: e.reversesEntryId,
    });
  }
  return steps;
}

/** The last thing the book learned about this group. `null` if there is none. */
export function learnedAtOf(
  entries: readonly CorrectionEntryFacts[],
): CorrectionEntryFacts | null {
  let latest: CorrectionEntryFacts | null = null;
  for (const e of entries) {
    if (latest === null || e.bookingSeq > latest.bookingSeq) latest = e;
  }
  return latest;
}

/* -------------------------------------------------------------------------- */
/* 5. Aging: which axis, and why                                              */
/* -------------------------------------------------------------------------- */

/**
 * One axis's two facts. Both come from the database: `ageDays` is
 * `book_date(now()) - <the date>` and `closesCrossed` counts `book_day` rows.
 */
export interface AxisFacts {
  readonly ageDays: number;
  readonly closesCrossed: number;
}

export interface AgingInput {
  readonly correctionClass: CorrectionClass;
  /** Signed. Only its magnitude drives severity. */
  readonly residualCents: bigint;
  /** The engine's own verdict, carried through for `not_a_correction`. */
  readonly explainedBy: ExplainedBy | null;
  /** Age from the break's business day. Always available. */
  readonly valueAxis: AxisFacts;
  /** Age from the group's most recent booking. `null` with no group. */
  readonly bookingAxis: AxisFacts | null;
}

export interface ExplainedAging {
  readonly axis: AgingAxis;
  readonly ageDays: number;
  readonly closesCrossed: number;
  readonly severity: Severity;
  /** Why this axis and not the other, in one sentence, for the screen. */
  readonly axisRationale: string;
  /** Both axes are always carried, so the screen can print the one it is not using. */
  readonly valueAxis: AxisFacts;
  readonly bookingAxis: AxisFacts | null;
}

/**
 * ===========================================================================
 * WHICH AXIS DOES A BREAK AGE ON
 * ===========================================================================
 *
 * The question the brief poses: a break we learned about this morning,
 * concerning a settlement three weeks ago — is it three weeks old?
 *
 * It depends on what the age is FOR, and the answer is genuinely different
 * for the two classes, which is why this is a function of the class and not a
 * constant.
 *
 * AN UNEXPLAINED BREAK AGES ON THE VALUE DATE.
 *   The age is measuring EXPOSURE: how long the book has been wrong. A
 *   settlement three weeks ago that we have never booked has been missing
 *   from three weeks of balances, three weeks of available-balance
 *   calculations and — the fact that actually bites — every statement issued
 *   for those days. That damage is a function of the value date and of
 *   nothing else. Learning about it this morning does not make the three
 *   weeks of wrong statements younger. This is also the existing behaviour of
 *   `v_recon_break.age_days`, and it was already right; nothing here changes
 *   it.
 *
 * A CORRECTION-GROUP BREAK AGES ON THE BOOKING AXIS.
 *   The age is measuring an OPEN OPERATIONAL ITEM: how long this has been
 *   sitting on somebody's desk. And the desk only received it when the
 *   correction was booked. A reversal carries its original's value date — that
 *   is the entire bitemporal design — so aging a correction on the value axis
 *   reads the age of the SETTLEMENT and prints it as the age of the
 *   CORRECTION. Concretely: a three-week-old settlement reversed ten minutes
 *   ago would render as `31+`, `critical`, three closes crossed. Nobody failed
 *   to act on it. It would sit at the top of the screen above genuine
 *   month-old breaks, and within a week an operator would learn that the top
 *   of the screen is noise. That is how a breaks screen dies.
 *
 *   The converse case is why this is not merely cosmetic: a reversal posted a
 *   fortnight ago whose re-book never arrived is a real, aging operational
 *   failure. On the value axis it is indistinguishable from the settlement's
 *   own age; on the booking axis it climbs the ladder exactly as it should,
 *   close by close.
 *
 * AND A CORRECTED-BUT-STILL-SHORT BREAK AGES ON THE VALUE DATE AGAIN.
 *   `correction_residual` is the trap. There is a correction group, so the
 *   "it is fresh, we just learned" argument is available — and it is wrong,
 *   because the residual is money that has been missing since the value date
 *   and is missing still. The correction did not touch it. So the residual
 *   ages as exposure, on the value axis, with the full severity ladder and no
 *   `explained` rung available to it. This is the single most important line
 *   in this module: it is the one place where a plausible-sounding
 *   generalisation ("correction groups age on the booking axis") would have
 *   quietly downgraded a live break.
 *
 * There is exactly one severity ladder in this system — `severityOf` in
 * `aging.ts`, unchanged — and this function chooses which facts to feed it.
 * A second ladder would be a second set of thresholds to disagree with the
 * first within a month.
 */
export function axisFor(correctionClass: CorrectionClass): AgingAxis {
  return correctionClass === "correction_open" || correctionClass === "correction_closed"
    ? "booking_time"
    : "value_date";
}

const AXIS_RATIONALE: Record<CorrectionClass, string> = {
  not_a_correction:
    "Aged from the value date: the age of an unexplained break is how long the book has been wrong, and every statement issued since that day carries the error.",
  correction_open:
    "Aged from the booking of the reversal, not from the settlement's value date: the reversal carries the original's value date, so the value axis would print the age of the settlement and call it the age of the correction.",
  correction_closed:
    "Aged from the booking of the re-book: this row is the record of something already fixed, and the only question left is how recently it was fixed.",
  correction_residual:
    "Aged from the value date even though a correction group exists: the remainder is money that has been missing since the business day and is missing still, and the correction did not touch it.",
};

export function ageExplainedBreak(input: AgingInput): ExplainedAging {
  const wanted = axisFor(input.correctionClass);
  // Fall back to the value axis rather than inventing one. A correction class
  // with no booking facts is impossible by construction (the class is derived
  // from the entries that produce those facts); if it ever happens, the louder
  // of the two axes is the right place to land.
  const usable: AgingAxis =
    wanted === "booking_time" && input.bookingAxis === null ? "value_date" : wanted;

  const facts = usable === "booking_time" ? input.bookingAxis : input.valueAxis;
  const chosen = facts ?? input.valueAxis;

  // Only `correction_closed` may reach the `explained` rung through a
  // correction. `correction_open` and `correction_residual` are passed `null`
  // — they are explainABLE, which is not the same word as explained.
  //
  // `not_a_correction` may reach it through an ADJUDICATION and through
  // nothing else. The engine's `reversal_and_rebook` verdict is deliberately
  // dropped here rather than trusted: this class means "I read the correction
  // group myself and found no reversal in it", so an inherited flag claiming a
  // reversal-and-re-book is a DISAGREEMENT between the view and the entries,
  // and a disagreement about whether money is explained resolves to the louder
  // answer, every time. An adjudication is different in kind — it is a
  // person's signature on a `recon_break_note`, not an inference this module
  // is in a position to second-guess.
  const explainedBy: ExplainedBy | null =
    input.correctionClass === "correction_closed"
      ? "reversal_and_rebook"
      : input.correctionClass === "not_a_correction" && input.explainedBy === "adjudicated"
        ? "adjudicated"
        : null;

  const severity = severityOf({
    ageDays: chosen.ageDays,
    closesCrossed: chosen.closesCrossed,
    breakAmountCents: input.residualCents,
    explainedBy,
  });

  return {
    axis: usable,
    ageDays: chosen.ageDays,
    closesCrossed: chosen.closesCrossed,
    severity,
    axisRationale: AXIS_RATIONALE[input.correctionClass],
    valueAxis: input.valueAxis,
    bookingAxis: input.bookingAxis,
  };
}

/* -------------------------------------------------------------------------- */
/* 6. The whole explanation                                                   */
/* -------------------------------------------------------------------------- */

export interface BreakExplanation {
  readonly correctionClass: CorrectionClass;
  readonly steps: readonly CorrectionStep[];
  /** Cents still outstanding against the file, after the whole group. */
  readonly residualCents: bigint;
  /** The group's net now. `null` when the break has no ledger side. */
  readonly ledgerNetCents: bigint | null;
  /** ISO instant of the group's most recent booking. `null` with no group. */
  readonly learnedAt: string | null;
  /** The largest value-date-to-booking-date gap in the group. */
  readonly maxBackdatedDays: number;
  readonly aging: ExplainedAging;
  /** What believing this classification could hide. Rendered on the screen. */
  readonly exclusionRisk: string;
}

export function explainBreak(
  input: CorrectionInput,
  axes: { readonly valueAxis: AxisFacts; readonly bookingAxis: AxisFacts | null },
  explainedBy: ExplainedBy | null,
): BreakExplanation {
  const correctionClass = classifyCorrection(input);
  const steps = buildTimeline(input.entries);
  const residualCents = residualCentsOf(input);
  const latest = learnedAtOf(input.entries);

  const aging = ageExplainedBreak({
    correctionClass,
    residualCents,
    explainedBy,
    valueAxis: axes.valueAxis,
    bookingAxis: correctionClass === "not_a_correction" ? null : axes.bookingAxis,
  });

  return {
    correctionClass,
    steps,
    residualCents,
    ledgerNetCents: input.ledgerNetCents,
    learnedAt: latest?.bookingTime ?? null,
    maxBackdatedDays: steps.reduce((worst, s) => Math.max(worst, s.backdatedDays), 0),
    aging,
    exclusionRisk: CORRECTION_CLASS_EXCLUSION_RISK[correctionClass],
  };
}

/**
 * Does this explanation mean the operator can stop reading?
 *
 * ONE function, used by every caller, so "explained" has one definition. It is
 * deliberately narrow: only `correction_closed`, and only when nothing is
 * outstanding. A row that fails this test is worked like any other break.
 */
export function isFullyExplained(explanation: BreakExplanation): boolean {
  return explanation.correctionClass === "correction_closed" && explanation.residualCents === 0n;
}
