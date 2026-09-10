/**
 * The breaks screen without a database.
 *
 * Two jobs, and they are different:
 *
 * 1. THE FOUR NON-DEFAULT STATES. `loading`, `empty`, `error` and `edge` have
 *    to be reachable in front of a panel without writing a row, so they are
 *    fixtures even when a database is configured. `default` is always the live
 *    query; that is the state the planted break has to be found in.
 *
 * 2. NO DATABASE AT ALL. `pnpm dev` with no `.env` still renders a real
 *    screen, labelled `fixture` on its face. The label is not decoration — see
 *    `ReconSource` in the contract: a figure without provenance is a rumour,
 *    and a breaks screen that quietly showed made-up money would be the worst
 *    place in this codebase to start.
 *
 * The numbers are the demo scenario's own (src/lib/recon/demo.ts), so the
 * fixture and the live screen tell the same story: an ACH settlement booked at
 * the authorised amount, an entry the ODFI's file omits, a settled transfer
 * whose webhook never arrived, and one mismatch that has already been
 * corrected by a reversal plus a re-book.
 */

import { ok, fail } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type {
  BreakDetail,
  BreakRow,
  ReconDataSource,
  ReconQuery,
  ReconView,
  RunRow,
} from "./data-contract";
import type { DemoState } from "./view-state";

/**
 * The instant every fixture is read as-of.
 *
 * Fixed rather than `Date.now()`, so ages and countdowns are reproducible, the
 * screen is a pure function of the URL, and the server render cannot disagree
 * with the client hydration.
 */
export const DEMO_NOW = "2026-09-10T02:14:00.000Z"; // 22:14 ET, after the nightly file

/** How long the `loading` state holds the skeleton open. Long enough to see. */
export const DEMO_LOADING_MS = 6_000;

const BUSINESS_DATE = "2026-09-09";

const RUN: RunRow = {
  runId: "run_demo_0002",
  runNo: 2,
  fileId: "file_demo_0001",
  filename: "achsim-settlement-2026-09-09.csv",
  fileSha256: "9f2c41b8e07d5a6631cc0f4a2e8b7d1953ac6e0f4b8d2a7c1e5f93b06d4a8c72",
  provider: "achsim",
  rail: "ach",
  businessDate: BUSINESS_DATE,
  bookingWatermark: 184,
  matchedCount: 8,
  fileRowCount: 9,
  breakCount: 4,
  breakTotalCents: 28_884,
  inFileNotLedger: 1,
  inLedgerNotFile: 1,
  amountMismatch: 2,
  rejectedRows: 5,
  contentHash: "3ad9f0c15e7b28d4a6c93f10b8e25d7c4f0a1b93e6d825c7a4f1b0e93d6c852a",
  startedAt: "2026-09-10T02:05:11.000Z",
  runBy: "ledger-poster",
};

const RUN_1: RunRow = {
  ...RUN,
  runId: "run_demo_0001",
  runNo: 1,
  startedAt: "2026-09-09T22:00:04.000Z",
};

