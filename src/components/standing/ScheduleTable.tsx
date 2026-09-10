import Link from "next/link";

import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { formatDate } from "@/lib/format/datetime";

import type { ScheduleRow } from "./data-contract";
import { standingHref, type StandingFilter } from "./view-state";

/**
 * The mandates.
 *
 * Column order is the order somebody reads a direct-debit list: what is it,
 * how much, how often, where does it go, when is it next. "Next" is the column
 * people actually come here for, so it is last and it is the only one carrying
 * a badge.
 *
 * NEXT IS NOT COMPUTED HERE. It comes from `v_standing_order_next`, which asks
 * `standing_order_due_dates()` — the one definition of when a mandate is due,
 * in SQL, also used by the firing routine and by the trigger that validates an
 * occurrence insert. There is no month-end clamping in TypeScript for this
 * column to get wrong, which is why a mandate for the 31st can be shown as due
 * on 30 April without anyone having to check whether the screen agrees with the
 * scheduler.
 *
 * Every row links to its own occurrences. That filter is a query parameter
 * rather than client state, so it is deep-linkable and survives a reload.
 */
export function ScheduleTable({
  rows,
  filter,
}: {
  readonly rows: readonly ScheduleRow[];
  readonly filter: StandingFilter;
}) {
  if (rows.length === 0) {
    return (
      <div className="px-5 py-10 text-center">
        <p className="mx-auto max-w-prose text-xs leading-relaxed text-muted">
          No standing order has been set up. There is nothing to show and
          nothing has gone wrong — an empty schedule is an honest blank, not an
          error. A mandate is created with a key derived from the thing that
          authorised it (a signed form, a lease id), so creating one twice is a
          no-op the database decides.
        </p>
      </div>
    );
  }

  return (
    <TableScroll>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Standing orders, live first, then by creation date
        </caption>
        <thead className="border-b border-border">
          <tr>
            <th scope="col" className={TH_CLASS}>
              Reference
            </th>
            <th scope="col" className={`${TH_CLASS} text-right`}>
              Amount
            </th>
            <th scope="col" className={TH_CLASS}>
              Cadence
            </th>
            <th scope="col" className={TH_CLASS}>
              Payee
            </th>
            <th scope="col" className={TH_CLASS}>
              Next occurrence
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const selected = filter.standingOrderId === row.id;
            return (
              <tr
                key={row.id}
                className={`border-t border-border ${selected ? "bg-surface-raised" : ""}`}
              >
                <td className={TD_CLASS}>
                  <Link
                    href={standingHref(filter, {
                      standingOrderId: selected ? null : row.id,
                      occurrenceId: null,
                    })}
                    aria-current={selected ? "true" : undefined}
                    className={`font-medium underline-offset-4 hover:underline ${FOCUS_RING}`}
                  >
                    {row.reference}
                  </Link>
                  <p className="mt-0.5 text-[11px] text-muted">
                    {row.rail.toUpperCase()} · set up by {row.createdByName} ·{" "}
                    <span className="font-mono">{row.mandateKey}</span>
                  </p>
                </td>

                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={row.amountCents} tone="neutral" />
                </td>

                <td className={TD_CLASS}>
                  {row.cadenceLabel}
                  <p className="mt-0.5 text-[11px] text-muted">
                    from {formatDate(row.startDate)}
                    {row.endDate === null ? ", no end date" : ` to ${formatDate(row.endDate)}`}
                  </p>
                </td>

                <td className={`${TD_CLASS} max-w-[22rem]`}>
                  <span className="text-xs">{row.destination}</span>
                </td>

                <td className={TD_CLASS}>
                  {row.cancelled ? (
                    <>
                      <Badge tone="quiet">CANCELLED</Badge>
                      <p className="mt-1 max-w-[18rem] text-[11px] leading-relaxed text-muted">
                        {row.cancellationReason}
                      </p>
                    </>
                  ) : row.nextDueDate === null ? (
                    <>
                      <Badge tone="quiet">NO DATES LEFT</Badge>
                      <p className="mt-1 text-[11px] text-muted">
                        the schedule has run past its end date
                      </p>
                    </>
                  ) : (
                    <>
                      <Badge tone="neutral">{formatDate(row.nextDueDate)}</Badge>
                      <p className="mt-1 text-[11px] text-muted">
                        unclaimed; the calendar decides, not a stored cursor
                      </p>
                    </>
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
