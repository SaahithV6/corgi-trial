import { TableScroll, TD_CLASS, TH_CLASS } from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";

import type { RefusalRowView } from "./data-contract";

/**
 * Every destination the arithmetic refused.
 *
 * This table is the evidence the feature works, and it is the reason
 * `payee_candidate_refusal` exists at all: a blocked candidate never becomes a
 * payee, so without a row here the caught typo would be invisible five minutes
 * after it was caught.
 *
 * The digits are shown as typed — not corrected, not normalised, not masked —
 * because the whole point is that somebody can look at `101401533` next to
 * `011401533` and see what their hand did.
 */
export function RefusalTable({ rows }: { readonly rows: readonly RefusalRowView[] }) {
  if (rows.length === 0) {
    return (
      <p className="px-5 py-8 text-center text-sm text-muted">
        Nothing has been refused. Either nobody has mistyped a routing number, or nobody has
        tried to add one.
      </p>
    );
  }

  return (
    <TableScroll>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={TH_CLASS}>Attempted</th>
            <th scope="col" className={TH_CLASS}>By</th>
            <th scope="col" className={TH_CLASS}>Intended payee</th>
            <th scope="col" className={TH_CLASS}>As typed</th>
            <th scope="col" className={TH_CLASS}>Why it was refused</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className={TD_CLASS}>{formatTimestamp(row.attemptedAt)}</td>
              <td className={TD_CLASS}>{row.attemptedByName}</td>
              <td className={TD_CLASS}>
                {row.holderName}
                <div className="mt-0.5 text-[11px] uppercase tracking-[0.08em] text-muted">
                  {row.rail}
                  {row.accountNumberLast4 === null ? "" : ` ••${row.accountNumberLast4}`}
                </div>
              </td>
              <td className={TD_CLASS}>
                <span className="font-mono text-xs text-negative">{row.routingNumber}</span>
              </td>
              <td className={`${TD_CLASS} max-w-prose`}>
                <code className="text-[11px] text-muted">{row.code}</code>
                <p className="mt-1 text-xs leading-relaxed text-muted">{row.reason}</p>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