const BREAKS: readonly BreakRow[] = [
  {
    id: "in_ledger_not_file:entry_demo_0007",
    kind: "in_ledger_not_file",
    reasonCode: "unmatched_reference",
    severity: "aged",
    ageBucket: "0-1",
    externalRef: "ACH-LEDGER-ONLY-20260909",
    valueDate: BUSINESS_DATE,
    businessDate: BUSINESS_DATE,
    provider: "achsim",
    rail: "ach",
    fileAmountCents: null,
    ledgerAmountCents: 21_450,
    ledgerNetCents: 21_450,
    breakAmountCents: 21_450,
    ageDays: 1,
    closesCrossed: 1,
    explainedBy: null,
    severityReason:
      "Open across one day close — a signed-off day contains this break.",
    description: "ACH settlement notified by webhook, absent from the ODFI file",
    fileRowId: null,
    fileRowNo: null,
    entryId: "entry_demo_0007",
    correctionGroupId: "grp_demo_0007",
  },
  {
    id: "in_file_not_ledger:row_demo_0003",
    kind: "in_file_not_ledger",
    reasonCode: "unmatched_reference",
    severity: "aged",
    ageBucket: "0-1",
    externalRef: "507320856535806",
    valueDate: BUSINESS_DATE,
    businessDate: BUSINESS_DATE,
    provider: "achsim",
    rail: "ach",
    fileAmountCents: 10_274,
    ledgerAmountCents: null,
    ledgerNetCents: null,
    breakAmountCents: 10_274,
    ageDays: 1,
    closesCrossed: 1,
    explainedBy: null,
    severityReason:
      "Open across one day close — a signed-off day contains this break.",
    description: null,
    fileRowId: "row_demo_0003",
    fileRowNo: 3,
    entryId: null,
    correctionGroupId: null,
  },
  {
    id: "amount_mismatch:row_demo_0006",
    kind: "amount_mismatch",
    reasonCode: "amount_differs",
    severity: "aged",
    ageBucket: "0-1",
    externalRef: "671660289866849",
    valueDate: BUSINESS_DATE,
    businessDate: BUSINESS_DATE,
    provider: "achsim",
    rail: "ach",
    fileAmountCents: 19_685,
    ledgerAmountCents: 17_845,
    ledgerNetCents: 17_845,
    breakAmountCents: 1_840,
    ageDays: 1,
    closesCrossed: 1,
    explainedBy: null,
    severityReason:
      "Open across one day close — a signed-off day contains this break.",
    description: "ACH settlement (booked at the authorised amount)",
    fileRowId: "row_demo_0006",
    fileRowNo: 6,
    entryId: "entry_demo_0006",
    correctionGroupId: "grp_demo_0006",
  },
  {
    id: "amount_mismatch:row_demo_0008",
    kind: "amount_mismatch",
    reasonCode: "amount_differs",
    severity: "explained",
    ageBucket: "0-1",
    externalRef: "783748572668991",
    valueDate: BUSINESS_DATE,
    businessDate: BUSINESS_DATE,
    provider: "achsim",
    rail: "ach",
    fileAmountCents: 25_959,
    ledgerAmountCents: 30_959,
    ledgerNetCents: 25_959,
    breakAmountCents: -5_000,
    ageDays: 1,
    closesCrossed: 1,
    explainedBy: "reversal_and_rebook",
    severityReason:
      "The entry behind this break was reversed and re-booked; the correction group now nets to the file's amount.",
    description: "ACH settlement (amount taken from the wrong field)",
    fileRowId: "row_demo_0008",
    fileRowNo: 8,
    entryId: "entry_demo_0008",
    correctionGroupId: "grp_demo_0008",
  },
];

/** The edge case's drill-through: the original, the reversal, and the re-book. */
const EDGE_DETAIL: BreakDetail = {
  row: BREAKS[3] as BreakRow,
  fileRow: {
    fileRowId: "row_demo_0008",
    rowNo: 8,
    externalRef: "783748572668991",
    amountCents: 25_959,
    valueDate: BUSINESS_DATE,
    raw: {
      reference: "783748572668991",
      amount: "259.59",
      value_date: BUSINESS_DATE,
      direction: "credit",
      descriptor: "CORGI 008",
    },
    filename: "achsim-settlement-2026-09-09.csv",
    fileSha256: RUN.fileSha256,
    importedAt: "2026-09-10T02:05:09.000Z",
  },
  correctionGroup: [
    {
      entryId: "entry_demo_0008",
      bookingSeq: 171,
      bookingTime: "2026-09-09T18:12:03.000Z",
      valueDate: BUSINESS_DATE,
      entryType: "original",
      description: "ACH settlement (amount taken from the wrong field)",
      externalRef: "783748572668991",
      idempotencyKey: "ach:settled:2026-09-09:783748572668991",
      reversesEntryId: null,
      lines: [
        {
          ordinal: 0,
          accountCode: "1130",
          accountName: "ACH receivable — inbound in transit",
          amountCents: 30_959,
          railControl: "ach",
        },
        {
          ordinal: 1,
          accountCode: "2100",
          accountName: "Ridgeline Robotics, Inc. — business current account",
          amountCents: -30_959,
          railControl: null,
        },
      ],
    },
    {
      entryId: "entry_demo_0008r",
      bookingSeq: 172,
      bookingTime: "2026-09-09T18:12:04.000Z",
      valueDate: BUSINESS_DATE,
      entryType: "reversal",
      description:
        "Reversal of entry_demo_0008: settled amount taken from the wrong field on the provider payload",
      externalRef: "783748572668991",
      idempotencyKey: "reversal:entry_demo_0008",
      reversesEntryId: "entry_demo_0008",
      lines: [
        {
          ordinal: 0,
          accountCode: "1130",
          accountName: "ACH receivable — inbound in transit",
          amountCents: -30_959,
          railControl: "ach",
        },
        {
          ordinal: 1,
          accountCode: "2100",
          accountName: "Ridgeline Robotics, Inc. — business current account",
          amountCents: 30_959,
          railControl: null,
        },
      ],
    },
    {
      entryId: "entry_demo_0008b",
      bookingSeq: 173,
      bookingTime: "2026-09-09T18:12:05.000Z",
      valueDate: BUSINESS_DATE,
      entryType: "rebook",
      description: "ACH settlement, re-booked at the settled amount",
      externalRef: "783748572668991",
      idempotencyKey: "ach:rebook:2026-09-09:783748572668991",
      reversesEntryId: null,
      lines: [
        {
          ordinal: 0,
          accountCode: "1130",
          accountName: "ACH receivable — inbound in transit",
          amountCents: 25_959,
          railControl: "ach",
        },
        {
          ordinal: 1,
          accountCode: "2100",
          accountName: "Ridgeline Robotics, Inc. — business current account",
          amountCents: -25_959,
          railControl: null,
        },
      ],
    },
  ],
  notes: [],
};

