import Link from "next/link";

import { FOCUS_RING, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";

import type { QuoteView } from "./data-contract";
import { QuoteStateBadge, RateEvidenceBadge } from "./labels";
import { payoutHref, type DemoState } from "./view-state";

/**
 * The quote book.
 *
 * Ordered newest first and never filtered by state: an expired quote stays on
 * this screen exactly as long as an accepted one does, because it stays in the
 * database forever and hiding it would make the book a summary rather than a
 * record. The whole point of an append-only quote table is that you can see
 * the ones nobody took.
 *
 * Every figure is a string the server formatted. The one number this component
 * touches is a row count.
 */
export function QuoteTable({
  rows,
  state,
  selected,
}: {
  readonly rows: readonly QuoteView[];
  readonly state: DemoState;
  readonly selected: string | null;
}) {
  return (
    <TableScroll>
      <table className="w-full min-w-[52rem] border-collapse">
        <caption className="sr-only">
          Every quote raised, newest first, with the state derived from whether it was accepted and
          when.
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th className={TH_CLASS} scope="col">
              Quote
            </th>
            <th className={TH_CLASS} scope="col">
              Customer
            </th>
            <th className={TH_CLASS} scope="col">
              Beneficiary
            </th>
            <th className={`${TH_CLASS} text-right`} scope="col">
              In
            </th>
            <th className={`${TH_CLASS} text-right`} scope="col">
              Rate
            </th>
            <th className={`${TH_CLASS} text-right`} scope="col">
              Out
            </th>
            <th className={TH_CLASS} scope="col">
              State
            </th>
            <th className={TH_CLASS} scope="col">
              Raised
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.quoteRef}
              className={`border-t border-border ${
                row.quoteRef === selected ? "bg-surface-raised" : ""
              }`}
            >
              <td className={TD_CLASS}>
                <Link
                  href={payoutHref({ state, quoteRef: row.quoteRef })}
                  aria-current={row.quoteRef === selected ? "true" : undefined}
                  className={`money rounded underline decoration-border-strong underline-offset-2 hover:decoration-text ${FOCUS_RING}`}
                >
                  {row.quoteRef}
                </Link>
              </td>
              <td className={TD_CLASS}>{row.businessName}</td>
              <td className={TD_CLASS}>{row.beneficiaryRef}</td>
              <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
                <span className="money">{row.sellLabel}</span>
              </td>
              <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
                <span className="money">{row.customerRateLabel}</span>
                <div className="mt-1">
                  <RateEvidenceBadge evidence={row.rate.evidence} />
                </div>
              </td>
              <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
                <span className="money">{row.buyLabel}</span>
              </td>
              <td className={TD_CLASS}>
                <QuoteStateBadge state={row.state} />
              </td>
              <td className={`${TD_CLASS} whitespace-nowrap text-muted`}>
                {formatTimestamp(row.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
