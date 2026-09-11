import Link from "next/link";

import { Money } from "@/components/ui/Money";
import { Badge, FOCUS_RING, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";
import { formatDate } from "@/lib/format/datetime";

import type { DayRow } from "./data-contract";
import { accrualHref, type AccrualFilter } from "./view-state";

/**
 * Per-account daily accrual, with the fraction on every row.
 *
 * The columns are deliberately the OPERANDS and not just the answer: the price,
 * the divisor, the day, the base share, the residual, the amount, the
 * month-to-date. A reader can add the column up and get the price. That is the
 * whole point — a screen that showed only "84¢" would be asking to be trusted,
 * and this one is asking to be checked.
 *
 * The RESIDUAL column is the reason two adjacent days differ by a cent, and it
 * is a badge rather than a number because "did this day carry one" is a yes/no
 * and rendering it as `1` next to a column of `0`s invites someone to add the
 * wrong column.
 */
export function DayTable({
  rows,
  filter,
  scheduleCount,
}: {
  readonly rows: readonly DayRow[];
  readonly filter: AccrualFilter;
  readonly scheduleCount: number;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-5 py-8 text-sm text-muted">
        {scheduleCount === 0
          ? "Nobody is enrolled in a daily-accrued charge, so there is nothing to accrue. Not an error — an empty book."
          : filter.scheduleId === null
            ? "No day has been accrued yet. The tick claims a date the first time it runs on or after it; until then this is empty and the gap counter above says how many days are owed."
            : "This schedule has accrued nothing yet."}
      </p>
    );
  }

  return (
    <TableScroll>
      <table className="w-full min-w-[62rem] border-collapse">
        <caption className="sr-only">
          One row per accrual date per schedule, newest first, with the full
          division that produced each amount.
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={TH_CLASS}>
              Date
            </th>
            <th scope="col" className={TH_CLASS}>
              Account · plan
            </th>
            <th scope="col" className={`${TH_CLASS} text-right`}>
              Basis / month
            </th>
            <th scope="col" className={`${TH_CLASS} text-right`}>
              ÷ days
            </th>
            <th scope="col" className={`${TH_CLASS} text-right`}>
              Base share
            </th>
            <th scope="col" className={TH_CLASS}>
              Residual
            </th>
            <th scope="col" className={`${TH_CLASS} text-right`}>
              Accrued
            </th>
            <th scope="col" className={`${TH_CLASS} text-right`}>
              Month to date
            </th>
            <th scope="col" className={TH_CLASS}>
              Entry
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const a = row.arithmetic;
            const selected = row.accrualDayId === filter.accrualDayId;
            return (
              <tr
                key={row.accrualDayId}
                className={`border-b border-border last:border-0 ${
                  selected ? "bg-surface-raised" : ""
                }`}
              >
                <td className={TD_CLASS}>
                  <Link
                    href={accrualHref(filter, { accrualDayId: row.accrualDayId })}
                    aria-current={selected ? "true" : undefined}
                    className={`underline underline-offset-4 ${FOCUS_RING}`}
                  >
                    {formatDate(row.accrualDate)}
                  </Link>
                </td>
                <td className={TD_CLASS}>
                  <span className="block">{row.businessName ?? "—"}</span>
                  <span className="block text-[11px] text-muted">{row.planName}</span>
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  {a === null ? "—" : <Money cents={a.monthlyCents} tone="neutral" />}
                </td>
                <td className={`${TD_CLASS} money text-right`}>{a?.daysInMonth ?? "—"}</td>
                <td className={`${TD_CLASS} money text-right`}>
                  {a === null ? "—" : `${a.baseShareCents}¢`}
                </td>
                <td className={TD_CLASS}>
                  {a === null ? (
                    "—"
                  ) : a.residualApplied ? (
                    <Badge
                      tone="neutral"
                      title={`day ${a.dayOfMonth} ≤ ${a.residualPennies}, so it carries one of the ${a.residualPennies} leftover pennies`}
                    >
                      + 1¢
                    </Badge>
                  ) : (
                    <span className="text-[11px] text-muted">—</span>
                  )}
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  {a === null ? (
                    "—"
                  ) : row.disposition === "skipped" ? (
                    <span className="text-[11px] text-muted">zero — skipped</span>
                  ) : (
                    <Money cents={a.amountCents} tone="neutral" />
                  )}
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  {a === null ? "—" : <Money cents={a.cumulativeCents} tone="neutral" />}
                </td>
                <td className={TD_CLASS}>
                  {row.entryId === null ? (
                    <span className="text-[11px] text-muted">
                      {row.disposition === "skipped" ? "none — nothing to post" : "not decided"}
                    </span>
                  ) : (
                    <span className="font-mono text-[11px]" title={row.entryId}>
                      {row.entryId.slice(0, 8)}
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
