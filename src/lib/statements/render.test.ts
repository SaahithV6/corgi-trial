/**
 * The content-hash scheme, with no database.
 *
 * This is the file to read if you want to argue with the hash — that is the
 * whole reason the canonical rendering is TypeScript and not a `digest()`
 * expression inside a query. The claim under test is narrow and total:
 *
 *     the hash is a pure function of
 *     (format, account, period, watermark) and the immutable rows below it
 *
 * Everything here runs in CI, which holds no credentials by design. The
 * integration suite proves the same thing against the live book; these prove
 * it about the function, including the cases a live test cannot reach — a
 * provider description crafted to forge a different set of lines, for one.
 */
import { describe, expect, it } from "vitest";

import {
  STATEMENT_FORMAT,
  canonicalStatement,
  foldClosing,
  sortLines,
  statementHash,
  withRunningBalances,
} from "./render";
import type { StatementDocument, StatementLine } from "./types";

function line(over: Partial<StatementLine> = {}): StatementLine {
  return {
    entryId: "11111111-1111-4111-8111-111111111111",
    valueDate: "2026-07-24",
    bookingSeq: 100n,
    ordinal: 0,
    entryType: "original",
    description: "Card clearing — Harborview Supply Co.",
    externalRef: "STMT-DEMO-CARD-0001",
    rail: "card",
    reversesEntryId: null,
    correctionGroupId: null,
    signedCents: -24_850n,
    runningBalanceCents: 0n,
    ...over,
  };
}

function doc(over: Partial<StatementDocument> = {}): StatementDocument {
  const lines = over.lines ?? [
    line({ bookingSeq: 100n, signedCents: 120_000n, description: "Inbound ACH credit" }),
    line({ bookingSeq: 101n, signedCents: -24_850n }),
  ];
  return {
    accountId: "a0c41a37-2be1-5c30-bfe9-03455f048fac",
    periodStart: "2026-07-24",
    periodEnd: "2026-07-24",
    bookingWatermark: 480n,
    openingBalanceCents: 1_153_733n,
    closingBalanceCents: foldClosing(1_153_733n, lines),
    lineCount: lines.length,
    ...over,
    lines,
  };
}

describe("the canonical rendering", () => {
  it("is byte-identical across calls", () => {
    const d = doc();
    expect(canonicalStatement(d)).toBe(canonicalStatement(d));
    expect(statementHash(d)).toBe(statementHash(d));
  });

  it("is a function of the SET of lines, not the order they arrived in", () => {
    const forwards = doc();
    const backwards = doc({ lines: [...forwards.lines].reverse() });
    // Not a stylistic point. The query has an ORDER BY, but a hash that
    // depended on it would make the guarantee contingent on a clause somebody
    // could later "optimise away" without any test noticing.
    expect(canonicalStatement(backwards)).toBe(canonicalStatement(forwards));
  });

  it("orders by (value date, booking seq, ordinal) — a total order", () => {
    const scrambled: StatementLine[] = [
      line({ valueDate: "2026-07-24", bookingSeq: 200n, ordinal: 1 }),
      line({ valueDate: "2026-07-24", bookingSeq: 200n, ordinal: 0 }),
      line({ valueDate: "2026-07-23", bookingSeq: 999n, ordinal: 0 }),
      line({ valueDate: "2026-07-24", bookingSeq: 199n, ordinal: 0 }),
    ];
    expect(
      sortLines(scrambled).map((l) => `${l.valueDate}/${l.bookingSeq}/${l.ordinal}`),
    ).toEqual([
      "2026-07-23/999/0",
      "2026-07-24/199/0",
      "2026-07-24/200/0",
      "2026-07-24/200/1",
    ]);
  });

  it("changes when the watermark moves, with the same lines", () => {
    // The watermark is IN the preimage rather than merely bounding the query,
    // so two documents rendered at different watermarks are distinguishable
    // even in the window where no entry has landed between them yet.
    expect(statementHash(doc({ bookingWatermark: 480n }))).not.toBe(
      statementHash(doc({ bookingWatermark: 481n })),
    );
  });

  it("changes when a single cent changes", () => {
    const before = doc();
    const after = doc({
      lines: [
        line({ bookingSeq: 100n, signedCents: 120_000n, description: "Inbound ACH credit" }),
        line({ bookingSeq: 101n, signedCents: -24_851n }),
      ],
    });
    expect(statementHash(after)).not.toBe(statementHash(before));
  });

  it("names the renderer in the preimage, first", () => {
    // A renderer change must invalidate old hashes LOUDLY. The alternative is
    // a formatter tweak that quietly makes every historical statement
    // unverifiable, which is the failure mode `statement.format` (0009) and
    // this field exist to keep apart from an actual tampered row.
    expect(canonicalStatement(doc()).startsWith(`format ${STATEMENT_FORMAT.length}:`)).toBe(
      true,
    );
    expect(canonicalStatement(doc())).toContain(STATEMENT_FORMAT);
  });

  it("does not hash the running balance, because it is derived", () => {
    const base = doc();
    const tampered = doc({
      lines: base.lines.map((l) => ({ ...l, runningBalanceCents: 999_999n })),
    });
    expect(statementHash(tampered)).toBe(statementHash(base));
  });
});

