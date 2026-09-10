/**
 * The scheme/settlement file: its format, its parser, and its renderer.
 *
 * Pure. No database, no `server-only` — it is imported by the ingest path, by
 * the simulator bridge, and by unit tests that must run in CI with no
 * credentials. The only Node API it touches is `node:crypto` for the hash.
 *
 * ---------------------------------------------------------------------------
 * THE FORMAT
 * ---------------------------------------------------------------------------
 *
 *   #CORGI-SETTLE v1 provider=achsim rail=ach business_date=2026-09-08
 *   reference,amount,value_date,direction,descriptor
 *   ACHSIM-100234512340001,73.40,2026-09-08,credit,ACME PAYROLL
 *   ACHSIM-100234512340002,-1250.00,2026-09-08,debit,VENDOR SETTLEMENT
 *
 * A header line, a column line, then one record per line. Blank lines and
 * further `#` lines are ignored. It is a plausible settlement file rather than
 * a real one — Nacha is fixed-width and NACHA batch headers would add three
 * hundred lines of parsing and nothing to the reconciliation — but it is
 * awkward in the ways real ones are, and that is the part that matters:
 *
 *   * AMOUNTS ARRIVE AS DECIMAL STRINGS. Providers send `73.40`, not `7340`.
 *     `parseFloat("73.40") * 100` is `7340.000000000001`, which floors to
 *     $73.39, and a reconciliation that is one cent out on some rows and not
 *     others is worse than no reconciliation. So the amount column is parsed
 *     by string surgery into `bigint` cents and a float is never constructed.
 *     There is no `Number()` anywhere in this file's money path.
 *
 *   * ROWS ARE MALFORMED. Truncated lines, thousands separators, a date in
 *     the wrong format, three decimal places, a direction that disagrees with
 *     the sign of its own amount. Every one of those is REJECTED AS A ROW and
 *     recorded; none of them aborts the import. A file that fails to import
 *     because of one bad line is a file nobody reconciles that night.
 *
 *   * REFERENCES REPEAT. A duplicated reference inside one file is not a
 *     parse error — the bytes are fine. Both rows are imported, at most one
 *     can match (recon_match is UNIQUE on entry_id), and the second surfaces
 *     as an in-file-not-ledger break. The duplicate reports itself; there is
 *     no special case for it anywhere in the engine.
 *
 * ---------------------------------------------------------------------------
 * SIGN CONVENTION
 * ---------------------------------------------------------------------------
 *
 * `amount` is signed from OUR point of view, on the same axis as the ledger's
 * rail-control lines (see the note in 0006_recon.sql):
 *
 *     positive -> money arriving over the rail  (direction=credit)
 *     negative -> money leaving over the rail   (direction=debit)
 *
 * The `direction` column is redundant, on purpose. Real files carry both and
 * real files sometimes disagree with themselves; when they do we want to
 * reject the row rather than guess which column meant it.
 */

import { createHash } from "node:crypto";

export const SCHEME_FILE_MAGIC = "#CORGI-SETTLE";
export const SCHEME_FILE_VERSION = "v1";

export const SCHEME_FILE_COLUMNS = [
  "reference",
  "amount",
  "value_date",
  "direction",
  "descriptor",
] as const;

/** Machine-readable reject reasons. A closed set the importer owns. */
export const REJECT_REASONS = [
  "field_count",
  "empty_reference",
  "bad_amount",
  "zero_amount",
  "bad_value_date",
  "bad_direction",
  "direction_sign_mismatch",
] as const;

export type RejectReason = (typeof REJECT_REASONS)[number];

export interface SchemeFileHeader {
  readonly provider: string;
  readonly rail: string;
  readonly businessDate: string;
}

export interface ParsedRow {
  /** 1-based, counted over DATA lines only, so it survives comments moving. */
  readonly rowNo: number;
  readonly externalRef: string;
  readonly amountCents: bigint;
  readonly valueDate: string;
  readonly direction: "credit" | "debit";
  readonly descriptor: string;
  /** The row as received, stored verbatim in `scheme_file_row.raw`. */
  readonly raw: Readonly<Record<string, string>>;
}

export interface RejectedRow {
  readonly rowNo: number;
  readonly rawLine: string;
  readonly reason: RejectReason;
  readonly detail: string;
}

export interface ParsedSchemeFile {
  readonly header: SchemeFileHeader;
  readonly rows: readonly ParsedRow[];
  readonly rejects: readonly RejectedRow[];
  /** sha256 of the file's exact bytes, lowercase hex. The natural key. */
  readonly sha256: string;
  readonly totalCents: bigint;
}

export class SchemeFileFormatError extends Error {
  override readonly name = "SchemeFileFormatError";
}

