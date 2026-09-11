import Link from "next/link";

import {
  FOCUS_RING,
  TableScroll,
  TD_CLASS,
  TH_CLASS,
} from "@/components/ui/primitives";
import { formatDate, formatTimestamp } from "@/lib/format/datetime";

import type { PayeeRow } from "./data-contract";
import {
  DirectoryBadge,
  FreshnessBadge,
  NameMatchBadge,
  OutcomeBadge,
} from "./labels";
import { payeeHref, type PayeeFilter } from "./view-state";

/**
 * The book.
 *
 * The routing number is shown IN FULL and in a monospace face. Both are
 * deliberate. Routing numbers are published — they are printed on every cheque
 * and listed by the Federal Reserve — so masking one protects nothing and
 * costs the reader the only thing that makes a transposition legible. The
 * account number is the secret, and only its last four digits exist anywhere
 * in this system.
 *
 * The columns are ordered by what a person actually checks: who, where, and
 * then how long ago anybody last looked.
 */
export function PayeeTable({
  rows,
  filter,
}: {
  readonly rows: readonly PayeeRow[];
  readonly filter: PayeeFilter;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-5 py-8 text-center text-sm text-muted">
        No payees. Nothing has been keyed and nothing is wrong.
      </p>
    );
  }

  return (
    <TableScroll>
      <table className="w-full border-collapse">
        <caption className="px-5 pb-3 text-left text-xs text-muted">
          {rows.length} payee{rows.length === 1 ? "" : "s"}, newest added first — ordered by
          when the payee was keyed, not by when it was last checked. Archived payees are
          listed with the rest and marked; nothing is hidden from this table and there is no
          second page.
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={TH_CLASS}>Payee</th>
            <th scope="col" className={TH_CLASS}>Destination</th>
            <th scope="col" className={TH_CLASS}>Institution</th>
            <th scope="col" className={TH_CLASS}>Name check</th>
            <th scope="col" className={TH_CLASS}>Standing</th>
            <th scope="col" className={TH_CLASS}>Last checked</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => {
            const selected = row.payeeId === filter.payeeId;
            return (
              <tr
                key={row.payeeId}
                className={selected ? "bg-surface-raised" : undefined}
                aria-current={selected ? "true" : undefined}
              >
                <td className={TD_CLASS}>
                  <Link
                    href={payeeHref({ state: filter.state, payeeId: row.payeeId })}
                    className={`font-medium underline underline-offset-4 ${FOCUS_RING}`}
                  >
                    {row.displayName}
                  </Link>
                  <div className="mt-0.5 text-xs text-muted">{row.holderName}</div>
                  {row.archived ? (
                    <div className="mt-1 text-[11px] text-muted">
                      archived · {row.archivalReason}
                    </div>
                  ) : null}
                </td>

                <td className={TD_CLASS}>
                  <span className="font-mono text-xs">
                    {row.routingNumber ?? "—"}
                    {row.accountNumberLast4 === null ? "" : ` ••${row.accountNumberLast4}`}
                  </span>
                  <div className="mt-0.5 text-[11px] uppercase tracking-[0.08em] text-muted">
                    {row.rail}
                    {row.accountType === null ? "" : ` · ${row.accountType}`}
                  </div>
                </td>

                <td className={TD_CLASS}>
                  <DirectoryBadge
                    directory={row.directory}
                    institutionName={row.institutionName}
                    provider={row.directoryProvider}
                  />
                </td>

                <td className={TD_CLASS}>
                  <NameMatchBadge
                    match={row.nameMatch}
                    source={row.nameSource}
                    score={row.nameMatchScore}
                  />
                </td>

                <td className={TD_CLASS}>
                  <OutcomeBadge outcome={row.outcome} acknowledged={row.acknowledged} />
                  {row.outcome === "warned" ? (
                    <div className="mt-1 text-[11px] text-muted">
                      {row.acknowledged
                        ? `signed by ${row.acknowledgedByName ?? "an actor no longer on file"}${
                            row.acknowledgedAt === null
                              ? ""
                              : ` · ${formatTimestamp(row.acknowledgedAt)}`
                          }`
                        : "nobody has signed for it"}
                    </div>
                  ) : null}
                </td>

                <td className={TD_CLASS}>
                  <FreshnessBadge freshness={row.freshness} days={row.checkedDaysAgo} />
                  <div className="mt-1 text-[11px] text-muted">
                    {row.checkedAt === null ? "—" : formatDate(row.checkedAt)}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}
