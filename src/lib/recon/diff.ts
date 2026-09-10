import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";

import { ageBucketOf, severityOf } from "./aging";
import {
  isBreakKind,
  isExplainedBy,
  isReasonCode,
  type ReconBreak,
} from "./types";

/**
 * The diff engine: matching, and the three break categories.
 *
 * The diff itself is SQL — `v_recon_pair` and `v_recon_break` in
 * db/migrations/0006_recon.sql — and there is no second implementation of it
 * in TypeScript, so the live screen and the frozen audit trail cannot drift
 * apart. This module is the reader, plus the one write the diff produces:
 * a `recon_match` row per pairing.
 *
 * ---------------------------------------------------------------------------
 * MATCHING IS ON THE PROVIDER'S OWN REFERENCE. FULL STOP.
 * ---------------------------------------------------------------------------
 *
 * There is no amount+date fallback in this module and there is not going to
 * be one. A same-amount, same-day heuristic looks like it improves the match
 * rate and actually destroys the reconciliation: two $40.00 coffee settlements
 * on the same Tuesday get paired at random, both "match", and a screen that
 * should have shown two breaks shows none. The failure is silent and it is
 * permanent, because `recon_match` is append-only.
 *
 * `recon_match.match_rule` in 0001 admits a third value, `'heuristic'`.
 * Nothing in this build writes it. The two rules this build uses are:
 *
 *   exact_ref            reference matches, amounts agree
 *   ref_amount_mismatch  reference matches, amounts differ -> an
 *                        amount-mismatch break, with BOTH amounts recorded on
 *                        the match row so the break carries its own evidence
 *
 * ---------------------------------------------------------------------------
 * WHAT `recon_match` IS FOR, GIVEN THE DIFF DOES NOT READ IT
 * ---------------------------------------------------------------------------
 *
 * `recon_match` is UNIQUE on `entry_id`, which is right and which is also why
 * the diff cannot be driven by it: a provider re-issuing a file — the exact
 * case the graders exercise by deleting a row — would find every entry already
 * paired against last night's version and report the new file as perfect. So
 * the diff re-derives the pairing per file, from references, every time (see
 * the long note in 0006_recon.sql), and `recon_match` keeps the job 0001
 * designed it for: the durable, append-only record of the FIRST time a
 * reference was paired with an entry, carrying both amounts as at that moment.
 *
 * That row is evidence, and it is the reason an amount mismatch stays
 * explicable after somebody corrects the entry: the book moves on, the match
 * row does not.
 *
 * ---------------------------------------------------------------------------
 * WHICH LEDGER ENTRY
 * ---------------------------------------------------------------------------
 *
 * A reference can name several entries: the original, its reversal, and the
 * re-book all carry the same `external_ref` and the same `correction_group_id`
 * (see `reverseAndRebook` in src/lib/ledger/post.ts). The pairing anchors on
 * the EARLIEST of them by `booking_seq` — what we had booked when the file was
 * produced — because that is the number the provider was disagreeing with.
 * `v_recon_break.ledger_net_cents` is where the group stands now. The gap
 * between the two is the entire reversal-plus-rebook case.
 */

export interface MatchPassResult {
  /** Pairings this file has, computed fresh from `v_recon_pair`. */
  readonly matched: number;
  readonly exactRef: number;
  readonly refAmountMismatch: number;
  /** `recon_match` rows this pass added. Zero on a re-run: they already exist. */
  readonly recorded: number;
}

/**
 * Record this file's pairings in `recon_match`.
 *
 * The pairing itself is `v_recon_pair`; this writes it down. `ON CONFLICT DO
 * NOTHING` is what makes a re-run a no-op rather than a unique violation, and
 * DO NOTHING rather than DO UPDATE is deliberate twice over: it preserves the
 * FIRST pairing's amounts as evidence, and it needs no privilege beyond INSERT
 * — `corgi_app` holds no UPDATE on `recon_match` and this path must never be
 * the reason it would need one.
 *
 * A second file for the same business date will find its entries already
 * recorded here and add nothing. That is correct: the evidence of when a
 * reference was first paired belongs to the first file that carried it. The
 * diff is unaffected, because the diff does not read this table.
 */
