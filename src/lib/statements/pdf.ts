/**
 * The statement as a document somebody can forward.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 *
 * `/statements` proves the bitemporal claim to a person sitting in front of
 * it. That is the wrong medium for the person the claim is actually for: an
 * accountant who was not at the demo, reading it three weeks later, next to a
 * trial balance. So this module renders the same two readings — the same
 * figures, from the same `renderStatement()` calls, through the same
 * `formatUsd` — as a PDF.
 *
 * The brief's document rule is one line and it is absolute: *"Documents must
 * be generated from data, never hand-typed."* Nothing below is typed. Every
 * figure on the page is folded, here, from the journal lines the screen was
 * given, and the page prints its own arithmetic so a reader can add the column
 * up and land on the closing balance.
 *
 * ---------------------------------------------------------------------------
 * THE ACCOUNTANT'S TEST
 * ---------------------------------------------------------------------------
 *
 * Not "is it pretty". It is: *can I tie this to something?* Which means, in
 * order, and on the page rather than in a footnote:
 *
 *     opening balance
 *   + every movement, each with its own date and reference
 *   = closing balance
 *
 * and then the part no ordinary bank statement has, because no ordinary bank
 * statement is bitemporal:
 *
 *     closing balance as published
 *   + every act booked after that document was issued
 *   = closing balance as corrected
 *
 * Both identities are computed in `bigint` cents and both are printed with the
 * word `checks` or `DOES NOT CHECK` beside them. A document that asserted the
 * arithmetic without showing it would be asking to be believed, which is the
 * one thing a statement may never do.
 *
 * ---------------------------------------------------------------------------
 * MONEY
 * ---------------------------------------------------------------------------
 *
 * The view contract carries `number` cents because `bigint` does not survive
 * JSON (see `data-contract.ts`). Every one of them is converted back to
 * `bigint` by `toCents` — which REFUSES a non-integer rather than rounding it
 * — before a single addition happens here. There is no `/ 100`, no `toFixed`,
 * and no float intermediate anywhere on this path; `formatUsd` does the
 * decimal placement by integer division.
 *
 * ---------------------------------------------------------------------------
 * REPRODUCIBILITY
 * ---------------------------------------------------------------------------
 *
 * `renderStatementPdf` is a pure function of its input: no clock, no random
 * source, no environment. The writer underneath it embeds no fonts, no dates
 * and no generated id (see `pdf-writer.ts`). Generate the same
 * `(account, value date, anchor watermark, current watermark)` twice and the
 * files are byte-identical — `pdf.test.ts` asserts exactly that, and the
 * `documentFingerprint` printed in the footer is a hash of the *content*, so
 * the claim is checkable from the page itself.
 *
 * The honest caveat, stated on the page rather than buried here: the
 * as-corrected column is read at the CURRENT watermark, and that number moves
 * every time anything is booked anywhere on the book. Two PDFs of the same day
 * taken either side of a card clearing are different documents and say so —
 * they carry different watermarks. What is guaranteed is what has always been
 * guaranteed: fix both watermarks and the bytes are fixed.
 */

import { createHash } from "node:crypto";

import type {
  BothReadingsView,
  CorrectionGroupView,
  DocumentView,
  StatementLineView,
} from "@/components/statements/data-contract";
import { formatDate, formatTimestamp } from "@/lib/format/datetime";
import { formatUsd, sumCents, toCents } from "@/lib/format/money";

import {
  LETTER_HEIGHT,
  LETTER_WIDTH,
  PdfDocument,
  truncateToWidth,
  type PdfFont,
  type PdfPage,
} from "./pdf-writer";

/* -------------------------------------------------------------------------- */
/* Input                                                                      */
/* -------------------------------------------------------------------------- */

export type StatementPdfAccount = {
  readonly accountId: string;
  readonly legalName: string;
  readonly accountName: string;
};

export type StatementPdfInput = {
  readonly account: StatementPdfAccount;
  readonly readings: BothReadingsView;
  /**
   * The URL this document was rendered from, printed on the page.
   *
   * Not decoration. The whole claim is that `(account, value date, watermark)`
   * reproduces forever, and a claim nobody can re-run is a claim. Optional
   * because the pure function must be callable without a request.
   */
  readonly sourceUrl?: string;
};

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

const MARGIN = 54;
const CONTENT_LEFT = MARGIN;
const CONTENT_RIGHT = LETTER_WIDTH - MARGIN;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;
const FOOTER_TOP = LETTER_HEIGHT - MARGIN + 14;
const BODY_BOTTOM = LETTER_HEIGHT - MARGIN - 6;

