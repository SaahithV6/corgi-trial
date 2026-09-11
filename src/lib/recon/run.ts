/**
 * A reconciliation run.
 *
 * ---------------------------------------------------------------------------
 * A RUN IS AN ARTEFACT, NOT A JOB
 * ---------------------------------------------------------------------------
 *
 * Re-running the reconciliation for the same day does not update anything. It
 * writes a NEW `recon_run` with the next `run_no` and a NEW set of
 * `recon_run_break` rows, and every row of every earlier run stays exactly as
 * it was. That is the same shape `statement` has in 0001 and the same argument
 * DESIGN.md §13 makes for it: an artefact pinned to a booking watermark
 * reproduces forever, and a corrected view of the same period is a new version
 * rather than an edit.
 *
 * It matters here for a specific reason. "Was that break open when we closed
 * Tuesday?" is a question somebody asks in a control review, weeks later,
 * about a break that was fixed within the hour. If the run mutated, the honest
 * answer would be gone. So the 21:00 run's rows say what 21:00 saw, the 23:00
 * run's rows say what 23:00 saw, and both survive.
 *
 * The live view (`v_recon_break`, read by `readBreaks`) is the CURRENT truth
 * and is never stale, because it is computed. The run snapshot is the
 * HISTORICAL truth and is never revised, because it is frozen. Neither one is
 * a cache of the other; a system with only one of them cannot answer both
 * questions.
 *
 * `content_hash` over the canonical rendering is the same tamper evidence
 * `statement.content_hash` carries: recomputing it from `recon_run_break` must
 * reproduce it, and a mismatch means something got past both the privilege
 * layer and the append-only trigger.
 */

import "server-only";

import { createHash } from "node:crypto";

import { sql, type Sql } from "@/lib/ledger/db";
import { currentBookingWatermark } from "@/lib/ledger/queries";

import { ageBucketOf } from "./aging";
import { matchFile, readBreaks, type MatchPassResult } from "./diff";
import {
  isBreakKind,
  isExplainedBy,
  isReasonCode,
  isSeverity,
  type ReconBreak,
  type ReconRunSummary,
} from "./types";

export interface RunReconciliationInput {
  readonly fileId: string;
  readonly actorId: string;
}

export interface RunReconciliationResult {
  readonly runId: string;
  readonly runNo: number;
  readonly bookingWatermark: bigint;
  readonly match: MatchPassResult;
  readonly breaks: readonly ReconBreak[];
  readonly contentHash: string;
}

export async function runReconciliation(
  input: RunReconciliationInput,
  conn: Sql = sql,
): Promise<RunReconciliationResult> {
  return conn.begin(async (tx) => {
    const scoped = tx as unknown as Sql;

    const [file] = await tx<{ id: string; business_date: string }[]>`
      SELECT id, business_date::text AS business_date
        FROM scheme_file WHERE id = ${input.fileId}::uuid`;
    if (!file) throw new Error(`no such scheme_file ${input.fileId}`);

    // Serialise run numbering per file. Held to COMMIT, so a concurrent
    // runner waits and then reads OUR run_no rather than racing it. The
    // UNIQUE (file_id, run_no) constraint is still the guarantee; this makes
    // the common case not fail.
    await tx`SELECT pg_advisory_xact_lock(hashtext('recon_run:' || ${input.fileId}))`;

    const [next] = await tx<{ run_no: number }[]>`
      SELECT (COALESCE(MAX(run_no), 0) + 1)::integer AS run_no
        FROM recon_run WHERE file_id = ${input.fileId}::uuid`;
    const runNo = next?.run_no ?? 1;

    // The watermark is taken BEFORE the diff reads the book, so the run's
    // recorded position can never be later than what it actually saw. Asked of
    // the ledger by name; it is the same aggregate over the same rows that
    // statements and the home console were each computing for themselves.
    const bookingWatermark = await currentBookingWatermark(scoped);

    const match = await matchFile(input.fileId, input.actorId, scoped);
    const breaks = await readBreaks({ fileId: input.fileId }, scoped);

    const contentHash = canonicalHash(breaks);
    const breakTotal = breaks.reduce((acc, b) => acc + b.breakAmountCents, 0n);

    const [run] = await tx<{ id: string }[]>`
      INSERT INTO recon_run
        (file_id, business_date, run_no, booking_watermark, matched_count,
         break_count, break_total_cents, content_hash, run_by)
      VALUES (
        ${input.fileId}::uuid,
        ${file.business_date}::date,
        ${runNo},
        ${bookingWatermark.toString()}::bigint,
        ${match.matched},
        ${breaks.length},
        ${breakTotal.toString()}::bigint,
        decode(${contentHash}, 'hex'),
        ${input.actorId}::uuid
      )
      RETURNING id`;
    if (!run) throw new Error("recon_run insert returned no id");

    if (breaks.length > 0) {
      await tx`
        INSERT INTO recon_run_break
          (run_id, break_kind, reason_code, break_key, external_ref, value_date,
           file_row_id, entry_id, file_amount_cents, ledger_amount_cents,
           ledger_net_cents, break_amount_cents, age_days, closes_crossed,
           severity, explained_by)
        SELECT ${run.id}::uuid,
               b->>'break_kind',
               b->>'reason_code',
               b->>'break_key',
               b->>'external_ref',
               (b->>'value_date')::date,
               (b->>'file_row_id')::uuid,
               (b->>'entry_id')::uuid,
               (b->>'file_amount_cents')::bigint,
               (b->>'ledger_amount_cents')::bigint,
               (b->>'ledger_net_cents')::bigint,
               (b->>'break_amount_cents')::bigint,
               (b->>'age_days')::integer,
               (b->>'closes_crossed')::integer,
               b->>'severity',
               b->>'explained_by'
          FROM jsonb_array_elements(${tx.json(
            breaks.map((b) => ({
              break_kind: b.kind,
              reason_code: b.reasonCode,
              break_key: b.breakKey,
              external_ref: b.externalRef,
              value_date: b.valueDate,
              file_row_id: b.fileRowId,
              entry_id: b.entryId,
              // bigint never crosses JSON as a number. Decimal string, cast in
              // Postgres — the same rule as src/lib/ledger/post.ts.
              file_amount_cents: b.fileAmountCents?.toString() ?? null,
              ledger_amount_cents: b.ledgerAmountCents?.toString() ?? null,
              ledger_net_cents: b.ledgerNetCents?.toString() ?? null,
              break_amount_cents: b.breakAmountCents.toString(),
              age_days: b.ageDays,
              closes_crossed: b.closesCrossed,
              severity: b.severity,
              explained_by: b.explainedBy,
            })),
          )}) AS b`;
    }

    return { runId: run.id, runNo, bookingWatermark, match, breaks, contentHash };
  });
}