/**
 * sha256 over the file's exact bytes.
 *
 * THE NATURAL KEY. `scheme_file` is UNIQUE on this, so re-importing an
 * identical file is a unique violation, i.e. a no-op decided by Postgres and
 * not by a check the importer could forget. Note "exact bytes": the hash is
 * taken over the input string as given, before any trimming or line-ending
 * normalisation, because a file that differs by a trailing newline IS a
 * different file and we would rather import it twice and see two identical
 * runs than silently treat two different artefacts as one.
 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `-1,234.56` is NOT accepted; `-1234.56`, `1234.5`, `1234` and `+7.00` are.
 *
 * Deliberately strict. A thousands separator in a machine-readable settlement
 * file means the provider rendered it for a human somewhere upstream, and the
 * next surprise in that file will not be as harmless — so the row is rejected
 * and an operator gets told, rather than the separator being stripped and the
 * number quietly believed.
 */
const AMOUNT_RE = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Decimal string to `bigint` cents, with no float in the middle.
 *
 * Returns `null` rather than throwing: a malformed amount is an expected
 * property of a real file, not an exceptional condition, and the caller's job
 * is to record it and carry on.
 */
export function parseDecimalCents(text: string): bigint | null {
  const match = AMOUNT_RE.exec(text.trim());
  if (match === null) return null;

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2];
  if (whole === undefined) return null;
  // padEnd, not multiplication: "73.4" is 40 cents of fraction, not 4.
  const fraction = (match[3] ?? "").padEnd(2, "0");

  return sign * (BigInt(whole) * 100n + BigInt(fraction));
}

/** `7340` -> `73.40`. Integer division and remainder only; never `/ 100`. */
export function formatDecimalCents(cents: bigint): string {
  const negative = cents < 0n;
  const magnitude = negative ? -cents : cents;
  const whole = magnitude / 100n;
  const fraction = magnitude % 100n;
  return `${negative ? "-" : ""}${whole}.${fraction.toString().padStart(2, "0")}`;
}

/**
 * Split one CSV line.
 *
 * Handles double-quoted fields with `""` escaping, because a merchant
 * descriptor with a comma in it is the single most common way a settlement
 * file breaks a naive `split(",")`. It does not handle embedded newlines, and
 * that is a stated limitation rather than a bug: a record is a line.
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (line.charAt(i + 1) === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' && current === "") {
      quoted = true;
      continue;
    }
    if (ch === ",") {
      fields.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

function parseHeaderLine(line: string): SchemeFileHeader {
  const parts = line.trim().split(/\s+/);
  if (parts[0] !== SCHEME_FILE_MAGIC) {
    throw new SchemeFileFormatError(
      `not a settlement file: expected a first line beginning ${SCHEME_FILE_MAGIC}`,
    );
  }
  if (parts[1] !== SCHEME_FILE_VERSION) {
    throw new SchemeFileFormatError(
      `unsupported settlement file version ${parts[1] ?? "(none)"}; this build reads ${SCHEME_FILE_VERSION}`,
    );
  }

  const attrs = new Map<string, string>();
  for (const part of parts.slice(2)) {
    const eq = part.indexOf("=");
    if (eq > 0) attrs.set(part.slice(0, eq), part.slice(eq + 1));
  }

  const provider = attrs.get("provider");
  const rail = attrs.get("rail");
  const businessDate = attrs.get("business_date");

  // A file that does not say which rail and which day it describes cannot be
  // reconciled against anything, so this IS fatal where a bad row is not.
  if (provider === undefined || provider === "") {
    throw new SchemeFileFormatError("settlement file header is missing provider=");
  }
  if (rail === undefined || rail === "") {
    throw new SchemeFileFormatError("settlement file header is missing rail=");
  }
  if (businessDate === undefined || !DATE_RE.test(businessDate)) {
    throw new SchemeFileFormatError(
      `settlement file header business_date must be YYYY-MM-DD, got ${businessDate ?? "(none)"}`,
    );
  }

  return { provider, rail, businessDate };
}

/**
 * Parse a whole file.
 *
 * Throws only for a file that is not a settlement file at all — a bad magic
 * line, an unknown version, a header with no rail. Every other problem is a
 * `RejectedRow` and the import continues.
 */
