/**
 * The live implementation of the breaks screen's data contract.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SCREEN SHOWS, AND WHY IT IS THE LIVE VIEW
 * ---------------------------------------------------------------------------
 *
 * The screen is scoped to a RUN — a (file, booking watermark) pair — because
 * that is how an ops team works: "last night's ACH file". But the breaks it
 * lists are the LIVE ones from `v_recon_break`, not the frozen ones from
 * `recon_run_break`.
 *
 * That is deliberate and it is the more useful of the two. A break corrected
 * ten minutes ago should read as corrected; a screen that showed the 21:00
 * snapshot would have somebody chasing a mismatch that ops already fixed. The
 * frozen snapshot is evidence for a control review, reachable through the run
 * history, and the screen says which one it is showing rather than leaving it
 * to be inferred.
 *
 * ---------------------------------------------------------------------------
 * `bigint` NARROWS HERE, ONCE
 * ---------------------------------------------------------------------------
 *
 * Everything in `src/lib/recon/**` is `bigint` cents. The contract is `number`
 * cents, because these values cross to the client and `bigint` does not
 * survive JSON. `toCents` is the single conversion site and it refuses rather
 * than silently rounds: a balance past 2^53 is a bug worth crashing on, not a
 * number to approximate in front of an operator.
 */

import "server-only";

import type {
  BreakDetail,
  BreakRow,
  ReconQuery,
  ReconView,
  RejectRow,
  RunRow,
} from "@/components/recon/data-contract";
import { fail, ok, type ErrorShape, type Result } from "@/lib/result";

import { compareBreaks, severityReason } from "./aging";
import {
  readBreakNotes,
  readBreaks,
  readCorrectionGroup,
  readFileRow,
} from "./diff";
import { listRejects } from "./ingest";
import { listRuns } from "./run";
import type { ReconBreak } from "./types";

/** The one bigint -> number narrowing in the read path. Refuses, never rounds. */
function toCents(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `${value} cents is past Number.MAX_SAFE_INTEGER; widen Cents to bigint before rendering it`,
    );
  }
  return Number(value);
}

function toCentsOrNull(value: bigint | null): number | null {
  return value === null ? null : toCents(value);
}

/** `<kind>:<breakKey>` — stable, and safe in a query string. */
export function breakIdOf(b: Pick<ReconBreak, "kind" | "breakKey">): string {
  return `${b.kind}:${b.breakKey}`;
}

export function parseBreakId(id: string): { kind: string; key: string } | null {
  const at = id.indexOf(":");
  if (at <= 0) return null;
  return { kind: id.slice(0, at), key: id.slice(at + 1) };
}

function toBreakRow(b: ReconBreak): BreakRow {
  return {
    id: breakIdOf(b),
    kind: b.kind,
    reasonCode: b.reasonCode,
    severity: b.severity,
    ageBucket: b.ageBucket,
    externalRef: b.externalRef,
    valueDate: b.valueDate,
    businessDate: b.businessDate,
    provider: b.provider,
    rail: b.rail,
    fileAmountCents: toCentsOrNull(b.fileAmountCents),
    ledgerAmountCents: toCentsOrNull(b.ledgerAmountCents),
    ledgerNetCents: toCentsOrNull(b.ledgerNetCents),
    breakAmountCents: toCents(b.breakAmountCents),
    ageDays: b.ageDays,
    closesCrossed: b.closesCrossed,
    explainedBy: b.explainedBy,
    severityReason: severityReason(
      {
        ageDays: b.ageDays,
        closesCrossed: b.closesCrossed,
        breakAmountCents: b.breakAmountCents,
        explainedBy: b.explainedBy,
      },
      b.severity,
    ),
    description: b.description,
    fileRowId: b.fileRowId,
    fileRowNo: b.fileRowNo,
    entryId: b.entryId,
    correctionGroupId: b.correctionGroupId,
  };
}

function toRunRow(r: Awaited<ReturnType<typeof listRuns>>[number]): RunRow {
  return {
    runId: r.runId,
    runNo: r.runNo,
    fileId: r.fileId,
    filename: r.filename,
    fileSha256: r.fileSha256,
    provider: r.provider,
    rail: r.rail,
    businessDate: r.businessDate,
    bookingWatermark: toCents(r.bookingWatermark),
    matchedCount: r.matchedCount,
    fileRowCount: r.fileRowCount,
    breakCount: r.breakCount,
    breakTotalCents: toCents(r.breakTotalCents),
    inFileNotLedger: r.inFileNotLedger,
    inLedgerNotFile: r.inLedgerNotFile,
    amountMismatch: r.amountMismatch,
    rejectedRows: r.rejectedRows,
    contentHash: r.contentHash,
    startedAt: r.startedAt,
    runBy: r.runBy,
  };
}