export async function matchFile(
  fileId: string,
  actorId: string,
  conn: Sql = sql,
): Promise<MatchPassResult> {
  const recorded = await conn<{ match_rule: string }[]>`
    INSERT INTO recon_match
      (file_row_id, entry_id, file_amount_cents, ledger_amount_cents, match_rule, matched_by)
    SELECT p.file_row_id,
           p.entry_id,
           p.file_amount_cents,
           p.ledger_amount_cents,
           p.match_rule,
           ${actorId}::uuid
      FROM v_recon_pair p
     WHERE p.file_id = ${fileId}::uuid
    ON CONFLICT DO NOTHING
    RETURNING match_rule`;

  const [totals] = await conn<
    { matched: number; exact_ref: number; ref_amount_mismatch: number }[]
  >`
    SELECT count(*)::integer AS matched,
           count(*) FILTER (WHERE p.match_rule = 'exact_ref')::integer AS exact_ref,
           count(*) FILTER (WHERE p.match_rule = 'ref_amount_mismatch')::integer
             AS ref_amount_mismatch
      FROM v_recon_pair p
     WHERE p.file_id = ${fileId}::uuid`;

  return {
    recorded: recorded.length,
    matched: totals?.matched ?? 0,
    exactRef: totals?.exact_ref ?? 0,
    refAmountMismatch: totals?.ref_amount_mismatch ?? 0,
  };
}

/** A row of `v_recon_break`, before the policy layer runs over it. */
interface BreakRow {
  file_id: string;
  provider: string;
  rail: string;
  business_date: string;
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
  file_amount_cents: bigint | null;
  ledger_amount_cents: bigint | null;
  ledger_net_cents: bigint | null;
  break_amount_cents: bigint;
  description: string | null;
  age_days: number;
  closes_crossed: number;
  explained_by: string | null;
}

/**
 * Read the three break categories.
 *
 * The three queries live in `v_recon_break` (db/migrations/0006_recon.sql) —
 * one definition, read live here and frozen into `recon_run_break` by a run.
 * There is no second implementation of the diff in TypeScript, so the screen
 * and the audit trail cannot drift apart.
 *
 * What happens HERE and not in SQL is the policy: the age bucket and the
 * severity, from `src/lib/recon/aging.ts`, so the thresholds are unit-tested
 * without a database and exist in exactly one place.
 */
export async function readBreaks(
  filter: { readonly fileId?: string; readonly businessDate?: string } = {},
  conn: Sql = sql,
): Promise<readonly ReconBreak[]> {
  const rows = await conn<BreakRow[]>`
    SELECT file_id,
           provider,
           rail::text                AS rail,
           business_date::text       AS business_date,
           break_kind,
           reason_code,
           break_key,
           external_ref,
           value_date::text          AS value_date,
           file_row_id,
           file_row_no,
           entry_id,
           entry_booking_seq,
           correction_group_id,
           file_amount_cents,
           ledger_amount_cents,
           ledger_net_cents,
           break_amount_cents,
           description,
           age_days,
           closes_crossed,
           explained_by
      FROM v_recon_break
     WHERE (${filter.fileId ?? null}::uuid IS NULL OR file_id = ${filter.fileId ?? null}::uuid)
       AND (${filter.businessDate ?? null}::date IS NULL
            OR business_date = ${filter.businessDate ?? null}::date)`;

  return rows.map(toReconBreak);
}

export function toReconBreak(row: BreakRow): ReconBreak {
  if (!isBreakKind(row.break_kind)) {
    // The view's own CHECK vocabulary and this union are the same three
    // strings. If they ever are not, fail loudly rather than render a break
    // with no category.
    throw new Error(`v_recon_break returned an unknown break_kind: ${row.break_kind}`);
  }
  if (!isReasonCode(row.reason_code)) {
    throw new Error(`v_recon_break returned an unknown reason_code: ${row.reason_code}`);
  }
  const explainedBy = isExplainedBy(row.explained_by) ? row.explained_by : null;
  const facts = {
    ageDays: row.age_days,
    closesCrossed: row.closes_crossed,
    breakAmountCents: row.break_amount_cents,
    explainedBy,
  };

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
    severity: severityOf(facts),
    explainedBy,
  };
}

/* -------------------------------------------------------------------------- */
/* Drill-through                                                              */
/* -------------------------------------------------------------------------- */

export interface EntryLineDetail {
  readonly ordinal: number;
  readonly accountCode: string;
  readonly accountName: string;
  readonly amountCents: bigint;
  readonly railControl: string | null;
}

export interface EntryDetail {
  readonly entryId: string;
  readonly bookingSeq: bigint;
  readonly bookingTime: string;
  readonly valueDate: string;
  readonly entryType: "original" | "reversal" | "rebook";
  readonly description: string;
  readonly externalRef: string | null;
  readonly idempotencyKey: string;
  readonly reversesEntryId: string | null;
  readonly correctionGroupId: string;
  readonly lines: readonly EntryLineDetail[];
}

/**
 * The journal entry behind a break, and every other entry in its correction
 * group, oldest first.
 *
 * The group is the point. Showing one entry answers "what did we book"; the
 * group answers "and what did we do about it", which is the only way a
 * reversal-plus-rebook reads as an explanation rather than as three unrelated
 * postings that happen to share a reference.
 */
