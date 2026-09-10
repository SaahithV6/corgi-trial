/**
 * The statements screen without a database.
 *
 * Two jobs, and they are different:
 *
 * 1. THE FOUR NON-DEFAULT STATES. `loading`, `empty`, `error` and `edge` have
 *    to be reachable in front of a panel without closing a day or issuing a
 *    document, so they are fixtures even when a database is configured. Both
 *    of those writes are PERMANENT — `book_day` and `statement` are
 *    append-only and the application role holds no `UPDATE` — so a demo
 *    control that produced them for real would be a demo control with no undo.
 *    `default` is always the live query; that is the state the reproducibility
 *    claim has to be true in.
 *
 * 2. NO DATABASE AT ALL. `pnpm dev` with no `.env` still renders a real
 *    screen, labelled `fixture` on its face.
 *
 * THE HASHES BELOW ARE NOT HASHES OF ANYTHING. They are 64 valid hex
 * characters beginning `deadbeef`, typed rather than computed, so that nobody
 * copies one out of a screenshot and goes looking for the document it came
 * from. That is safe only
 * because the screen says `FIXTURE DATA` on its face and repeats it in prose;
 * a content hash whose provenance is a fixture is the single most misleading
 * thing this file could produce, so it is called out here as well as there.
 *
 * The numbers are the live demo scenario's own (`src/lib/statements/demo.ts`),
 * so the fixture and the live screen tell the same story: a funded day, a card
 * clearing, a statement issued against the close, and then the merchant
 * reversing and re-presenting for less at the original value date.
 */

import { fail, ok } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type {
  AccountOption,
  DayOption,
  DocumentView,
  PublishedStatementView,
  StatementDetailView,
  StatementLineView,
  StatementsDataSource,
  StatementsView,
} from "./data-contract";
import type { DemoState } from "./view-state";

/**
 * The instant every fixture is read as-of.
 *
 * Fixed rather than `Date.now()`, so the screen is a pure function of the URL
 * and the server render cannot disagree with the client hydration.
 */
export const DEMO_NOW = "2026-07-25T14:20:00.000Z";

/** How long the `loading` state holds the skeleton open. Long enough to see. */
export const DEMO_LOADING_MS = 6_000;

const BUSINESS_DATE = "2026-07-24";
const CLOSE_WATERMARK = 485;
const NOW_WATERMARK = 487;

const ACCOUNTS: readonly AccountOption[] = [
  {
    accountId: "acct-ridgeline-2100",
    legalName: "Ridgeline Robotics, Inc.",
    accountName: "Ridgeline Robotics, Inc. — business current account",
  },
  {
    accountId: "acct-kettle-2100",
    legalName: "Kettle & Crumb Bakery LLC",
    accountName: "Kettle & Crumb Bakery LLC — business current account",
  },
];

const OPENING_CENTS = 1_805_505;
const CREDIT_CENTS = 120_000;
const CLEARING_CENTS = -24_850;
const REVERSAL_CENTS = 24_850;
const REBOOK_CENTS = -19_850;

function line(over: Partial<StatementLineView> & { readonly bookingSeq: number }): StatementLineView {
  return {
    id: `${over.bookingSeq}:${over.ordinal ?? 1}`,
    entryId: `entry-${over.bookingSeq}`,
    valueDate: BUSINESS_DATE,
    ordinal: 1,
    entryType: "original",
    description: "",
    externalRef: null,
    rail: null,
    reversesEntryId: null,
    correctionGroupId: null,
    amountCents: 0,
    runningBalanceCents: 0,
    late: false,
    ...over,
  };
}

const PUBLISHED_LINES: readonly StatementLineView[] = [
  line({
    bookingSeq: 483,
    description: "Inbound ACH credit — customer funding",
    externalRef: "STMT-DEMO-ACH-0001",
    rail: "ach",
    amountCents: CREDIT_CENTS,
    runningBalanceCents: OPENING_CENTS + CREDIT_CENTS,
  }),
  line({
    bookingSeq: 484,
    description: "Card clearing — Harborview Supply Co.",
    externalRef: "STMT-DEMO-CARD-0001",
    rail: "card",
    amountCents: CLEARING_CENTS,
    runningBalanceCents: OPENING_CENTS + CREDIT_CENTS + CLEARING_CENTS,
  }),
];

