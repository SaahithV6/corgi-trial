/**
 * The PDF, with no database and no clock.
 *
 * The claim under test is the one the whole module lives or dies on:
 *
 *     the same (account, value date, both watermarks) produces the same BYTES
 *
 * A PDF is the format where that guarantee is easiest to lose by accident —
 * `/CreationDate`, a random `/ID`, an embedded font subset — so each of those
 * gets its own assertion rather than being covered incidentally by the
 * byte-equality test. If someone later swaps this renderer for a library, the
 * tests below are what will refuse.
 *
 * The second thing under test is the accountant's test: opening plus the
 * movements equals the closing balance, and the closing balance as published
 * plus the later acts equals the closing balance as corrected. Both identities
 * are asserted against figures read out of the generated file, not against the
 * inputs — a document that prints numbers it did not derive would pass the
 * first kind of test and fail a reader.
 */
import { describe, expect, it } from "vitest";

import type {
  BothReadingsView,
  CorrectionGroupView,
  DocumentView,
  StatementLineView,
} from "@/components/statements/data-contract";

import {
  documentFingerprint,
  renderStatementPdf,
  statementPdfFilename,
  type StatementPdfInput,
} from "./pdf";
import { textWidth, truncateToWidth } from "./pdf-writer";

/* -------------------------------------------------------------------------- */
/* A book that looks like the real one                                        */
/* -------------------------------------------------------------------------- */

function line(over: Partial<StatementLineView> = {}): StatementLineView {
  return {
    id: "507:0",
    entryId: "eaf694e2-1266-43d9-b782-41101e0012ab",
    valueDate: "2026-07-25",
    bookingSeq: 507,
    ordinal: 0,
    entryType: "original",
    description: "Inbound ACH credit — customer funding",
    externalRef: "STMT-DEMO-ACH-0001",
    rail: "ach",
    reversesEntryId: null,
    correctionGroupId: null,
    amountCents: 120_000,
    runningBalanceCents: 2_225_955,
    late: false,
    ...over,
  };
}

const BELIEVED_LINES: readonly StatementLineView[] = [
  line(),
  line({
    id: "508:0",
    bookingSeq: 508,
    description: "Card clearing — Harborview Supply Co.",
    externalRef: "STMT-DEMO-CARD-0001",
    rail: "card",
    amountCents: -24_850,
    runningBalanceCents: 2_201_105,
  }),
];

const CORRECTED_LINES: readonly StatementLineView[] = [
  ...BELIEVED_LINES,
  line({
    id: "509:0",
    bookingSeq: 509,
    entryType: "reversal",
    description: "Reversal of eaf694e2-1266-43d9-b782-41101e0012ab",
    externalRef: null,
    rail: "card",
    reversesEntryId: "eaf694e2-1266-43d9-b782-41101e0012ab",
    correctionGroupId: "eaf694e2-1266-43d9-b782-41101e0012ab",
    amountCents: 24_850,
    runningBalanceCents: 2_225_955,
    late: true,
  }),
  line({
    id: "510:0",
    bookingSeq: 510,
    entryType: "rebook",
    description: "Card clearing re-presented — Harborview Supply Co.",
    externalRef: "STMT-DEMO-CARD-0001-RB",
    rail: "card",
    correctionGroupId: "eaf694e2-1266-43d9-b782-41101e0012ab",
    amountCents: -19_850,
    runningBalanceCents: 2_206_105,
    late: true,
  }),
];

function document(
  lines: readonly StatementLineView[],
  watermark: number,
  closing: number,
): DocumentView {
  return {
    periodStart: "2026-07-25",
    periodEnd: "2026-07-25",
    bookingWatermark: watermark,
    openingBalanceCents: 2_105_955,
    closingBalanceCents: closing,
    lineCount: lines.length,
    lines,
  };
}

