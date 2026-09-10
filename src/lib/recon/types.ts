/**
 * Reconciliation vocabulary.
 *
 * Pure types and pure predicates. No `server-only`, no database handle, no
 * `node:crypto` — this module is imported by the screen's data contract as
 * well as by the query layer, and the two must agree on the words.
 *
 * MONEY IS `bigint` CENTS EVERYWHERE IN THIS FILE. The screen narrows to
 * `number` at its own boundary (see src/components/recon/data-contract.ts and
 * the note on `Cents` there); nothing in `src/lib/recon/**` does arithmetic on
 * anything but `bigint`.
 */

/**
 * The three break categories. Three, no more and no fewer.
 *
 * They are exhaustive over the ways a file and a book can disagree once
 * matching is by reference: the reference is on one side only (two ways), or
 * it is on both and the money differs (one way). A fourth category would mean
 * either a fourth kind of disagreement — there isn't one — or a status,
 * which is what `severity` and `explainedBy` are for.
 *
 * The strings are the same ones `recon_break_note.break_kind` and
 * `recon_run_break.break_kind` CHECK in the schema. One vocabulary, three
 * places, no translation layer.
 */
export const BREAK_KINDS = [
  "in_file_not_ledger",
  "in_ledger_not_file",
  "amount_mismatch",
] as const;

export type BreakKind = (typeof BREAK_KINDS)[number];

export const BREAK_KIND_LABELS: Record<BreakKind, string> = {
  in_file_not_ledger: "In file, not in ledger",
  in_ledger_not_file: "In ledger, not in file",
  amount_mismatch: "Amount mismatch",
};

export const BREAK_KIND_MEANINGS: Record<BreakKind, string> = {
  in_file_not_ledger:
    "The provider says it happened and we have no entry for it. A webhook that never arrived, one that arrived and failed, or a force post nobody has booked yet.",
  in_ledger_not_file:
    "We booked it and the provider's file omits it. A duplicate posting, a timing difference across the file cutoff, or a row that vanished between two versions of the file.",
  amount_mismatch:
    "Matched on the provider's reference, disagreeing on money. A partial capture booked at the authorised amount, a tip or fuel adjustment, an over-capture.",
};

export function isBreakKind(value: unknown): value is BreakKind {
  return BREAK_KINDS.some((kind) => kind === value);
}

/**
 * Severity, worst last.
 *
 * The ladder is ordered so `SEVERITIES.indexOf` is a comparison, and every
 * rung is a fact about the break rather than an opinion about the money:
 *
 *   explained  the book already answers it — a reversal-plus-rebook nets to
 *              the file's number, or someone adjudicated it with a
 *              recon_break_note. Still shown; never hidden.
 *   open       the business day it belongs to has not been closed yet. It
 *              appeared this morning and tonight's close is its first test.
 *   aged       it survived a day close. Somebody signed off a day with this
 *              break open, which is the fact that makes it worse.
 *   stale      it survived two or more.
 *   critical   two or more closes AND material, or older than a month.
 */
export const SEVERITIES = ["explained", "open", "aged", "stale", "critical"] as const;

export type Severity = (typeof SEVERITIES)[number];

export const SEVERITY_LABELS: Record<Severity, string> = {
  explained: "Explained",
  open: "Open",
  aged: "Aged",
  stale: "Stale",
  critical: "Critical",
};

export function isSeverity(value: unknown): value is Severity {
  return SEVERITIES.some((s) => s === value);
}

/** DESIGN.md §15's buckets, verbatim. */
export const AGE_BUCKETS = ["0-1", "2-3", "4-7", "8-30", "31+"] as const;

export type AgeBucket = (typeof AGE_BUCKETS)[number];

export function isAgeBucket(value: unknown): value is AgeBucket {
  return AGE_BUCKETS.some((b) => b === value);
}

/**
 * WHY a row is a break, within its category.
 *
 * Not a fourth category — every one of these is still one of the three. It is
 * the sentence an operator needs before they can act: "in file, not in ledger"
 * says what the screen found, `duplicate_reference_in_file` says what to do
 * about it.
 */
export const REASON_CODES = [
  "unmatched_reference",
  "duplicate_reference_in_file",
  "duplicate_posting",
  "no_reference",
  "amount_differs",
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export const REASON_CODE_LABELS: Record<ReasonCode, string> = {
  unmatched_reference: "No counterpart under this reference",
  duplicate_reference_in_file: "The file repeats this reference",
  duplicate_posting: "We posted this reference twice",
  no_reference: "The entry carries no provider reference",
  amount_differs: "Both sides have it; the money differs",
};

export function isReasonCode(value: unknown): value is ReasonCode {
  return REASON_CODES.some((r) => r === value);
}

/** Why a break is already answered. `null` means it is not. */
export type ExplainedBy = "reversal_and_rebook" | "adjudicated";

export function isExplainedBy(value: unknown): value is ExplainedBy {
  return value === "reversal_and_rebook" || value === "adjudicated";
}

/**
 * One break, as the engine computes it.
 *
 * `fileAmountCents` and `ledgerAmountCents` are BOTH present on a mismatch —
 * that is requirement, not convenience: a break that does not carry its own
 * evidence forces whoever reads it to re-derive the numbers from a book that
 * has moved on since.
 *
 * `ledgerNetCents` is the correction group's net position on the rail. It
 * differs from `ledgerAmountCents` exactly when the matched entry was later
 * reversed and re-booked, and that difference is the entire edge case.
 */
export interface ReconBreak {
  readonly kind: BreakKind;
  readonly reasonCode: ReasonCode;
  /** file_row_id, entry_id or recon_match id, as text. Joins recon_break_note. */
  readonly breakKey: string;
  readonly externalRef: string;
  /** `YYYY-MM-DD`. The business day, not an instant. */
  readonly valueDate: string;

  readonly fileId: string;
  readonly provider: string;
  readonly rail: string;
  readonly businessDate: string;

  /** Drill-through: the file row that produced this, when there is one. */
  readonly fileRowId: string | null;
  readonly fileRowNo: number | null;
  /** Drill-through: the journal entry that produced this, when there is one. */
  readonly entryId: string | null;
  readonly entryBookingSeq: bigint | null;
  readonly correctionGroupId: string | null;

  readonly fileAmountCents: bigint | null;
  readonly ledgerAmountCents: bigint | null;
  readonly ledgerNetCents: bigint | null;
  /** Signed, on the file's axis: how much the file is out by. */
  readonly breakAmountCents: bigint;

  readonly description: string | null;

  readonly ageDays: number;
  readonly closesCrossed: number;
  readonly ageBucket: AgeBucket;
  readonly severity: Severity;
  readonly explainedBy: ExplainedBy | null;
}

/** A run's header. Immutable once written; re-running appends a new one. */
export interface ReconRunSummary {
  readonly runId: string;
  readonly fileId: string;
  readonly provider: string;
  readonly rail: string;
  readonly filename: string;
  readonly fileSha256: string;
  /** Rows the importer could read. Rejects are counted separately. */
  readonly fileRowCount: number;
  readonly businessDate: string;
  readonly runNo: number;
  readonly bookingWatermark: bigint;
  readonly matchedCount: number;
  readonly breakCount: number;
  readonly breakTotalCents: bigint;
  readonly contentHash: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runBy: string;
  readonly inFileNotLedger: number;
  readonly inLedgerNotFile: number;
  readonly amountMismatch: number;
  readonly rejectedRows: number;
}
