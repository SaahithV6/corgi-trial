import Link from "next/link";
import type { Metadata } from "next";

import { isErr } from "@/lib/result";
import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { DEMO_ACCOUNTS } from "@/components/account/fixtures";
import { listLiveAccounts } from "@/components/account/live-data-source";
import { DEMO_STATE_LABELS, demoQuery } from "@/components/account/demo-state";

export const metadata: Metadata = {
  title: "Accounts · Corgi ops console",
};

/**
 * Never prerendered. The figures below are a fold over the journal taken at
 * request time; baking them into a build artefact would put a balance from
 * deploy-time on a screen an operator reads as current.
 */
export const dynamic = "force-dynamic";

/**
 * `/accounts` — the account directory.
 *
 * Two tables, and the split is the point. The first is every real deposit
 * account on the book, read live; the second is the demo accounts that back
 * the `?state=` screens. They are labelled, because a directory that mixes
 * seeded demo money with real balances under one heading is how a screenshot
 * ends up in a deck claiming the wrong thing.
 *
 * Both balances in the live table come from `getAccountSummary` — the same
 * fold the account screen itself renders — so a row here and the page it links
 * to cannot quote different numbers.
 */
export default async function AccountsPage() {
  const live = await listLiveAccounts();

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
        description="Read from the journal at request time: ledger is Σ amount_cents × normal_side over this account's lines, available is that minus every hold still withholding money."
        actions={<Badge tone="positive">live ledger</Badge>}
      >
        {isErr(live) ? (
          <div className="px-5 py-8">
            <p className="text-sm text-negative">
              The account list could not be read.
            </p>
            <dl className="mt-3 grid gap-2 sm:grid-cols-[8rem_1fr]">
              <dt className="text-xs uppercase tracking-[0.08em] text-muted">
                Code
              </dt>
              <dd className="font-mono text-xs">{live.error.code}</dd>
              <dt className="text-xs uppercase tracking-[0.08em] text-muted">
                Message
              </dt>
              <dd className="max-w-prose text-sm">{live.error.message}</dd>
            </dl>
            <p className="mt-3 max-w-prose text-xs leading-relaxed text-muted">
              This is a read failure. Nothing moved — the ledger is append-only
              and a query cannot alter it. The demo accounts below are fixtures
              and still work.
            </p>
          </div>
        ) : live.value.length === 0 ? (
          <p className="px-5 py-8 text-sm text-muted">
            No customer deposit accounts have been opened. A business gets its
            2100 account when KYB approves it, and not before — you cannot owe
            money to a business you have not verified.
          </p>
        ) : (
          <TableScroll>
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                Customer deposit accounts with their ledger and available
                balances, read live from the journal
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
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {live.value.map((account) => (
                  <tr key={account.accountId}>
                    <th
                      scope="row"
                      className={`${TD_CLASS} text-left font-normal`}
                    >
                      <Link
                        href={`/accounts/${account.accountId}`}
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
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title="Demo accounts"
        description="Fixtures behind the five URL-driven states. They write nothing and read nothing: an over-capture, an empty account and a failed query are not conditions you seed on a live ledger to show someone."
        actions={<Badge tone="quiet">fixture</Badge>}
      >
        <TableScroll>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Demo accounts, with the state each row opens in
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
              {DEMO_ACCOUNTS.map((account) => {
                // The bare default URL is live now, so the demo account that
                // quotes the default fixture opens with the authorisation
                // toggle instead — the one other view that is still a fixture.
                const query = demoQuery({
                  state: account.state,
                  authPending: account.state === "default",
                });

                return (
                  <tr key={account.accountId}>
                    <th
                      scope="row"
                      className={`${TD_CLASS} text-left font-normal`}
                    >
                      <Link
                        href={`/accounts/${account.accountId}${query}`}
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
                      {account.state === "default" ? " · auth pending" : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      </Panel>
    </div>
  );
}
