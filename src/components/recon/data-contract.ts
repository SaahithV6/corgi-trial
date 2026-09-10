/**
 * The breaks screen's data contract.
 *
 * Same seam, and the same rules, as `src/components/account/data-contract.ts`:
 * nothing under `src/components/**` opens a connection, imports `postgres`, or
 * reaches into `src/lib/recon/*` for anything but these types. The screen
 * depends on this interface; `src/lib/recon/screen.ts` implements it against
 * the live database and `./fixtures.ts` implements it without one.
 *
 * Shape notes:
 *
 * - **Every amount is integer minor units (US cents)**, never dollars, never a
 *   float, never a string with a decimal point in it. `number` rather than
 *   `bigint` because these cross the server/client boundary and `number` is
 *   exact to about $90 trillion; the query layer works in `bigint` throughout
 *   and narrows once, at the edge, in `screen.ts`. Widening this alias later is
 *   a one-line change plus a serialisation decision, and no component
 *   arithmetic changes.
 * - **Value dates are `YYYY-MM-DD`**; instants are ISO 8601 with an offset.
 *   They are different types because they are different clocks (DESIGN.md §5).
 * - **Failure is a value, not a throw**, so the error state is a branch.
 * - **The screen never writes.** Reconciliation runs and adjudication notes are
 *   operator actions with an actor attached; a render is not one.
 */

import type { ErrorShape, Result } from "@/lib/result";
import type {
  AgeBucket,
  BreakKind,
  ExplainedBy,
  ReasonCode,
  Severity,
} from "@/lib/recon/types";

/** Integer minor units (US cents). Never dollars. */
export type Cents = number;
/** ISO 8601 instant. */
export type Instant = string;
/** `YYYY-MM-DD`. The value-date axis, not an instant. */
export type ValueDate = string;

export type { AgeBucket, BreakKind, ExplainedBy, ReasonCode, Severity };

/* -------------------------------------------------------------------------- */
/* A break                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One row of the breaks table.
 *
 * `fileAmountCents` and `ledgerAmountCents` are both present on a mismatch and
 * exactly one is present on the two one-sided categories. `null` is not zero:
 * "the provider's file does not carry this at all" and "the provider's file
 * carries it as nothing" are different facts, and the table renders the first
 * as an em dash.
 *
 * `ledgerNetCents` differs from `ledgerAmountCents` exactly when the matched
 * entry was later reversed and re-booked. That difference is the edge state.
 */
export type BreakRow = {
  /** Stable across renders: `<kind>:<breakKey>`. The row's identity in a URL. */
  readonly id: string;
  readonly kind: BreakKind;
  readonly reasonCode: ReasonCode;
  readonly severity: Severity;
  readonly ageBucket: AgeBucket;

  readonly externalRef: string;
  readonly valueDate: ValueDate;
  readonly businessDate: ValueDate;
  readonly provider: string;
  readonly rail: string;

  readonly fileAmountCents: Cents | null;
  readonly ledgerAmountCents: Cents | null;
  readonly ledgerNetCents: Cents | null;
  /** Signed, on the file's axis: how much the file is out by. */
  readonly breakAmountCents: Cents;

  readonly ageDays: number;
  /** Day closes this break has survived. Zero means its day is still open. */
  readonly closesCrossed: number;
  readonly explainedBy: ExplainedBy | null;
  /** One sentence saying why it has the severity it has. */
  readonly severityReason: string;

  readonly description: string | null;

  /* ---- drill-through ---- */
  readonly fileRowId: string | null;
  readonly fileRowNo: number | null;
  readonly entryId: string | null;
  readonly correctionGroupId: string | null;
};

/* -------------------------------------------------------------------------- */
/* Drill-through                                                              */
/* -------------------------------------------------------------------------- */

export type EntryLine = {
  readonly ordinal: number;
  readonly accountCode: string;
  readonly accountName: string;
  /** Debit positive, credit negative — the journal's own sign, not flipped. */
  readonly amountCents: Cents;
  /** Set on the rail-facing control account: the leg reconciliation compares. */
  readonly railControl: string | null;
};

