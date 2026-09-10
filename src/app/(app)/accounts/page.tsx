import Link from "next/link";
import type { Metadata } from "next";

import { Money } from "@/components/ui/Money";
import {
  FOCUS_RING,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { DEMO_ACCOUNTS } from "@/components/account/fixtures";
import { DEMO_STATE_LABELS, demoQuery } from "@/components/account/demo-state";

export const metadata: Metadata = {
  title: "Accounts · Corgi ops console",
};

/**
 * `/accounts` — the account directory.
 *
 * Deliberately thin: it exists so the account screen has somewhere to be
 * navigated from, and so the two balances appear side by side one level up as
 * well. Each row opens in the demo state whose figures it is quoting, so the
 * directory can never disagree with the screen it links to.
 */
export default function AccountsPage() {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Accounts</h1>
        <p className="mt-0.5 max-w-prose text-sm text-muted">
          Every deposit account on this business&rsquo;s book. Ledger and
          available are both folds over journal lines — neither is a stored
          column.
        </p>
      </header>

      <Panel
        title="Deposit accounts"
        description="Balances as of the last booking watermark."
      >
        <TableScroll>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Deposit accounts with their ledger and available balances
            </caption>
            <thead className="border-b border-border">
              <tr>
                <th scope="col" className={TH_CLASS}>
                  Account
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Ledger balance
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Available balance
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Opens in
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {DEMO_ACCOUNTS.map((account) => (
                <tr key={account.accountId}>
                  <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                    <Link
                      href={`/accounts/${account.accountId}${demoQuery({
                        state: account.state,
                      })}`}
                      className={`font-medium underline underline-offset-4 hover:text-muted ${FOCUS_RING}`}
                    >
                      {account.accountName} ••{account.last4}
                    </Link>
                    <span className="mt-0.5 block text-xs text-muted">
                      {account.businessName}
                    </span>
                  </th>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={account.ledgerCents} />
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={account.availableCents} />
                  </td>
                  <td className={`${TD_CLASS} text-right text-xs text-muted`}>
                    {DEMO_STATE_LABELS[account.state]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Panel>
    </div>
  );
}