/**
 * The canonical rendering a run's `content_hash` is taken over.
 *
 * Sorted by (kind, key) so the hash is a function of the SET of breaks and not
 * of the order the view happened to return them — the same reasoning that
 * makes a statement's content hash stable (queries.draft.sql §4c). Amounts go
 * in as decimal cent strings; there is no float anywhere in the input.
 */
export function canonicalHash(breaks: readonly ReconBreak[]): string {
  const lines = breaks
    .map((b) =>
      [
        b.kind,
        b.reasonCode,
        b.breakKey,
        b.externalRef,
        b.valueDate,
        b.fileAmountCents?.toString() ?? "",
        b.ledgerAmountCents?.toString() ?? "",
        b.breakAmountCents.toString(),
        b.severity,
        b.explainedBy ?? "",
      ].join(":"),
    )
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(lines.join("|"), "utf8").digest("hex");
}

/** Run history, newest first. `v_recon_run_history` in 0006_recon.sql. */
export async function listRuns(
  filter: { readonly fileId?: string; readonly businessDate?: string; readonly limit?: number } = {},
  conn: Sql = sql,
): Promise<readonly ReconRunSummary[]> {
  const rows = await conn<
    {
      run_id: string;
      file_id: string;
      provider: string;
      rail: string;
      filename: string;
      file_sha256: string;
      file_row_count: number;
      business_date: string;
      run_no: number;
      booking_watermark: bigint;
      matched_count: number;
      break_count: number;
      break_total_cents: bigint;
      content_hash: string;
      started_at: string;
      finished_at: string;
      run_by: string;
      in_file_not_ledger: number;
      in_ledger_not_file: number;
      amount_mismatch: number;
      rejected_rows: number;
    }[]
  >`
    SELECT run_id, file_id, provider, rail::text AS rail, filename, file_sha256, file_row_count,
           business_date::text AS business_date, run_no, booking_watermark,
           matched_count, break_count, break_total_cents, content_hash,
           started_at::text AS started_at, finished_at::text AS finished_at,
           run_by, in_file_not_ledger, in_ledger_not_file, amount_mismatch,
           rejected_rows
      FROM v_recon_run_history
     WHERE (${filter.fileId ?? null}::uuid IS NULL OR file_id = ${filter.fileId ?? null}::uuid)
       AND (${filter.businessDate ?? null}::date IS NULL
            OR business_date = ${filter.businessDate ?? null}::date)
     -- Business date first, so "the most recent run" means last night's FILE
     -- and not whichever file somebody happened to re-run most recently. Within
     -- one file the business date is constant, so this degenerates to newest
     -- run first, which is what the run history wants.
     ORDER BY business_date DESC, started_at DESC, run_no DESC
     LIMIT ${filter.limit ?? 25}`;

  return rows.map((r) => ({
    runId: r.run_id,
    fileId: r.file_id,
    provider: r.provider,
    rail: r.rail,
    filename: r.filename,
    fileSha256: r.file_sha256,
    fileRowCount: r.file_row_count,
    businessDate: r.business_date,
    runNo: r.run_no,
    bookingWatermark: r.booking_watermark,
    matchedCount: r.matched_count,
    breakCount: r.break_count,
    breakTotalCents: r.break_total_cents,
    contentHash: r.content_hash,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    runBy: r.run_by,
    inFileNotLedger: r.in_file_not_ledger,
    inLedgerNotFile: r.in_ledger_not_file,
    amountMismatch: r.amount_mismatch,
    rejectedRows: r.rejected_rows,
  }));
}

