import Link from "next/link";

import { formatDate, formatTimestamp } from "@/lib/format/datetime";
import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
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
  pageSize,
}: {
  readonly postings: readonly Posting[];
  readonly ledgerCents: number;
  /**
   * How many rows were ASKED FOR. The table below is a page, not the account's
   * history, and without this the two are indistinguishable — a payment
   * released four hours ago simply is not on the screen and nothing says why.
   */
  readonly pageSize: number;
}) {
  const balances = runningLedgerBalances(postings, ledgerCents);
  const capped = postings.length >= pageSize;

  return (
    <Panel
      id="activity"
      title="Activity"
      description="Newest first by booking time, not by value date. Memo postings move availability only; financial postings move the ledger balance and, unless a hold releases against them, availability too."
      actions={
        <span className="text-xs text-muted">
          {postings.length} posting{postings.length === 1 ? "" : "s"} shown
        </span>
      }
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
        <>
          <p className="max-w-prose border-b border-border px-5 py-2.5 text-[11px] leading-relaxed text-muted">
            {capped ? (
              <>
                The newest {pageSize} postings on this account, and no more. Anything booked before
                the oldest row below is not on this page and is not counted in any figure on it —
                the balances above are folded over the WHOLE journal, so they and this table do not
                answer the same question. Ask for more with{" "}
                <span className="font-mono text-text">?rows=200</span> on this URL.
              </>
            ) : (
              <>
                Every posting on this account: fewer than the {pageSize} this page asked for came
                back, so nothing is below the cut.
              </>
            )}{" "}
            Each row names the journal entry it is, so a release event on /approvals that cites an
            entry id can be found here by matching it.
          </p>
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
                      <p className="mt-0.5 font-mono text-[11px] break-all text-muted">
                        entry {posting.id}
                        {posting.holdId === null ? null : (
                          <>
                            {" · "}
                            <Link
                              href={`/accounts/holds/${posting.holdId}`}
                              className={`underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
                              title="The hold this posting placed or released, with its event set and the fold behind it."
                            >
                              hold {posting.holdId}
                            </Link>
                          </>
                        )}
                      </p>
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
        </>
      )}
    </Panel>
  );
}
