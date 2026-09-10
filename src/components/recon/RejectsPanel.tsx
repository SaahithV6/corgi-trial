import {
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";

import type { RejectRow } from "./data-contract";

/**
 * Lines the parser could not read.
 *
 * These are NOT breaks and they are deliberately not in the breaks table. A
 * break is a disagreement between two things we understood; a reject is a line
 * we did not understand at all, so it has no amount to be out by and putting
 * it in the same table would make the net difference a lie.
 *
 * They are on the same screen because the two questions are asked together at
 * 22:05: "what disagrees" and "what did we fail to read". A file that imported
 * 900 rows and rejected 40 has a bigger problem than its four breaks.
 *
 * The line is shown verbatim. Re-rendering it would hide the very thing that
 * needs looking at — a stray quote, a tab, a truncation.
 */
export function RejectsPanel({ rejects }: { readonly rejects: readonly RejectRow[] }) {
  return (
    <Panel
      title={`Rows that could not be read (${rejects.length})`}
      description="Recorded, not fatal. A file that fails to import over one bad line is a file nobody reconciles that night."
    >
      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Settlement file lines the parser rejected
          </caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH_CLASS}>
                Line
              </th>
              <th scope="col" className={TH_CLASS}>
                Reason
              </th>
              <th scope="col" className={TH_CLASS}>
                As received
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rejects.map((reject) => (
              <tr key={reject.rowNo}>
                <th scope="row" className={`${TD_CLASS} text-left font-normal tabular-nums`}>
                  #{reject.rowNo}
                </th>
                <td className={TD_CLASS}>
                  <span className="font-mono text-xs">{reject.reason}</span>
                  <span className="mt-0.5 block max-w-prose text-xs text-muted">
                    {reject.detail}
                  </span>
                </td>
                <td className={TD_CLASS}>
                  <code className="block max-w-md overflow-x-auto whitespace-pre text-[11px] text-muted">
                    {reject.rawLine}
                  </code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  );
}
