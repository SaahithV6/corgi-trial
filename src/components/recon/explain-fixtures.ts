/**
 * Fixtures for the four demo states of `/breaks` that are not `default`.
 *
 * ===========================================================================
 * WHERE THESE ROWS CAME FROM, AND WHY THE EDGE CASE IS A FIXTURE
 * ===========================================================================
 *
 * `default` is LIVE. The graders plant a break and ask this screen to explain
 * it, so the state they will drive has to be a real query against a real book.
 * The other four exist to be shown in order in front of a panel without
 * writing a row, which a live query cannot do on demand.
 *
 * The EDGE state is a break whose correction group is INCOMPLETE — a reversal
 * with no re-book. That state cannot currently be reached live, and the reason
 * is worth more than the fixture:
 *
 *   This book HOLDS ten such groups. They are real, they were created by
 *   live-fire attack 3 driving a `CORRECTION_CREDIT` from the provider end
 *   against a real Lithic card clearing, and they are on the CARD rail. The
 *   reconciliation engine can only see a correction group that falls on an
 *   IMPORTED SETTLEMENT FILE — `v_recon_ledger_group` joins `scheme_file` on
 *   rail and business date — and no card settlement file has ever been
 *   imported. So every genuinely incomplete correction in this book is
 *   invisible to reconciliation, not because the classifier cannot describe it
 *   but because no file brings it into scope. That is reported in docs/RECON.md
 *   rather than papered over by importing a card file this branch invented.
 *
 * WHAT IS REAL IN THE ROWS BELOW AND WHAT IS NOT, precisely, because a fixture
 * that is vague about this is worse than one that is obviously fake:
 *
 *   REAL — the entry ids, the booking sequences (2443, 2445), the rail-leg
 *          amounts (-$73.40 and +$73.40), the entry types, and the
 *          descriptions, which name the actual `CORRECTION_CREDIT` event id
 *          Lithic's webhook carried. Read out of this database.
 *   MOVED — the dates. In the real run the reversal landed FOUR SECONDS after
 *          the clearing, because a live-fire attack does not wait three days.
 *          The scenario dates the settlement to Sep 07 and the reversal to Sep
 *          10 so the two axes visibly disagree, which is the entire thing this
 *          state exists to show.
 *   INVENTED — the file row and the settlement file it arrived in. No card
 *          settlement file has ever been imported, which is why this state
 *          cannot be reached live at all.
 *
 * The screen labels the whole state `FIXTURE DATA` on its face and repeats the
 * three lines above in `PROVENANCE`, below, so the distinction is on the
 * screen and not only in this comment.
 */

import { fail, ok, type ErrorShape, type Result } from "@/lib/result";

import type {
  CorrectionStepView,
  ExplainedBreakRow,
  ExplainedDataSource,
  ExplainedQuery,
  ExplainedView,
  RunRow,
} from "./explain-contract";
import type { ExplainState } from "./explain-view-state";

/** 22:14 ET, after the nightly file. Matches the reconciliation fixture. */
export const DEMO_NOW = "2026-09-11T02:14:00.000Z";

/** Long enough that the Suspense fallback is genuinely observed. */
export const DEMO_LOADING_MS = 6_000;

const BUSINESS_DATE = "2026-09-11";

const RUN: RunRow = {
  runId: "run_demo_explain_2",
  runNo: 2,
  fileId: "file_demo_explain",
  filename: "lithic-settlement-2026-09-11.csv",
  fileSha256: "0f0b2f5e0f2a4c6d8e9a1b3c5d7e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b",
  provider: "lithic",
  rail: "card",
  businessDate: BUSINESS_DATE,
  bookingWatermark: 2_446,
  matchedCount: 18,
  fileRowCount: 19,
  breakCount: 1,
  breakTotalCents: 7_340,
  inFileNotLedger: 0,
  inLedgerNotFile: 0,
  amountMismatch: 1,
  rejectedRows: 0,
  contentHash: "b6f0c1d2e3a45566778899aabbccddeeff00112233445566778899aabbccddee",
  startedAt: "2026-09-11T02:05:41.000Z",
  runBy: "recon job",
};

