import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";

import {
  parseSchemeFile,
  type ParsedSchemeFile,
  type RejectedRow,
} from "./parse";

/**
 * Importing a scheme/settlement file.
 *
 * Two rules, and everything here is one of them.
 *
 * 1. THE FILE'S HASH IS THE NATURAL KEY. `scheme_file` is UNIQUE on `sha256`,
 *    so re-importing an identical file is a unique violation — a no-op decided
 *    by Postgres, not by a check in this module that a future caller could
 *    bypass. This function reports `imported: false` and hands back the
 *    EXISTING file id, so a nightly job that runs twice, or a retry after a
 *    timeout that actually committed, both do exactly nothing and both return
 *    the right id. Two identical files never become two files.
 *
 *    Note what is NOT the key: filename, provider, business date. A provider
 *    that re-sends yesterday's file under today's name is sending yesterday's
 *    file, and the hash says so.
 *
 * 2. A BAD ROW IS A ROW, NOT AN ABORT. Malformed lines go to
 *    `scheme_file_reject` with the line verbatim and a reason; the rest of the
 *    file imports. A settlement file that fails to import because of one
 *    truncated line is a file nobody reconciles that night, and "nobody
 *    reconciled last night" is a much larger problem than "seven rows need
 *    a human".
 *
 * The whole import is ONE transaction. A file row without its file, or a file
 * whose `row_count` disagrees with the rows actually stored, would each be a
 * lie told by an append-only table, and an append-only table has no way to
 * take it back.
 */

export interface ImportSchemeFileInput {
  readonly filename: string;
  /** The file's exact bytes as text. Hashed as given; never normalised. */
  readonly content: string;
  readonly importedBy: string;
}

export interface ImportSchemeFileResult {
  readonly fileId: string;
  /** False when this exact file was already on record. */
  readonly imported: boolean;
  readonly sha256: string;
  readonly provider: string;
  readonly rail: string;
  readonly businessDate: string;
  readonly rowCount: number;
  readonly rejectedCount: number;
  readonly totalCents: bigint;
  readonly rejects: readonly RejectedRow[];
}

/** Postgres unique violation. The one error class this module treats as normal. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(thrown: unknown): boolean {
  return (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    (thrown as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

export async function importSchemeFile(
  input: ImportSchemeFileInput,
  conn: Sql = sql,
): Promise<ImportSchemeFileResult> {
  // Parse before touching the database. A file that is not a settlement file
  // at all throws here, having written nothing.
  const parsed = parseSchemeFile(input.content);

  const existing = await findBySha256(parsed.sha256, conn);
  if (existing !== null) {
    return {
      ...describe(parsed, existing.id, false),
      // The rejects reported are THIS parse's, which is the same parse the
      // original import did — same bytes, same parser, same rejects. They are
      // also on record in scheme_file_reject; re-reporting them costs nothing
      // and means a re-import still tells the operator what is wrong.
      rejects: parsed.rejects,
    };
  }

  try {
    const fileId = await conn.begin(async (tx) => {
      const [file] = await tx<{ id: string }[]>`
        INSERT INTO scheme_file
          (provider, rail, business_date, filename, sha256, row_count, total_cents, imported_by)
        VALUES (
          ${parsed.header.provider},
          ${parsed.header.rail}::rail,
          ${parsed.header.businessDate}::date,
          ${input.filename},
          decode(${parsed.sha256}, 'hex'),
          ${parsed.rows.length},
          ${parsed.totalCents.toString()}::bigint,
          ${input.importedBy}::uuid
        )
        RETURNING id`;
      if (!file) throw new Error("scheme_file insert returned no id");

      if (parsed.rows.length > 0) {
        await tx`
          INSERT INTO scheme_file_row (file_id, row_no, external_ref, amount_cents, value_date, raw)
          SELECT ${file.id}::uuid,
                 (r->>'row_no')::integer,
                 r->>'external_ref',
                 (r->>'amount_cents')::bigint,
                 (r->>'value_date')::date,
                 r->'raw'
            FROM jsonb_array_elements(${tx.json(
              parsed.rows.map((row) => ({
                row_no: row.rowNo,
                external_ref: row.externalRef,
                // bigint does not survive JSON.stringify. Decimal string, cast
                // in Postgres — the same rule as src/lib/ledger/post.ts.
                amount_cents: row.amountCents.toString(),
                value_date: row.valueDate,
                raw: row.raw,
              })),
            )}) AS r`;
      }

      if (parsed.rejects.length > 0) {
        await tx`
          INSERT INTO scheme_file_reject (file_id, row_no, raw_line, reason, detail)
          SELECT ${file.id}::uuid,
                 (r->>'row_no')::integer,
                 r->>'raw_line',
                 r->>'reason',
                 r->>'detail'
            FROM jsonb_array_elements(${tx.json(
              parsed.rejects.map((r) => ({
                row_no: r.rowNo,
                raw_line: r.rawLine,
                reason: r.reason,
                detail: r.detail,
              })),
            )}) AS r`;
      }

      return file.id;
    });

    return { ...describe(parsed, fileId, true), rejects: parsed.rejects };
  } catch (thrown) {
    // The race: two importers, same bytes, neither saw the other's SELECT.
    // Postgres decided it; we just report the decision.
    if (isUniqueViolation(thrown)) {
      const raced = await findBySha256(parsed.sha256, conn);
      if (raced !== null) {
        return { ...describe(parsed, raced.id, false), rejects: parsed.rejects };
      }
    }
    throw thrown;
  }
}

async function findBySha256(
  sha256: string,
  conn: Sql,
): Promise<{ id: string } | null> {
  const [row] = await conn<{ id: string }[]>`
    SELECT id FROM scheme_file WHERE sha256 = decode(${sha256}, 'hex')`;
  return row ?? null;
}

function describe(
  parsed: ParsedSchemeFile,
  fileId: string,
  imported: boolean,
): Omit<ImportSchemeFileResult, "rejects"> {
  return {
    fileId,
    imported,
    sha256: parsed.sha256,
    provider: parsed.header.provider,
    rail: parsed.header.rail,
    businessDate: parsed.header.businessDate,
    rowCount: parsed.rows.length,
    rejectedCount: parsed.rejects.length,
    totalCents: parsed.totalCents,
  };
}

export interface SchemeFileRejectRecord {
  readonly rowNo: number;
  readonly rawLine: string;
  readonly reason: string;
  readonly detail: string;
}

/** The rejects on record for a file. What the screen shows under "not read". */
export async function listRejects(
  fileId: string,
  conn: Sql = sql,
): Promise<readonly SchemeFileRejectRecord[]> {
  const rows = await conn<
    { row_no: number; raw_line: string; reason: string; detail: string }[]
  >`
    SELECT row_no, raw_line, reason, detail
      FROM scheme_file_reject
     WHERE file_id = ${fileId}::uuid
     ORDER BY row_no`;
  return rows.map((r) => ({
    rowNo: r.row_no,
    rawLine: r.raw_line,
    reason: r.reason,
    detail: r.detail,
  }));
}
