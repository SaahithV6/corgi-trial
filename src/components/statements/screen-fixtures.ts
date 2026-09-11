/**
 * The statements screen without a database.
 *
 * Two jobs, and they are different:
 *
 * 1. THE NON-DEFAULT DEMO STATES. `loading`, `empty` and `error` have to be
 *    reachable in front of a panel without closing a day or issuing a document
 *    — both of those writes are PERMANENT, because `book_day` and `statement`
 *    are append-only and the application role holds no `UPDATE`, so a demo
 *    control that produced them for real would be a demo control with no undo.
 *    `edge` is the exception and it is deliberate: see below.
 *
 * 2. NO DATABASE AT ALL. `pnpm dev` with no `.env` still renders a real
 *    screen, labelled `FIXTURE DATA` on its face and again in prose.
 *
 * WHY `edge` IS NOT NORMALLY A FIXTURE ANY MORE. The edge state is "the
 * corrected day itself", and the whole claim of this screen is that a
 * corrected day is a thing the live ledger can show. A fixture of a corrected
 * day proves nothing — it is two numbers somebody typed. So the page runs
 * `edge` LIVE, resolving to the most recently corrected value date on the
 * book, and falls back to what is below only when there is no database or no
 * correction to find. When it falls back, the screen says FIXTURE DATA.
 *
 * THE HASHES BELOW ARE NOT HASHES OF ANYTHING. They are 64 valid hex
 * characters beginning `deadbeef`, typed rather than computed, so that nobody
 * copies one out of a screenshot and goes looking for the document it came
 * from. A content hash whose provenance is a fixture is the single most
 * misleading thing this file could produce, which is why it is called out
 * here as well as on the screen.
 *
 * The numbers are the live demo scenario's own (`src/lib/statements/demo.ts`),
 * so the fixture and the live screen tell the same story: a funded day, a card
 * clearing, a statement issued against the close, and then the merchant
 * reversing and re-presenting for less at the ORIGINAL value date.
 */