const ACT: CorrectionGroupView = {
  id: "eaf694e2-1266-43d9-b782-41101e0012ab",
  correctionGroupId: "eaf694e2-1266-43d9-b782-41101e0012ab",
  isCorrection: true,
  netCents: 5_000,
  postings: [
    {
      entryId: "eaf694e2-1266-43d9-b782-41101e0012ab",
      valueDate: "2026-07-25",
      bookingSeq: 509,
      bookingTime: "2026-09-10T22:15:26.000Z",
      entryType: "reversal",
      description: "Reversal of eaf694e2-1266-43d9-b782-41101e0012ab",
      externalRef: null,
      reversesEntryId: "eaf694e2-1266-43d9-b782-41101e0012ab",
      amountCents: 24_850,
      affectsOpening: false,
    },
    {
      entryId: "bb1d0f10-8c58-4e04-9a6b-2c5f6f5f9a11",
      valueDate: "2026-07-25",
      bookingSeq: 510,
      bookingTime: "2026-09-10T22:15:26.000Z",
      entryType: "rebook",
      description: "Card clearing re-presented — Harborview Supply Co.",
      externalRef: "STMT-DEMO-CARD-0001-RB",
      reversesEntryId: null,
      amountCents: -19_850,
      affectsOpening: false,
    },
  ],
};

function readings(over: Partial<BothReadingsView> = {}): BothReadingsView {
  return {
    valueDate: "2026-07-25",
    closedAt: "2026-09-10T22:05:00.000Z",
    closeWatermark: 508,
    anchor: "published",
    anchors: [],
    believed: {
      label: "As published",
      bookingWatermark: 508,
      closingBalanceCents: 2_201_105,
      document: document(BELIEVED_LINES, 508, 2_201_105),
      contentHash: "a".repeat(64),
    },
    corrected: {
      label: "As corrected",
      bookingWatermark: 982,
      closingBalanceCents: 2_206_105,
      document: document(CORRECTED_LINES, 982, 2_206_105),
      contentHash: "b".repeat(64),
    },
    deltaCents: 5_000,
    differs: true,
    explained: true,
    acts: [ACT],
    learnedAt: "2026-09-10T22:15:26.000Z",
    published: {
      statementId: "2f0c9d6e-58ad-4b62-9e0e-1a4b6b5d0c77",
      version: 1,
      bookingWatermark: 508,
      openingBalanceCents: 2_105_955,
      closingBalanceCents: 2_201_105,
      lineCount: 2,
      contentHash: "a".repeat(64),
      format: "corgi.statement.v1",
      generatedAt: "2026-09-10T22:06:00.000Z",
      generatedBy: "Dana Whitfield",
    },
    reproduced: true,
    formatChanged: false,
    versions: [],
    ...over,
  };
}

function input(over: Partial<StatementPdfInput> = {}): StatementPdfInput {
  return {
    account: {
      accountId: "a0c41a37-2be1-5c30-bfe9-03455f048fac",
      legalName: "Ridgeline Robotics, Inc.",
      accountName: "Ridgeline Robotics, Inc. — business current account",
    },
    readings: readings(),
    sourceUrl: "/statements?account=a0c41a37-2be1-5c30-bfe9-03455f048fac&day=2026-07-25&as=published",
    ...over,
  };
}