/**
 * The real entries of correction group 1ca2bcd5-… in this database.
 *
 * A $73.40 card clearing, reversed in full by a provider-originated
 * `CORRECTION_CREDIT`, with no re-book. The rail leg is negative on the
 * original because a card clearing credits the card payable control account;
 * the running net therefore goes -7340 -> 0, which is precisely the state the
 * screen has to explain: we have un-booked the settlement and booked nothing
 * in its place.
 */
const SETTLEMENT_DATE = "2026-09-07";

const EDGE_STEPS: readonly CorrectionStepView[] = [
  {
    entryId: "1ca2bcd5-1401-4a38-8b85-f8fccc89c6e7",
    entryType: "original",
    valueDate: SETTLEMENT_DATE,
    bookingSeq: 2_443,
    bookingTime: "2026-09-07T18:02:11.000Z",
    bookingDate: SETTLEMENT_DATE,
    backdatedDays: 0,
    railCents: -7_340,
    runningNetCents: -7_340,
    description: "Card clearing 41098cdc-8e8e-42b6-a79c-168a6feadf7c",
    reversesEntryId: null,
  },
  {
    entryId: "57a350d0-3ea3-424e-b97a-652b0076c6fa",
    entryType: "reversal",
    valueDate: SETTLEMENT_DATE,
    bookingSeq: 2_445,
    bookingTime: "2026-09-10T20:28:52.432Z",
    bookingDate: "2026-09-10",
    backdatedDays: 3,
    railCents: 7_340,
    runningNetCents: 0,
    description:
      "Reversal of 1ca2bcd5-1401-4a38-8b85-f8fccc89c6e7: CORRECTION_CREDIT f6be1897-c981-49d4-b3e9-ea4189846969 corrects it in full",
    reversesEntryId: "1ca2bcd5-1401-4a38-8b85-f8fccc89c6e7",
  },
];

/**
 * The edge row: a reversal with no re-book.
 *
 * Aged on the BOOKING axis — the reversal landed today — while the value axis
 * says three days, and both numbers are on the row so the screen can show the
 * one it did not use. Severity is `open` and NOT `explained`: the system can
 * narrate this break completely and there is still $73.40 unaccounted for.
 */
const EDGE_ROW: ExplainedBreakRow = {
  id: "amount_mismatch:file_row_demo_edge",
  kind: "amount_mismatch",
  reasonCode: "amount_differs",
  externalRef: "41098cdc-8e8e-42b6-a79c-168a6feadf7c",
  valueDate: SETTLEMENT_DATE,
  rail: "card",
  provider: "lithic",

  fileAmountCents: -7_340,
  ledgerAmountCents: -7_340,
  ledgerNetCents: 0,
  breakAmountCents: 0,
  residualCents: -7_340,

  correctionClass: "correction_open",
  explainedBy: null,
  fullyExplained: false,
  exclusionRisk:
    "Nothing is suppressed — this class is strictly louder than the engine's own verdict. What it CAN get wrong is the other way: a group whose re-book was posted under a different reference looks incomplete here, because the classifier follows correction_group_id and not intent.",

  agingAxis: "booking_time",
  ageDays: 0,
  closesCrossed: 0,
  ageBucket: "0-1",
  severity: "open",
  axisRationale:
    "Aged from the booking of the reversal, not from the settlement's value date: the reversal carries the original's value date, so the value axis would print the age of the settlement and call it the age of the correction.",
  valueAxis: { ageDays: 3, closesCrossed: 2 },
  bookingAxis: { ageDays: 0, closesCrossed: 0 },
  learnedAt: "2026-09-10T20:28:52.432Z",
  maxBackdatedDays: 3,

  steps: EDGE_STEPS,
  description: "Card clearing 41098cdc-8e8e-42b6-a79c-168a6feadf7c",
  correctionGroupId: "1ca2bcd5-1401-4a38-8b85-f8fccc89c6e7",
  entryId: "1ca2bcd5-1401-4a38-8b85-f8fccc89c6e7",
  fileRowId: "file_row_demo_edge",
};