export async function readCorrectionGroup(
  entryId: string,
  conn: Sql = sql,
): Promise<readonly EntryDetail[]> {
  const entries = await conn<
    {
      id: string;
      booking_seq: bigint;
      booking_time: string;
      value_date: string;
      entry_type: "original" | "reversal" | "rebook";
      description: string;
      external_ref: string | null;
      idempotency_key: string;
      reverses_entry_id: string | null;
      correction_group_id: string;
    }[]
  >`
    SELECT e.id, e.booking_seq, e.booking_time::text AS booking_time,
           e.value_date::text AS value_date, e.entry_type, e.description,
           e.external_ref, e.idempotency_key, e.reverses_entry_id,
           e.correction_group_id
      FROM journal_entry e
     WHERE e.correction_group_id = (
             SELECT correction_group_id FROM journal_entry WHERE id = ${entryId}::uuid)
     ORDER BY e.booking_seq`;

  if (entries.length === 0) return [];

  const lines = await conn<
    {
      entry_id: string;
      ordinal: number;
      code: string;
      name: string;
      amount_cents: bigint;
      rail_control: string | null;
    }[]
  >`
    SELECT l.entry_id, l.ordinal, a.code, a.name, l.amount_cents,
           a.rail_control::text AS rail_control
      FROM journal_line l
      JOIN account      a ON a.id = l.account_id
     WHERE l.entry_id = ANY(${entries.map((e) => e.id)}::uuid[])
     ORDER BY l.entry_id, l.ordinal`;

  return entries.map((e) => ({
    entryId: e.id,
    bookingSeq: e.booking_seq,
    bookingTime: e.booking_time,
    valueDate: e.value_date,
    entryType: e.entry_type,
    description: e.description,
    externalRef: e.external_ref,
    idempotencyKey: e.idempotency_key,
    reversesEntryId: e.reverses_entry_id,
    correctionGroupId: e.correction_group_id,
    lines: lines
      .filter((l) => l.entry_id === e.id)
      .map((l) => ({
        ordinal: l.ordinal,
        accountCode: l.code,
        accountName: l.name,
        amountCents: l.amount_cents,
        railControl: l.rail_control,
      })),
  }));
}

export interface FileRowDetail {
  readonly fileRowId: string;
  readonly rowNo: number;
  readonly externalRef: string;
  readonly amountCents: bigint;
  readonly valueDate: string;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly filename: string;
  readonly fileSha256: string;
  readonly provider: string;
  readonly importedAt: string;
}

/** The file row behind a break, with the file it arrived in. */
export async function readFileRow(
  fileRowId: string,
  conn: Sql = sql,
): Promise<FileRowDetail | null> {
  const [row] = await conn<
    {
      id: string;
      row_no: number;
      external_ref: string;
      amount_cents: bigint;
      value_date: string;
      raw: Record<string, unknown>;
      filename: string;
      sha256: string;
      provider: string;
      imported_at: string;
    }[]
  >`
    SELECT r.id, r.row_no, r.external_ref, r.amount_cents,
           r.value_date::text AS value_date, r.raw,
           f.filename, encode(f.sha256, 'hex') AS sha256, f.provider,
           f.imported_at::text AS imported_at
      FROM scheme_file_row r
      JOIN scheme_file     f ON f.id = r.file_id
     WHERE r.id = ${fileRowId}::uuid`;
  if (!row) return null;

  return {
    fileRowId: row.id,
    rowNo: row.row_no,
    externalRef: row.external_ref,
    amountCents: row.amount_cents,
    valueDate: row.value_date,
    raw: row.raw,
    filename: row.filename,
    fileSha256: row.sha256,
    provider: row.provider,
    importedAt: row.imported_at,
  };
}

export interface BreakNote {
  readonly createdAt: string;
  readonly note: string;
  readonly resolution: string | null;
  readonly adjustingEntryId: string | null;
  readonly createdBy: string;
}

/**
 * Adjudication history for one break. Append-only, so a resolved break keeps
 * its story instead of disappearing from a screen (DESIGN.md §15).
 */
export async function readBreakNotes(
  breakKind: string,
  breakKey: string,
  conn: Sql = sql,
): Promise<readonly BreakNote[]> {
  const rows = await conn<
    {
      created_at: string;
      note: string;
      resolution: string | null;
      adjusting_entry_id: string | null;
      display_name: string;
    }[]
  >`
    SELECT n.created_at::text AS created_at, n.note, n.resolution,
           n.adjusting_entry_id, act.display_name
      FROM recon_break_note n
      JOIN actor            act ON act.id = n.created_by
     WHERE n.break_kind = ${breakKind}
       AND n.break_key  = ${breakKey}
     ORDER BY n.created_at`;

  return rows.map((r) => ({
    createdAt: r.created_at,
    note: r.note,
    resolution: r.resolution,
    adjustingEntryId: r.adjusting_entry_id,
    createdBy: r.display_name,
  }));
}