export function parseSchemeFile(text: string): ParsedSchemeFile {
  const lines = text.split(/\r?\n/);
  const firstNonBlank = lines.find((l) => l.trim() !== "");
  if (firstNonBlank === undefined) {
    throw new SchemeFileFormatError("settlement file is empty");
  }
  const header = parseHeaderLine(firstNonBlank);

  const rows: ParsedRow[] = [];
  const rejects: RejectedRow[] = [];
  let seenHeaderLine = false;
  let seenColumnLine = false;
  let rowNo = 0;
  let totalCents = 0n;

  for (const line of lines) {
    if (line.trim() === "") continue;
    if (!seenHeaderLine) {
      seenHeaderLine = true;
      continue;
    }
    if (line.trimStart().startsWith("#")) continue;
    if (!seenColumnLine) {
      seenColumnLine = true;
      // The column line is documentation for humans; the parser is positional,
      // so a provider reordering columns would be caught by the amount and
      // date validators rather than silently mis-read. Not asserted, because
      // a file with an extra trailing column is still readable.
      continue;
    }

    rowNo += 1;
    const parsed = parseRow(rowNo, line);
    if ("reason" in parsed) {
      rejects.push(parsed);
      continue;
    }
    rows.push(parsed);
    totalCents += parsed.amountCents;
  }

  return { header, rows, rejects, sha256: sha256Hex(text), totalCents };
}

function parseRow(rowNo: number, line: string): ParsedRow | RejectedRow {
  const reject = (reason: RejectReason, detail: string): RejectedRow => ({
    rowNo,
    // Truncated so one absurd line cannot bloat the table; the row number
    // points at the original.
    rawLine: line.length > 500 ? `${line.slice(0, 497)}...` : line,
    reason,
    detail,
  });

  const fields = splitCsvLine(line);
  if (fields.length < SCHEME_FILE_COLUMNS.length) {
    return reject(
      "field_count",
      `expected ${SCHEME_FILE_COLUMNS.length} fields (${SCHEME_FILE_COLUMNS.join(", ")}), got ${fields.length}`,
    );
  }

  const externalRef = (fields[0] ?? "").trim();
  const amountText = (fields[1] ?? "").trim();
  const valueDate = (fields[2] ?? "").trim();
  const directionText = (fields[3] ?? "").trim().toLowerCase();
  const descriptor = (fields[4] ?? "").trim();

  if (externalRef === "") {
    return reject("empty_reference", "matching is by the provider's reference; a row without one can never be matched");
  }

  const amountCents = parseDecimalCents(amountText);
  if (amountCents === null) {
    return reject(
      "bad_amount",
      `amount ${JSON.stringify(amountText)} is not a signed decimal with at most two places`,
    );
  }
  if (amountCents === 0n) {
    // A zero-value settlement row is meaningless and always upstream noise.
    return reject("zero_amount", "a settlement row for zero cents carries no money and cannot be reconciled");
  }

  if (!DATE_RE.test(valueDate)) {
    return reject("bad_value_date", `value_date ${JSON.stringify(valueDate)} is not YYYY-MM-DD`);
  }

  if (directionText !== "credit" && directionText !== "debit") {
    return reject("bad_direction", `direction ${JSON.stringify(directionText)} is neither credit nor debit`);
  }

  const impliedDirection = amountCents > 0n ? "credit" : "debit";
  if (impliedDirection !== directionText) {
    return reject(
      "direction_sign_mismatch",
      `direction says ${directionText} but the amount ${amountText} is a ${impliedDirection}; the file disagrees with itself`,
    );
  }

  return {
    rowNo,
    externalRef,
    amountCents,
    valueDate,
    direction: directionText,
    descriptor,
    raw: {
      reference: externalRef,
      amount: amountText,
      value_date: valueDate,
      direction: directionText,
      descriptor,
    },
  };
}

export interface RenderRow {
  readonly externalRef: string;
  readonly amountCents: bigint;
  readonly valueDate: string;
  readonly descriptor: string;
}

/**
 * Render a settlement file.
 *
 * The exact inverse of the parser for well-formed input, which is what the
 * round-trip test asserts. Used by `simulate.ts` to turn the ACH simulator's
 * settled transfers into a nightly file, and by the planted-break test to
 * produce the SECOND file — the one with a row deleted.
 */
export function renderSchemeFile(
  header: SchemeFileHeader,
  rows: readonly RenderRow[],
): string {
  const out: string[] = [
    `${SCHEME_FILE_MAGIC} ${SCHEME_FILE_VERSION} provider=${header.provider} rail=${header.rail} business_date=${header.businessDate}`,
    SCHEME_FILE_COLUMNS.join(","),
  ];
  for (const row of rows) {
    out.push(
      [
        row.externalRef,
        formatDecimalCents(row.amountCents),
        row.valueDate,
        row.amountCents > 0n ? "credit" : "debit",
        csvQuote(row.descriptor),
      ].join(","),
    );
  }
  // Trailing newline: POSIX text files end with one, and its presence changes
  // the sha256, so it must be produced deterministically.
  return `${out.join("\n")}\n`;
}

function csvQuote(value: string): string {
  if (!/[",]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}