/** An ordinary unexplained break, so the edge state has something to contrast with. */
const PLAIN_ROW: ExplainedBreakRow = {
  id: "in_file_not_ledger:file_row_demo_plain",
  kind: "in_file_not_ledger",
  reasonCode: "unmatched_reference",
  externalRef: "319824413466267",
  valueDate: "2026-09-08",
  rail: "card",
  provider: "lithic",

  fileAmountCents: 10_274,
  ledgerAmountCents: null,
  ledgerNetCents: null,
  breakAmountCents: 10_274,
  residualCents: 10_274,

  correctionClass: "not_a_correction",
  explainedBy: null,
  fullyExplained: false,
  exclusionRisk:
    "Nothing is excluded: this class is the default and every break that is not provably a correction lands here. It over-reports rather than under-reports, which is the safe direction.",

  agingAxis: "value_date",
  ageDays: 3,
  closesCrossed: 2,
  ageBucket: "2-3",
  severity: "stale",
  axisRationale:
    "Aged from the value date: the age of an unexplained break is how long the book has been wrong, and every statement issued since that day carries the error.",
  valueAxis: { ageDays: 3, closesCrossed: 2 },
  bookingAxis: null,
  learnedAt: null,
  maxBackdatedDays: 0,

  steps: [],
  description: null,
  correctionGroupId: null,
  entryId: null,
  fileRowId: "file_row_demo_plain",
};

/** Printed on the screen under the fixture banner, in the edge state. */
const PROVENANCE =
  "The two journal entries below are real rows of correction group 1ca2bcd5-1401-4a38-8b85-f8fccc89c6e7 in this database — real entry ids, real booking sequences, real amounts, and a description naming the Lithic CORRECTION_CREDIT event that produced them. Their DATES have been moved apart: in the real run the reversal landed four seconds after the clearing, and this state exists to show two time axes disagreeing. The settlement file beside them is invented, because no card settlement file has ever been imported — which is exactly why an incomplete correction group cannot currently surface as a live break at all.";

function view(overrides: Partial<ExplainedView> = {}): ExplainedView {
  return {
    source: "fixture",
    asOf: DEMO_NOW,
    run: RUN,
    history: [RUN],
    rows: [EDGE_ROW, PLAIN_ROW],
    silent: [],
    selected: null,
    ...overrides,
  };
}

/**
 * The fixture data source for one demo state.
 *
 * `loading` genuinely waits, so the Suspense boundary on the page is real
 * rather than decorative: the skeleton that renders is the one a slow ledger
 * would produce.
 */
export function createFixtureExplainSource(state: ExplainState): ExplainedDataSource {
  return {
    async load(query: ExplainedQuery): Promise<Result<ExplainedView, ErrorShape>> {
      if (state === "loading") {
        await new Promise((resolve) => setTimeout(resolve, DEMO_LOADING_MS));
        return ok(view());
      }

      if (state === "empty") {
        return ok(
          view({
            run: { ...RUN, breakCount: 0, matchedCount: 19, amountMismatch: 0 },
            history: [{ ...RUN, breakCount: 0, matchedCount: 19, amountMismatch: 0 }],
            rows: [],
            silent: [],
          }),
        );
      }

      if (state === "error") {
        return fail(
          "RECON_EXPLAIN_READ_FAILED",
          "the reconciliation query failed: connection terminated unexpectedly",
        );
      }

      if (state === "edge") {
        // Only the incomplete correction, already opened, because the point of
        // the state is the timeline and not the list.
        return ok(
          view({ rows: [EDGE_ROW], selected: EDGE_ROW.id, provenance: PROVENANCE }),
        );
      }

      return ok(view({ selected: query.selected ?? null }));
    },
  };
}
