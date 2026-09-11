/**
 * The database half of the explanation: correction groups, the booking axis,
 * and the corrections the breaks screen cannot see at all.
 *
 * `explain.ts` is pure and holds the policy. This file holds the three reads
 * that policy needs and nothing else.
 *
 * ===========================================================================
 * THE LEDGER BOUNDARY
 * ===========================================================================
 *
 * Nothing here writes SQL against `journal_entry`, `journal_line` or
 * `account`. The entries of a correction group come from
 * `src/lib/ledger/queries.ts` -> `readCorrectionGroup`, forwarded through
 * `./diff.ts`, which is the reader the ledger already exposes for exactly this
 * question. `src/lib/ledger/boundary.test.ts` is a ratchet and this module is
 * deliberately absent from its debt list.
 *
 * What IS read directly here is recon's own surface — `v_recon_pair` from
 * db/migrations/0006_recon.sql — and `book_day`, which is the close log the
 * severity ladder already counts and which `v_recon_break` itself reads.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";

import { readCorrectionGroup, type EntryDetail } from "./diff";
import { bookDateOf, type AxisFacts, type CorrectionEntryFacts } from "./explain";
import type { ReconRunSummary } from "./types";

/* -------------------------------------------------------------------------- */
/* 1. The correction group, reduced to rail-facing facts                      */
/* -------------------------------------------------------------------------- */

/**
 * An entry's signed effect on the leg reconciliation compares.
 *
 * The file carries one number per reference: what moved over the rail. An
 * entry carries two or more lines, of which exactly the ones on an account
 * whose `rail_control` is this rail are the rail's side. Summing those and
 * nothing else is the same rule `v_recon_ledger_group` applies in SQL — see
 * the sign-convention note in 0006_recon.sql — restated here over the same
 * rows so the timeline's running total and the view's `ledger_net_cents`
 * cannot disagree.
 *
 * Lines are debit-positive and `scheme_file_row.amount_cents` is on the same
 * axis, so an inbound settlement is positive, its reversal is negative, and
 * they sum to zero with no `CASE` anywhere.
 */
export function railCentsOf(entry: EntryDetail, rail: string): bigint {
  let total = 0n;
  for (const line of entry.lines) {
    if (line.railControl === rail) total += line.amountCents;
  }
  return total;
}

export function toCorrectionEntryFacts(
  entry: EntryDetail,
  rail: string,
): CorrectionEntryFacts {
  // `booking_time` arrives as Postgres text (`2026-09-11 04:32:39.392034+00`).
  // The contract downstream says ISO 8601, so it is normalised HERE, once,
  // rather than every renderer being expected to know that a space is a `T`.
  const parsed = new Date(entry.bookingTime);
  const bookingTime = Number.isNaN(parsed.getTime())
    ? entry.bookingTime
    : parsed.toISOString();

  return {
    entryId: entry.entryId,
    entryType: entry.entryType,
    valueDate: entry.valueDate,
    bookingSeq: entry.bookingSeq,
    bookingTime,
    bookingDate: bookDateOf(bookingTime),
    railCents: railCentsOf(entry, rail),
    description: entry.description,
    reversesEntryId: entry.reversesEntryId,
  };
}

/**
 * Every correction group behind a set of breaks, keyed by correction group id.
 *
 * Batched by group rather than by break because several breaks routinely share
 * one group — the same reference appears on four versions of the same file —
 * and reading it once per break would issue the same two queries a dozen times
 * to render one screen.
 */
export async function readGroupsForBreaks(
  breaks: readonly {
    readonly entryId: string | null;
    readonly correctionGroupId: string | null;
    readonly rail: string;
  }[],
  conn: Sql = sql,
): Promise<ReadonlyMap<string, readonly CorrectionEntryFacts[]>> {
  const wanted = new Map<string, { entryId: string; rail: string }>();
  for (const b of breaks) {
    if (b.entryId === null || b.correctionGroupId === null) continue;
    if (!wanted.has(b.correctionGroupId)) {
      wanted.set(b.correctionGroupId, { entryId: b.entryId, rail: b.rail });
    }
  }

  const out = new Map<string, readonly CorrectionEntryFacts[]>();
  await Promise.all(
    [...wanted].map(async ([groupId, { entryId, rail }]) => {
      const entries = await readCorrectionGroup(entryId, conn);
      out.set(
        groupId,
        entries.map((e) => toCorrectionEntryFacts(e, rail)),
      );
    }),
  );
  return out;
}