/** Column geometry for the movement tables. Right edges, in points from the left. */
const COL = {
  markX: CONTENT_LEFT,
  dateX: CONTENT_LEFT + 10,
  dateW: 52,
  descX: CONTENT_LEFT + 66,
  // 190 points is not arbitrary: it is the measured width, at Helvetica 8, of
  // the longest description this book actually produces — `Card clearing
  // re-presented — Harborview Supply Co.`. A column sized by eye put the
  // reference column's text into the booking-sequence column on a real
  // statement, which is the sort of thing a reader notices before they notice
  // that the arithmetic is right.
  descW: 190,
  refX: CONTENT_LEFT + 262,
  refW: 72,
  seqRight: CONTENT_LEFT + 362,
  amountRight: CONTENT_LEFT + 428,
  balanceRight: CONTENT_RIGHT,
} as const;

const GRAY = {
  ink: 0,
  soft: 420,
  faint: 620,
  rule: 800,
  hairline: 880,
  shade: 940,
  band: 965,
} as const;

/* -------------------------------------------------------------------------- */
/* A page cursor that knows how to break                                      */
/* -------------------------------------------------------------------------- */

/**
 * Top-down layout with page breaks.
 *
 * Deliberately tiny: a statement is a stack of blocks, and the only thing the
 * layout has to get right is never starting a block it cannot finish without
 * running off the page. `onBreak` lets a table repeat its own header.
 */
class Flow {
  private page: PdfPage;
  private cursor = MARGIN;
  private onBreak: ((page: PdfPage, y: number) => number) | null = null;

  constructor(private readonly doc: PdfDocument) {
    this.page = doc.addPage();
  }

  get y(): number {
    return this.cursor;
  }

  get current(): PdfPage {
    return this.page;
  }

  advance(points: number): void {
    this.cursor += points;
  }

  /** Start a new page if `needed` points will not fit below the cursor. */
  ensure(needed: number): void {
    if (this.cursor + needed <= BODY_BOTTOM) return;
    this.page = this.doc.addPage();
    this.cursor = MARGIN;
    if (this.onBreak !== null) this.cursor = this.onBreak(this.page, this.cursor);
  }

  /** While set, every page break re-draws this header and returns the new cursor. */
  withRepeatingHeader(
    header: ((page: PdfPage, y: number) => number) | null,
    body: () => void,
  ): void {
    const previous = this.onBreak;
    this.onBreak = header;
    body();
    this.onBreak = previous;
  }

  text(
    x: number,
    value: string,
    options: {
      readonly font?: PdfFont;
      readonly size?: number;
      readonly gray?: number;
      readonly align?: "left" | "right";
      /** Baseline offset from the cursor. Defaults to the font size. */
      readonly baseline?: number;
    } = {},
  ): void {
    const size = options.size ?? 9;
    this.page.text(x, this.cursor + (options.baseline ?? size), value, {
      ...(options.font === undefined ? {} : { font: options.font }),
      size,
      ...(options.gray === undefined ? {} : { gray: options.gray }),
      ...(options.align === undefined ? {} : { align: options.align }),
    });
  }

  rule(gray: number = GRAY.rule): void {
    this.page.rule(CONTENT_LEFT, this.cursor, CONTENT_WIDTH, gray);
  }

  fill(x: number, w: number, h: number, gray: number): void {
    this.page.fill(x, this.cursor, w, h, gray);
  }
}

/* -------------------------------------------------------------------------- */
/* Fingerprint                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A content fingerprint for the whole artefact: sha256 over what it says.
 *
 * Not over the file. The file is byte-stable too, and the test proves it — but
 * hashing the CONTENT is the honest primitive, because it stays meaningful if
 * the layout ever changes and it is the thing a reader can recompute from the
 * two statement hashes that are printed beside it.
 *
 * Both readings' `contentHash` values are already sha256 over the canonical
 * rendering of `(format, account, period, watermark)` and every immutable row
 * below it, so this adds only the pairing.
 */
