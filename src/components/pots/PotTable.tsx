import { Money } from "@/components/ui/Money";
import {
  Badge,
  Panel,
  TableScroll,
  TD_CLASS,
  TH_CLASS,
} from "@/components/ui/primitives";

import type { IdentityView, PotView } from "./data-contract";

/**
 * One row per pot, plus the main balance as a row of the same table.
 *
 * They belong in one table because they are the same KIND of thing: sibling
 * leaves of one customer's deposit liability, each with a balance that is a sum
 * over its own journal lines. Putting the main balance in a separate box would
 * suggest it is a different sort of number, and the footer that adds the column
 * up to the total is the identity again — this time as a column you can add
 * with your finger.
 */
export function PotTable({
  pots,
  identity,
  legalName,
}: {
  readonly pots: readonly PotView[];
  readonly identity: IdentityView;
  readonly legalName: string;
}) {
  return (
    <Panel
      id="pots"
      title="Pots"
      description="Sub-accounts of this customer's deposit liability. The money is still owed to the same customer — it is earmarked, not moved anywhere."
      actions={<Badge tone="quiet">{pots.length} open</Badge>}
    >
      {pots.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">
          No pots. The main balance below is the whole of this customer&rsquo;s
          deposit liability, and the identity{" "}
          <code>main + Σ pots = total</code> degenerates to{" "}
          <code>main = total</code> — which is still true, and still checked by{" "}
          <code>v_pot_identity_drift</code>.
        </p>
      ) : null}

      <TableScroll>
        <table className="w-full border-collapse">
          <caption className="sr-only">
            {legalName}: the main deposit balance and every pot beneath it
          </caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={TH_CLASS}>
                Account
              </th>
              <th scope="col" className={TH_CLASS}>
                Chart code
              </th>
              <th scope="col" className={TH_CLASS}>
                Purpose
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Share
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Balance
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border">
              <td className={TD_CLASS}>
                <span className="font-medium">{legalName} — main balance</span>
                <p className="mt-0.5 text-xs text-muted">
                  Spendable. This is the account <code>availableBalance()</code>{" "}
                  reads.
                </p>
              </td>
              <td className={`${TD_CLASS} money text-xs`}>2100</td>
              <td className={`${TD_CLASS} text-xs text-muted`}>
                Everything not earmarked
              </td>
              <td className={`${TD_CLASS} text-right text-xs text-muted`}>
                {sharePercent(identity.mainCents, identity.totalCents)}
              </td>
              <td className={`${TD_CLASS} text-right`}>
                <Money cents={identity.mainCents} className="font-semibold" />
              </td>
            </tr>

            {pots.map((pot) => (
              <tr key={pot.potId} className="border-b border-border">
                <td className={TD_CLASS}>
                  <span className="font-medium">{pot.name}</span>
                  <p className="mt-0.5 text-xs text-muted">
                    opened {formatInstant(pot.openedAt)}
                  </p>
                </td>
                <td className={`${TD_CLASS} money text-xs break-all`}>
                  {pot.accountCode}
                </td>
                <td className={`${TD_CLASS} max-w-xs text-xs text-muted`}>
                  {pot.purpose ?? "—"}
                </td>
                <td className={`${TD_CLASS} text-right text-xs text-muted`}>
                  {pot.sharePercent}%
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={pot.balanceCents} className="font-semibold" />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className={`${TD_CLASS} font-medium`} colSpan={4}>
                Total deposit liability — what the bank owes {legalName}
              </td>
              <td className={`${TD_CLASS} text-right`}>
                <Money cents={identity.totalCents} className="font-semibold" />
              </td>
            </tr>
          </tfoot>
        </table>
      </TableScroll>
    </Panel>
  );
}

/**
 * Integer percent. Not money, so a plain `number` division is safe here — and
 * it is deliberately the only division on this screen. Every money figure
 * arrives already in cents and is rendered by `formatUsd`, which does integer
 * division on `bigint`.
 */
function sharePercent(part: number, total: number): string {
  if (total === 0) return "—";
  return `${Math.round((part * 100) / total)}%`;
}

function formatInstant(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toISOString().replace("T", " ").slice(0, 16);
}
