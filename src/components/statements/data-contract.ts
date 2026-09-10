/**
 * The statements screen's data contract.
 *
 * Same seam, and the same rules, as `src/components/recon/data-contract.ts`:
 * nothing under `src/components/**` opens a connection, imports `postgres`, or
 * reaches into `src/lib/statements/*` for anything but these types. The screen
 * depends on this interface; `src/lib/statements/screen.ts` implements it
 * against the live database and `./fixtures.ts` implements it without one.
 *
 * Shape notes:
 *
 * - **Every amount is integer minor units (US cents)**, never dollars, never a
 *   float, never a string with a decimal point in it. `number` rather than
 *   `bigint` because these cross the server/client boundary and `bigint` does
 *   not survive JSON; the library works in `bigint` throughout and narrows
 *   once, at the edge, in `screen.ts`, where it refuses rather than rounds.
 * - **`bookingWatermark` is a `number` for the same reason** — it is a sequence
 *   position, not money, and this book will not reach 2^53 entries.
 * - **Value dates are `YYYY-MM-DD`**; instants are ISO 8601 with an offset.
 *   Different types because they are different clocks (DESIGN.md §5), and this
 *   screen is the one place in the console where confusing them would be
 *   invisible rather than obvious.
 * - **Failure is a value, not a throw**, so the error state is a branch.
 * - **The screen never writes.** Closing a day and publishing a statement are
 *   operator actions with an actor attached; a render is not one. That is why
 *   there is no `publish` on this interface, and why a day that has been closed
 *   without a statement renders as a state rather than silently issuing one.
 */

import type { ErrorShape, Result } from "@/lib/result";

/** Integer minor units (US cents). Never dollars. */
export type Cents = number;
/** ISO 8601 instant. */
export type Instant = string;
/** `YYYY-MM-DD`. The value-date axis, not an instant. */
export type ValueDate = string;

export type EntryType = "original" | "reversal" | "rebook";

/* -------------------------------------------------------------------------- */
/* The document                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One line of a rendered statement.
 *
 * `amountCents` is positive for money IN to the account holder — a statement's
 * sign, not the journal's debit-positive one. The flip happens once, in SQL,
 * as `amount_cents * normal_side`.
 */
export type StatementLineView = {
  /** `<bookingSeq>:<ordinal>` — the line's identity in the total order. */
  readonly id: string;
  readonly entryId: string;
  readonly valueDate: ValueDate;
  readonly bookingSeq: number;
  readonly ordinal: number;
  readonly entryType: EntryType;
  readonly description: string;
  readonly externalRef: string | null;
  readonly rail: string | null;
  readonly reversesEntryId: string | null;
  readonly correctionGroupId: string | null;
  readonly amountCents: Cents;
  readonly runningBalanceCents: Cents;
  /**
   * True when this line was booked ABOVE the published statement's watermark.
   *
   * Only ever true on the as-corrected document — by definition, the published
   * one has no such lines. It is what lets the corrected view mark exactly
   * which rows are new since the document went out, rather than leaving the
   * reader to diff two tables by eye.
   */
  readonly late: boolean;
};

export type DocumentView = {
  readonly periodStart: ValueDate;
  readonly periodEnd: ValueDate;
  readonly bookingWatermark: number;
  readonly openingBalanceCents: Cents;
  readonly closingBalanceCents: Cents;
  readonly lineCount: number;
  readonly lines: readonly StatementLineView[];
};

/* -------------------------------------------------------------------------- */
/* The published row                                                          */
/* -------------------------------------------------------------------------- */

export type PublishedStatementView = {
  readonly statementId: string;
  readonly version: number;
  readonly bookingWatermark: number;
  readonly openingBalanceCents: Cents;
  readonly closingBalanceCents: Cents;
  readonly lineCount: number;
  /** sha256 over the canonical rendering, lowercase hex. */
  readonly contentHash: string;
  /** The renderer that produced the hash. A hash only compares within a format. */
  readonly format: string;
  readonly generatedAt: Instant;
  /** Display name of the actor that issued it. */
  readonly generatedBy: string;
};

/* -------------------------------------------------------------------------- */
/* Why the two readings differ                                                */
/* -------------------------------------------------------------------------- */

