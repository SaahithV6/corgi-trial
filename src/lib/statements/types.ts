/**
 * Statement vocabulary.
 *
 * ---------------------------------------------------------------------------
 * A STATEMENT IS A (PERIOD, BOOKING WATERMARK) PAIR, NOT A PERIOD
 * ---------------------------------------------------------------------------
 *
 * That single sentence (DESIGN.md §13) resolves the requirement that looks
 * self-contradictory: *"a closed day's statement is reproducible forever,
 * identical every time"* and *"Tuesday's statement shows the corrected
 * position"*. Both are true because they are statements about different
 * documents:
 *
 *   - **v1** is pinned to the watermark `book_day` froze at Tuesday's close.
 *     Every input row below that watermark is immutable and no row can ever
 *     appear below it later (`booking_seq` is drawn under an advisory lock, so
 *     sequence order is commit order — DESIGN §5.3). Re-render it in year
 *     seven and you get the same bytes. `content_hash` proves it.
 *   - **v2** is a NEW document at a LATER watermark, issued when a correction
 *     with a value date inside the closed period lands. It shows the corrected
 *     position. v1 is not touched, because there is no edit anywhere in this
 *     system.
 *
 * The two figures have names throughout this module and they are never mixed:
 *
 *   **as published** — what the document we issued said. Frozen, hashed,
 *                      re-derivable from the ledger at its own watermark.
 *   **as corrected** — what the ledger says that day was, read now. Live.
 *
 * Both are true. Neither overwrote the other. A screen that shows only the
 * first is a filing cabinet; a screen that shows only the second cannot answer
 * "what did you tell the customer on Wednesday". This module produces both and
 * makes the difference explicit, itemised, and attributable to specific
 * entries.
 *
 * ---------------------------------------------------------------------------
 * MONEY
 * ---------------------------------------------------------------------------
 *
 * `bigint` cents everywhere in this module, matching `src/lib/ledger/**`. The
 * narrowing to the screen contract's `number` happens once, at the edge, in
 * `screen.ts`, and it refuses rather than rounds.
 *
 * Signs: a statement line's `signedCents` is `amount_cents * normal_side`, so
 * **positive is money in for the account holder** — the direction a human
 * reading a bank statement expects. The journal's raw debit-positive sign
 * stays in the journal.
 */

/** `YYYY-MM-DD` in book time (America/New_York). The value-date axis. */
export type BusinessDate = string;

export type EntryType = "original" | "reversal" | "rebook";

/**
 * One line of a rendered statement.
 *
 * The identity is `(valueDate, bookingSeq, ordinal)`, which is a TOTAL order:
 * `booking_seq` is unique per entry and `ordinal` is unique within an entry.
 * Without a total order the canonical rendering would depend on whatever order
 * Postgres felt like returning, and "identical every time" would be a coin
 * flip rather than a guarantee.
 */
export interface StatementLine {
  readonly entryId: string;
  readonly valueDate: BusinessDate;
  readonly bookingSeq: bigint;
  readonly ordinal: number;
  readonly entryType: EntryType;
  readonly description: string;
  readonly externalRef: string | null;
  readonly rail: string | null;
  /** Set on a reversal: the entry it negates. The lineage, shown not hidden. */
  readonly reversesEntryId: string | null;
  /** Ties original + reversal + rebook together. */
  readonly correctionGroupId: string | null;
  /** `amount_cents * normal_side`. Positive is money in for the holder. */
  readonly signedCents: bigint;
  /**
   * Opening balance plus every `signedCents` up to and including this line.
   *
   * Derived, not stored, and deliberately NOT part of the content hash: it is
   * a pure function of `openingBalanceCents` and the prefix of `signedCents`,
   * so hashing it would add no discrimination — two documents that agree on
   * the opening balance and every line amount cannot disagree here.
   */
  readonly runningBalanceCents: bigint;
}

/**
 * A rendered statement, before it is published (or after it is re-derived).
 *
 * This is the object the content hash is taken over. Everything in it is a
 * deterministic function of `(accountId, periodStart, periodEnd,
 * bookingWatermark)` and immutable ledger rows — there is no clock, no row id
 * we generated, and no version number in it, which is exactly why re-rendering
 * reproduces it forever.
 */
export interface StatementDocument {
  readonly accountId: string;
  readonly periodStart: BusinessDate;
  readonly periodEnd: BusinessDate;
  readonly bookingWatermark: bigint;
  readonly openingBalanceCents: bigint;
  readonly closingBalanceCents: bigint;
  readonly lineCount: number;
  readonly lines: readonly StatementLine[];
}

/** A `book_day` row: the moment a business day was signed off, and at what watermark. */
export interface BookDay {
  readonly entityId: string;
  readonly businessDate: BusinessDate;
  /** ISO 8601 instant. */
  readonly closedAt: string;
  /** `max(booking_seq)` at the moment of close. The freeze. */
  readonly bookingWatermark: bigint;
  readonly closedBy: string;
}

/**
 * A published `statement` row.
 *
 * Immutable: the table carries the append-only triggers from 0001 and
 * `corgi_app` holds `SELECT, INSERT` and nothing else. A correction produces a
 * new `version`, never an edit — which is also how a real bank issues a
 * corrected statement, and the only answer that survives the question "so
 * which is it, immutable or corrected?"
 */
