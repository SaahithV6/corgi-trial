import { Money } from "@/components/ui/Money";
import { Panel, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";
import { formatDate } from "@/lib/format/datetime";

import type { PolicyView } from "./data-contract";

/**
 * Every version of every threshold policy.
 *
 * Shown in full, including versions no longer in force, because that is the
 * whole argument for effective dating: `approval_policy` is append-only, a
 * change is a new row with a later `effective_from`, and both rows exist for
 * ever. Each payment above stores the id of the row it was judged under, so
 * raising the ACH threshold tomorrow cannot make today's approvals look wrong —
 * they still cite `ach@2026-01-01` and this table still contains it.
 */
export function PolicyPanel({ policies }: { readonly policies: readonly PolicyView[] }) {
  return (
    <Panel
      id="policies"
      title="Threshold policy, every version"
      description="Append-only and effective-dated. A change is an INSERT with a later effective_from; nothing is ever edited, so a payment's cited version outlives the rule it was judged under."
    >
      <TableScroll>
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={TH_CLASS}>
                Version
              </th>
              <th scope="col" className={TH_CLASS}>
                In force from
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Threshold
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Approvals
              </th>
              <th scope="col" className={TH_CLASS}>
                Why
              </th>
            </tr>
          </thead>
          <tbody>
            {policies.map((policy) => (
              <tr key={policy.id} className="border-b border-border last:border-b-0">
                <td className={`${TD_CLASS} font-mono`}>{policy.version}</td>
                <td className={`${TD_CLASS} text-muted`}>{formatDate(policy.effectiveFrom)}</td>
                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={policy.thresholdCents} tone="neutral" />
                </td>
                <td className={`${TD_CLASS} money text-right`}>{policy.requiredApprovals}</td>
                <td className={`${TD_CLASS} max-w-prose text-xs leading-relaxed text-muted`}>
                  {policy.note}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  );
}
