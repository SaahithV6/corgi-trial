/**
 * Aging and severity — the policy layer, in one place, with no database.
 *
 * `v_recon_break` returns FACTS: how old the break is in business days, how
 * many day closes it has survived, and whether a correction group or an
 * adjudication already answers it. It deliberately does not return a severity.
 *
 * Severity is a threshold someone will want to argue about at some point, and
 * a threshold that lives in a CASE expression inside a view AND in TypeScript
 * for the fixtures is a threshold that will disagree with itself within a
 * month. So it lives here, once, as a pure function of four numbers, and both
 * the live screen and the frozen run snapshot call it.
 *
 * ---------------------------------------------------------------------------
 * WHY A DAY CLOSE AND NOT A CLOCK
 * ---------------------------------------------------------------------------
 *
 * "A break that has been open across a day close is worse than one from this
 * morning" is not the same statement as "a break that is 24 hours old is worse
 * than one that is 2 hours old", and the difference matters.
 *
 * A day close (DESIGN.md §13) is somebody signing off a business day: it pins
 * `book_day.booking_watermark` and it is what statements are rendered against.
 * A break that was open when that happened is a break that got past a control.
 * A break that appeared at 09:14 this morning has not been past anything yet —
 * tonight's close is its first test, and if it is resolved before then, no
 * signed-off day ever contained it.
 *
 * So the ladder is driven by `closesCrossed`, and `ageDays` is only a
 * tiebreaker for the two ends: a break can be days old on a book that has not
 * been closed (a weekend, an outage, a Monday holiday), and a break past a
 * month is critical regardless of how many closes ran.
 */

import {
  AGE_BUCKETS,
  type AgeBucket,
  type ExplainedBy,
  type Severity,
  SEVERITIES,
} from "./types";

/**
 * Material for the purpose of severity: $1,000.00.
 *
 * Not a universal truth — it is the number this build escalates at, stated
 * once so it can be changed in one place and argued about in review. It is
 * compared against the ABSOLUTE break amount, because a file that is $5,000
 * short and a file that is $5,000 over are the same size of problem.
 */
export const MATERIAL_BREAK_CENTS = 100_000n;

/** Past this, a break is critical however few closes have run. */
export const STALE_AGE_DAYS = 30;

export interface AgingFacts {
  /** `book_date(now()) - value_date`. May be negative for a forward-dated file. */
  readonly ageDays: number;
  /** Day closes at or after the break's own business day. Never negative. */
  readonly closesCrossed: number;
  /** Signed. Only its magnitude is used. */
  readonly breakAmountCents: bigint;
  /** Set when a correction group or an adjudication already answers the break. */
  readonly explainedBy: ExplainedBy | null;
}

/**
 * DESIGN.md §15's buckets: 0–1 / 2–3 / 4–7 / 8–30 / 31+.
 *
 * A negative age — a file whose value date is in the future, which happens
 * with a warehoused ACH effective date — buckets as `0-1` rather than
 * throwing. It is not aged; it has not happened yet.
 */
export function ageBucketOf(ageDays: number): AgeBucket {
  if (ageDays <= 1) return "0-1";
  if (ageDays <= 3) return "2-3";
  if (ageDays <= 7) return "4-7";
  if (ageDays <= 30) return "8-30";
  return "31+";
}

/**
 * The ladder.
 *
 *   explained  the book already answers it
 *   critical   >30 days old, or material AND past two closes
 *   stale      past two or more closes
 *   aged       past one close
 *   open       its business day has not been closed yet
 *
 * `explained` is checked FIRST and unconditionally. A break whose entry was
 * reversed and re-booked to the file's own number is not a $900 emergency
 * however long it has sat, and paging someone about it teaches them to ignore
 * the pager. It stays on the screen — it is never filtered away — but it is
 * ranked as what it is.
 */
export function severityOf(facts: AgingFacts): Severity {
  if (facts.explainedBy !== null) return "explained";

  const magnitude =
    facts.breakAmountCents < 0n ? -facts.breakAmountCents : facts.breakAmountCents;
  const material = magnitude >= MATERIAL_BREAK_CENTS;
  const closes = Math.max(0, facts.closesCrossed);

  if (facts.ageDays > STALE_AGE_DAYS) return "critical";
  if (closes >= 2 && material) return "critical";
  if (closes >= 2) return "stale";
  if (closes >= 1) return "aged";
  return "open";
}

/** Worst first. Used to sort the screen: the thing that needs doing is on top. */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITIES.indexOf(b) - SEVERITIES.indexOf(a);
}

/** Oldest first within a severity, then largest first. A total order. */
export function compareBreaks(
  a: { severity: Severity; ageDays: number; breakAmountCents: bigint; breakKey: string },
  b: { severity: Severity; ageDays: number; breakAmountCents: bigint; breakKey: string },
): number {
  const bySeverity = compareSeverity(a.severity, b.severity);
  if (bySeverity !== 0) return bySeverity;
  if (a.ageDays !== b.ageDays) return b.ageDays - a.ageDays;

  const magA = a.breakAmountCents < 0n ? -a.breakAmountCents : a.breakAmountCents;
  const magB = b.breakAmountCents < 0n ? -b.breakAmountCents : b.breakAmountCents;
  if (magA !== magB) return magB > magA ? 1 : -1;

  // Deterministic tail so a re-render never reorders two equal rows.
  return a.breakKey.localeCompare(b.breakKey);
}

/**
 * A one-line explanation of the severity, for the screen.
 *
 * Written as a sentence about what happened rather than a restatement of the
 * label, because "Stale" on its own tells an operator nothing they can act on.
 */
export function severityReason(facts: AgingFacts, severity: Severity): string {
  if (severity === "explained") {
    return facts.explainedBy === "reversal_and_rebook"
      ? "The entry behind this break was reversed and re-booked; the correction group now nets to the file's amount."
      : "Adjudicated: a recon note with a resolution is on file.";
  }
  const closes = Math.max(0, facts.closesCrossed);
  if (severity === "critical" && facts.ageDays > STALE_AGE_DAYS) {
    return `Open for ${facts.ageDays} business days — past the ${STALE_AGE_DAYS}-day threshold.`;
  }
  if (severity === "critical") {
    return `Material, and open across ${closes} day closes.`;
  }
  if (severity === "stale") return `Open across ${closes} day closes.`;
  if (severity === "aged") return "Open across one day close — a signed-off day contains this break.";
  return "Its business day has not been closed yet; tonight's close is the first test.";
}

/** Every bucket, in order, for a filter control that must not reorder itself. */
export const AGE_BUCKET_ORDER: readonly AgeBucket[] = AGE_BUCKETS;
