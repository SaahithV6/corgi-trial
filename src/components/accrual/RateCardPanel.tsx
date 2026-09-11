import { Badge, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";
import { formatDate } from "@/lib/format/datetime";

import type { RateCardRow } from "./data-contract";

/**
 * The rate card, every version of it, with the window each was in force for.
 *
 * This table is the answer to "a rate that changes must not retroactively
 * re-price yesterday", made visible rather than asserted. Two rows for one
 * tier mean the price of money changed on a date, and `interest_rate_at(tier,
 * accrual_date)` resolves on the ACCRUAL date — so every day below is priced
 * by the row whose window contains it, and a replay of an old date re-derives
 * the old row by construction.
 *
 * The forward-only trigger is named on the panel because an operator reading
 * this wants to know whether they COULD backdate one, and the answer is no:
 * `interest_rate_policy_forward_only` refuses a row whose effective date is
 * not after every existing row for its tier AND after every date already
 * accrued under it.
 */
export function RateCardPanel({
  rows,
  bookDate,
}: {
  readonly rows: readonly RateCardRow[];
  readonly bookDate: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-5 py-8 text-sm text-muted">
        No rate card is configured, so no interest can be priced. Not an error —
        an unconfigured product. An enrolment on a tier with no version is
        refused at INSERT by <code>assert_interest_schedule()</code> rather than
        failing one day at a time.
      </p>
    );
  }

  return (
    <TableScroll>
      <table className="w-full min-w-[56rem] border-collapse">
        <caption className="sr-only">
          Every version of every interest rate card, with its effective window,
          both rates, the day-count convention, and how many days it priced.
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={TH_CLASS}>Card</th>
            <th scope="col" className={TH_CLASS}>In force</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>We pay (credit)</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>We charge (overdraft)</th>
            <th scope="col" className={TH_CLASS}>Day count</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>Days priced</th>
            <th scope="col" className={TH_CLASS}>Why this version exists</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const current = row.supersededOn === null;
            const live = current && row.effectiveFrom <= bookDate;
            return (
              <tr key={row.id} className="border-b border-border last:border-0">
                <td className={TD_CLASS}>
                  <span className="block">{row.tier}</span>
                  {live ? (
                    <Badge tone="neutral">CURRENT</Badge>
                  ) : (
                    <span className="text-[11px] text-muted">superseded</span>
                  )}
                </td>
                <td className={TD_CLASS}>
                  {formatDate(row.effectiveFrom)}
                  {row.supersededOn === null
                    ? " — open"
                    : ` — ${formatDate(row.supersededOn)} (exclusive)`}
                </td>
                <td className={`${TD_CLASS} money text-right`}>
                  {percent(row.creditRateBps)}
                  <span className="block text-[11px] text-muted">{row.creditRateBps} bps</span>
                </td>
                <td className={`${TD_CLASS} money text-right`}>
                  {percent(row.overdraftRateBps)}
                  <span className="block text-[11px] text-muted">{row.overdraftRateBps} bps</span>
                </td>
                <td className={TD_CLASS}>
                  ACT/{row.dayCountDenominator}
                  <span className="block text-[11px] text-muted">
                    {row.dayCountDenominator === 365 ? "fixed, per Reg DD" : "money-market"}
                  </span>
                </td>
                <td className={`${TD_CLASS} money text-right`}>{row.daysPriced}</td>
                <td className={`${TD_CLASS} max-w-md text-[11px] leading-relaxed text-muted`}>
                  {row.note}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}

/** `150` → `1.50%`. Integer arithmetic; basis points are per ten-thousand. */
function percent(bps: number): string {
  return `${Math.trunc(bps / 100)}.${String(Math.abs(bps % 100)).padStart(2, "0")}%`;
}
