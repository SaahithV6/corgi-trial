/**
 * The parser, with no database.
 *
 * These run in CI, where there are deliberately no credentials, so the part of
 * reconciliation most likely to be wrong in a way nobody notices — turning a
 * provider's `73.40` into cents — is covered on every push rather than only
 * when somebody remembers to point the suite at Neon.
 */
import { describe, expect, it } from "vitest";

import {
  formatDecimalCents,
  parseDecimalCents,
  parseSchemeFile,
  renderSchemeFile,
  sha256Hex,
  SchemeFileFormatError,
  splitCsvLine,
} from "./parse";

const HEADER = "#CORGI-SETTLE v1 provider=achsim rail=ach business_date=2026-09-08";
const COLUMNS = "reference,amount,value_date,direction,descriptor";

function file(...rows: string[]): string {
  return [HEADER, COLUMNS, ...rows].join("\n") + "\n";
}

describe("parseDecimalCents", () => {
  it("turns a provider's decimal string into exact cents", () => {
    expect(parseDecimalCents("73.40")).toBe(7_340n);
    expect(parseDecimalCents("0.01")).toBe(1n);
    expect(parseDecimalCents("1234")).toBe(123_400n);
    expect(parseDecimalCents("-1250.00")).toBe(-125_000n);
    expect(parseDecimalCents("+7.00")).toBe(700n);
  });

  it("pads a single decimal place to cents rather than to tenths", () => {
    // "73.4" is forty cents, not four. Getting this backwards is a 36-cent
    // error per row that reconciles perfectly against nothing.
    expect(parseDecimalCents("73.4")).toBe(7_340n);
  });

  it("is exact where a float is not", () => {
    // parseFloat("73.40") * 100 === 7340.000000000001, which floors to 7339.
    // This is the single reason this function exists.
    expect(parseDecimalCents("73.40")).toBe(7_340n);
    expect(parseDecimalCents("1.005")).toBeNull(); // three places: refused
    expect(parseDecimalCents("0.1")).toBe(10n);
    expect(parseDecimalCents("0.2")).toBe(20n);
    expect(
      (parseDecimalCents("0.1") ?? 0n) + (parseDecimalCents("0.2") ?? 0n),
    ).toBe(30n);
  });

  it("survives amounts past Number.MAX_SAFE_INTEGER", () => {
    expect(parseDecimalCents("999999999999999999.99")).toBe(99_999_999_999_999_999_999n);
  });

  it("refuses what a strict reader should refuse", () => {
    expect(parseDecimalCents("1,240.00")).toBeNull(); // thousands separator
    expect(parseDecimalCents("88.125")).toBeNull(); // mills
    expect(parseDecimalCents("abc")).toBeNull();
    expect(parseDecimalCents("")).toBeNull();
    expect(parseDecimalCents("1.2.3")).toBeNull();
    expect(parseDecimalCents("1e5")).toBeNull();
    expect(parseDecimalCents("NaN")).toBeNull();
    expect(parseDecimalCents("Infinity")).toBeNull();
  });
});

describe("formatDecimalCents", () => {
  it("is the exact inverse of the parser", () => {
    for (const cents of [0n, 1n, 40n, 7_340n, -125_000n, 99_999_999_999n]) {
      expect(parseDecimalCents(formatDecimalCents(cents))).toBe(cents);
    }
  });

  it("always renders two places", () => {
    expect(formatDecimalCents(7_300n)).toBe("73.00");
    expect(formatDecimalCents(7n)).toBe("0.07");
    expect(formatDecimalCents(-7n)).toBe("-0.07");
  });
});

describe("splitCsvLine", () => {
  it("keeps a comma inside a quoted merchant descriptor", () => {
    expect(splitCsvLine('REF1,73.40,2026-09-08,credit,"ACME, INC"')).toEqual([
      "REF1",
      "73.40",
      "2026-09-08",
      "credit",
      "ACME, INC",
    ]);
  });

  it("unescapes a doubled quote", () => {
    expect(splitCsvLine('A,"say ""hi"""')).toEqual(["A", 'say "hi"']);
  });
});