import { fail, ok } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type {
  AccountOption,
  AnchorOptionView,
  BothReadingsView,
  DayOption,
  DocumentView,
  PublishedStatementView,
  ReadingView,
  StatementLineView,
  StatementsScreenSource,
  StatementsScreenView,
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

const CORRECTION_GROUP = "8f42c1d6-0a77-4a9e-9f2b-6d1c05e3ab94";

function line(
  over: Partial<StatementLineView> & { readonly bookingSeq: number },
): StatementLineView {
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

const BELIEVED_LINES: readonly StatementLineView[] = [
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

const CORRECTED_LINES: readonly StatementLineView[] = [
  ...BELIEVED_LINES,
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

const BELIEVED_DOCUMENT: DocumentView = {
  periodStart: BUSINESS_DATE,
  periodEnd: BUSINESS_DATE,
  bookingWatermark: CLOSE_WATERMARK,
  openingBalanceCents: OPENING_CENTS,
  closingBalanceCents: OPENING_CENTS + CREDIT_CENTS + CLEARING_CENTS,
  lineCount: BELIEVED_LINES.length,
  lines: BELIEVED_LINES,
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
  openingBalanceCents: BELIEVED_DOCUMENT.openingBalanceCents,
  closingBalanceCents: BELIEVED_DOCUMENT.closingBalanceCents,
  lineCount: BELIEVED_DOCUMENT.lineCount,
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

function anchors(hasCorrection: boolean, published: boolean): readonly AnchorOptionView[] {
  return [
    {
      anchor: "published",
      label: "As published",
      available: published,
      bookingWatermark: published ? CLOSE_WATERMARK : null,
      note: published
        ? "The booking watermark v1 was issued against. Its stored hash makes this reading checkable by somebody who does not trust us."
        : "No statement has been issued for this day, so there is no as-published document to stand on.",
    },
    {
      anchor: "close",
      label: "At the close",
      available: true,
      bookingWatermark: CLOSE_WATERMARK,
      note: "The watermark this business day was frozen at. Everything after it is a late posting by definition.",
    },
    {
      anchor: "before",
      label: "Before the correction",
      available: hasCorrection,
      bookingWatermark: hasCorrection ? 485 : null,
      note: hasCorrection
        ? "The sequence immediately before this day's most recent correcting act landed — what we believed one instant earlier."
        : "Nothing with this value date has been reversed or re-booked, so there is no moment before a correction.",
    },
    {
      anchor: "now",
      label: "Everything we know",
      available: true,
      bookingWatermark: NOW_WATERMARK,
      note: "The same watermark as the right-hand column. Both readings become one reading, which is the honest answer when nothing has corrected this day.",
    },
  ];
}

function reading(label: string, document: DocumentView, hash: string): ReadingView {
  return {
    label,
    bookingWatermark: document.bookingWatermark,
    closingBalanceCents: document.closingBalanceCents,
    document,
    contentHash: hash,
  };
}

/** A clean day: published once, nothing has landed since. The common case. */
const CLEAN: BothReadingsView = {
  valueDate: BUSINESS_DATE,
  closedAt: DAY_UNCORRECTED.closedAt,
  closeWatermark: CLOSE_WATERMARK,
  anchor: "published",
  anchors: anchors(false, true),
  believed: reading("As published", BELIEVED_DOCUMENT, V1.contentHash),
  corrected: reading("As corrected", BELIEVED_DOCUMENT, V1.contentHash),
  deltaCents: 0,
  differs: false,
  explained: true,
  acts: [],
  learnedAt: null,
  published: V1,
  reproduced: true,
  formatChanged: false,
  versions: [V1],
};

/**
 * THE EDGE STATE, as a fallback only.
 *
 * A day whose statement was published, then corrected by a reversal and a
 * re-book at that day's own value date. v1 still says what it said and still
 * hashes to what it hashed to; v2 exists; the difference is itemised as one
 * act rather than two rows; and the two readings are both true at once.
 */
const CORRECTED: BothReadingsView = {
  valueDate: BUSINESS_DATE,
  closedAt: DAY_CORRECTED.closedAt,
  closeWatermark: CLOSE_WATERMARK,
  anchor: "published",
  anchors: anchors(true, true),
  believed: reading("As published", BELIEVED_DOCUMENT, V1.contentHash),
  corrected: reading("As corrected", CORRECTED_DOCUMENT, V2.contentHash),
  deltaCents: REVERSAL_CENTS + REBOOK_CENTS,
  differs: true,
  explained: true,
  acts: [
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
  learnedAt: "2026-07-25T14:09:03.000Z",
  published: V1,
  reproduced: true,
  formatChanged: false,
  versions: [V1, V2],
};

/**
 * A day closed with nothing issued.
 *
 * Note what this state is NOT: it is not "no readings". The two axes are still
 * answerable — that is the point of deriving them rather than storing them —
 * so the screen still shows both figures, anchored at the close, and says
 * plainly that no document was published against that watermark.
 */
const UNPUBLISHED: BothReadingsView = {
  valueDate: DAY_UNPUBLISHED.businessDate,
  closedAt: DAY_UNPUBLISHED.closedAt,
  closeWatermark: DAY_UNPUBLISHED.bookingWatermark,
  anchor: "close",
  anchors: [
    {
      anchor: "published",
      label: "As published",
      available: false,
      bookingWatermark: null,
      note: "No statement has been issued for this day, so there is no as-published document to stand on.",
    },
    {
      anchor: "close",
      label: "At the close",
      available: true,
      bookingWatermark: DAY_UNPUBLISHED.bookingWatermark,
      note: "The watermark this business day was frozen at. Everything after it is a late posting by definition.",
    },
    {
      anchor: "before",
      label: "Before the correction",
      available: false,
      bookingWatermark: null,
      note: "Nothing with this value date has been reversed or re-booked, so there is no moment before a correction.",
    },
    {
      anchor: "now",
      label: "Everything we know",
      available: true,
      bookingWatermark: DAY_UNPUBLISHED.bookingWatermark,
      note: "The same watermark as the right-hand column. Both readings become one reading, which is the honest answer when nothing has corrected this day.",
    },
  ],
  believed: reading(
    "As believed",
    {
      periodStart: DAY_UNPUBLISHED.businessDate,
      periodEnd: DAY_UNPUBLISHED.businessDate,
      bookingWatermark: DAY_UNPUBLISHED.bookingWatermark,
      openingBalanceCents: OPENING_CENTS,
      closingBalanceCents: OPENING_CENTS,
      lineCount: 0,
      lines: [],
    },
    "deadbeef33333333c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f708190",
  ),
  corrected: reading(
    "As corrected",
    {
      periodStart: DAY_UNPUBLISHED.businessDate,
      periodEnd: DAY_UNPUBLISHED.businessDate,
      bookingWatermark: DAY_UNPUBLISHED.bookingWatermark,
      openingBalanceCents: OPENING_CENTS,
      closingBalanceCents: OPENING_CENTS,
      lineCount: 0,
      lines: [],
    },
    "deadbeef33333333c1d2e3f405162738495a6b7c8d9e0f1a2b3c4d5e6f708190",
  ),
  deltaCents: 0,
  differs: false,
  explained: true,
  acts: [],
  learnedAt: null,
  published: null,
  reproduced: false,
  formatChanged: false,
  versions: [],
};

function viewFor(state: DemoState): StatementsScreenView {
  const base = {
    source: "fixture" as const,
    asOf: DEMO_NOW,
    accounts: ACCOUNTS,
    account: ACCOUNTS[0] ?? null,
  };

  if (state === "empty") {
    return { ...base, days: [DAY_UNPUBLISHED], readings: UNPUBLISHED };
  }
  if (state === "edge") {
    return { ...base, days: [DAY_CORRECTED, DAY_UNPUBLISHED], readings: CORRECTED };
  }
  return { ...base, days: [DAY_UNCORRECTED, DAY_UNPUBLISHED], readings: CLEAN };
}

/**
 * A source that answers from the fixture.
 *
 * `loading` genuinely waits, so the Suspense boundary on the page is real
 * rather than decorative, and `error` returns an `Err` rather than throwing,
 * so the error state is a branch the screen renders and not a boundary React
 * catches.
 */
export function createFixtureStatementsScreen(state: DemoState): StatementsScreenSource {
  return {
    async load(): Promise<Result<StatementsScreenView, ErrorShape>> {
      if (state === "loading") {
        await new Promise((resolve) => setTimeout(resolve, DEMO_LOADING_MS));
        return ok(viewFor("default"));
      }
      if (state === "error") {
        return fail(
          "STATEMENT_READ_FAILED",
          "re-deriving the document at the published watermark timed out after 5000ms",
        );
      }
      return ok(viewFor(state));
    },
  };
}