export interface PublishedStatement {
  readonly statementId: string;
  readonly accountId: string;
  readonly periodStart: BusinessDate;
  readonly periodEnd: BusinessDate;
  readonly version: number;
  readonly bookingWatermark: bigint;
  readonly openingBalanceCents: bigint;
  readonly closingBalanceCents: bigint;
  readonly lineCount: number;
  /** sha256 over the canonical rendering, lowercase hex. */
  readonly contentHash: string;
  /**
   * The canonical renderer that produced `contentHash` (`STATEMENT_FORMAT`).
   *
   * A hash is only comparable against a hash from the same format. Without
   * this, a renderer change and a tampered row are indistinguishable, and the
   * alarm that is supposed to mean "the ledger moved" would fire on a deploy.
   */
  readonly format: string;
  /** ISO 8601 instant. When the document was issued — NOT part of the hash. */
  readonly generatedAt: string;
  /** The actor that issued it. Matches `book_day.closed_by`. */
  readonly generatedBy: string;
}

/** What a publish call did. `created: false` means the identical document already existed. */
export interface PublishResult {
  readonly statement: PublishedStatement;
  /** True when a row was written. False when this was a byte-identical re-issue. */
  readonly created: boolean;
  /** The document the hash was taken over, re-derived on this call. */
  readonly document: StatementDocument;
}

/**
 * An entry booked AFTER the statement was issued that changes what that day
 * was worth.
 *
 * These are the rows that make "as corrected" differ from "as published", and
 * they are the answer to "why". `queries.draft.sql` §4e is the same idea,
 * scoped to entries *inside* the period — which is not quite enough, and the
 * integration suite proved it. A closing balance is `opening + Σ lines`, so an
 * entry backdated to before the period and booked after the close moves the
 * closing figure without ever appearing as a line. Listing only in-period
 * entries left part of the difference unattributed, and the screen would have
 * reported a gap it could not itemise. The predicate is therefore "value date
 * at or before the period end", and `affectsOpening` says which side a row
 * landed on.
 *
 * Closing a day does not forbid any of them. Late and corrected entries with a
 * value date inside a closed period are legal and expected (DESIGN §13); they
 * land above the watermark and show up in the next version. Forbidding them is
 * how ledgers end up with a "corrections" suspense account nobody can explain.
 */
export interface LatePosting {
  readonly entryId: string;
  readonly valueDate: BusinessDate;
  readonly bookingSeq: bigint;
  /** ISO 8601 instant. When we learned it. */
  readonly bookingTime: string;
  readonly entryType: EntryType;
  readonly description: string;
  readonly externalRef: string | null;
  readonly reversesEntryId: string | null;
  readonly correctionGroupId: string | null;
  /** This entry's effect on the account, positive = money in for the holder. */
  readonly signedCents: bigint;
  /**
   * Its value date is BEFORE the period, so it moved the opening balance.
   *
   * Same effect on the closing figure as an in-period line, and a completely
   * different thing to read: "the day before was restated" rather than "this
   * day was corrected".
   */
  readonly affectsOpening: boolean;
}

/**
 * The bitemporal payoff, as one object.
 *
 * `published` is the document we issued and its frozen figures. `corrected` is
 * the same period re-read at the current watermark. `latePostings` is the
 * itemised difference and `deltaCents` is its total — and the invariant that
 * holds them together is checked in `compare.ts`:
 *
 *     corrected.closing - published.closing === Σ latePostings.signedCents
 *
 * If that ever fails, the difference is not explained by anything we can name,
 * which is a P1 rather than a number to render.
 */
export interface StatementComparison {
  readonly published: PublishedStatement;
  /** Re-derived from the ledger at `published.bookingWatermark`. */
  readonly publishedDocument: StatementDocument;
  /**
   * True when re-rendering the published watermark reproduced the stored hash.
   *
   * This is the reproducibility claim, evaluated on every page load rather
   * than asserted in a README. False means either a money row changed —
   * impossible through the application role, see the REVOKEs — or the renderer
   * changed, which is a deployment question and not a ledger question.
   */
  readonly reproduced: boolean;
  /**
   * The hash the re-derivation actually produced.
   *
   * Equal to `published.contentHash` when `reproduced` is true. Carried
   * separately rather than recomputed by the caller so the screen can show
   * BOTH values side by side when they disagree — "expected X, got Y" is an
   * incident report; "verification failed" is a shrug.
   */
  readonly recomputedHash: string;
  /**
   * The stored row was rendered by a different renderer than the one running.
   *
   * When true, `reproduced` being false is a deployment fact and not a ledger
   * fact: the two hashes were never comparable. See `statement.format` (0009).
   */
  readonly formatChanged: boolean;
  /** The same period at the CURRENT watermark. What we now know the day to be. */
  readonly correctedDocument: StatementDocument;
  /** `corrected.closing - published.closing`. Zero when nothing landed late. */
  readonly deltaCents: bigint;
  readonly latePostings: readonly LatePosting[];
  /** Every version issued for this period, oldest first. The lineage. */
  readonly versions: readonly PublishedStatement[];
}
