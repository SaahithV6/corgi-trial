import { formatDate, formatTimestamp } from "@/lib/format/datetime";
import { Money } from "@/components/ui/Money";
import {
  Badge,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";

import type { Posting } from "./data-contract";
import { runningLedgerBalances } from "./derive";

/**
 * Activity, with both effects of every posting shown separately.
 *
 * The two delta columns are the point. A card authorisation has an available
 * effect and no ledger effect; a partial clearing against its own hold has a
 * ledger effect and *no* available effect, because the hold released exactly
 * what the ledger took. Both facts are visible in a glance across a row, which
 * is not true of any single-amount transaction list.
 *
 * The running balance column is derived here from the current ledger balance
 * and the deltas above it (§10: balances are folds, not columns), so a stored
 * balance that had drifted could not be displayed even by accident.
 */
export function PostingsTable({
  postings,
  ledgerCents,
}: {
  readonly postings: readonly Posting[];
  readonly ledgerCents: number;
}) {
  const balances = runningLedgerBalances(postings, ledgerCents);

  return (
    <Panel
      id="activity"
      title="Activity"
      description="Newest first. Memo postings move availability only; financial postings move the ledger balance and, unless a hold releases against them, availability too."
    >
      {postings.length === 0 ? (
        <div className="px-5 py-10">
          <p className="text-sm">No postings yet.</p>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
            This account has been opened but nothing has been booked to it. The
            ledger balance is <Money cents={0} tone="neutral" /> because there
            are no journal lines to fold, not because a balance field was
            initialised to zero.
          </p>
        </div>
      ) : (
        <TableScroll>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Postings on this account, newest first, with their effect on the
              ledger balance and on the available balance
            </caption>
            <thead className="border-b border-border">
              <tr>
                <th scope="col" className={TH_CLASS}>
                  When
                </th>
                <th scope="col" className={TH_CLASS}>
                  Description
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Ledger Δ
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Available Δ
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Ledger balance
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {postings.map((posting, index) => {
                const balance = balances[index] ?? null;
                const memo = posting.ledgerDeltaCents === null;

                return (
                  <tr key={posting.id}>
                    <td className={`${TD_CLASS} whitespace-nowrap text-muted`}>
                      <span className="block">
                        {formatTimestamp(posting.occurredAt)}
                      </span>
                      <span className="mt-0.5 block text-xs">
                        value date {formatDate(posting.valueDate)}
                      </span>
                    </td>

                    <td className={TD_CLASS}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{posting.description}</span>
                        {memo ? (
                          <Badge
                            tone="quiet"
                            title="Memo book. No financial entry, so the ledger balance cannot move."
                          >
                            memo
                          </Badge>
                        ) : null}
                      </div>
                      {posting.sourceRef === null ? null : (
                        <p className="mt-0.5 font-mono text-[11px] text-muted">
                          {posting.sourceRef}
                        </p>
                      )}
                    </td>

                    <td className={`${TD_CLASS} text-right`}>
                      {posting.ledgerDeltaCents === null ? (
                        <>
                          <span aria-hidden="true" className="text-muted">
                            —
                          </span>
                          <span className="sr-only">no ledger effect</span>
                        </>
                      ) : (
                        <Money
                          cents={posting.ledgerDeltaCents}
                          tone="direction"
                          signed
                        />
                      )}
                    </td>

                    <td className={`${TD_CLASS} text-right`}>
                      {posting.availableDeltaCents === 0 ? (
                        <span
                          className="money text-muted"
                          title="Available did not move: the hold released exactly what the ledger took."
                        >
                          $0.00
                        </span>
                      ) : (
                        <Money
                          cents={posting.availableDeltaCents}
                          tone="direction"
                          signed
                        />
                      )}
                    </td>

                    <td className={`${TD_CLASS} text-right`}>
                      {balance === null ? (
                        <>
                          <span aria-hidden="true" className="text-muted">
                            —
                          </span>
                          <span className="sr-only">unchanged</span>
                        </>
                      ) : (
                        <Money cents={balance} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Panel>
  );
}
