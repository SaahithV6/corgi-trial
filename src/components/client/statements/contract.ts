/**
 * What the customer's statements screen renders.
 *
 * Pure types. No `server-only`, no database, no React — the live reader in
 * `src/app/(app)/client/statements/source.ts` produces this shape and the view
 * consumes it, and the live test drives the reader without booting a page.
 *
 * ===========================================================================
 * EVERY FIGURE ON THIS SCREEN CAME OUT OF `src/lib/statements/**`
 * ===========================================================================
 *
 * There is not one balance, running total or hash in this contract that was
 * computed anywhere but inside the statements library. `openingBalanceCents`,
 * `closingBalanceCents`, every line's `amountCents` and `runningBalanceCents`
 * and both hashes come from `renderStatement`, `compareStatement` and
 * `statementHash`. The reader narrows `bigint` to `number` at the edge and
 * arranges the result; it never adds two numbers together and calls the answer
 * a statement figure. A second computation of a statement is a second
 * definition of it, and this build has exactly one of each on purpose
 * (DESIGN §13).
 *
 * That is also why the corrections panel below carries LINES and not a net
 * total. The net effect of a reversal and its re-book is already in
 * `closingBalanceCents`, folded once by `foldClosing`. Summing the group here
 * to print the same money a second way would be the second definition, arrived
 * at through a display feature.
 *
 * ===========================================================================
 * TWO ANCHORS, NAMED, NEVER BLURRED
 * ===========================================================================
 *
 * `anchor` says which watermark the document on screen was rendered at, and
 * the two are genuinely different documents:
 *
 *   "issued"  a statement was PUBLISHED for this day. The document shown is
 *             that statement, re-derived from the ledger at its own frozen
 *             watermark on this request, and checked against the hash stored
 *             when it was issued. `storedHash` is non-null here.
 *   "closed"  the day was closed — the watermark is frozen and the document is
 *             reproducible forever — but no statement was ever issued for it.
 *             `storedHash` is null, because there is nothing to check against,
 *             and the screen says "closed, not yet issued" rather than dressing
 *             a derivation up as a document the customer was sent.
 *
 * There is no third anchor. An OPEN day never reaches this screen: the period
 * list is built from `book_day`, which only has a row once a day has been
 * signed off, so "today, so far" is not offered, cannot be linked to, and
 * cannot be mistaken for a published statement.
 */

import type { BusinessRef } from "@/components/client/contract";

/** `YYYY-MM-DD` in book time. */
export type BusinessDate = string;

export type ClientStatementAnchor = "issued" | "closed";

/** One closed day in the customer's period list. */
export type ClientStatementPeriod = {
  readonly businessDate: BusinessDate;
  /** ISO instant the entity signed the day off. */
  readonly closedAt: string;
  /** `max(booking_seq)` frozen at the close. The thing that makes it repeatable. */
  readonly closeWatermark: number;
  /** Statements issued for this account and this day. `0` is a real state. */
  readonly versionCount: number;
  readonly lineCount: number;
  /**
   * Entries with this value date that were booked ABOVE the close watermark.
   *
   * Non-zero means the day was corrected after it was signed off. The list
   * marks those periods so the customer can find the corrected day without
   * opening eleven statements.
   */
  readonly latePostingCount: number;
};

export type ClientStatementLine = {
  /** `bookingSeq:ordinal` — a total order, so the rendering is stable. */
  readonly id: string;
  readonly entryId: string;
  readonly valueDate: BusinessDate;
  readonly entryType: "original" | "reversal" | "rebook";
  readonly description: string;
  readonly reversesEntryId: string | null;
  readonly correctionGroupId: string | null;
  /** Positive is money in for the account holder. */
  readonly amountCents: number;
  readonly runningBalanceCents: number;
};

/**
 * A correction visible ON the statement: an original, its reversal, and the
 * re-book, tied together by `correction_group_id`.
 *
 * Carried as the library's own lines, in the library's own order. No total —
 * see the module note.
 */