/* -------------------------------------------------------------------------- */
/* 2. The booking axis                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `ageDays` and `closesCrossed` measured from an instant rather than from a
 * business day, for every instant in one round trip.
 *
 * Both facts are computed in Postgres for the same reason `v_recon_break`
 * computes the value-date pair there: `book_date()` is the book's own calendar
 * function and `book_day` is the close log, and re-implementing either in
 * TypeScript would give the screen a second opinion about what day it is.
 *
 * `closes_crossed` here counts closes AT OR AFTER the instant we learned — the
 * booking-axis mirror of the view's "closes at or after the break's business
 * day". Zero means nobody has signed off a day since the correction was
 * booked, which is the honest reading of a reversal posted an hour ago.
 *
 * WITH ORDINALITY, and the result keyed by position rather than by the text of
 * the timestamp: a `timestamptz` that goes into Postgres as
 * `2026-09-11T04:32:39.392Z` comes back as `2026-09-11 04:32:39.392+00`, and
 * keying a map on that round trip is a bug waiting for a microsecond.
 */
export async function readBookingAxis(
  instants: readonly string[],
  conn: Sql = sql,
): Promise<readonly AxisFacts[]> {
  if (instants.length === 0) return [];

  const rows = await conn<{ idx: number; age_days: number; closes_crossed: number }[]>`
    SELECT t.i::integer                                   AS idx,
           (book_date(now()) - book_date(t.at))::integer   AS age_days,
           (SELECT count(*)::integer
              FROM book_day bd
             WHERE bd.closed_at >= t.at)                   AS closes_crossed
      FROM unnest(${instants as string[]}::timestamptz[]) WITH ORDINALITY AS t(at, i)`;

  const byIndex = new Map<number, AxisFacts>();
  for (const r of rows) {
    byIndex.set(r.idx, { ageDays: r.age_days, closesCrossed: r.closes_crossed });
  }

  return instants.map(
    (_, i) => byIndex.get(i + 1) ?? { ageDays: 0, closesCrossed: 0 },
  );
}

/* -------------------------------------------------------------------------- */
/* 2b. One run, by id                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A run looked up BY ID rather than found in a page of recent ones.
 *
 * `listRuns` orders by business date and takes a `LIMIT`, which is right for a
 * history panel and wrong for a deep link: a synthetic business date from a
 * live-fire attack sorts above everything, and `?run=<uuid>` for a run outside
 * the first page silently fell through to "nothing has been reconciled yet".
 * Measured, not assumed — it happened on the first deep link this screen was
 * given. A URL that is the whole state model has to resolve every id the
 * database holds, not the recent ones.
 *
 * `v_recon_run_history` is recon's own view (0006_recon.sql); the columns and
 * their casts are the same ones `listRuns` selects.
 */