export function documentFingerprint(input: StatementPdfInput): string {
  const r = input.readings;
  const preimage = [
    "corgi.statement.pdf.v1",
    input.account.accountId,
    r.valueDate,
    r.anchor,
    String(r.believed.bookingWatermark),
    r.believed.contentHash,
    String(r.corrected.bookingWatermark),
    r.corrected.contentHash,
  ]
    .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`)
    .join("\n");
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

/* -------------------------------------------------------------------------- */
/* The document                                                               */
/* -------------------------------------------------------------------------- */

/** A filename a human can file: `statement-ridgeline-2026-07-25-v1.pdf`. */
export function statementPdfFilename(input: StatementPdfInput): string {
  const slug = input.account.legalName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const version =
    input.readings.published === null
      ? input.readings.anchor
      : `v${input.readings.published.version}`;
  return `statement-${slug === "" ? "account" : slug}-${input.readings.valueDate}-${version}.pdf`;
}

/**
 * Render the statement.
 *
 * Pure: same input, same bytes. Everything it needs is in `input`.
 */
export function renderStatementPdf(input: StatementPdfInput): Uint8Array {
  const fingerprint = documentFingerprint(input);
  const r = input.readings;

  const doc = new PdfDocument({
    title: `Statement — ${input.account.legalName} — ${formatDate(r.valueDate)}`,
    subject:
      "A single value date read on both time axes: as published and as corrected.",
    documentId: fingerprint.slice(0, 32),
  });

  const flow = new Flow(doc);

  masthead(flow, input);
  bothAxesExplainer(flow, input);
  headline(flow, input);
  movementTable(flow, {
    title: believedTitle(input),
    subtitle: believedSubtitle(input),
    document: r.believed.document,
    markLate: false,
    anchorWatermark: r.believed.bookingWatermark,
  });
  evidenceBlock(flow, input);

  if (r.differs) {
    movementTable(flow, {
      title: "The same day, as the ledger reads it now",
      subtitle: `As corrected · booking watermark ${r.corrected.bookingWatermark} · every posting with value date ${formatDate(r.valueDate)}`,
      document: r.corrected.document,
      markLate: true,
      anchorWatermark: r.believed.bookingWatermark,
    });
    reconciliation(flow, input);
  } else {
    nothingChanged(flow, input);
  }

  howToCheck(flow, input, fingerprint);
  stampFooters(doc, input, fingerprint);

  return doc.toBytes();
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                     */
/* -------------------------------------------------------------------------- */

function masthead(flow: Flow, input: StatementPdfInput): void {
  const r = input.readings;

  flow.text(CONTENT_LEFT, "CORGI", { font: "bold", size: 13 });
  flow.text(CONTENT_RIGHT, "STATEMENT OF ACCOUNT", {
    font: "bold",
    size: 10,
    align: "right",
  });
  flow.advance(18);
  flow.rule(GRAY.ink);
  flow.advance(12);

  const top = flow.y;

  flow.text(CONTENT_LEFT, input.account.legalName, { font: "bold", size: 12 });
  flow.advance(15);
  flow.text(CONTENT_LEFT, input.account.accountName, { size: 9, gray: GRAY.soft });
  flow.advance(12);
  flow.text(CONTENT_LEFT, `Account ${input.account.accountId}`, {
    font: "mono",
    size: 7,
    gray: GRAY.faint,
  });
  flow.advance(11);
  flow.text(CONTENT_LEFT, "USD · all amounts are exact integer cents", {
    size: 7,
    gray: GRAY.faint,
  });

  const leftBottom = flow.y;

  // The right-hand meta block, laid out from the same top.
  const rows: readonly (readonly [string, string])[] = [
    ["Value date", formatDate(r.valueDate)],
    [
      "Business day",
      r.closedAt === null
        ? "not yet closed"
        : `closed ${formatTimestamp(r.closedAt)} · watermark ${r.closeWatermark}`,
    ],
    [
      "This document",
      r.published === null
        ? `${r.believed.label} at booking watermark ${r.believed.bookingWatermark}`
        : `version ${r.published.version}, issued ${formatTimestamp(r.published.generatedAt)}`,
    ],
    [
      "Issued by",
      r.published === null ? "not issued — a reading, not a document" : r.published.generatedBy,
    ],
  ];

  let y = top;
  for (const [label, value] of rows) {
    flow.current.text(CONTENT_RIGHT, y + 7, label.toUpperCase(), {
      font: "bold",
      size: 6,
      gray: GRAY.faint,
      align: "right",
    });
    flow.current.text(CONTENT_RIGHT, y + 17, value, {
      size: 8,
      gray: GRAY.ink,
      align: "right",
    });
    y += 22;
  }

  flow.advance(Math.max(leftBottom, y) - leftBottom + 12);
}

/**
 * The sentence the whole document exists to make legible.
 *
 * Written for somebody who has never heard the word bitemporal and is not
 * going to learn it from a statement. Two dates, one they already know and one
 * they do not, and then the three figures in the order a person asks for them.
 */
function bothAxesExplainer(flow: Flow, input: StatementPdfInput): void {
  const r = input.readings;
  const day = formatDate(r.valueDate);

  flow.ensure(64);
  flow.fill(CONTENT_LEFT, CONTENT_WIDTH, 60, GRAY.band);
  flow.advance(9);
  flow.text(CONTENT_LEFT + 10, "TWO DATES SIT ON EVERY ENTRY IN THIS LEDGER", {
    font: "bold",
    size: 7,
    gray: GRAY.soft,
  });
  flow.advance(12);
  for (const line of [
    `The value date is the day the money belongs to — here, ${day}. The booking time is the moment we learned about it, which can be`,
    `days later. Nothing is ever edited: when we learn something new about ${day}, a new entry is appended carrying ${day}'s value date`,
    `and today's booking time. So this page shows ${day} twice — as we reported it, and as we now know it — and lists what moved between.`,
  ]) {
    flow.text(CONTENT_LEFT + 10, line, { size: 7, gray: GRAY.ink });
    flow.advance(10);
  }
  flow.advance(17);
}