const CORRECTION_GROUP = "8f42c1d6-0a77-4a9e-9f2b-6d1c05e3ab94";

const CORRECTED_LINES: readonly StatementLineView[] = [
  ...PUBLISHED_LINES,
  line({
    bookingSeq: 486,
    description: "Reversal of card clearing — merchant reversed",
    externalRef: "STMT-DEMO-CARD-0001",
    rail: "card",
    entryType: "reversal",
    reversesEntryId: "entry-484",
    correctionGroupId: CORRECTION_GROUP,
    amountCents: REVERSAL_CENTS,
    runningBalanceCents: OPENING_CENTS + CREDIT_CENTS + CLEARING_CENTS + REVERSAL_CENTS,
    late: true,
  }),
  line({
    bookingSeq: 487,
    description: "Card clearing re-presented — Harborview Supply Co.",
    externalRef: "STMT-DEMO-CARD-0001",
    rail: "card",
    entryType: "rebook",
    correctionGroupId: CORRECTION_GROUP,
    amountCents: REBOOK_CENTS,
    runningBalanceCents:
      OPENING_CENTS + CREDIT_CENTS + CLEARING_CENTS + REVERSAL_CENTS + REBOOK_CENTS,
    late: true,
  }),
];

const PUBLISHED_DOCUMENT: DocumentView = {
  periodStart: BUSINESS_DATE,
  periodEnd: BUSINESS_DATE,
  bookingWatermark: CLOSE_WATERMARK,
  openingBalanceCents: OPENING_CENTS,
  closingBalanceCents: OPENING_CENTS + CREDIT_CENTS + CLEARING_CENTS,
  lineCount: PUBLISHED_LINES.length,
  lines: PUBLISHED_LINES,
};

const CORRECTED_DOCUMENT: DocumentView = {
  periodStart: BUSINESS_DATE,
  periodEnd: BUSINESS_DATE,
  bookingWatermark: NOW_WATERMARK,
  openingBalanceCents: OPENING_CENTS,
  closingBalanceCents:
    OPENING_CENTS + CREDIT_CENTS + CLEARING_CENTS + REVERSAL_CENTS + REBOOK_CENTS,
  lineCount: CORRECTED_LINES.length,
  lines: CORRECTED_LINES,
};

const V1: PublishedStatementView = {
  statementId: "stmt-fixture-v1",
  version: 1,
  bookingWatermark: CLOSE_WATERMARK,
  openingBalanceCents: PUBLISHED_DOCUMENT.openingBalanceCents,
  closingBalanceCents: PUBLISHED_DOCUMENT.closingBalanceCents,
  lineCount: PUBLISHED_DOCUMENT.lineCount,
  contentHash: "deadbeef111111110a9f8e7d6c5b4a3928170f6e5d4c3b2a1908172635445300",
  format: "corgi.statement.v1",
  generatedAt: "2026-07-24T23:05:12.000Z",
  generatedBy: "Dana Okonkwo",
};

const V2: PublishedStatementView = {
  statementId: "stmt-fixture-v2",
  version: 2,
  bookingWatermark: NOW_WATERMARK,
  openingBalanceCents: CORRECTED_DOCUMENT.openingBalanceCents,
  closingBalanceCents: CORRECTED_DOCUMENT.closingBalanceCents,
  lineCount: CORRECTED_DOCUMENT.lineCount,
  contentHash: "deadbeef222222229b2c8d3a40e7f6152c9b8a37d4e0f1a2b3c4d5e6f7081900",
  format: "corgi.statement.v1",
  generatedAt: "2026-07-25T14:11:40.000Z",
  generatedBy: "Dana Okonkwo",
};

const DAY_UNCORRECTED: DayOption = {
  businessDate: BUSINESS_DATE,
  closedAt: "2026-07-24T23:02:00.000Z",
  bookingWatermark: CLOSE_WATERMARK,
  versionCount: 1,
  lineCount: 2,
  latePostingCount: 0,
};

const DAY_CORRECTED: DayOption = {
  ...DAY_UNCORRECTED,
  versionCount: 2,
  lineCount: 4,
  latePostingCount: 2,
};

