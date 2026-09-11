import Link from "next/link";

import { Money } from "@/components/ui/Money";
import { Badge, FOCUS_RING, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";
import { formatDate } from "@/lib/format/datetime";

import type { InterestDayRow } from "./data-contract";
import { accrualHref, type AccrualFilter } from "./view-state";

/**
 * Per-account daily interest, with the whole fraction on every row.
 *
 * The columns are deliberately the OPERANDS and not just the answer: the
 * balance it was priced on, the rate, the day count, the two integers of the
 * exact fraction, the whole cents, the sub-cent remainder that was dropped,
 * which way §12.2 rounded it, and the cents posted. A reader with a calculator
 * can reproduce every row from the row itself — which is the entire
 * requirement, and the reason the fraction is shown as `N ÷ D` rather than as
 * a decimal that would have to be a float to print.
 *
 * THE ROUNDING COLUMN IS THE ONE TO READ. `tie_to_even` is the only value of
 * it that half-up would have got different, so it is the label worth being
 * able to pick out; `up` and `down` are the ordinary cases and are shown with
 * the comparison (`2r` against `D`) that decided them.
 */
export function InterestDayTable({
  rows,
  filter,
  scheduleCount,
}: {
  readonly rows: readonly InterestDayRow[];
  readonly filter: AccrualFilter;
  readonly scheduleCount: number;
}) {
  if (rows.length === 0) {
    return (
      <p className="px-5 py-8 text-sm text-muted">
        {scheduleCount === 0
          ? "No account is enrolled for interest, so nothing is priced. Not an error — an empty book."
          : "No day has been priced yet. The tick claims a date the first time it runs on or after it; until then this is empty and the gap counter above says how many days are owed."}
      </p>
    );
  }

  return (
    <TableScroll>
      <table className="w-full min-w-[74rem] border-collapse">
        <caption className="sr-only">
          One row per interest date per enrolment, newest first, with the
          balance, the rate, the exact fraction and the rounding that produced
          each amount.
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={TH_CLASS}>Date</th>
            <th scope="col" className={TH_CLASS}>Account</th>
            <th scope="col" className={TH_CLASS}>Side</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>Balance priced</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>Rate</th>
            <th scope="col" className={TH_CLASS}>Exact fraction</th>
            <th scope="col" className={TH_CLASS}>Rounding</th>
            <th scope="col" className={`${TH_CLASS} text-right`}>Posted</th>
            <th scope="col" className={TH_CLASS}>Entry</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const a = row.arithmetic;
            const selected = row.interestDayId === filter.interestDayId;
            return (
              <tr
                key={row.interestDayId}
                className={`border-b border-border last:border-0 ${
                  selected ? "bg-surface-raised" : ""
                }`}
              >
                <td className={TD_CLASS}>
                  <Link
                    href={accrualHref(filter, { interestDayId: row.interestDayId })}
                    aria-current={selected ? "true" : undefined}
                    className={`underline underline-offset-4 ${FOCUS_RING}`}
                  >
                    {formatDate(row.accrualDate)}
                  </Link>
                </td>
                <td className={TD_CLASS}>
                  <span className="block">{row.businessName ?? "—"}</span>
                  <span className="block text-[11px] text-muted">
                    card {row.rateTier}
                    {row.policyEffectiveFrom === null
                      ? ""
                      : ` · effective ${formatDate(row.policyEffectiveFrom)}`}
                  </span>
                </td>
                <td className={TD_CLASS}>
                  {a === null ? "—" : <SideBadge side={a.side} />}
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  {a === null ? "—" : <Money cents={a.basisBalanceCents} tone="auto" />}
                </td>
                <td className={`${TD_CLASS} money text-right`}>
                  {a === null ? (
                    "—"
                  ) : (
                    <>
                      {a.rateBps} bps
                      <span className="block text-[11px] text-muted">/{a.dayCount}</span>
                    </>
                  )}
                </td>
                <td className={`${TD_CLASS} money text-[11px]`}>
                  {a === null ? (
                    "—"
                  ) : (
                    <>
                      {a.numerator} ÷ {a.denominator}
                      <span className="block text-muted">
                        = {a.wholeCents} r {a.remainderUnits}
                      </span>
                    </>
                  )}
                </td>
                <td className={TD_CLASS}>
                  {a === null ? "—" : <RoundingBadge a={a} />}
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  {a === null ? (
                    "—"
                  ) : row.disposition === "skipped" ? (
                    <span className="text-[11px] text-muted">zero — skipped</span>
                  ) : (
                    <Money cents={a.customerEffectCents} tone="direction" signed />
                  )}
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

function SideBadge({ side }: { readonly side: "credit" | "overdraft" | "flat" }) {
  if (side === "credit") {
    return (
      <Badge tone="positive" title="The customer was in credit, so we pay: 5400 debit, deposit credit">
        WE PAY · 5400
      </Badge>
    );
  }
  if (side === "overdraft") {
    return (
      <Badge tone="negative" title="The customer was overdrawn, so we charge: deposit debit, 4400 credit">
        WE CHARGE · 4400
      </Badge>
    );
  }
  return <Badge tone="quiet" title="A balance of exactly zero prices at nothing on either side">FLAT</Badge>;
}

function RoundingBadge({
  a,
}: {
  readonly a: {
    readonly rounding: "exact" | "down" | "up" | "tie_to_even";
    readonly remainderUnits: number;
    readonly denominator: number;
    readonly wholeCents: number;
  };
}) {
  const twice = a.remainderUnits * 2;
  switch (a.rounding) {
    case "exact":
      return <span className="text-[11px] text-muted">exact — it divided</span>;
    case "up":
      return (
        <Badge tone="neutral" title={`2 × ${a.remainderUnits} = ${twice} > ${a.denominator}`}>
          UP
        </Badge>
      );
    case "down":
      return (
        <Badge tone="quiet" title={`2 × ${a.remainderUnits} = ${twice} < ${a.denominator}`}>
          DOWN
        </Badge>
      );
    case "tie_to_even":
      return (
        <Badge
          tone="neutral"
          title={`2 × ${a.remainderUnits} = ${a.denominator} exactly — half a cent. §12.2 breaks it to the even cent; ${a.wholeCents} is ${a.wholeCents % 2 === 0 ? "even, so it stays" : "odd, so it goes up"}.`}
        >
          TIE → EVEN
        </Badge>
      );
  }
}
