import Link from "next/link";

import { Money } from "@/components/ui/Money";
import { Badge, FOCUS_RING, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";
import { formatDate } from "@/lib/format/datetime";

import type { InterestScheduleRow } from "./data-contract";
import { accrualHref, type AccrualFilter } from "./view-state";

/**
 * Who earns or is charged interest, on which card, and which side they are on
 * TODAY.
 *
 * There is no product column because there is no product choice. An account is
 * enrolled in interest; the sign of its balance on a given business date
 * decides whether that date lands on `4400` or on `5400`. The "side today"
 * column is derived from the live balance on every render, so the day an
 * account crosses zero it flips here first and on the day table the morning
 * after — which is what makes the crossing a single account's single timeline
 * rather than two products handing off.
 *
 * The balance shown is `ledger_settled_cents()` at the book date and the live
 * watermark, computed on every read. It is not stored anywhere and nothing
 * downstream reads it.
 */
export function InterestEnrolmentTable({
  rows,
  filter,
}: {
  readonly rows: readonly InterestScheduleRow[];
  readonly filter: AccrualFilter;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-5 py-8 text-sm text-muted">
        No account is enrolled for interest. Nothing to show, nothing wrong — an
        account with no enrolment accrues nothing and appears nowhere on this
        screen.
      </p>
    );
  }

  return (
    <TableScroll>
      <table className="w-full min-w-[56rem] border-collapse">
        <caption className="sr-only">
          One row per enrolled account: the rate card, the window, the balance
          today and which side of the book that balance puts it on.
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={TH_CLASS}>Account</th>
            <th scope="col" className={TH_CLASS}>Rate card</th>
            <th scope="col" className={TH_CLASS}>Enrolled</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>Balance today</th>
            <th scope="col" className={TH_CLASS}>Side today</th>
            <th scope="col" className={TH_CLASS}>Next owed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const selected = row.id === filter.scheduleId;
            const side =
              row.currentBalanceCents > 0
                ? "credit"
                : row.currentBalanceCents < 0
                  ? "overdraft"
                  : "flat";
            return (
              <tr
                key={row.id}
                className={`border-b border-border last:border-0 ${selected ? "bg-surface-raised" : ""}`}
              >
                <td className={TD_CLASS}>
                  <Link
                    href={accrualHref(filter, {
                      scheduleId: selected ? null : row.id,
                      interestDayId: null,
                    })}
                    aria-current={selected ? "true" : undefined}
                    className={`underline underline-offset-4 ${FOCUS_RING}`}
                  >
                    {row.businessName ?? row.accountName}
                  </Link>
                  <span className="block font-mono text-[11px] text-muted">{row.scheduleKey}</span>
                </td>
                <td className={TD_CLASS}>{row.rateTier}</td>
                <td className={TD_CLASS}>
                  {formatDate(row.startDate)}
                  {row.endDate === null ? " — open" : ` — ${formatDate(row.endDate)}`}
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={row.currentBalanceCents} tone="auto" />
                </td>
                <td className={TD_CLASS}>
                  {side === "credit" ? (
                    <Badge tone="positive" title="In credit, so we pay: 5400 debit, deposit credit">
                      WE PAY · 5400
                    </Badge>
                  ) : side === "overdraft" ? (
                    <Badge tone="negative" title="Overdrawn, so we charge: deposit debit, 4400 credit">
                      WE CHARGE · 4400
                    </Badge>
                  ) : (
                    <Badge tone="quiet">FLAT · nothing to price</Badge>
                  )}
                </td>
                <td className={TD_CLASS}>
                  {row.nextDueDate === null ? (
                    <span className="text-[11px] text-muted">caught up</span>
                  ) : (
                    formatDate(row.nextDueDate)
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