/**
 * Load the screen.
 *
 * One entry point, so `run`, `history`, `breaks`, `rejects` and `detail` are
 * consistent as of one read rather than five that could interleave with a
 * concurrent run.
 */
export async function loadReconView(
  query: ReconQuery = {},
): Promise<Result<ReconView, ErrorShape>> {
  try {
    const asOf = new Date().toISOString();

    // The most recent run across every file, unless a run was named.
    const recent = await listRuns({ limit: 50 });
    const run =
      query.runId === undefined
        ? recent[0]
        : recent.find((r) => r.runId === query.runId);

    if (run === undefined) {
      return ok({
        source: "live",
        asOf,
        run: null,
        history: [],
        breaks: [],
        rejects: [],
        detail: null,
      });
    }

    const [rawBreaks, history, rejects] = await Promise.all([
      readBreaks({ fileId: run.fileId }),
      listRuns({ fileId: run.fileId }),
      listRejects(run.fileId),
    ]);

    const breaks = [...rawBreaks].sort(compareBreaks).map(toBreakRow);
    const detail = await loadDetail(rawBreaks, query.selectedBreak);

    return ok({
      source: "live",
      asOf,
      run: toRunRow(run),
      history: history.map(toRunRow),
      breaks,
      rejects: rejects.map(
        (r): RejectRow => ({
          rowNo: r.rowNo,
          rawLine: r.rawLine,
          reason: r.reason,
          detail: r.detail,
        }),
      ),
      detail,
    });
  } catch (thrown) {
    // A read failure is a VALUE here, so the screen's error state is a branch
    // and not a boundary. Nothing moved: the reconciliation is read-only and
    // the ledger is append-only, and the panel says so.
    return fail(
      "RECON_READ_FAILED",
      thrown instanceof Error ? thrown.message : "the reconciliation query failed",
    );
  }
}

async function loadDetail(
  breaks: readonly ReconBreak[],
  selected: string | undefined,
): Promise<BreakDetail | null> {
  if (selected === undefined) return null;
  const target = breaks.find((b) => breakIdOf(b) === selected);
  if (target === undefined) return null;

  const [fileRow, group, notes] = await Promise.all([
    target.fileRowId === null ? Promise.resolve(null) : readFileRow(target.fileRowId),
    target.entryId === null ? Promise.resolve([]) : readCorrectionGroup(target.entryId),
    readBreakNotes(target.kind, target.breakKey),
  ]);

  return {
    row: toBreakRow(target),
    fileRow:
      fileRow === null
        ? null
        : {
            fileRowId: fileRow.fileRowId,
            rowNo: fileRow.rowNo,
            externalRef: fileRow.externalRef,
            amountCents: toCents(fileRow.amountCents),
            valueDate: fileRow.valueDate,
            raw: fileRow.raw,
            filename: fileRow.filename,
            fileSha256: fileRow.fileSha256,
            importedAt: fileRow.importedAt,
          },
    correctionGroup: group.map((e) => ({
      entryId: e.entryId,
      bookingSeq: Number(e.bookingSeq),
      bookingTime: e.bookingTime,
      valueDate: e.valueDate,
      entryType: e.entryType,
      description: e.description,
      externalRef: e.externalRef,
      idempotencyKey: e.idempotencyKey,
      reversesEntryId: e.reversesEntryId,
      lines: e.lines.map((l) => ({
        ordinal: l.ordinal,
        accountCode: l.accountCode,
        accountName: l.accountName,
        amountCents: toCents(l.amountCents),
        railControl: l.railControl,
      })),
    })),
    notes: notes.map((n) => ({
      createdAt: n.createdAt,
      note: n.note,
      resolution: n.resolution,
      adjustingEntryId: n.adjustingEntryId,
      createdBy: n.createdBy,
    })),
  };
}

/**
 * Whether a database is configured at all.
 *
 * Used by the page to choose between the live source and the fixture, and to
 * label which one the operator is looking at. Reads the raw env rather than
 * `src/lib/env.ts`, because that module throws on a missing key at import time
 * and "no database configured" must be a renderable state, not a crash.
 */
export function hasDatabase(): boolean {
  const url = process.env["APP_DATABASE_URL"];
  return typeof url === "string" && url.trim() !== "";
}
