import Link from "next/link";

import { Money } from "@/components/ui/Money";
import { FOCUS_RING, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";
import { formatDate } from "@/lib/format/datetime";

import type { ScheduleRow } from "./data-contract";
import { accrualHref, type AccrualFilter } from "./view-state";

/**
 * Who is enrolled, at what price, and what the rule makes of it.
 *
 * The last column is the whole rounding rule stated per plan, before a single
 * day is looked at: `$25.00 ÷ 30 = 83¢, 10¢ over → days 1–10 pay 84¢`. Somebody
 * reading this row can predict every figure in the table below it, which is the
 * strongest form of "reproducible by hand" there is.
 *
 * Note the three plans are deliberately priced so the three cases are visible
 * at once: on the 10th of a 30-day month, Business Standard and Business Plus
 * carry a residual penny and Starter does not.
 */
export function ScheduleTable({
  rows,
  filter,
}: {
  readonly rows: readonly ScheduleRow[];
  readonly filter: AccrualFilter;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-5 py-8 text-sm text-muted">
        Nobody is enrolled in a daily-accrued charge. Nothing to show, nothing
        wrong — an account with no plan accrues nothing and appears nowhere on
        this screen.
      </p>
    );
  }

  return (
    <TableScroll>
      <table className="w-full min-w-[52rem] border-collapse">
        <caption className="sr-only">
          One row per enrolled account: the plan, the monthly price, the window,
          and the allocation the price produces.
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={TH_CLASS}>Account</th>
            <th scope="col" className={TH_CLASS}>Plan</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>Price / month</th>
            <th scope="col" className={TH_CLASS}>Effective</th>
            <th scope="col" className={TH_CLASS}>Next owed</th>
            <th scope="col" className={TH_CLASS}>Allocation in a 30-day month</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const base = Math.floor(row.monthlyCents / 30);
            const residual = row.monthlyCents - base * 30;
            const selected = row.id === filter.scheduleId;
            return (
              <tr
                key={row.id}
                className={`border-b border-border last:border-0 ${selected ? "bg-surface-raised" : ""}`}
              >
                <td className={TD_CLASS}>
                  <Link
                    href={accrualHref(filter, {
                      scheduleId: selected ? null : row.id,
                      accrualDayId: null,
                    })}
                    aria-current={selected ? "true" : undefined}
                    className={`underline underline-offset-4 ${FOCUS_RING}`}
                  >
                    {row.businessName ?? row.accountName}
                  </Link>
                  <span className="block font-mono text-[11px] text-muted">{row.scheduleKey}</span>
                </td>
                <td className={TD_CLASS}>{row.planName}</td>
                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={row.monthlyCents} tone="neutral" />
                </td>
                <td className={TD_CLASS}>
                  {formatDate(row.startDate)}
                  {row.endDate === null ? " — open" : ` — ${formatDate(row.endDate)}`}
                </td>
                <td className={TD_CLASS}>
                  {row.nextDueDate === null ? (
                    <span className="text-[11px] text-muted">caught up</span>
                  ) : (
                    formatDate(row.nextDueDate)
                  )}
                </td>
                <td className={`${TD_CLASS} text-[11px] leading-relaxed text-muted`}>
                  <span className="money">{row.monthlyCents}¢ ÷ 30 = {base}¢</span>
                  {residual === 0
                    ? ", nothing over — every day the same"
                    : `, ${residual}¢ over → days 1–${residual} pay ${base + 1}¢, the rest ${base}¢`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}