/**
 * What one run saw, read back from the frozen snapshot.
 *
 * NOT recomputed. This is the whole point of `recon_run_break`: the severity
 * and the age are the ones that run computed, so a break that was `stale` at
 * 21:00 still reads `stale` after it was corrected at 21:30.
 */
export async function readRunBreaks(
  runId: string,
  conn: Sql = sql,
): Promise<readonly ReconBreak[]> {
  const rows = await conn<
    {
      break_kind: string;
      reason_code: string;
      break_key: string;
      external_ref: string;
      value_date: string;
      file_row_id: string | null;
      file_row_no: number | null;
      entry_id: string | null;
      entry_booking_seq: bigint | null;
      correction_group_id: string | null;
      description: string | null;
      file_amount_cents: bigint | null;
      ledger_amount_cents: bigint | null;
      ledger_net_cents: bigint | null;
      break_amount_cents: bigint;
      age_days: number;
      closes_crossed: number;
      severity: string;
      explained_by: string | null;
      file_id: string;
      provider: string;
      rail: string;
      business_date: string;
    }[]
  >`
    SELECT b.break_kind, b.reason_code, b.break_key, b.external_ref, b.value_date::text AS value_date,
           b.file_row_id, r.row_no AS file_row_no, b.entry_id, e.booking_seq AS entry_booking_seq,
           e.correction_group_id, e.description,
           b.file_amount_cents, b.ledger_amount_cents, b.ledger_net_cents,
           b.break_amount_cents, b.age_days, b.closes_crossed, b.severity, b.explained_by,
           run.file_id, f.provider, f.rail::text AS rail, f.business_date::text AS business_date
      FROM recon_run_break b
      JOIN recon_run       run ON run.id = b.run_id
      JOIN scheme_file     f   ON f.id = run.file_id
      LEFT JOIN scheme_file_row r ON r.id = b.file_row_id
      LEFT JOIN journal_entry   e ON e.id = b.entry_id
     WHERE b.run_id = ${runId}::uuid`;

  return rows.map((row) => {
    if (!isBreakKind(row.break_kind)) {
      throw new Error(`recon_run_break holds an unknown break_kind: ${row.break_kind}`);
    }
    if (!isSeverity(row.severity)) {
      throw new Error(`recon_run_break holds an unknown severity: ${row.severity}`);
    }
    if (!isReasonCode(row.reason_code)) {
      throw new Error(`recon_run_break holds an unknown reason_code: ${row.reason_code}`);
    }
    return {
      kind: row.break_kind,
      reasonCode: row.reason_code,
      breakKey: row.break_key,
      externalRef: row.external_ref,
      valueDate: row.value_date,
      fileId: row.file_id,
      provider: row.provider,
      rail: row.rail,
      businessDate: row.business_date,
      fileRowId: row.file_row_id,
      fileRowNo: row.file_row_no,
      entryId: row.entry_id,
      entryBookingSeq: row.entry_booking_seq,
      correctionGroupId: row.correction_group_id,
      fileAmountCents: row.file_amount_cents,
      ledgerAmountCents: row.ledger_amount_cents,
      ledgerNetCents: row.ledger_net_cents,
      breakAmountCents: row.break_amount_cents,
      description: row.description,
      ageDays: row.age_days,
      closesCrossed: row.closes_crossed,
      ageBucket: ageBucketOf(row.age_days),
      severity: row.severity,
      explainedBy: isExplainedBy(row.explained_by) ? row.explained_by : null,
    };
  });
}

/**
 * Verify a run's content hash against its own frozen rows.
 *
 * The recon equivalent of `verify_chain`. It should be run nightly over the
 * whole table; a mismatch is a P1, never a number to overwrite.
 */
export async function verifyRun(runId: string, conn: Sql = sql): Promise<boolean> {
  const [run] = await conn<{ content_hash: string }[]>`
    SELECT encode(content_hash, 'hex') AS content_hash
      FROM recon_run WHERE id = ${runId}::uuid`;
  if (!run) return false;
  const breaks = await readRunBreaks(runId, conn);
  return canonicalHash(breaks) === run.content_hash;
}
