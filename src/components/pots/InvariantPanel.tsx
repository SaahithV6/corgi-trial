import { Badge, Panel, TableScroll, TD_CLASS, TH_CLASS } from "@/components/ui/primitives";

import type { InvariantView } from "./data-contract";

/**
 * The invariant views, queried at render time, with their row counts.
 *
 * These are TESTS, not telemetry. Every one must return zero rows; a non-zero
 * count is a bug to fix and never a number for anything in production to
 * repair. They are on the screen rather than only in CI because the claim this
 * feature makes — "a new level in the account tree did not break the ledger" —
 * is exactly the sort of claim that is true on the day it ships and quietly
 * false a week later.
 *
 * `v_deposit_control_drift` is first on purpose. It is the one that a
 * sub-account level was most likely to break, it IS the one a sub-account level
 * broke, and the fix is in `db/migrations/0015_pots.sql` with the measurement
 * that prompted it written out above the SQL.
 */
export function InvariantPanel({
  invariants,
}: {
  readonly invariants: readonly InvariantView[];
}) {
  if (invariants.length === 0) return null;

  const broken = invariants.filter((row) => row.rows > 0);

  return (
    <Panel
      id="invariants"
      title="Invariants, at this moment"
      description="Read live, on this render, as the application role. Each must return zero rows."
      actions={
        broken.length === 0 ? (
          <Badge tone="positive">{invariants.length} / {invariants.length} empty</Badge>
        ) : (
          <Badge tone="negative">{broken.length} NON-EMPTY</Badge>
        )
      }
    >
      <TableScroll>
        <table className="w-full border-collapse">
          <caption className="sr-only">Invariant views and their row counts</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={TH_CLASS}>
                View
              </th>
              <th scope="col" className={TH_CLASS}>
                What it proves
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Rows
              </th>
            </tr>
          </thead>
          <tbody>
            {invariants.map((row) => (
              <tr key={row.view} className="border-b border-border align-top">
                <td className={`${TD_CLASS} money text-xs whitespace-nowrap`}>
                  {row.view}
                </td>
                <td className={`${TD_CLASS} max-w-prose text-xs text-muted`}>
                  {row.what}
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  {row.rows === 0 ? (
                    <Badge tone="positive">0</Badge>
                  ) : (
                    <Badge tone="negative">{row.rows}</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  );
}
