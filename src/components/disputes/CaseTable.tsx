import Link from "next/link";

import { Money } from "@/components/ui/Money";
import { Badge, FOCUS_RING, Panel, TableScroll, TD_CLASS, TH_CLASS } from "@/components/ui/primitives";

import type { CaseView } from "./data-contract";
import { disputesHref, statusLabel, statusTone, type DisputesFilter } from "./view-state";

/**
 * Every case on this customer.
 *
 * Two columns carry the whole feature and are deliberately side by side:
 *
 *   ADVANCED  what we have actually paid out on this case, summed from
 *             `journal_line` through the events — not a column on `dispute`.
 *   HELD      what the memo book is withholding of it.
 *
 * While a case is open those two are EQUAL, and that equality is the promise:
 * the credit is in the customer's ledger balance and none of it is spendable.
 * A reader can check it by eye, which is the only kind of claim worth making
 * about money.
 *
 * `ageing` is the network's outside date, not the hold's clock. The hold is
 * released by a decision and never by time (see 0019 §2); a case running past
 * the date the network should have answered by is an ops problem, and an ops
 * problem belongs on a screen rather than in an invariant view.
 */
export function CaseTable({
  cases,
  filter,
}: {
  readonly cases: readonly CaseView[];
  readonly filter: DisputesFilter;
}) {
  if (cases.length === 0) {
    return (
      <Panel
        title="Cases"
        description="Every dispute raised on this customer, with what has been advanced and what is still withheld."
      >
        <div className="px-5 py-6">
          <p className="max-w-prose text-sm text-muted">
            No dispute has ever been raised on this customer. That is an empty
            screen, not a broken one — and it is the state every customer starts
            in.
          </p>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="Cases"
      description="Newest first, by the instant the case was raised, capped at 50 — an older case than the last row is not shown here. 'advanced' and 'held' are both sums over journal_line; while a case is open they are equal, which is the whole promise."
    >
      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <thead className="border-b border-border">
            <tr>
              <th className={TH_CLASS}>case</th>
              <th className={TH_CLASS}>reason</th>
              <th className={`${TH_CLASS} text-right`}>claimed</th>
              <th className={`${TH_CLASS} text-right`}>advanced</th>
              <th className={`${TH_CLASS} text-right`}>held</th>
              <th className={TH_CLASS}>status</th>
              <th className={TH_CLASS}>checker</th>
              <th className={`${TH_CLASS} text-right`}>outside date</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c) => (
              <tr key={c.disputeId} className="border-b border-border last:border-0 align-top">
                <td className={TD_CLASS}>
                  <Link
                    href={disputesHref(filter, { state: "edge", disputeId: c.disputeId })}
                    className={`money underline underline-offset-2 ${FOCUS_RING}`}
                  >
                    {c.caseRef}
                  </Link>
                  <p className="mt-1 text-[11px] text-muted">
                    raised {c.valueDate} by {c.raisedBy}
                  </p>
                </td>

                <td className={TD_CLASS}>
                  <span>{c.reason.replaceAll("_", " ")}</span>
                  <p className="mt-1 text-[11px] text-muted">
                    <span className="money">
                      {c.network} {c.networkCode}
                    </span>
                    {c.networkLabel === null ? null : ` · ${c.networkLabel}`}
                  </p>
                </td>

                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={c.amountCents} />
                </td>

                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={c.advancedCents} />
                </td>

                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={c.heldCents} />
                  {c.advancedCents > 0 && c.advancedCents === c.heldCents ? (
                    <p className="mt-1 text-[11px] text-muted">all of it, unspendable</p>
                  ) : null}
                </td>

                <td className={TD_CLASS}>
                  <Badge tone={statusTone(c.status)} title={c.statusMeaning}>
                    {statusLabel(c.status)}
                  </Badge>
                  {/* A status with no date is a state with no history. `decidedOn`
                      is the value date the case was resolved on; it is null while
                      the case is still running. */}
                  <p className="mt-1 text-[11px] text-muted">
                    {c.decidedOn === null ? (
                      "not yet decided"
                    ) : (
                      <>
                        decided <span className="money">{c.decidedOn}</span>
                      </>
                    )}
                  </p>
                </td>

                <td className={TD_CLASS}>
                  {c.needsAuthorization ? (
                    <span className="text-xs">
                      {c.authorizations}/{c.requiredApprovals} above{" "}
                      <Money cents={c.thresholdCents} />
                    </span>
                  ) : (
                    <span className="text-xs text-muted">
                      below <Money cents={c.thresholdCents} />
                    </span>
                  )}
                </td>

                <td className={`${TD_CLASS} text-right`}>
                  <span className="money">{c.networkOutsideDate}</span>
                  <p className="mt-1 text-[11px] text-muted">
                    {c.isClosed
                      ? "closed"
                      : c.daysToOutsideDate < 0
                        ? `${-c.daysToOutsideDate} days past`
                        : `${c.daysToOutsideDate} days left`}
                  </p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  );
}
