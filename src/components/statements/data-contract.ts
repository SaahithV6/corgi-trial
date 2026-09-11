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

/* -------------------------------------------------------------------------- */
/* BOTH TIME AXES — the shape the screen is actually built around              */
/* -------------------------------------------------------------------------- */

/**
 * Which booking watermark the LEFT-HAND column is read at.
 *
 * The right-hand column is always "everything we have learned"; the question
 * the screen exists to answer is what we believed BEFORE that, and there are
 * only ever three honest places to stand:
 *
 *   `published`  the watermark a document was issued against. The strongest
 *                anchor there is, because a customer could be holding the
 *                paper, and because the stored hash makes the reading
 *                checkable by someone who does not trust us.
 *   `close`      the watermark the business day was frozen at. Available on
 *                any closed day, published or not.
 *   `before`     the sequence immediately before the first correcting entry
 *                for this day landed. Available on an OPEN day, which is where
 *                a correction that arrived this morning actually lives — and
 *                without it the screen could only tell the story a day late.
 *   `now`        the same watermark as the right-hand column. Degenerate on
 *                purpose: it is what a day with no corrections and no close
 *                honestly offers, and the screen says the two readings are the
 *                same reading rather than implying a difference exists.
 */
export type BelievedAnchor = "published" | "close" | "before" | "now";

/**
 * One selectable anchor, INCLUDING the ones this day does not have.
 *
 * Unavailable anchors are rendered, disabled, with the reason — because "no
 * statement was ever published for this day" is a fact a reader needs and a
 * missing chip does not convey. It is the same argument the breaks screen
 * makes about a break whose net is zero: absence has to be shown, not implied.
 */
export type AnchorOptionView = {
  readonly anchor: BelievedAnchor;
  /** Short label, e.g. `As published`. Used as the left column's heading. */
  readonly label: string;
  readonly available: boolean;
  /** `null` exactly when `available` is false. */
  readonly bookingWatermark: number | null;
  /** One sentence: what this anchor is, or why this day does not have it. */
  readonly note: string;
};

/** One reading of one value date: a document, at a watermark, with its hash. */
export type ReadingView = {
  readonly label: string;
  readonly bookingWatermark: number;
  readonly closingBalanceCents: Cents;
  readonly document: DocumentView;
  /**
   * sha256 over the canonical rendering, recomputed on THIS read.
   *
   * Present for both readings, not only the published one. The reproducibility
   * claim is a property of `(period, watermark)`, not of the act of
   * publishing: any reading pinned to a watermark reproduces forever, and
   * showing the fingerprint of the unpublished one is how the screen says so
   * without claiming a document was issued.
   */
  readonly contentHash: string;
};

/**
 * The two readings of one value date, and everything between them.
 *
 * This is the type the screen is built around. `believed` and `corrected` are
 * peers: neither is the correction of the other, they are answers to two
 * different questions, and the screen renders them as two columns of equal
 * weight with the difference stated between them.
 */
export type BothReadingsView = {
  readonly valueDate: ValueDate;
  /** `null` when the business day has not been closed. Not an error. */
  readonly closedAt: Instant | null;
  readonly closeWatermark: number | null;

  readonly anchor: BelievedAnchor;
  readonly anchors: readonly AnchorOptionView[];

  readonly believed: ReadingView;
  readonly corrected: ReadingView;

  /** `corrected − believed`, signed from the account holder's point of view. */
  readonly deltaCents: Cents;
  readonly differs: boolean;
  /** Do the acts below sum to exactly `deltaCents`? Rendered honestly if not. */
  readonly explained: boolean;
  readonly acts: readonly CorrectionGroupView[];
  /** Booking time of the earliest act above the anchor: when we learned otherwise. */
  readonly learnedAt: Instant | null;

  /** The issued document at this anchor, when one was issued. `null` otherwise. */
  readonly published: PublishedStatementView | null;
  readonly reproduced: boolean;
  readonly formatChanged: boolean;
  readonly versions: readonly PublishedStatementView[];
};

/** The whole screen, in one read. */
export type StatementsScreenView = {
  readonly source: StatementSource;
  readonly asOf: Instant;
  readonly accounts: readonly AccountOption[];
  readonly account: AccountOption | null;
  readonly days: readonly DayOption[];
  /** `null` only when there is no customer account to read at all. */
  readonly readings: BothReadingsView | null;
};

export type StatementsScreenQuery = {
  readonly accountId?: string | undefined;
  readonly businessDate?: string | undefined;
  /** Which published version anchors the `published` reading. Defaults to v1. */
  readonly version?: number | undefined;
  readonly anchor?: BelievedAnchor | undefined;
  /**
   * Open on a day that actually carries a correction, when the URL names none.
   *
   * What `?state=edge` means. It is a default-selection hint and nothing else:
   * it cannot invent a correction, and when the book has none the screen says
   * so rather than pretending.
   */
  readonly preferCorrected?: boolean | undefined;
};

export interface StatementsScreenSource {
  load(query: StatementsScreenQuery): Promise<Result<StatementsScreenView, ErrorShape>>;
}