export type EntryView = {
  readonly entryId: string;
  readonly bookingSeq: number;
  readonly bookingTime: Instant;
  readonly valueDate: ValueDate;
  readonly entryType: "original" | "reversal" | "rebook";
  readonly description: string;
  readonly externalRef: string | null;
  readonly idempotencyKey: string;
  readonly reversesEntryId: string | null;
  readonly lines: readonly EntryLine[];
};

export type FileRowView = {
  readonly fileRowId: string;
  readonly rowNo: number;
  readonly externalRef: string;
  readonly amountCents: Cents;
  readonly valueDate: ValueDate;
  /** The row exactly as it arrived. Shown verbatim; never re-rendered. */
  readonly raw: Readonly<Record<string, unknown>>;
  readonly filename: string;
  readonly fileSha256: string;
  readonly importedAt: Instant;
};

export type BreakNoteView = {
  readonly createdAt: Instant;
  readonly note: string;
  readonly resolution: string | null;
  readonly adjustingEntryId: string | null;
  readonly createdBy: string;
};

/**
 * Everything behind one break.
 *
 * `correctionGroup` is the whole group, oldest first — not just the matched
 * entry. Showing one entry answers "what did we book"; the group answers "and
 * what did we do about it", which is the only way a reversal-plus-rebook reads
 * as an explanation rather than three unrelated postings.
 */
export type BreakDetail = {
  readonly row: BreakRow;
  readonly fileRow: FileRowView | null;
  readonly correctionGroup: readonly EntryView[];
  readonly notes: readonly BreakNoteView[];
};

/* -------------------------------------------------------------------------- */
/* Runs                                                                       */
/* -------------------------------------------------------------------------- */

export type RunRow = {
  readonly runId: string;
  readonly runNo: number;
  readonly fileId: string;
  readonly filename: string;
  readonly fileSha256: string;
  readonly provider: string;
  readonly rail: string;
  readonly businessDate: ValueDate;
  readonly bookingWatermark: number;
  readonly matchedCount: number;
  readonly fileRowCount: number;
  readonly breakCount: number;
  readonly breakTotalCents: Cents;
  readonly inFileNotLedger: number;
  readonly inLedgerNotFile: number;
  readonly amountMismatch: number;
  readonly rejectedRows: number;
  readonly contentHash: string;
  readonly startedAt: Instant;
  readonly runBy: string;
};

export type RejectRow = {
  readonly rowNo: number;
  readonly rawLine: string;
  readonly reason: string;
  readonly detail: string;
};

/* -------------------------------------------------------------------------- */
/* The view                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Where the numbers came from.
 *
 * Rendered on the screen, always. This codebase's whole posture is that a
 * figure without provenance is a rumour (see `RailSlotHealth.evidence` and
 * `KYB` evidence degradation), and a breaks screen that silently falls back to
 * a fixture when the database is unreachable would be the worst example of it.
 */
export type ReconSource = "live" | "fixture";

export type ReconView = {
  readonly source: ReconSource;
  /** The instant the read was taken. Every age on screen is measured to this. */
  readonly asOf: Instant;
  /** The run being shown. `null` when nothing has been reconciled yet. */
  readonly run: RunRow | null;
  /** Run history for the same file, newest first. */
  readonly history: readonly RunRow[];
  /**
   * Breaks as they stand NOW, not as the run recorded them.
   *
   * The run snapshot is immutable evidence of what a past run saw; this list
   * is the live view, so a break corrected ten minutes ago shows as explained
   * rather than as whatever it was at 21:00. Both are true and the screen says
   * which one it is showing.
   */
  readonly breaks: readonly BreakRow[];
  /** Lines of the file the parser could not read. */
  readonly rejects: readonly RejectRow[];
  /** Present when a break is selected in the URL. */
  readonly detail: BreakDetail | null;
};

export type ReconQuery = {
  /** Which run to show. Omit for the most recent. */
  readonly runId?: string | undefined;
  /** `<kind>:<breakKey>` — the drill-through target. */
  readonly selectedBreak?: string | undefined;
};

export interface ReconDataSource {
  load(query: ReconQuery): Promise<Result<ReconView, ErrorShape>>;
}