/** The three figures, as a band: the two readings and the difference between. */
function headline(flow: Flow, input: StatementPdfInput): void {
  const r = input.readings;
  const believed = toCents(r.believed.closingBalanceCents);
  const corrected = toCents(r.corrected.closingBalanceCents);
  const delta = toCents(r.deltaCents);

  flow.ensure(96);

  const cellW = Math.floor(CONTENT_WIDTH / 3);
  const xs = [CONTENT_LEFT, CONTENT_LEFT + cellW, CONTENT_LEFT + cellW * 2];
  const widths = [cellW, cellW, CONTENT_WIDTH - cellW * 2];

  flow.fill(CONTENT_LEFT, CONTENT_WIDTH, 84, GRAY.shade);
  // Hairlines between the cells: three columns of equal weight, because
  // neither reading is subordinate to the other.
  flow.current.fill(xs[1] as number, flow.y, 1, 84, GRAY.hairline);
  flow.current.fill(xs[2] as number, flow.y, 1, 84, GRAY.hairline);

  const cells: readonly {
    readonly label: string;
    readonly figure: string;
    readonly under: string;
    readonly note: readonly string[];
  }[] = [
    {
      label: r.believed.label.toUpperCase(),
      figure: formatUsd(believed),
      under: `booking watermark ${r.believed.bookingWatermark}`,
      note: believedNote(input),
    },
    {
      label: "DIFFERENCE",
      figure: r.differs ? formatUsd(delta, { signed: true }) : "none",
      under: `as corrected − ${r.believed.label.toLowerCase()}`,
      note: r.differs
        ? [
            `Accounted for entry by entry by ${r.acts.length}`,
            `later ${r.acts.length === 1 ? "act" : "acts"}, listed below.`,
          ]
        : ["Nothing with this value date has been", "booked above the left-hand watermark."],
    },
    {
      label: "AS CORRECTED",
      figure: formatUsd(corrected),
      under: `booking watermark ${r.corrected.bookingWatermark}`,
      note: ["What we now know this day to be,", "using everything learned since."],
    },
  ];

  cells.forEach((cell, index) => {
    const x = (xs[index] as number) + 12;
    const w = (widths[index] as number) - 24;
    flow.current.text(x, flow.y + 16, cell.label, {
      font: "bold",
      size: 6,
      gray: GRAY.soft,
    });
    flow.current.text(x, flow.y + 38, cell.figure, { font: "bold", size: 17 });
    flow.current.text(x, flow.y + 51, cell.under, { size: 7, gray: GRAY.soft });
    cell.note.forEach((line, i) => {
      flow.current.text(x, flow.y + 65 + i * 9, truncateToWidth(line, "regular", 7, w), {
        size: 7,
        gray: GRAY.faint,
      });
    });
  });

  flow.advance(94);
}

/** What the left-hand figure IS, named by its anchor. Four different claims. */
function believedNote(input: StatementPdfInput): readonly string[] {
  const r = input.readings;
  const day = formatDate(r.valueDate);
  switch (r.anchor) {
    case "published":
      return [`What the statement for ${day} said`, "when it was issued."];
    case "close":
      return [`What ${day} closed at when the`, "business day was signed off."];
    case "before":
      return [`What ${day} closed at one instant`, "before we learned otherwise."];
    case "now":
      return ["The same watermark as the column", "on the right: nothing earlier exists."];
  }
}

function believedTitle(input: StatementPdfInput): string {
  const r = input.readings;
  if (r.published !== null) {
    return `Statement as published — version ${r.published.version}`;
  }
  return `${r.believed.label} — booking watermark ${r.believed.bookingWatermark}`;
}

function believedSubtitle(input: StatementPdfInput): string {
  const r = input.readings;
  if (r.published !== null) {
    return `Issued ${formatTimestamp(r.published.generatedAt)} by ${r.published.generatedBy} · booking watermark ${r.believed.bookingWatermark} · re-derived from the ledger, not read back from a stored total`;
  }
  return "Re-derived from the ledger at this watermark. No document was issued against it.";
}

/* -------------------------------------------------------------------------- */
/* The movement table — the part an accountant actually adds up               */
/* -------------------------------------------------------------------------- */

