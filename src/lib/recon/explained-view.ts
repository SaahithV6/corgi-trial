/**
 * The live implementation of the explaining breaks screen.
 *
 * ===========================================================================
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * ===========================================================================
 *
 * It is a SECOND READING of the same breaks `/reconciliation` shows. It calls
 * `readBreaks()` — the one diff, in `v_recon_break` — and adds a
 * classification, a causal timeline and an axis decision on top. It does not
 * re-derive the diff, it does not filter the diff, and it cannot remove a row
 * from it:
 *
 *     rows.length === readBreaks(...).length,  always.
 *
 * That property is asserted in `explained-view.test.ts` over generated inputs
 * and it is the whole safety argument of this feature. The hazard here is that
 * "explainable" becomes "suppressed" — that a classification meant to change
 * how a break is DISPLAYED ends up changing whether it is COUNTED. So the
 * classification is additive by construction: every break in, every break out,
 * with a class attached.
 *
 * The one thing this screen shows that `/reconciliation` does not is a list of
 * rows the diff reports as CLEAN and which are not — see `readSilentCorrections`
 * in `./explain-read.ts`. That is additive in the other direction: rows
 * appear, none disappear.
 *
 * MONEY narrows from `bigint` to `number` cents exactly once, in `toCents`
 * below, which refuses rather than rounds.
 */

import "server-only";

import type {
  CorrectionStepView,
  ExplainedBreakRow,
  ExplainedQuery,
  ExplainedView,
  SilentCorrectionRow,
} from "@/components/recon/explain-contract";
import { fail, ok, type ErrorShape, type Result } from "@/lib/result";

import { ageBucketOf, compareSeverity } from "./aging";
import { readBreaks } from "./diff";
import {
  explainBreak,
  isFullyExplained,
  type AxisFacts,
  type CorrectionEntryFacts,
  type CorrectionStep,
} from "./explain";
import {
  readBookingAxis,
  readGroupsForBreaks,
  readRunById,
  readSilentCorrections,
} from "./explain-read";
import { listRuns } from "./run";
import { breakIdOf } from "./screen";
import type { ReconBreak } from "./types";

/** The one bigint -> number narrowing. Refuses, never rounds. */
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

function toStepView(step: CorrectionStep): CorrectionStepView {
  return {
    entryId: step.entryId,
    entryType: step.entryType,
    valueDate: step.valueDate,
    bookingSeq: Number(step.bookingSeq),
    bookingTime: step.bookingTime,
    bookingDate: step.bookingDate,
    backdatedDays: step.backdatedDays,
    railCents: toCents(step.railCents),
    runningNetCents: toCents(step.runningNetCents),
    description: step.description,
    reversesEntryId: step.reversesEntryId,
  };
}

/**
 * Worst first, then whatever is oldest ON ITS OWN AXIS, then largest
 * outstanding, then a deterministic tail.
 *
 * The second key is the subtle one. Two rows on this screen can be sorted
 * against each other while being aged on different clocks — that is the point
 * of the feature — so the comparison is between "how long has this been
 * somebody's problem", which is the number each row has already resolved for
 * itself. Comparing a value-date age against a booking age is not an apples
 * comparison, and pretending otherwise by forcing one axis would undo the
 * decision this module exists to make.
 *
 * The magnitude key is the RESIDUAL and not the engine's break amount: a
 * corrected row whose file disagreed by $50.00 and which owes nothing should
 * not outrank a live $12.00 shortfall.
 */
function compareExplained(a: ExplainedBreakRow, b: ExplainedBreakRow): number {
  const bySeverity = compareSeverity(a.severity, b.severity);
  if (bySeverity !== 0) return bySeverity;
  if (a.ageDays !== b.ageDays) return b.ageDays - a.ageDays;

  const magA = Math.abs(a.residualCents);
  const magB = Math.abs(b.residualCents);
  if (magA !== magB) return magB - magA;

  return a.id.localeCompare(b.id);
}

/**
 * Load the screen.
 *
 * One entry point so the run header, the rows and the advisory list are
 * consistent as of one read rather than three that could interleave with a
 * concurrent reconciliation run.
 */
