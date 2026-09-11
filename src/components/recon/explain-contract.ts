/**
 * The explaining breaks screen's data contract.
 *
 * Same seam and same rules as `./data-contract.ts`: nothing under
 * `src/components/**` opens a connection or imports `postgres`.
 * `src/lib/recon/explained-view.ts` implements this against the live book and
 * `./explain-fixtures.ts` implements it without one.
 *
 * Every amount is integer minor units (US cents). The query layer works in
 * `bigint` throughout and narrows once, at the edge, in `explained-view.ts`.
 * There is no division and no `toFixed` on any path that reaches this file.
 */

import type { ErrorShape, Result } from "@/lib/result";
import type {
  AgingAxis,
  CorrectionClass,
} from "@/lib/recon/explain";
import type {
  AgeBucket,
  BreakKind,
  ExplainedBy,
  ReasonCode,
  Severity,
} from "@/lib/recon/types";

import type { Cents, Instant, RunRow, ValueDate } from "./data-contract";

export type { AgeBucket, AgingAxis, BreakKind, Cents, CorrectionClass, ExplainedBy, Instant, ReasonCode, RunRow, Severity, ValueDate };

/* -------------------------------------------------------------------------- */
/* The timeline                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One step of the causal history, carrying BOTH axes.
 *
 * `valueDate` is the day the money belongs to; `bookingTime` and `bookingSeq`
 * are when the book learned. `backdatedDays` is the distance between them, and
 * it is the field the whole screen exists to put in front of somebody: on a
 * reversal it is greater than zero, and the value date it carries is the
 * ORIGINAL's, not the day we found out.
 */
export type CorrectionStepView = {
  readonly entryId: string;
  readonly entryType: "original" | "reversal" | "rebook";
  readonly valueDate: ValueDate;
  /** Monotonic booking position. Rendered as `seq N`, never as a time. */
  readonly bookingSeq: number;
  readonly bookingTime: Instant;
  readonly bookingDate: ValueDate;
  readonly backdatedDays: number;
  /** Signed effect on the rail-control leg. Debit positive. */
  readonly railCents: Cents;
  /** The group's net on the rail after this step. */
  readonly runningNetCents: Cents;
  readonly description: string;
  readonly reversesEntryId: string | null;
};

/* -------------------------------------------------------------------------- */
/* A break that can explain itself                                            */
/* -------------------------------------------------------------------------- */

export type AxisFactsView = {
  readonly ageDays: number;
  readonly closesCrossed: number;
};

export type ExplainedBreakRow = {
  /** `<kind>:<breakKey>`. Identical to the reconciliation screen's id. */
  readonly id: string;
  readonly kind: BreakKind;
  readonly reasonCode: ReasonCode;
  readonly externalRef: string;
  readonly valueDate: ValueDate;
  readonly rail: string;
  readonly provider: string;

  /* ---- the numbers ---- */
  readonly fileAmountCents: Cents | null;
  /** What the anchor entry booked — the number the provider disagreed with. */
  readonly ledgerAmountCents: Cents | null;
  /** Where the correction group stands now. */
  readonly ledgerNetCents: Cents | null;
  /** `file - anchor`. The engine's own break amount. */
  readonly breakAmountCents: Cents;
  /** `file - net`. What is still outstanding after the whole group. */
  readonly residualCents: Cents;

  /* ---- the classification ---- */
  readonly correctionClass: CorrectionClass;
  /** The engine's `explained_by`, carried through unchanged. */
  readonly explainedBy: ExplainedBy | null;
  /** Never true unless the class is `correction_closed` AND residual is zero. */
  readonly fullyExplained: boolean;
  /** What believing this classification could hide. Shown, not buried. */
  readonly exclusionRisk: string;

  /* ---- the two clocks ---- */
  readonly agingAxis: AgingAxis;
  readonly ageDays: number;
  readonly closesCrossed: number;
  readonly ageBucket: AgeBucket;
  readonly severity: Severity;
  readonly axisRationale: string;
  /** Always both, so the screen can print the axis it did NOT age on. */
  readonly valueAxis: AxisFactsView;
  readonly bookingAxis: AxisFactsView | null;
  readonly learnedAt: Instant | null;
  readonly maxBackdatedDays: number;

  /* ---- the story ---- */
  readonly steps: readonly CorrectionStepView[];
  readonly description: string | null;
  readonly correctionGroupId: string | null;
  readonly entryId: string | null;
  readonly fileRowId: string | null;
};

/* -------------------------------------------------------------------------- */
/* Corrections the diff cannot see                                            */
/* -------------------------------------------------------------------------- */

/**
 * A file row that matched clean against the anchor entry and whose correction
 * group has since moved away from it.
 *
 * Advisory, and labelled as such on the screen. Not a break kind: see the long
 * note at `readSilentCorrections` in `src/lib/recon/explain-read.ts`.
 */
export type SilentCorrectionRow = {
  readonly fileRowId: string;
  readonly rowNo: number;
  readonly entryId: string;
  readonly correctionGroupId: string;
  readonly externalRef: string;
  readonly valueDate: ValueDate;
  readonly rail: string;
  readonly fileAmountCents: Cents;
  readonly ledgerNetCents: Cents;
  /** `file - net`. Signed on the file's axis. */
  readonly driftCents: Cents;
  readonly hasReversal: boolean;
  readonly hasRebook: boolean;
  readonly entryCount: number;
  readonly description: string | null;
  readonly steps: readonly CorrectionStepView[];
};

/* -------------------------------------------------------------------------- */
/* The view                                                                   */
/* -------------------------------------------------------------------------- */

export type ExplainedView = {
  readonly source: "live" | "fixture";
  readonly asOf: Instant;
  readonly run: RunRow | null;
  /** Recent runs, newest first, for the run picker. Never used for the diff. */
  readonly history: readonly RunRow[];
  readonly rows: readonly ExplainedBreakRow[];
  readonly silent: readonly SilentCorrectionRow[];
  /** `<kind>:<breakKey>` of the row opened in the timeline, if any. */
  readonly selected: string | null;
  /**
   * Where a fixture's rows came from, verbatim, for the fixture banner.
   *
   * Only ever set by `./explain-fixtures.ts`. The live source leaves it
   * `undefined`: a live read's provenance is the run header and the LIVE
   * LEDGER badge, and a sentence claiming provenance would be one more thing
   * that could be wrong.
   */
  readonly provenance?: string | undefined;
};

export type ExplainedQuery = {
  readonly runId?: string | undefined;
  readonly selected?: string | undefined;
};

export interface ExplainedDataSource {
  load(query: ExplainedQuery): Promise<Result<ExplainedView, ErrorShape>>;
}