function movementTable(
  flow: Flow,
  args: {
    readonly title: string;
    readonly subtitle: string;
    readonly document: DocumentView;
    readonly markLate: boolean;
    readonly anchorWatermark: number;
  },
): void {
  const opening = toCents(args.document.openingBalanceCents);
  const closing = toCents(args.document.closingBalanceCents);
  const movements = sumCents(args.document.lines.map((l) => l.amountCents));
  const ties = opening + movements === closing;

  flow.ensure(90);
  sectionHeading(flow, args.title, args.subtitle);

  const header = (page: PdfPage, y: number): number => {
    page.fill(CONTENT_LEFT, y, CONTENT_WIDTH, 1, GRAY.ink);
    const base = y + 12;
    page.text(COL.dateX, base, "VALUE DATE", { font: "bold", size: 6, gray: GRAY.soft });
    page.text(COL.descX, base, "DESCRIPTION", { font: "bold", size: 6, gray: GRAY.soft });
    page.text(COL.refX, base, "REFERENCE", { font: "bold", size: 6, gray: GRAY.soft });
    page.text(COL.seqRight, base, "BOOKED", {
      font: "bold",
      size: 6,
      gray: GRAY.soft,
      align: "right",
    });
    page.text(COL.amountRight, base, "AMOUNT", {
      font: "bold",
      size: 6,
      gray: GRAY.soft,
      align: "right",
    });
    page.text(COL.balanceRight, base, "BALANCE", {
      font: "bold",
      size: 6,
      gray: GRAY.soft,
      align: "right",
    });
    page.fill(CONTENT_LEFT, y + 17, CONTENT_WIDTH, 1, GRAY.rule);
    return y + 18;
  };

  flow.advance(header(flow.current, flow.y) - flow.y);

  // OPENING BALANCE — the first number in the column, so the column can be
  // added. A statement that starts at its first movement cannot be tied to the
  // day before it.
  flow.ensure(16);
  flow.text(COL.descX, "Opening balance", { font: "bold", size: 8, baseline: 10 });
  flow.text(COL.balanceRight, formatUsd(opening), {
    font: "monoBold",
    size: 8,
    align: "right",
    baseline: 10,
  });
  flow.advance(15);

  flow.withRepeatingHeader(header, () => {
    if (args.document.lines.length === 0) {
      flow.ensure(16);
      flow.text(COL.descX, "No movements with this value date.", {
        size: 8,
        gray: GRAY.faint,
        baseline: 10,
      });
      flow.advance(15);
      return;
    }
    for (const line of args.document.lines) {
      movementRow(flow, line, args.markLate && line.bookingSeq > args.anchorWatermark);
    }
  });

  // CLOSING BALANCE, and the identity that produced it, spelled out.
  flow.ensure(42);
  flow.rule(GRAY.rule);
  flow.advance(4);
  flow.text(COL.descX, "Closing balance", { font: "bold", size: 9, baseline: 11 });
  flow.text(COL.amountRight, formatUsd(movements, { signed: true }), {
    font: "monoBold",
    size: 8,
    align: "right",
    baseline: 11,
  });
  flow.text(COL.balanceRight, formatUsd(closing), {
    font: "monoBold",
    size: 9,
    align: "right",
    baseline: 11,
  });
  flow.advance(17);
  flow.rule(GRAY.ink);
  flow.advance(6);

  const count = args.document.lines.length;
  flow.text(
    COL.dateX,
    `${formatUsd(opening)} opening ${movements < 0n ? "−" : "+"} ${formatUsd(
      movements < 0n ? -movements : movements,
    )} across ${count} ${count === 1 ? "movement" : "movements"} = ${formatUsd(closing)} closing`,
    { font: "mono", size: 7, gray: GRAY.soft },
  );
  flow.text(CONTENT_RIGHT, ties ? "CHECKS" : "DOES NOT CHECK", {
    font: "bold",
    size: 7,
    gray: ties ? GRAY.soft : GRAY.ink,
    align: "right",
  });
  flow.advance(20);

  if (args.markLate && args.document.lines.some((l) => l.bookingSeq > args.anchorWatermark)) {
    flow.text(
      COL.markX,
      "†  booked after the document on the previous page was issued — a later booking time, the same value date. Nothing was edited to put it here.",
      { size: 7, gray: GRAY.faint },
    );
    flow.advance(16);
  }
}