const DAY_UNPUBLISHED: DayOption = {
  businessDate: "2026-07-23",
  closedAt: "2026-07-23T23:01:00.000Z",
  bookingWatermark: 471,
  versionCount: 0,
  lineCount: 3,
  latePostingCount: 0,
};

/** A clean day: published once, nothing has landed since. */
const CLEAN_DETAIL: StatementDetailView = {
  published: V1,
  publishedDocument: PUBLISHED_DOCUMENT,
  reproduced: true,
  recomputedHash: V1.contentHash,
  formatChanged: false,
  correctedDocument: PUBLISHED_DOCUMENT,
  deltaCents: 0,
  differs: false,
  explained: true,
  corrections: [],
  versions: [V1],
};

/**
 * THE EDGE STATE.
 *
 * A day whose statement was published, then corrected by a reversal and a
 * re-book at that day's own value date. v1 still says what it said and still
 * hashes to what it hashed to; v2 exists; the difference is itemised as one
 * act rather than two rows; and the two readings are both true at once.
 */
const CORRECTED_DETAIL: StatementDetailView = {
  published: V1,
  publishedDocument: PUBLISHED_DOCUMENT,
  reproduced: true,
  recomputedHash: V1.contentHash,
  formatChanged: false,
  correctedDocument: CORRECTED_DOCUMENT,
  deltaCents: REVERSAL_CENTS + REBOOK_CENTS,
  differs: true,
  explained: true,
  corrections: [
    {
      id: CORRECTION_GROUP,
      correctionGroupId: CORRECTION_GROUP,
      isCorrection: true,
      netCents: REVERSAL_CENTS + REBOOK_CENTS,
      postings: [
        {
          entryId: "entry-486",
          valueDate: BUSINESS_DATE,
          bookingSeq: 486,
          bookingTime: "2026-07-25T14:09:03.000Z",
          entryType: "reversal",
          description: "Reversal of card clearing — merchant reversed",
          externalRef: "STMT-DEMO-CARD-0001",
          reversesEntryId: "entry-484",
          amountCents: REVERSAL_CENTS,
          affectsOpening: false,
        },
        {
          entryId: "entry-487",
          valueDate: BUSINESS_DATE,
          bookingSeq: 487,
          bookingTime: "2026-07-25T14:09:03.000Z",
          entryType: "rebook",
          description: "Card clearing re-presented — Harborview Supply Co.",
          externalRef: "STMT-DEMO-CARD-0001",
          reversesEntryId: null,
          amountCents: REBOOK_CENTS,
          affectsOpening: false,
        },
      ],
    },
  ],
  versions: [V1, V2],
};

function viewFor(state: DemoState): StatementsView {
  const base = {
    source: "fixture" as const,
    asOf: DEMO_NOW,
    accounts: ACCOUNTS,
    account: ACCOUNTS[0] ?? null,
  };

  if (state === "empty") {
    // A day that was closed and never issued. Not an error, and not the same
    // as "no such day" — the watermark exists, the document is derivable, and
    // nobody has published it.
    return {
      ...base,
      days: [DAY_UNPUBLISHED],
      day: DAY_UNPUBLISHED,
      statement: null,
    };
  }

  if (state === "edge") {
    return {
      ...base,
      days: [DAY_CORRECTED, DAY_UNPUBLISHED],
      day: DAY_CORRECTED,
      statement: CORRECTED_DETAIL,
    };
  }

  return {
    ...base,
    days: [DAY_UNCORRECTED, DAY_UNPUBLISHED],
    day: DAY_UNCORRECTED,
    statement: CLEAN_DETAIL,
  };
}

/**
 * A source that answers from the fixture.
 *
 * `loading` genuinely waits, so the Suspense boundary on the page is real
 * rather than decorative, and `error` returns an `Err` rather than throwing,
 * so the error state is a branch the screen renders and not a boundary React
 * catches.
 */
export function createFixtureStatementsSource(state: DemoState): StatementsDataSource {
  return {
    async load(): Promise<Result<StatementsView, ErrorShape>> {
      if (state === "loading") {
        await new Promise((resolve) => setTimeout(resolve, DEMO_LOADING_MS));
        return ok(viewFor("default"));
      }
      if (state === "error") {
        return fail(
          "STATEMENT_READ_FAILED",
          "re-deriving the published document timed out after 5000ms",
        );
      }
      return ok(viewFor(state));
    },
  };
}