const REJECTS = [
  {
    rowNo: 1,
    rawLine: "TRUNCATED-ROW-0001,142.50",
    reason: "field_count",
    detail:
      "expected 5 fields (reference, amount, value_date, direction, descriptor), got 2",
  },
  {
    rowNo: 2,
    rawLine: 'SEPARATOR-ROW-0002,"1,240.00",2026-09-09,credit,ACME PAYROLL',
    reason: "bad_amount",
    detail: 'amount "1,240.00" is not a signed decimal with at most two places',
  },
  {
    rowNo: 3,
    rawLine: "MILLS-ROW-0003,88.125,2026-09-09,credit,FRACTIONAL CENTS",
    reason: "bad_amount",
    detail: 'amount "88.125" is not a signed decimal with at most two places',
  },
  {
    rowNo: 4,
    rawLine: "EUDATE-ROW-0004,64.00,09/09/2026,credit,DATE FORMAT DRIFT",
    reason: "bad_value_date",
    detail: 'value_date "09/09/2026" is not YYYY-MM-DD',
  },
  {
    rowNo: 5,
    rawLine: "SIGNCLASH-ROW-0005,-410.00,2026-09-09,credit,DIRECTION DISAGREES",
    reason: "direction_sign_mismatch",
    detail:
      "direction says credit but the amount -410.00 is a debit; the file disagrees with itself",
  },
] as const;

function view(overrides: Partial<ReconView> = {}): ReconView {
  return {
    source: "fixture",
    asOf: DEMO_NOW,
    run: RUN,
    history: [RUN, RUN_1],
    breaks: BREAKS,
    rejects: REJECTS,
    detail: null,
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
export function createFixtureReconSource(state: DemoState): ReconDataSource {
  return {
    async load(query: ReconQuery): Promise<Result<ReconView, ErrorShape>> {
      if (state === "loading") {
        await new Promise((resolve) => setTimeout(resolve, DEMO_LOADING_MS));
        return ok(view());
      }

      if (state === "empty") {
        return ok(
          view({
            run: { ...RUN, breakCount: 0, matchedCount: 9, rejectedRows: 0 },
            history: [{ ...RUN, breakCount: 0, matchedCount: 9, rejectedRows: 0 }],
            breaks: [],
            rejects: [],
          }),
        );
      }

      if (state === "error") {
        return fail(
          "RECON_READ_FAILED",
          "the reconciliation query failed: connection terminated unexpectedly",
        );
      }

      if (state === "edge") {
        // Only the explained break, already drilled into, because the point of
        // the state is the explanation and not the list.
        return ok(
          view({
            breaks: [BREAKS[3] as BreakRow],
            detail: EDGE_DETAIL,
          }),
        );
      }

      return ok(
        view(
          query.selectedBreak === EDGE_DETAIL.row.id ? { detail: EDGE_DETAIL } : {},
        ),
      );
    },
  };
}