function movementRow(flow: Flow, line: StatementLineView, late: boolean): void {
  const amount = toCents(line.amountCents);
  const balance = toCents(line.runningBalanceCents);
  const kind =
    line.entryType === "reversal"
      ? "reversal"
      : line.entryType === "rebook"
        ? "re-book"
        : line.rail === null
          ? ""
          : line.rail;
  const height = kind === "" ? 15 : 21;

  flow.ensure(height + 1);
  if (late) flow.fill(CONTENT_LEFT, CONTENT_WIDTH, height, GRAY.shade);

  if (late) {
    flow.text(COL.markX, "†", { font: "bold", size: 8, baseline: 10 });
  }
  flow.text(COL.dateX, formatDate(line.valueDate), { size: 7, baseline: 10 });
  flow.text(
    COL.descX,
    truncateToWidth(line.description, "regular", 8, COL.descW),
    { size: 8, baseline: 10 },
  );
  flow.text(
    COL.refX,
    truncateToWidth(line.externalRef ?? "—", "mono", 6, COL.refW),
    { font: "mono", size: 6, gray: GRAY.faint, baseline: 10 },
  );
  flow.text(COL.seqRight, `seq ${line.bookingSeq}`, {
    font: "mono",
    size: 6,
    gray: GRAY.faint,
    align: "right",
    baseline: 10,
  });
  flow.text(COL.amountRight, formatUsd(amount, { signed: true }), {
    font: "mono",
    size: 8,
    align: "right",
    baseline: 10,
  });
  flow.text(COL.balanceRight, formatUsd(balance), {
    font: "mono",
    size: 8,
    align: "right",
    baseline: 10,
  });

  // The rail, or the correction kind, as a caption under the description. Its
  // baseline and the row's height are set together: at 18 points of row the
  // separator rule cut through the caption's descenders on a real statement.
  if (kind !== "") {
    flow.text(COL.descX, kind.toUpperCase(), {
      font: "bold",
      size: 5,
      gray: GRAY.faint,
      baseline: 17,
    });
  }
  flow.advance(height);
  flow.current.fill(CONTENT_LEFT, flow.y - 3, CONTENT_WIDTH, 1, GRAY.hairline);
}

/* -------------------------------------------------------------------------- */
/* The reconciliation between the two readings                                */
/* -------------------------------------------------------------------------- */

/**
 * As published + the acts = as corrected, one line per act, with the sum shown.
 *
 * This is the second identity, and the one that is actually novel. It is
 * checked here in `bigint` rather than trusted from the view's `explained`
 * flag, because a document that prints "checks" has to have done the addition
 * itself.
 */
function reconciliation(flow: Flow, input: StatementPdfInput): void {
  const r = input.readings;
  const believed = toCents(r.believed.closingBalanceCents);
  const corrected = toCents(r.corrected.closingBalanceCents);
  const delta = toCents(r.deltaCents);
  const summed = sumCents(r.acts.map((a) => a.netCents));
  const explains = summed === delta && believed + delta === corrected;

  flow.ensure(96);
  sectionHeading(
    flow,
    "What changed between them, and when we learned",
    `Every entry booked above watermark ${r.believed.bookingWatermark} carrying a value date on or before ${formatDate(r.valueDate)}, grouped by act — a reversal and the re-book that completes it are one act.`,
  );

  flow.rule(GRAY.ink);
  flow.advance(6);

  flow.text(COL.descX, `${r.believed.label} closing balance`, {
    font: "bold",
    size: 8,
    baseline: 10,
  });
  flow.text(COL.balanceRight, formatUsd(believed), {
    font: "monoBold",
    size: 8,
    align: "right",
    baseline: 10,
  });
  flow.advance(16);

  for (const act of r.acts) actBlock(flow, act);

  flow.ensure(48);
  flow.rule(GRAY.rule);
  flow.advance(4);
  flow.text(COL.descX, `Sum of the ${r.acts.length} ${r.acts.length === 1 ? "act" : "acts"} above`, {
    size: 8,
    baseline: 10,
  });
  flow.text(COL.balanceRight, formatUsd(summed, { signed: true }), {
    font: "mono",
    size: 8,
    align: "right",
    baseline: 10,
  });
  flow.advance(14);
  flow.text(COL.descX, "As corrected closing balance", {
    font: "bold",
    size: 9,
    baseline: 11,
  });
  flow.text(COL.balanceRight, formatUsd(corrected), {
    font: "monoBold",
    size: 9,
    align: "right",
    baseline: 11,
  });
  flow.advance(17);
  flow.rule(GRAY.ink);
  flow.advance(6);
  flow.text(
    COL.dateX,
    `${formatUsd(believed)} ${delta < 0n ? "−" : "+"} ${formatUsd(delta < 0n ? -delta : delta)} = ${formatUsd(corrected)}`,
    { font: "mono", size: 7, gray: GRAY.soft },
  );
  flow.text(CONTENT_RIGHT, explains ? "CHECKS" : "DOES NOT CHECK — TREAT AS AN INCIDENT", {
    font: "bold",
    size: 7,
    gray: GRAY.soft,
    align: "right",
  });
  flow.advance(20);
}