export async function loadExplainedView(
  query: ExplainedQuery = {},
): Promise<Result<ExplainedView, ErrorShape>> {
  try {
    const asOf = new Date().toISOString();

    // A named run is looked up BY ID, never found in a page of recent ones:
    // `listRuns` orders by business date and takes a LIMIT, so a deep link to
    // a run outside the first page would silently render "nothing has been
    // reconciled yet". Measured on this screen's first deep link.
    const history = await listRuns({ limit: 12 });
    const run =
      query.runId === undefined
        ? history[0]
        : ((await readRunById(query.runId)) ?? undefined);

    if (run === undefined) {
      return ok({
        source: "live",
        asOf,
        run: null,
        history: [],
        rows: [],
        silent: [],
        selected: null,
      });
    }

    const breaks = await readBreaks({ fileId: run.fileId });

    const [groups, silentRaw] = await Promise.all([
      readGroupsForBreaks(breaks, undefined),
      readSilentCorrections(run.fileId),
    ]);

    // One round trip for every booking-axis measurement on the page: the
    // breaks' groups and the advisory rows' groups together.
    const silentGroups = await readGroupsForBreaks(
      silentRaw.map((s) => ({
        entryId: s.entryId,
        correctionGroupId: s.correctionGroupId,
        rail: s.rail,
      })),
      undefined,
    );

    const learnedInstants: string[] = [];
    const learnedIndex = new Map<string, number>();
    for (const b of breaks) {
      const entries = groupEntriesFor(groups, b);
      const latest = latestBookingTime(entries);
      if (latest === null) continue;
      const id = breakIdOf(b);
      learnedIndex.set(id, learnedInstants.length);
      learnedInstants.push(latest);
    }

    const bookingFacts = await readBookingAxis(learnedInstants);

    const rows = breaks
      .map((b) => {
        const entries = groupEntriesFor(groups, b);
        const at = learnedIndex.get(breakIdOf(b));
        const bookingAxis: AxisFacts | null =
          at === undefined ? null : (bookingFacts[at] ?? null);

        const explanation = explainBreak(
          {
            breakKind: b.kind,
            fileAmountCents: b.fileAmountCents,
            ledgerAnchorCents: b.ledgerAmountCents,
            ledgerNetCents: b.ledgerNetCents,
            entries,
          },
          {
            valueAxis: { ageDays: b.ageDays, closesCrossed: b.closesCrossed },
            bookingAxis,
          },
          b.explainedBy,
        );

        const row: ExplainedBreakRow = {
          id: breakIdOf(b),
          kind: b.kind,
          reasonCode: b.reasonCode,
          externalRef: b.externalRef,
          valueDate: b.valueDate,
          rail: b.rail,
          provider: b.provider,

          fileAmountCents: toCentsOrNull(b.fileAmountCents),
          ledgerAmountCents: toCentsOrNull(b.ledgerAmountCents),
          ledgerNetCents: toCentsOrNull(b.ledgerNetCents),
          breakAmountCents: toCents(b.breakAmountCents),
          residualCents: toCents(explanation.residualCents),

          correctionClass: explanation.correctionClass,
          explainedBy: b.explainedBy,
          fullyExplained: isFullyExplained(explanation),
          exclusionRisk: explanation.exclusionRisk,

          agingAxis: explanation.aging.axis,
          ageDays: explanation.aging.ageDays,
          closesCrossed: explanation.aging.closesCrossed,
          ageBucket: ageBucketOf(explanation.aging.ageDays),
          severity: explanation.aging.severity,
          axisRationale: explanation.aging.axisRationale,
          valueAxis: explanation.aging.valueAxis,
          bookingAxis: explanation.aging.bookingAxis,
          learnedAt: explanation.learnedAt,
          maxBackdatedDays: explanation.maxBackdatedDays,

          steps: explanation.steps.map(toStepView),
          description: b.description,
          correctionGroupId: b.correctionGroupId,
          entryId: b.entryId,
          fileRowId: b.fileRowId,
        };
        return row;
      })
      .sort(compareExplained);

    const silent: readonly SilentCorrectionRow[] = silentRaw.map((s) => {
      const entries = silentGroups.get(s.correctionGroupId) ?? [];
      return {
        fileRowId: s.fileRowId,
        rowNo: s.rowNo,
        entryId: s.entryId,
        correctionGroupId: s.correctionGroupId,
        externalRef: s.externalRef,
        valueDate: s.valueDate,
        rail: s.rail,
        fileAmountCents: toCents(s.fileAmountCents),
        ledgerNetCents: toCents(s.ledgerNetCents),
        driftCents: toCents(s.driftCents),
        hasReversal: s.hasReversal,
        hasRebook: s.hasRebook,
        entryCount: s.entryCount,
        description: s.description,
        steps: explainBreak(
          {
            breakKind: "amount_mismatch",
            fileAmountCents: s.fileAmountCents,
            ledgerAnchorCents: s.fileAmountCents,
            ledgerNetCents: s.ledgerNetCents,
            entries,
          },
          { valueAxis: { ageDays: 0, closesCrossed: 0 }, bookingAxis: null },
          null,
        ).steps.map(toStepView),
      };
    });

    return ok({
      source: "live",
      asOf,
      run: toRunRow(run),
      history: history.map(toRunRow),
      rows,
      silent,
      selected: query.selected ?? null,
    });
  } catch (thrown) {
    // A read failure is a VALUE, so the screen's error state is a branch and
    // not a boundary. Nothing moved: this path is read-only end to end.
    return fail(
      "RECON_EXPLAIN_READ_FAILED",
      thrown instanceof Error ? thrown.message : "the reconciliation query failed",
    );
  }
}

function groupEntriesFor(
  groups: ReadonlyMap<string, readonly CorrectionEntryFacts[]>,
  b: ReconBreak,
): readonly CorrectionEntryFacts[] {
  if (b.correctionGroupId === null) return [];
  return groups.get(b.correctionGroupId) ?? [];
}

function latestBookingTime(entries: readonly CorrectionEntryFacts[]): string | null {
  let best: CorrectionEntryFacts | null = null;
  for (const e of entries) {
    if (best === null || e.bookingSeq > best.bookingSeq) best = e;
  }
  return best?.bookingTime ?? null;
}

function toRunRow(r: Awaited<ReturnType<typeof listRuns>>[number]) {
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
 * Whether a database is configured at all.
 *
 * Reads the raw env rather than `src/lib/env.ts`, which throws on a missing
 * key at import time — "no database configured" has to be a renderable state,
 * not a crash.
 */
export function hasDatabase(): boolean {
  const url = process.env["APP_DATABASE_URL"];
  return typeof url === "string" && url.trim() !== "";
}