/** The file as a latin1 string. Streams are uncompressed, so this is the text. */
function asText(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

/**
 * WinAnsi codes 128..159 back to Unicode.
 *
 * The file is WinAnsiEncoded, and WinAnsi disagrees with Latin-1 in exactly
 * this range — 0x97 is an em dash, not a C1 control. Decoding without this
 * table is how a reader "proves" the page says `Card clearing  Harborview` and
 * misses that the dash rendered fine.
 */
const FROM_WINANSI = new Map<number, string>([
  [128, "€"], [130, "‚"], [131, "ƒ"], [132, "„"], [133, "…"], [134, "†"], [135, "‡"],
  [136, "ˆ"], [137, "‰"], [138, "Š"], [139, "‹"], [140, "Œ"], [142, "Ž"], [145, "‘"],
  [146, "’"], [147, "“"], [148, "”"], [149, "•"], [150, "–"], [151, "—"], [152, "˜"],
  [153, "™"], [154, "š"], [155, "›"], [156, "œ"], [158, "ž"], [159, "Ÿ"],
]);

/** Every string literal drawn on the page, in drawing order. */
function drawnText(bytes: Uint8Array): readonly string[] {
  const out: string[] = [];
  const re = /\((?:\\.|[^\\()])*\)\s+Tj/g;
  for (const match of asText(bytes).matchAll(re)) {
    const raw = match[0].slice(1, match[0].lastIndexOf(")"));
    out.push(
      raw
        .replace(/\\([0-7]{3})/g, (_, oct: string) => {
          const code = Number.parseInt(oct, 8);
          return FROM_WINANSI.get(code) ?? String.fromCharCode(code);
        })
        .replace(/\\([()\\])/g, "$1"),
    );
  }
  return out;
}

/* -------------------------------------------------------------------------- */

describe("byte-identical generation", () => {
  it("produces the same bytes twice, for the same input", () => {
    const first = renderStatementPdf(input());
    const second = renderStatementPdf(input());
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  it("produces the same bytes for a structurally identical input built separately", () => {
    // Not the same object graph: a fresh construction of the same facts. This
    // is the case that catches an object identity or insertion-order
    // dependency hiding inside the layout.
    const a = renderStatementPdf(input());
    const b = renderStatementPdf({ ...input(), readings: readings() });
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  });

  it("carries no creation or modification date", () => {
    // The single commonest reason a PDF is not reproducible. Asserted on the
    // bytes, because a library swap would reintroduce it silently.
    const text = asText(renderStatementPdf(input()));
    expect(text).not.toContain("/CreationDate");
    expect(text).not.toContain("/ModDate");
  });

  it("carries no embedded font, so nothing can vary by machine", () => {
    const text = asText(renderStatementPdf(input()));
    expect(text).not.toContain("/FontFile");
    expect(text).toContain("/BaseFont /Helvetica");
    expect(text).toContain("/Encoding /WinAnsiEncoding");
  });

  it("derives the trailer /ID from the content, not from a random source", () => {
    const fingerprint = documentFingerprint(input());
    expect(asText(renderStatementPdf(input()))).toContain(
      `/ID [<${fingerprint.slice(0, 32)}> <${fingerprint.slice(0, 32)}>]`,
    );
  });

  it("changes when a single cent changes", () => {
    const base = readings();
    const moved = readings({
      corrected: {
        ...base.corrected,
        closingBalanceCents: base.corrected.closingBalanceCents + 1,
      },
    });
    expect(Buffer.from(renderStatementPdf(input({ readings: moved }))).equals(
      Buffer.from(renderStatementPdf(input())),
    )).toBe(false);
  });

  it("changes its fingerprint when a watermark moves, with the same lines", () => {
    const base = readings();
    const later = readings({
      corrected: { ...base.corrected, bookingWatermark: base.corrected.bookingWatermark + 1 },
    });
    expect(documentFingerprint(input({ readings: later }))).not.toBe(
      documentFingerprint(input()),
    );
  });
});

describe("the file is a well-formed PDF", () => {
  it("opens with a header and closes with a correct startxref", () => {
    const bytes = renderStatementPdf(input());
    const text = asText(bytes);
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.endsWith("%%EOF\n")).toBe(true);

    const startxref = /startxref\n(\d+)\n%%EOF\n$/.exec(text);
    expect(startxref).not.toBeNull();
    const offset = Number.parseInt((startxref as RegExpExecArray)[1] as string, 10);
    // The offset must land exactly on the xref keyword, or no reader opens it.
    expect(text.slice(offset, offset + 4)).toBe("xref");
  });

  it("indexes every object at the byte offset the xref claims", () => {
    const text = asText(renderStatementPdf(input()));
    const startxref = Number.parseInt(
      (/startxref\n(\d+)\n/.exec(text) as RegExpExecArray)[1] as string,
      10,
    );
    const table = text.slice(startxref);
    const entries = [...table.matchAll(/^(\d{10}) (\d{5}) n $/gm)];
    expect(entries.length).toBeGreaterThan(7);
    entries.forEach((entry, index) => {
      const offset = Number.parseInt(entry[1] as string, 10);
      expect(text.slice(offset)).toMatch(new RegExp(`^${index + 1} 0 obj\\n`));
    });
  });

  it("declares each content stream's length in bytes", () => {
    const text = asText(renderStatementPdf(input()));
    const streams = [...text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)];
    expect(streams.length).toBeGreaterThan(0);
    for (const stream of streams) {
      const declared = Number.parseInt(stream[1] as string, 10);
      const start = (stream.index as number) + (stream[0] as string).length;
      expect(text.slice(start + declared, start + declared + 9)).toBe("endstream");
    }
  });
});

describe("the accountant's test", () => {
  it("prints the opening balance, the movements and the closing balance", () => {
    const drawn = drawnText(renderStatementPdf(input()));
    expect(drawn).toContain("Opening balance");
    expect(drawn).toContain("Closing balance");
    // $21,059.55 opening + $1,200.00 − $248.50 = $22,011.05 closing.
    expect(drawn).toContain("$21,059.55");
    expect(drawn).toContain("+$1,200.00");
    expect(drawn).toContain("-$248.50");
    expect(drawn).toContain("$22,011.05");
  });

  it("states the arithmetic that closes the first loop, and says it checks", () => {
    const drawn = drawnText(renderStatementPdf(input()));
    expect(drawn).toContain(
      "$21,059.55 opening + $951.50 across 2 movements = $22,011.05 closing",
    );
    expect(drawn).toContain("CHECKS");
    expect(drawn.join("\n")).not.toContain("DOES NOT CHECK");
  });

  it("states the arithmetic that closes the bitemporal loop", () => {
    const drawn = drawnText(renderStatementPdf(input()));
    // as published + the acts = as corrected
    expect(drawn).toContain("$22,011.05 + $50.00 = $22,061.05");
    expect(drawn).toContain("+$50.00");
  });

  it("says DOES NOT CHECK when the acts do not account for the difference", () => {
    // The document must never print a confident total it cannot derive. This
    // is the case where the itemisation is short — which on the screen is an
    // incident, and on a forwarded document would be a lie.
    const short: CorrectionGroupView = { ...ACT, netCents: 1_000, postings: [] };
    const drawn = drawnText(
      renderStatementPdf(input({ readings: readings({ acts: [short] }) })),
    );
    expect(drawn.join("\n")).toContain("DOES NOT CHECK");
  });

  it("refuses a non-integer cent count rather than rounding it onto a statement", () => {
    const broken = readings({
      believed: { ...readings().believed, closingBalanceCents: 2_201_105.5 },
    });
    expect(() => renderStatementPdf(input({ readings: broken }))).toThrow(
      /integer cents/,
    );
  });
});

describe("both time axes, for a reader who has never heard of bitemporality", () => {
  it("names the two dates in plain words before it shows a figure", () => {
    const drawn = drawnText(renderStatementPdf(input())).join("\n");
    expect(drawn).toContain("TWO DATES SIT ON EVERY ENTRY IN THIS LEDGER");
    expect(drawn).toContain("The value date is the day the money belongs to");
    expect(drawn).toContain("The booking time is the moment we learned about it");
  });

  it("labels the three headline figures and both watermarks", () => {
    const drawn = drawnText(renderStatementPdf(input()));
    expect(drawn).toContain("AS PUBLISHED");
    expect(drawn).toContain("DIFFERENCE");
    expect(drawn).toContain("AS CORRECTED");
    expect(drawn).toContain("booking watermark 508");
    expect(drawn).toContain("booking watermark 982");
  });

  it("shows the entry that changed between them, with when we learned it", () => {
    const drawn = drawnText(renderStatementPdf(input())).join("\n");
    expect(drawn).toContain("CORRECTION · REVERSAL AND RE-BOOK");
    expect(drawn).toContain("Reversal of eaf694e2");
    expect(drawn).toContain("learned Sep 10, 2026 · 18:15 ET");
  });

  it("marks the rows that were booked after the document went out", () => {
    const drawn = drawnText(renderStatementPdf(input())).join("\n");
    expect(drawn).toContain("†");
    expect(drawn).toContain("booked after the document on the previous page was issued");
  });

  it("reads correctly on a day nothing has corrected", () => {
    const quiet = readings({
      corrected: {
        ...readings().corrected,
        bookingWatermark: 508,
        closingBalanceCents: 2_201_105,
        document: document(BELIEVED_LINES, 508, 2_201_105),
      },
      deltaCents: 0,
      differs: false,
      acts: [],
      learnedAt: null,
    });
    const drawn = drawnText(renderStatementPdf(input({ readings: quiet }))).join("\n");
    expect(drawn).toContain("Nothing has corrected this day");
    // "none", not "$0.00": a zero leaves it ambiguous whether the comparison
    // ran at all. Same argument the screen makes.
    expect(drawn).toContain("none");
  });

  it("renders a day with no statement issued as a reading, not a document", () => {
    const unpublished = readings({
      anchor: "before",
      published: null,
      reproduced: false,
      believed: { ...readings().believed, label: "As believed" },
    });
    const drawn = drawnText(renderStatementPdf(input({ readings: unpublished }))).join("\n");
    expect(drawn).toContain("not issued — a reading, not a document");
    expect(drawn).toContain("AS BELIEVED");
  });
});

describe("evidence a reader can re-run", () => {
  it("prints both content hashes and the fingerprint over them", () => {
    const bytes = renderStatementPdf(input());
    const drawn = drawnText(bytes).join("\n");
    expect(drawn).toContain("a".repeat(64));
    expect(drawn).toContain("b".repeat(64));
    expect(drawn).toContain(documentFingerprint(input()));
  });

  it("says so when the stored hash and the re-derivation disagree", () => {
    const tampered = readings({ reproduced: false, formatChanged: false });
    const drawn = drawnText(renderStatementPdf(input({ readings: tampered }))).join("\n");
    expect(drawn).toContain("THE HASHES DISAGREE");
  });

  it("distinguishes a renderer change from a ledger change", () => {
    const migrated = readings({ reproduced: false, formatChanged: true });
    const drawn = drawnText(renderStatementPdf(input({ readings: migrated }))).join("\n");
    expect(drawn).toContain("rendered by an earlier renderer");
    expect(drawn).not.toContain("THE HASHES DISAGREE");
  });

  it("names a file after the account, the day and the version", () => {
    expect(statementPdfFilename(input())).toBe(
      "statement-ridgeline-robotics-inc-2026-07-25-v1.pdf",
    );
  });
});

describe("text measurement", () => {
  it("measures with the real Helvetica metrics, not a character count", () => {
    // `i` and `W` are 222 and 944 thousandths. A character-count approximation
    // would make these equal and a merchant name would overprint the amount.
    expect(textWidth("iiii", "regular", 10)).toBeLessThan(textWidth("WWWW", "regular", 10));
    expect(textWidth("0000", "mono", 10)).toBe(textWidth("WWWW", "mono", 10));
  });

  it("truncates with an ellipsis rather than overprinting the next column", () => {
    const long = "Card clearing — a merchant with a very long trading name indeed";
    const cut = truncateToWidth(long, "regular", 8, 120);
    expect(cut.endsWith("…")).toBe(true);
    expect(textWidth(cut, "regular", 8)).toBeLessThanOrEqual(120);
  });

  it("leaves a string that already fits completely alone", () => {
    expect(truncateToWidth("Opening balance", "regular", 8, 400)).toBe("Opening balance");
  });
});
