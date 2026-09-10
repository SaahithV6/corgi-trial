import Link from "next/link";

import { Money } from "@/components/ui/Money";
import {
  FOCUS_RING,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";

import type { RunRow } from "./data-contract";
import { breakHref, type BreakFilter } from "./view-state";

/**
 * Every run over this file, newest first.
 *
 * A re-run does not update anything. It writes a new `recon_run` with the next
 * `run_no` and a new set of frozen `recon_run_break` rows, and every row of
 * every earlier run stays exactly as it was — the same shape a statement has
 * (DESIGN.md §13), and for the same reason: "was that break open when we
 * closed Tuesday" is asked weeks later, about a break that was fixed within
 * the hour.
 *
 * The watermark and the content hash are on screen because they are what make
 * that claim checkable rather than asserted. Two runs at the same watermark
 * over the same file MUST carry the same content hash; if they ever do not,
 * something changed underneath an append-only table and this row is where you
 * would see it first.
 */
export function RunHistory({
  runs,
  current,
  filter,
}: {
  readonly runs: readonly RunRow[];
  readonly current: RunRow;
  readonly filter: BreakFilter;
}) {
  return (
    <Panel
      title="Runs over this file"
      description="A run is immutable. Re-running appends; it never revises."
    >
      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Reconciliation runs over this settlement file, newest first
          </caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH_CLASS}>
                Run
              </th>
              <th scope="col" className={TH_CLASS}>
                Started
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Watermark
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Matched
              </th>
              <th scope="col" className={TH_CLASS}>
                Breaks
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Net
              </th>
              <th scope="col" className={TH_CLASS}>
                Content hash
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {runs.map((run) => {
              const isCurrent = run.runId === current.runId;
              return (
                <tr
                  key={run.runId}
                  className={isCurrent ? "bg-surface-raised" : undefined}
                  aria-current={isCurrent ? "true" : undefined}
                >
                  <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                    <Link
                      href={breakHref(filter, { runId: run.runId, selected: null })}
                      className={`font-medium underline underline-offset-4 hover:text-muted ${FOCUS_RING}`}
                    >
                      #{run.runNo}
                    </Link>
                    <span className="mt-0.5 block text-xs text-muted">
                      {run.runBy}
                    </span>
                  </th>
                  <td className={TD_CLASS}>{formatTimestamp(run.startedAt)}</td>
                  <td className={`${TD_CLASS} text-right tabular-nums`}>
                    {run.bookingWatermark}
                  </td>
                  <td className={`${TD_CLASS} text-right tabular-nums`}>
                    {run.matchedCount} / {run.fileRowCount}
                  </td>
                  <td className={TD_CLASS}>
                    <span className="tabular-nums">{run.breakCount}</span>
                    <span className="mt-0.5 block text-xs text-muted">
                      {run.inFileNotLedger} file · {run.inLedgerNotFile} ledger ·{" "}
                      {run.amountMismatch} amount
                    </span>
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={run.breakTotalCents} tone="direction" signed />
                  </td>
                  <td className={TD_CLASS}>
                    <span
                      className="font-mono text-[10px] text-muted"
                      title={run.contentHash}
                    >
                      {run.contentHash.slice(0, 12)}…
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  );
}