export type ClientCorrection = {
  readonly correctionGroupId: string;
  readonly lines: readonly ClientStatementLine[];
};

/** An entry that landed after this document's watermark. */
export type ClientLatePosting = {
  readonly entryId: string;
  readonly valueDate: BusinessDate;
  readonly description: string;
  readonly amountCents: number;
  /** Its value date is before this period, so it moved the opening balance. */
  readonly affectsOpening: boolean;
};

/**
 * The reproduction this request actually performed.
 *
 * Every field here is the result of work done while rendering the page the
 * reader is looking at. Nothing is remembered from a previous load and nothing
 * is asserted by a fixture: `renderedHash` and `renderedAgainHash` are two
 * independent renderings of the same (period, watermark) rectangle, taken at
 * two instants inside this request, hashed by `statementHash`.
 *
 * `matchesStoredHash` is `null` — not `false` — when there is no stored hash to
 * compare against, which is the honest answer for a closed day that was never
 * issued. `false` means a stored hash exists and the re-derivation disagreed
 * with it, which is an incident and is rendered as one.
 */
export type ClientReproduction = {
  /** ISO instant the first rendering was taken. */
  readonly firstAt: string;
  /** ISO instant the second rendering was taken. */
  readonly secondAt: string;
  readonly renderedHash: string;
  readonly renderedAgainHash: string;
  /** `renderedHash === renderedAgainHash`, evaluated on this request. */
  readonly identical: boolean;
  readonly storedHash: string | null;
  readonly matchesStoredHash: boolean | null;
  /**
   * The stored row was written by a different renderer than the one running.
   *
   * When true a hash mismatch is a deployment fact, not a ledger fact, and the
   * screen says which — `src/lib/statements/types.ts` makes the same
   * distinction for the operator console.
   */
  readonly formatChanged: boolean;
};

export type ClientStatementDocument = {
  readonly businessDate: BusinessDate;
  readonly anchor: ClientStatementAnchor;
  /** The booking watermark this document is pinned to. Frozen; never "now". */
  readonly watermark: number;
  /** ISO instant the day was signed off. */
  readonly closedAt: string;
  /** Non-null only when `anchor` is `"issued"`. */
  readonly version: number | null;
  /** ISO instant the statement was issued. Null when it never was. */
  readonly issuedAt: string | null;
  readonly openingBalanceCents: number;
  readonly closingBalanceCents: number;
  readonly lineCount: number;
  readonly lines: readonly ClientStatementLine[];
  readonly corrections: readonly ClientCorrection[];
  readonly reproduction: ClientReproduction;
  /** Earlier issued versions of this same day, oldest first. The lineage. */
  readonly earlierVersions: readonly {
    readonly version: number;
    readonly issuedAt: string;
    readonly closingBalanceCents: number;
  }[];
  /**
   * Entries with a value date in this period booked after this document's
   * watermark — the day has moved since, and a new version is owed.
   */
  readonly movedSince: readonly ClientLatePosting[];
  /**
   * `corrected.closing - this document's closing`, from `compareStatement`.
   *
   * `null` on the `"closed"` anchor, where the library was not asked for a
   * comparison and this reader is not going to invent one by subtracting two
   * numbers itself.
   */
  readonly movedSinceCents: number | null;
};

export type ClientStatementsScreen = {
  /** False only on the fixture states. Printed on the page. */
  readonly live: boolean;
  /** ISO instant this read was taken. */
  readonly asOf: string;
  readonly businesses: readonly BusinessRef[];
  readonly businessId: string;
  readonly legalName: string;
  readonly accountName: string | null;
  readonly periods: readonly ClientStatementPeriod[];
  readonly selected: ClientStatementDocument | null;
  /** Set when the screen has nothing to show and needs to say why. */
  readonly notice: string | null;
};