export type LatePostingView = {
  readonly entryId: string;
  readonly valueDate: ValueDate;
  readonly bookingSeq: number;
  readonly bookingTime: Instant;
  readonly entryType: EntryType;
  readonly description: string;
  readonly externalRef: string | null;
  readonly reversesEntryId: string | null;
  readonly amountCents: Cents;
  /**
   * Its value date is before the period, so it moved the OPENING balance.
   *
   * Same effect on the closing figure, and a different sentence: "the day
   * before was restated" rather than "this day was corrected".
   */
  readonly affectsOpening: boolean;
};

/**
 * One ACT that changed the day after it was published.
 *
 * A reversal and its re-book are one act that produced two entries, and the
 * question "why is that day different now" is a question about acts.
 */
export type CorrectionGroupView = {
  readonly id: string;
  readonly correctionGroupId: string | null;
  readonly isCorrection: boolean;
  readonly netCents: Cents;
  readonly postings: readonly LatePostingView[];
};

/* -------------------------------------------------------------------------- */
/* Pickers                                                                    */
/* -------------------------------------------------------------------------- */

export type AccountOption = {
  readonly accountId: string;
  readonly legalName: string;
  readonly accountName: string;
};

export type DayOption = {
  readonly businessDate: ValueDate;
  readonly closedAt: Instant;
  readonly bookingWatermark: number;
  /** Statement versions published for this account and day. */
  readonly versionCount: number;
  /** Lines on this account with this value date, as known now. */
  readonly lineCount: number;
  /** Of those, how many were booked after the close. */
  readonly latePostingCount: number;
};

/* -------------------------------------------------------------------------- */
/* The view                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The two readings, side by side, with the evidence for both.
 *
 * This type is the whole point of the screen, so it is worth saying what each
 * field is FOR:
 *
 *   `published` / `publishedDocument`  what the statement said when it was
 *                                      issued. Re-derived from the ledger at
 *                                      its own frozen watermark on this very
 *                                      read — not read out of the stored
 *                                      figures.
 *   `reproduced` / `recomputedHash`    the proof that the re-derivation
 *                                      matched. Shown, because a
 *                                      reproducibility claim the reader cannot
 *                                      check is a claim they have to believe.
 *   `correctedDocument`                the same day at today's watermark.
 *   `deltaCents` / `corrections`       the difference, and the acts that
 *                                      caused it.
 *   `explained`                        whether those acts account for the
 *                                      whole difference. Rendered honestly
 *                                      when they do not.
 */
export type StatementDetailView = {
  readonly published: PublishedStatementView;
  readonly publishedDocument: DocumentView;
  readonly reproduced: boolean;
  readonly recomputedHash: string;
  /** True when the stored row was rendered by a different renderer than today's. */
  readonly formatChanged: boolean;
  readonly correctedDocument: DocumentView;
  readonly deltaCents: Cents;
  readonly differs: boolean;
  readonly explained: boolean;
  readonly corrections: readonly CorrectionGroupView[];
  readonly versions: readonly PublishedStatementView[];
};

/**
 * Where the numbers came from.
 *
 * Rendered on the screen, always. A figure without provenance is a rumour, and
 * a statement is the single worst place in this console for one.
 */
export type StatementSource = "live" | "fixture";

export type StatementsView = {
  readonly source: StatementSource;
  /** The instant the read was taken. */
  readonly asOf: Instant;
  readonly accounts: readonly AccountOption[];
  readonly account: AccountOption | null;
  readonly days: readonly DayOption[];
  readonly day: DayOption | null;
  /**
   * `null` when the selected day is closed but nothing has been published.
   *
   * A state, not an error. The screen says which, because "we closed the day
   * and never issued the document" and "there is no such day" are different
   * problems with different fixes.
   */
  readonly statement: StatementDetailView | null;
};

export type StatementsQuery = {
  readonly accountId?: string | undefined;
  readonly businessDate?: string | undefined;
  /** Which published version is the as-published side. Defaults to v1. */
  readonly version?: number | undefined;
};

export interface StatementsDataSource {
  load(query: StatementsQuery): Promise<Result<StatementsView, ErrorShape>>;
}

export type { ErrorShape, Result };
