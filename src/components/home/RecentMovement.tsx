import Link from "next/link";
import type { Route } from "next";

import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { formatDate, formatTimestamp } from "@/lib/format/datetime";

import { lineageNote, newestFirst } from "./console-derive";
import type { Movement } from "./console-contract";

/**
 * The last few things that moved.
 *
 * ============================================================================
 * Two clocks, side by side, on every row. `Booked` is when we learned it;
 * `Value` is when it happened. They are different facts and this ledger keeps
 * them apart (§5) — a settlement backdated to a closed day is booked today and
 * valued then, and a table that printed one date would be hiding the entire
 * bitemporal model behind a column heading.
 * ============================================================================
 *
 * Sorted by `booking_seq`, the total order of what we learned, so "recent"
 * means recently known rather than recently dated. A reversal and its re-book
 * sit adjacent and are labelled as what they are: nothing in this system is
 * ever edited, so a correction is always two more rows, and saying so on the
 * row is cheaper than the support ticket asking why the settlement appears
 * three times.
 *
 * `amountCents` arrives already signed from the customer's side — positive is
 * money in — so this file does no arithmetic at all.
 */
export function RecentMovement({
  movements,
  live,
}: {
  readonly movements: readonly Movement[];
  readonly live: boolean;
}) {
  const rows = newestFirst(movements);

  return (
    <Panel
      id="movement"
      title="Recent money movement"
      description="Journal lines that touched a customer's deposit account, newest first by booking order. Immutable rows: nothing here was ever updated."
      actions={
        <Badge tone={live ? "positive" : "quiet"}>
          {live ? "live query" : "fixture"}
        </Badge>
      }
    >
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-sm text-muted">
          No money has moved on this book yet. The journal is empty rather than
          unavailable — an empty fold is a zero, and this screen says which one
          it is looking at.
        </p>
      ) : (
        <TableScroll>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Recent journal lines against customer deposit accounts, with both
              the booking time and the value date for each
            </caption>
            <thead className="border-b border-border">
              <tr>
                <th scope="col" className={TH_CLASS}>
                  Entry
                </th>
                <th scope="col" className={TH_CLASS}>
                  Business
                </th>
                <th scope="col" className={TH_CLASS}>
                  Booked
                </th>
                <th scope="col" className={TH_CLASS}>
                  Value
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Amount
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((movement) => {
                const note = lineageNote(movement.entryType);
                return (
                  <tr key={`${movement.entryId}-${movement.bookingSeq}`}>
                    <th
                      scope="row"
                      className={`${TD_CLASS} max-w-prose text-left font-normal`}
                    >
                      <span className="block">{movement.description}</span>
                      <span className="mt-0.5 block text-[11px] text-muted">
                        {movement.rail === null ? "no rail" : movement.rail}
                        {movement.externalRef === null
                          ? null
                          : ` · ${movement.externalRef}`}
                        {" · seq "}
                        <span className="money">{movement.bookingSeq}</span>
                      </span>
                      {note === null ? null : (
                        <span className="mt-0.5 block text-[11px] text-muted">
                          {note}
                        </span>
                      )}
                    </th>
                    <td className={TD_CLASS}>
                      <Link
                        href={`/accounts/${movement.accountId}` as Route}
                        className={`underline underline-offset-4 hover:text-muted ${FOCUS_RING}`}
                      >
                        {movement.businessName}
                      </Link>
                    </td>
                    <td className={`${TD_CLASS} whitespace-nowrap text-xs text-muted`}>
                      {formatTimestamp(movement.bookingTime)}
                    </td>
                    <td className={`${TD_CLASS} whitespace-nowrap text-xs text-muted`}>
                      {formatDate(movement.valueDate)}
                    </td>
                    <td className={`${TD_CLASS} text-right`}>
                      <Money cents={movement.amountCents} tone="direction" signed />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Panel>
  );
}