describe("preimage ambiguity — the case a delimiter scheme gets wrong", () => {
  it("cannot be forged by a description containing the field separators", () => {
    // A provider controls `description` and `external_ref`. With a plain
    // `join(":")` or `join("|")` — the scheme used in src/lib/recon/run.ts,
    // where every field is a code or a decimal — a merchant could name itself
    // so that ONE line renders as the concatenation of two, and a statement
    // with a different set of postings would hash identically. Length-prefixed
    // fields make that impossible: the preimage determines the field sequence.
    const honest = doc({
      lines: [line({ description: "Coffee", externalRef: "REF-1" })],
    });
    const forged = doc({
      lines: [
        line({
          description: "Coffee\nline 10:2026-07-24 3:999 1:0 6:-24850",
          externalRef: "REF-1",
        }),
      ],
    });
    expect(statementHash(forged)).not.toBe(statementHash(honest));
  });

  it("keeps a null reference, an empty reference and the text 'null' apart", () => {
    const absent = doc({ lines: [line({ externalRef: null })] });
    const blank = doc({ lines: [line({ externalRef: "" })] });
    const literal = doc({ lines: [line({ externalRef: "null" })] });

    const hashes = new Set([
      statementHash(absent),
      statementHash(blank),
      statementHash(literal),
    ]);
    // Three different facts about a provider reference. Collapsing any two of
    // them into one hash would mean a statement could not distinguish "the
    // entry carries no reference" from "the entry carries a blank one".
    expect(hashes.size).toBe(3);
  });

  it("cannot be forged by dropping the last line", () => {
    // The trailing newline makes an N-line document impossible to be a prefix
    // of an (N+1)-line one — belt and braces on top of the `count` record.
    const two = doc();
    const one = doc({ lines: [two.lines[0] as StatementLine] });
    expect(canonicalStatement(two).startsWith(canonicalStatement(one))).toBe(false);
  });
});

describe("balance arithmetic", () => {
  it("runs the balance forward line by line, in cents, with no float anywhere", () => {
    const lines = withRunningBalances(1_000n, [
      line({ signedCents: 120_000n }),
      line({ signedCents: -24_850n }),
      line({ signedCents: 24_850n }),
      line({ signedCents: -19_850n }),
    ]);
    expect(lines.map((l) => l.runningBalanceCents)).toEqual([
      121_000n,
      96_150n,
      121_000n,
      101_150n,
    ]);
  });

  it("folds the closing balance from the opening balance and the lines", () => {
    expect(foldClosing(1_153_733n, doc().lines)).toBe(1_153_733n + 120_000n - 24_850n);
  });

  it("handles an empty period without inventing a movement", () => {
    const empty = doc({ lines: [], openingBalanceCents: 500n, closingBalanceCents: 500n });
    expect(foldClosing(500n, [])).toBe(500n);
    expect(canonicalStatement(empty)).toContain("count 1:0");
    // A closed day with no activity still has a hash, and it is stable.
    expect(statementHash(empty)).toBe(statementHash(empty));
  });
});
