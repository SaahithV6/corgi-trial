/**
 * The bridge from the ACH simulator to a nightly settlement file.
 *
 * `src/lib/rails/achsim` already models the awkward part of ACH: settlement
 * four days late, a return that arrives after the money looked settled, a
 * notification of change, a settlement webhook that overtakes its own
 * submission. What it does not produce is the artefact reconciliation actually
 * consumes — the file the ODFI drops at 03:00 — so this module renders one
 * from the simulator's own transfer records.
 *
 * Rendering rather than inventing matters: the references in the file are the
 * simulator's own trace numbers, minted by its seeded PRNG, so the same seed
 * produces the same file, byte for byte, and therefore the same sha256 and the
 * same import decision. A reconciliation demo whose file changes every run is
 * a demo that can never show a re-import being a no-op.
 *
 * Pure, and no `server-only`: unit tests run this in CI with no database.
 *
 * ---------------------------------------------------------------------------
 * WHICH TRANSFERS APPEAR, AND WITH WHAT SIGN
 * ---------------------------------------------------------------------------
 *
 * A settlement file reports what SETTLED. A transfer that was created,
 * submitted, cancelled or failed is not on it, and a transfer that settled and
 * was later returned is on the file for the day it settled — a return is a
 * second money movement on its own day (DESIGN.md §6.1), never an edit of the
 * first, so it never retracts a row from an earlier file. Both of those are
 * exactly the timing differences reconciliation exists to surface, so neither
 * is smoothed over here.
 *
 * Sign follows `scheme_file_row.amount_cents`: signed, from OUR point of view,
 * on the same axis as the ledger's rail-control lines.
 *
 *   ACH DEBIT  we pull from the counterparty -> money arrives -> POSITIVE
 *   ACH CREDIT we push to the counterparty   -> money leaves  -> NEGATIVE
 */

import type { AchSimTransferRecord } from "@/lib/rails/achsim";

import type { RenderRow } from "./parse";

/** ISO instant -> `YYYY-MM-DD` in the book timezone. */
const BOOK_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function bookDateOf(atMs: number): string {
  return BOOK_DATE.format(new Date(atMs));
}

/**
 * The reference the file carries, and the one the ledger must carry too.
 *
 * The trace number is the network's own identifier and is what a real ODFI
 * file keys on. A transfer that settled without one would be unmatchable, so
 * it falls back to the provider's transfer id rather than being dropped — an
 * unmatchable row that is IN the file is a break somebody can act on; a row
 * silently omitted is money nobody ever looks for.
 */
export function referenceOf(record: AchSimTransferRecord): string {
  return record.traceNumber ?? record.id;
}

/** Signed cents, on the file's axis. See the header note. */
export function signedCentsOf(record: AchSimTransferRecord): bigint {
  const magnitude = record.amount.amount;
  return record.direction === "debit" ? magnitude : -magnitude;
}

export interface SettlementRowOptions {
  /** Only transfers that settled on this business date. Defaults to all settled. */
  readonly businessDate?: string;
}

/**
 * The settled transfers, as file rows, ordered by settlement time then
 * reference so the rendering is deterministic.
 */
export function settlementRowsFrom(
  records: readonly AchSimTransferRecord[],
  options: SettlementRowOptions = {},
): readonly RenderRow[] {
  const rows: { row: RenderRow; settledAtMs: number }[] = [];

  for (const record of records) {
    if (record.settledAtMs === null) continue;
    const valueDate = bookDateOf(record.settledAtMs);
    if (options.businessDate !== undefined && options.businessDate !== valueDate) continue;

    rows.push({
      settledAtMs: record.settledAtMs,
      row: {
        externalRef: referenceOf(record),
        amountCents: signedCentsOf(record),
        valueDate,
        descriptor: record.statementDescriptor,
      },
    });
  }

  rows.sort(
    (a, b) =>
      a.settledAtMs - b.settledAtMs ||
      a.row.externalRef.localeCompare(b.row.externalRef),
  );
  return rows.map((r) => r.row);
}

/**
 * Corrupt a rendered file the way a real one arrives corrupt.
 *
 * Used by the demo seed so the reject path is exercised against real bytes
 * rather than against a hand-written fixture that only ever contains the
 * mistakes the author thought of. Every line here is a mistake a settlement
 * file has actually made somewhere:
 *
 *   a truncated line          the transfer cut mid-record
 *   a thousands separator     rendered for a human upstream
 *   three decimal places      a provider that carries mills
 *   a European date           a locale leaked into a machine format
 *   a sign/direction clash    two columns that disagree with each other
 */
export function malformedLines(businessDate: string): readonly string[] {
  const [year, month, day] = businessDate.split("-");
  return [
    "TRUNCATED-ROW-0001,142.50",
    `SEPARATOR-ROW-0002,"1,240.00",${businessDate},credit,ACME PAYROLL`,
    `MILLS-ROW-0003,88.125,${businessDate},credit,FRACTIONAL CENTS`,
    // DD/MM/YYYY: a locale that leaked into a machine format.
    `EUDATE-ROW-0004,64.00,${day}/${month}/${year},credit,DATE FORMAT DRIFT`,
    `SIGNCLASH-ROW-0005,-410.00,${businessDate},credit,DIRECTION DISAGREES`,
  ];
}

/**
 * Splice extra lines into a rendered file after the header and column lines.
 *
 * Returns new text; the input is never mutated, and the caller re-hashes,
 * because a file with different bytes is a different file.
 */
export function spliceLines(fileText: string, extra: readonly string[]): string {
  if (extra.length === 0) return fileText;
  const lines = fileText.split("\n");
  // Line 0 is the magic header, line 1 the column line. Data starts at 2.
  const head = lines.slice(0, 2);
  const tail = lines.slice(2);
  return [...head, ...extra, ...tail].join("\n");
}