export async function readRunById(
  runId: string,
  conn: Sql = sql,
): Promise<ReconRunSummary | null> {
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
    SELECT run_id, file_id, provider, rail::text AS rail, filename, file_sha256,
           file_row_count, business_date::text AS business_date, run_no,
           booking_watermark, matched_count, break_count, break_total_cents,
           content_hash, started_at::text AS started_at,
           finished_at::text AS finished_at, run_by, in_file_not_ledger,
           in_ledger_not_file, amount_mismatch, rejected_rows
      FROM v_recon_run_history
     WHERE run_id = ${runId}::uuid`;

  const r = rows[0];
  if (r === undefined) return null;

  return {
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
  };
}

/* -------------------------------------------------------------------------- */
/* 3. The corrections the breaks screen cannot see                            */
/* -------------------------------------------------------------------------- */

/**
 * ===========================================================================
 * A DETECTION GAP, FOUND WHILE BUILDING THIS AND SURFACED RATHER THAN FIXED
 * ===========================================================================
 *
 * `v_recon_pair` matches the file against the correction group's ANCHOR entry
 * — the earliest booking, "what we had booked when the provider produced the
 * file". That is the right anchor for the question the diff asks, and the long
 * note in 0006_recon.sql defends it well.
 *
 * It has a consequence nobody had written down. Consider a settlement the file
 * reports at $309.59 that we booked at $309.59 and later reversed and re-booked
 * at $259.59:
 *
 *     file 30959 == anchor 30959   ->  `exact_ref`, matched, NO BREAK
 *     group net  == 25959          ->  the book and the file are $50.00 apart
 *
 * The reconciliation reports the file clean while our position on that
 * reference is fifty dollars below the provider's. It is the same day, the
 * same reference and the same $50.00 that DOES surface as an explained
 * amount-mismatch when the provider re-issues the file at the corrected
 * figure. Which of the two an operator sees depends entirely on whether the
 * provider happened to restate the row — and the version that reports clean is
 * precisely the version where our book has moved away from the file.
 *
 * That is an exclusion shaped exactly like the thing it should catch, so it is
 * surfaced HERE, as its own list, rather than left to be discovered at month
 * end. These rows are ADVISORY and they are deliberately NOT a fourth break
 * kind: `BREAK_KINDS` is three, the three are exhaustive over the ways a file
 * and a book can disagree once matching is by reference, and `v_recon_break`,
 * `recon_run_break.break_kind` and `recon_break_note.break_kind` all CHECK the
 * same three strings. Adding a fourth would change the audit vocabulary, the
 * frozen run snapshots and four other branches' expectations to fix a display
 * problem.
 *
 * WHAT THIS QUERY COULD HIDE: nothing that was previously reported — it is
 * strictly additive, it removes no row from any break list and changes no
 * count. What it can MISS is the mirror case where the anchor itself is the
 * re-book (a group whose first rail-facing entry is not the original), which
 * cannot arise from `reverseAndRebook` but would arise if a correction were
 * ever posted as a fresh group. That is a real limit and it is not a
 * suppression: such a row would still be an ordinary amount mismatch.
 */
export interface SilentCorrection {
  readonly fileRowId: string;
  readonly rowNo: number;
  readonly entryId: string;
  readonly correctionGroupId: string;
  readonly externalRef: string;
  readonly valueDate: string;
  readonly rail: string;
  /** What the file says, and what the anchor entry booked. They are equal. */
  readonly fileAmountCents: bigint;
  /** Where the group stands now. This is the one that differs. */
  readonly ledgerNetCents: bigint;
  /** `fileAmountCents - ledgerNetCents`. Signed, on the file's axis. */
  readonly driftCents: bigint;
  readonly hasReversal: boolean;
  readonly hasRebook: boolean;
  readonly entryCount: number;
  readonly description: string | null;
}

export async function readSilentCorrections(
  fileId: string,
  conn: Sql = sql,
): Promise<readonly SilentCorrection[]> {
  const rows = await conn<
    {
      file_row_id: string;
      row_no: number;
      entry_id: string;
      correction_group_id: string;
      external_ref: string;
      value_date: string;
      rail: string;
      file_amount_cents: bigint;
      ledger_net_cents: bigint;
      has_reversal: boolean;
      has_rebook: boolean;
      entry_count: number;
      description: string | null;
    }[]
  >`
    SELECT p.file_row_id,
           p.row_no,
           p.entry_id,
           p.correction_group_id,
           p.external_ref,
           p.value_date::text AS value_date,
           f.rail::text       AS rail,
           p.file_amount_cents,
           p.ledger_net_cents,
           p.has_reversal,
           p.has_rebook,
           p.entry_count,
           p.description
      FROM v_recon_pair  p
      JOIN scheme_file   f ON f.id = p.file_id
     WHERE p.file_id = ${fileId}::uuid
       -- Matched clean on the anchor...
       AND p.file_amount_cents = p.ledger_amount_cents
       -- ...and the group has since moved away from it.
       AND p.ledger_net_cents <> p.file_amount_cents
     ORDER BY p.row_no`;

  return rows.map((r) => ({
    fileRowId: r.file_row_id,
    rowNo: r.row_no,
    entryId: r.entry_id,
    correctionGroupId: r.correction_group_id,
    externalRef: r.external_ref,
    valueDate: r.value_date,
    rail: r.rail,
    fileAmountCents: r.file_amount_cents,
    ledgerNetCents: r.ledger_net_cents,
    driftCents: r.file_amount_cents - r.ledger_net_cents,
    hasReversal: r.has_reversal,
    hasRebook: r.has_rebook,
    entryCount: r.entry_count,
    description: r.description,
  }));
}