function actBlock(flow: Flow, act: CorrectionGroupView): void {
  const net = toCents(act.netCents);
  const label = act.isCorrection ? "CORRECTION · REVERSAL AND RE-BOOK" : "LATE POSTING";
  const group =
    act.correctionGroupId === null ? "" : ` · group ${act.correctionGroupId.slice(0, 8)}`;

  flow.ensure(24 + act.postings.length * 13);
  flow.text(COL.dateX, `${label}${group}`, {
    font: "bold",
    size: 6,
    gray: GRAY.soft,
    baseline: 9,
  });
  flow.text(COL.balanceRight, formatUsd(net, { signed: true }), {
    font: "monoBold",
    size: 8,
    align: "right",
    baseline: 9,
  });
  flow.advance(13);

  for (const posting of act.postings) {
    const amount = toCents(posting.amountCents);
    flow.text(
      COL.descX,
      truncateToWidth(posting.description, "regular", 7, COL.descW + 60),
      { size: 7, gray: GRAY.ink, baseline: 8 },
    );
    flow.text(COL.amountRight, formatUsd(amount, { signed: true }), {
      font: "mono",
      size: 7,
      align: "right",
      baseline: 8,
    });
    flow.advance(9);
    flow.text(
      COL.descX,
      `value date ${formatDate(posting.valueDate)}${
        posting.affectsOpening ? " — before this period, so it moved the opening balance" : ""
      } · booked seq ${posting.bookingSeq} · learned ${formatTimestamp(posting.bookingTime)}`,
      { size: 6, gray: GRAY.faint, baseline: 7 },
    );
    flow.advance(11);
  }
  flow.advance(2);
  flow.current.fill(CONTENT_LEFT, flow.y - 4, CONTENT_WIDTH, 1, GRAY.hairline);
}

/**
 * The common case, said plainly: nothing corrected this day.
 *
 * A document that only makes sense on a corrected day is a document nobody
 * trusts on the other three hundred and sixty-four.
 */
function nothingChanged(flow: Flow, input: StatementPdfInput): void {
  const r = input.readings;
  flow.ensure(70);
  sectionHeading(
    flow,
    "Nothing has corrected this day",
    `No posting carrying value date ${formatDate(r.valueDate)} has been booked above watermark ${r.believed.bookingWatermark}.`,
  );
  for (const line of [
    `The two figures above are not a coincidence and not a fallback. They are two genuinely different queries over the same immutable`,
    `rows — value date ${r.valueDate} at booking watermark ${r.believed.bookingWatermark}, and the same value date at booking watermark ${r.corrected.bookingWatermark} — which return the same`,
    `number today because nothing landed in between. A backdated entry for this day remains legal at any time; it would be appended`,
    `above the watermark, the right-hand figure would move, the left-hand one would not, and the difference would appear here itemised.`,
  ]) {
    flow.text(COL.dateX, line, { size: 7, gray: GRAY.soft });
    flow.advance(10);
  }
  flow.advance(10);
}

/* -------------------------------------------------------------------------- */
/* Evidence                                                                   */
/* -------------------------------------------------------------------------- */

function evidenceBlock(flow: Flow, input: StatementPdfInput): void {
  const r = input.readings;
  if (r.published === null) return;

  flow.ensure(52);
  flow.fill(CONTENT_LEFT, CONTENT_WIDTH, 46, GRAY.band);
  flow.advance(9);
  flow.text(CONTENT_LEFT + 10, "THE DOCUMENT THAT WAS ISSUED", {
    font: "bold",
    size: 6,
    gray: GRAY.soft,
  });
  flow.advance(11);
  flow.text(
    CONTENT_LEFT + 10,
    `Stored hash  ${r.published.contentHash}`,
    { font: "mono", size: 6, gray: GRAY.ink },
  );
  flow.advance(9);
  flow.text(
    CONTENT_LEFT + 10,
    `Re-derived   ${r.believed.contentHash}  (${r.published.format})`,
    { font: "mono", size: 6, gray: GRAY.ink },
  );
  flow.advance(9);
  flow.text(
    CONTENT_LEFT + 10,
    r.reproduced
      ? "The stored hash and the hash recomputed from the ledger agree: this document reproduces."
      : r.formatChanged
        ? "The stored row was rendered by an earlier renderer, so the two hashes were never comparable."
        : "THE HASHES DISAGREE. Do not rely on this figure; this is an incident, not a rounding.",
    { size: 7, gray: r.reproduced ? GRAY.soft : GRAY.ink, font: r.reproduced ? "regular" : "bold" },
  );
  flow.advance(23);
}

