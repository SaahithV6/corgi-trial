import { formatAge } from "@/lib/recon/aging";

import Link from "next/link";

import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
  type BadgeTone,
} from "@/components/ui/primitives";
import { formatDate } from "@/lib/format/datetime";
import {
  BREAK_KIND_LABELS,
  REASON_CODE_LABELS,
  SEVERITY_LABELS,
  type Severity,
} from "@/lib/recon/types";

import type { BreakRow } from "./data-contract";
import { breakHref, type BreakFilter } from "./view-state";

/**
 * The breaks table.
 *
 * Column order is the order an operator reads: what kind, which reference, how
 * much, how old, how bad. The two money columns are side by side and always
 * both rendered, because the SHAPE of a break is half its meaning — a blank in
 * the file column IS the in-ledger-not-file case, and rendering it as an em
 * dash rather than as `$0.00` is the difference between "not on the file" and
 * "on the file as nothing".
 *
 * Every row links to itself. The drill-through is a query parameter rather
 * than a modal, so it is deep-linkable and survives a reload.
 */

const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  explained: "quiet",
  open: "neutral",
  aged: "neutral",
  stale: "negative",
  critical: "negative",
};

export function BreaksTable({
  rows,
  filter,
  total,
}: {
  readonly rows: readonly BreakRow[];
  readonly filter: BreakFilter;
  /** Rows before filtering, so an empty table can say which emptiness it is. */
  readonly total: number;
}) {
  if (rows.length === 0) {
    return <EmptyState filtered={total > 0} filter={filter} />;
  }

  return (
    <TableScroll>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Reconciliation breaks, worst first, then oldest, then largest
        </caption>
        <thead className="border-b border-border">
          <tr>
            <th scope="col" className={TH_CLASS}>
              Break
            </th>
            <th scope="col" className={TH_CLASS}>
              Reference
            </th>
            <th scope="col" className={`${TH_CLASS} text-right`}>
              File
            </th>
            <th scope="col" className={`${TH_CLASS} text-right`}>
              Ledger
            </th>
            <th scope="col" className={`${TH_CLASS} text-right`}>
              Difference
            </th>
            <th scope="col" className={TH_CLASS}>
              Age
            </th>
            <th scope="col" className={TH_CLASS}>
              Severity
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => {
            const selected = filter.selected === row.id;
            return (
              <tr
                key={row.id}
                className={selected ? "bg-surface-raised" : undefined}
                aria-current={selected ? "true" : undefined}
              >
                <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                  <Link
                    href={breakHref(filter, { selected: selected ? null : row.id })}
                    className={`font-medium underline underline-offset-4 hover:text-muted ${FOCUS_RING}`}
                  >
                    {BREAK_KIND_LABELS[row.kind]}
                  </Link>
                  <span className="mt-0.5 block text-xs text-muted">
                    {REASON_CODE_LABELS[row.reasonCode]}
                  </span>
                </th>

                <td className={TD_CLASS}>
                  <span className="font-mono text-xs">{row.externalRef}</span>
                  <span className="mt-0.5 block text-xs text-muted">
                    {formatDate(row.valueDate)} · {row.rail}
                  </span>
                </td>

                <td className={`${TD_CLASS} text-right`}>
                  <Absent value={row.fileAmountCents} title="not on the file" />
                </td>

                <td className={`${TD_CLASS} text-right`}>
                  <Absent value={row.ledgerAmountCents} title="not on the book" />
                  {row.ledgerNetCents !== null &&
                  row.ledgerAmountCents !== null &&
                  row.ledgerNetCents !== row.ledgerAmountCents ? (
                    <span className="mt-0.5 block text-[11px] text-muted">
                      now <Money cents={row.ledgerNetCents} />
                    </span>
                  ) : null}
                </td>

                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={row.breakAmountCents} tone="direction" signed />
                </td>

                <td className={TD_CLASS}>
                  <span className="tabular-nums">
                    {formatAge(row.ageDays, "d")}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">
                    {row.closesCrossed === 0
                      ? "day still open"
                      : `${row.closesCrossed} close${row.closesCrossed === 1 ? "" : "s"}`}
                  </span>
                </td>

                <td className={TD_CLASS}>
                  <Badge tone={SEVERITY_TONE[row.severity]} title={row.severityReason}>
                    {SEVERITY_LABELS[row.severity]}
                  </Badge>
                  {row.explainedBy === null ? null : (
                    <span className="mt-1 block text-[11px] text-muted">
                      {row.explainedBy === "reversal_and_rebook"
                        ? "reversed + re-booked"
                        : "adjudicated"}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}

/**
 * A money column that may legitimately have nothing in it.
 *
 * `null` is not zero. An em dash with a title, never `$0.00`.
 */
function Absent({
  value,
  title,
}: {
  readonly value: number | null;
  readonly title: string;
}) {
  if (value === null) {
    return (
      <span className="text-muted" title={title}>
        <span aria-hidden="true">&mdash;</span>
        <span className="sr-only">{title}</span>
      </span>
    );
  }
  return <Money cents={value} tone="neutral" />;
}

/**
 * Two different emptinesses, said differently.
 *
 * "This file reconciled clean" is the good news an ops team wants at 22:05.
 * "Your filter matched nothing" is a dead end with a way out. Rendering the
 * same grey box for both would turn the first into a suspicion that the screen
 * is broken.
 */
function EmptyState({
  filtered,
  filter,
}: {
  readonly filtered: boolean;
  readonly filter: BreakFilter;
}) {
  if (filtered) {
    return (
      <div className="px-5 py-12 text-center">
        <p className="text-sm font-medium">No breaks match these filters.</p>
        <p className="mx-auto mt-1 max-w-prose text-xs text-muted">
          There are breaks on this run; none of them are in this category and
          age band.
        </p>
        <Link
          href={breakHref(filter, { kind: null, age: null, selected: null })}
          className={`mt-4 inline-flex rounded border border-border-strong px-3 py-1.5 text-xs hover:bg-surface-raised ${FOCUS_RING}`}
        >
          Clear filters
        </Link>
      </div>
    );
  }

  return (
    <div className="px-5 py-12 text-center">
      <p className="text-sm font-medium">This file reconciled clean.</p>
      <p className="mx-auto mt-1 max-w-prose text-xs leading-relaxed text-muted">
        Every row in the provider&rsquo;s file matched a journal entry on the
        provider&rsquo;s own reference, and every amount agreed to the cent.
        Nothing to work.
      </p>
    </div>
  );
}