describe("parseSchemeFile", () => {
  it("reads the header and the rows", () => {
    const parsed = parseSchemeFile(
      file(
        "REF-1,73.40,2026-09-08,credit,ACME PAYROLL",
        "REF-2,-1250.00,2026-09-08,debit,VENDOR SETTLEMENT",
      ),
    );
    expect(parsed.header).toEqual({
      provider: "achsim",
      rail: "ach",
      businessDate: "2026-09-08",
    });
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]?.amountCents).toBe(7_340n);
    expect(parsed.rows[1]?.amountCents).toBe(-125_000n);
    // Signed, so the total is the file's net position and not its turnover.
    expect(parsed.totalCents).toBe(-117_660n);
    expect(parsed.rejects).toHaveLength(0);
  });

  it("records a malformed row and keeps reading", () => {
    const parsed = parseSchemeFile(
      file(
        "REF-1,73.40,2026-09-08,credit,GOOD",
        "TRUNCATED,142.50",
        'SEPARATOR,"1,240.00",2026-09-08,credit,THOUSANDS',
        "MILLS,88.125,2026-09-08,credit,FRACTIONAL",
        "EUDATE,64.00,08/09/2026,credit,LOCALE LEAK",
        "SIGNCLASH,-410.00,2026-09-08,credit,DISAGREES",
        ",10.00,2026-09-08,credit,MISSING REFERENCE",
        "ZERO,0.00,2026-09-08,credit,NO MONEY",
        "REF-2,10.00,2026-09-08,credit,ALSO GOOD",
      ),
    );

    // The point: the good rows still imported.
    expect(parsed.rows.map((r) => r.externalRef)).toEqual(["REF-1", "REF-2"]);
    expect(parsed.rejects.map((r) => r.reason)).toEqual([
      "field_count",
      "bad_amount",
      "bad_amount",
      "bad_value_date",
      "direction_sign_mismatch",
      "empty_reference",
      "zero_amount",
    ]);
    // Row numbers count DATA lines, so an operator can find the line.
    expect(parsed.rejects[0]?.rowNo).toBe(2);
    expect(parsed.rejects[0]?.rawLine).toBe("TRUNCATED,142.50");
  });

  it("keeps a duplicated reference: the bytes are fine, the diff decides", () => {
    const parsed = parseSchemeFile(
      file(
        "REF-1,73.40,2026-09-08,credit,FIRST",
        "REF-1,73.40,2026-09-08,credit,SECOND",
      ),
    );
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rejects).toHaveLength(0);
  });

  it("throws only for a file that is not a settlement file at all", () => {
    expect(() => parseSchemeFile("")).toThrow(SchemeFileFormatError);
    expect(() => parseSchemeFile("hello\n")).toThrow(SchemeFileFormatError);
    expect(() => parseSchemeFile("#CORGI-SETTLE v9 provider=x rail=ach business_date=2026-09-08\n"))
      .toThrow(/version/i);
    expect(() => parseSchemeFile("#CORGI-SETTLE v1 rail=ach business_date=2026-09-08\n"))
      .toThrow(/provider/i);
    expect(() => parseSchemeFile("#CORGI-SETTLE v1 provider=x rail=ach\n"))
      .toThrow(/business_date/i);
  });

  it("ignores blank lines and later comments", () => {
    const parsed = parseSchemeFile(
      [HEADER, "", COLUMNS, "# a note from the ODFI", "REF-1,1.00,2026-09-08,credit,X", ""].join("\n"),
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.rowNo).toBe(1);
  });
});

describe("the file hash", () => {
  it("is over the exact bytes, so a trailing newline is a different file", () => {
    expect(sha256Hex("a\n")).not.toBe(sha256Hex("a"));
  });

  it("is stable, which is what makes re-import a no-op", () => {
    const text = file("REF-1,73.40,2026-09-08,credit,X");
    expect(parseSchemeFile(text).sha256).toBe(parseSchemeFile(text).sha256);
    expect(parseSchemeFile(text).sha256).toBe(sha256Hex(text));
  });

  it("changes when one row is deleted — the planted-break case", () => {
    const complete = file(
      "REF-1,73.40,2026-09-08,credit,A",
      "REF-2,10.00,2026-09-08,credit,B",
    );
    const missing = file("REF-1,73.40,2026-09-08,credit,A");
    expect(sha256Hex(complete)).not.toBe(sha256Hex(missing));
  });
});

describe("renderSchemeFile", () => {
  it("round-trips through the parser", () => {
    const rows = [
      { externalRef: "REF-1", amountCents: 7_340n, valueDate: "2026-09-08", descriptor: "ACME" },
      { externalRef: "REF-2", amountCents: -125_000n, valueDate: "2026-09-08", descriptor: 'A, "B"' },
    ];
    const text = renderSchemeFile(
      { provider: "achsim", rail: "ach", businessDate: "2026-09-08" },
      rows,
    );
    const parsed = parseSchemeFile(text);

    expect(parsed.rejects).toHaveLength(0);
    expect(parsed.rows.map((r) => r.externalRef)).toEqual(["REF-1", "REF-2"]);
    expect(parsed.rows.map((r) => r.amountCents)).toEqual([7_340n, -125_000n]);
    expect(parsed.rows.map((r) => r.descriptor)).toEqual(["ACME", 'A, "B"']);
  });

  it("derives the direction column from the sign, so the two can never disagree", () => {
    const text = renderSchemeFile(
      { provider: "achsim", rail: "ach", businessDate: "2026-09-08" },
      [{ externalRef: "R", amountCents: -100n, valueDate: "2026-09-08", descriptor: "X" }],
    );
    expect(text).toContain("R,-1.00,2026-09-08,debit,X");
  });

  it("is deterministic, which is what makes the demo file's hash stable", () => {
    const rows = [
      { externalRef: "R", amountCents: 1n, valueDate: "2026-09-08", descriptor: "X" },
    ];
    const header = { provider: "achsim", rail: "ach", businessDate: "2026-09-08" };
    expect(renderSchemeFile(header, rows)).toBe(renderSchemeFile(header, rows));
  });
});