function howToCheck(flow: Flow, input: StatementPdfInput, fingerprint: string): void {
  const r = input.readings;

  // A sha256 is 64 characters and it must appear WHOLE — a truncated hash is
  // worse than no hash, because it looks checkable and is not. So the value
  // column is sized to hold one at Courier 6 and the labels carry the context
  // instead of sharing the line with it.
  const rows: readonly (readonly [string, string])[] = [
    ["Account", input.account.accountId],
    ["Value date", r.valueDate],
    [
      `${r.believed.label}`,
      `booking watermark ${r.believed.bookingWatermark}`,
    ],
    ["sha256 of that reading", r.believed.contentHash],
    ["As corrected", `booking watermark ${r.corrected.bookingWatermark}`],
    ["sha256 of that reading", r.corrected.contentHash],
    ["Document fingerprint", fingerprint],
    ...(input.sourceUrl === undefined
      ? []
      : ([["Reproduce from", input.sourceUrl]] as const)),
  ];

  // Long values WRAP rather than truncate. The URL that reproduces the
  // document is useless with its tail cut off, and so is a hash; a value in
  // this block is either complete or it is decoration.
  const valueWidth = CONTENT_RIGHT - COL.refX;
  const chunked = rows.map(
    ([label, value]) => [label, monoChunks(value, 6, valueWidth)] as const,
  );

  const closing: readonly string[] = [
    "A statement is a period AND a booking watermark, not a period. Fix both and the rendering is fixed forever: every journal row at or below",
    "a watermark is immutable, and none can appear below one after the fact, because booking sequence order is commit order. Re-render either",
    "column at the watermark beside it and the sha256 above is what you get — which is why a correction produces a NEW version of this document.",
  ];

  // THE BLOCK IS ATOMIC. Split, it produces a page carrying nothing but the
  // closing paragraph — which happened, and looked like a printing accident on
  // a document whose entire argument is that it is not one. So the height is
  // computed up front and the whole thing moves together.
  const height =
    28 + chunked.reduce((n, [, c]) => n + 11 * c.length, 0) + 4 + closing.length * 10 + 4;
  flow.ensure(height);

  sectionHeading(
    flow,
    "How to check this document",
    "Nothing on this page is stored as a total. Every figure was folded from journal entries when the file was generated.",
  );

  for (const [label, chunks] of chunked) {
    flow.text(COL.dateX, label, { font: "bold", size: 6, gray: GRAY.soft, baseline: 8 });
    for (const chunk of chunks) {
      flow.text(COL.refX, chunk, { font: "mono", size: 6, baseline: 8 });
      flow.advance(11);
    }
  }

  flow.advance(4);
  for (const line of closing) {
    flow.text(COL.dateX, line, { size: 7, gray: GRAY.soft });
    flow.advance(10);
  }
}

function sectionHeading(flow: Flow, title: string, subtitle: string): void {
  flow.text(CONTENT_LEFT, title, { font: "bold", size: 10 });
  flow.advance(13);
  for (const line of wrap(subtitle, "regular", 7, CONTENT_WIDTH)) {
    flow.text(CONTENT_LEFT, line, { size: 7, gray: GRAY.faint });
    flow.advance(9);
  }
  flow.advance(6);
}

/**
 * Split a monospaced value into lines that fit a width.
 *
 * Courier advances 600/1000 em for every character, so the number of
 * characters per line is exact arithmetic rather than a measurement — which is
 * the reason hashes and URLs are set in Courier here in the first place.
 */
function monoChunks(value: string, size: number, maxPoints: number): readonly string[] {
  const perLine = Math.floor((maxPoints * 1000) / (600 * size));
  if (perLine <= 0) return [value];
  const out: string[] = [];
  for (let i = 0; i < value.length; i += perLine) out.push(value.slice(i, i + perLine));
  return out.length === 0 ? [""] : out;
}

/** Greedy word wrap against the real font metrics. */
function wrap(
  text: string,
  font: PdfFont,
  size: number,
  maxPoints: number,
): readonly string[] {
  const words = text.split(" ");
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (truncateToWidth(candidate, font, size, maxPoints) === candidate) {
      line = candidate;
    } else {
      if (line !== "") out.push(line);
      line = word;
    }
  }
  if (line !== "") out.push(line);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Footers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Stamped after layout, because "page 1 of 3" needs the 3.
 *
 * The footer carries no clock — it carries the fingerprint, which is what a
 * reader would actually use to tell two renderings apart.
 */
function stampFooters(
  doc: PdfDocument,
  input: StatementPdfInput,
  fingerprint: string,
): void {
  const total = doc.pageCount;
  doc.allPages.forEach((page, i) => {
    page.fill(MARGIN, FOOTER_TOP - 8, LETTER_WIDTH - MARGIN * 2, 1, GRAY.hairline);
    page.text(
      MARGIN,
      FOOTER_TOP + 2,
      `${input.account.legalName} · value date ${formatDate(input.readings.valueDate)} · page ${i + 1} of ${total}`,
      { size: 6, gray: GRAY.faint },
    );
    page.text(
      LETTER_WIDTH - MARGIN,
      FOOTER_TOP + 2,
      `generated from the ledger · doc ${fingerprint.slice(0, 16)}`,
      { size: 6, gray: GRAY.faint, align: "right" },
    );
  });
}
