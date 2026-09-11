import Link from "next/link";

import { Money } from "@/components/ui/Money";
import { Badge, FOCUS_RING, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";
import { formatDate } from "@/lib/format/datetime";

import type { MonthRow } from "./data-contract";
import { accrualHref, type AccrualFilter } from "./view-state";

/**
 * The month roll-up: price against accrued, and the pennies placed so far.
 *
 * This is where the single claim the rounding rule makes becomes checkable.
 * On a COMPLETE month, `accrued` must equal `price` exactly — not within a
 * penny — and the row says so in as many words. On an incomplete one it shows
 * how many of the month's residual pennies have landed, which is the number
 * that explains why the daily figure changes partway through.
 *
 * `v_accrual_month_drift` is the same comparison asked as a query, and it must
 * return zero rows. The tile row above carries its count.
 */
export function MonthTable({
  rows,
  filter,
}: {
  readonly rows: readonly MonthRow[];
  readonly filter: AccrualFilter;
}) {
  if (rows.length === 0) {
    return <p className="px-5 py-8 text-sm text-muted">No month has accrued anything yet.</p>;
  }

  return (
    <TableScroll>
      <table className="w-full min-w-[54rem] border-collapse">
        <caption className="sr-only">
          One row per schedule per month: the price, what has accrued, and how
          many residual pennies have been placed.
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={TH_CLASS}>Month</th>
            <th scope="col" className={TH_CLASS}>Account · plan</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>Price</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>Days</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>Accrued</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>Remaining</th>
            <th scope="col" className={TH_CLASS}>Residual pennies</th>
            <th scope="col" className={TH_CLASS}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const exact = row.accruedCents === row.monthlyCents;
            return (
              <tr key={`${row.scheduleId}:${row.monthStart}`} className="border-b border-border last:border-0">
                <td className={TD_CLASS}>{formatDate(row.monthStart).slice(0, 8)}</td>
                <td className={TD_CLASS}>
                  <Link
                    href={accrualHref(filter, { scheduleId: row.scheduleId, accrualDayId: null })}
                    className={`underline underline-offset-4 ${FOCUS_RING}`}
                  >
                    {row.businessName ?? "—"}
                  </Link>
                  <span className="block text-[11px] text-muted">{row.planName}</span>
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={row.monthlyCents} tone="neutral" />
                </td>
                <td className={`${TD_CLASS} money text-right`}>
                  {row.daysDecided}/{row.daysInMonth}
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={row.accruedCents} tone="neutral" />
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={row.remainingCents} tone="neutral" />
                </td>
                <td className={TD_CLASS}>
                  <span className="money">
                    {row.residualPenniesApplied} of {row.residualPenniesInMonth}
                  </span>
                  <span className="block text-[11px] text-muted">
                    {row.residualPenniesInMonth === 0
                      ? "the price divides the month evenly"
                      : `one each to days 1–${row.residualPenniesInMonth}`}
                  </span>
                </td>
                <td className={TD_CLASS}>
                  {row.monthComplete ? (
                    exact ? (
                      <Badge tone="positive" title="Every day decided and the total equals the price exactly">
                        CLOSED · EXACT
                      </Badge>
                    ) : (
                      <Badge tone="negative" title="A complete month that does not sum to the price">
                        DRIFT
                      </Badge>
                    )
                  ) : (
                    <span className="text-[11px] text-muted">
                      in progress · {row.daysPosted} posted
                      {row.daysSkipped > 0 ? `, ${row.daysSkipped} zero-cent` : ""}
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
