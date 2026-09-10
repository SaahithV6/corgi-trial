import Link from "next/link";

import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
  type BadgeTone,
} from "@/components/ui/primitives";
import { formatDate } from "@/lib/format/datetime";

import type { OccurrenceRow } from "./data-contract";
import { standingHref, type StandingFilter } from "./view-state";

/**
 * The history: what fired, what was refused, and why.
 *
 * ONE ROW PER OCCURRENCE, INCLUDING THE ONES THAT DID NOT PAY. That is the
 * whole design. A schedule that silently skipped a month leaves nothing to
 * look at and the first anyone hears of it is the payee's phone call; a
 * schedule that RECORDS the refusal leaves a row with a code, a sentence and
 * the four balances it was judged against.
 *
 * Three dispositions render, and the third is not a database value:
 *
 *   RAISED     a payment instruction exists, in the approvals queue, under the
 *              same policy version and the same maker-checker rule as a
 *              hand-typed payment. Note what this does NOT say: that money
 *              moved. A standing order raises an instruction; a human releases
 *              it. There is no second path.
 *   REFUSED    attempted, declined, reason on the row.
 *   CLAIMED    an occurrence with no outcome. A process took it and did not
 *              finish. Nothing moved and the next tick re-drives it to the same
 *              instruction through the same derived key.
 */

const DISPOSITION_TONE: Record<string, BadgeTone> = {
  raised: "positive",
  refused: "negative",
  claimed: "neutral",
};

export function OccurrenceTable({
  rows,
  filter,
  total,
}: {
  readonly rows: readonly OccurrenceRow[];
  readonly filter: StandingFilter;
  /** Rows before the mandate filter, so an empty table can say which emptiness. */
  readonly total: number;
}) {
  if (rows.length === 0) {
    return (
      <div className="px-5 py-10 text-center">
        <p className="mx-auto max-w-prose text-xs leading-relaxed text-muted">
          {total > 0 ? (
            <>
              No occurrence for the selected mandate.{" "}
              <Link
                href={standingHref(filter, { standingOrderId: null, occurrenceId: null })}
                className={`underline underline-offset-4 ${FOCUS_RING}`}
              >
                Show every mandate
              </Link>
              .
            </>
          ) : (
            <>
              Nothing has come round yet. An occurrence exists only once a date
              the schedule generates has been claimed by a tick — there is no
              queue of future payments sitting in a table waiting to be
              cancelled, because the calendar already knows when they are due.
            </>
          )}
        </p>
      </div>
    );
  }

  return (
    <TableScroll>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Standing order occurrences, newest scheduled date first
        </caption>
        <thead className="border-b border-border">
          <tr>
            <th scope="col" className={TH_CLASS}>
              Due
            </th>
            <th scope="col" className={TH_CLASS}>
              Reference
            </th>
            <th scope="col" className={`${TH_CLASS} text-right`}>
              Amount
            </th>
            <th scope="col" className={TH_CLASS}>
              Outcome
            </th>
            <th scope="col" className={TH_CLASS}>
              Why
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const selected = filter.occurrenceId === row.occurrenceId;
            const label = row.disposition ?? "claimed";
            return (
              <tr
                key={row.occurrenceId}
                className={`border-t border-border ${selected ? "bg-surface-raised" : ""}`}
              >
                <td className={TD_CLASS}>
                  <Link
                    href={standingHref(filter, {
                      occurrenceId: selected ? null : row.occurrenceId,
                    })}
                    aria-current={selected ? "true" : undefined}
                    className={`font-medium underline-offset-4 hover:underline ${FOCUS_RING}`}
                  >
                    {formatDate(row.scheduledDate)}
                  </Link>
                  <p className="mt-0.5 font-mono text-[10px] leading-relaxed text-muted">
                    {row.idempotencyKey}
                  </p>
                </td>

                <td className={TD_CLASS}>
                  {row.reference}
                  <p className="mt-0.5 text-[11px] text-muted">
                    {row.rail.toUpperCase()} · claimed by{" "}
                    <span className="font-mono">{row.claimedBy}</span>
                  </p>
                </td>

                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={row.amountCents} tone="neutral" />
                  {row.shortfallCents === null ? null : (
                    <p className="mt-0.5 text-[11px] text-muted">
                      short by <Money cents={row.shortfallCents} tone="neutral" />
                    </p>
                  )}
                </td>

                <td className={TD_CLASS}>
                  <Badge tone={DISPOSITION_TONE[label] ?? "quiet"}>
                    {label.toUpperCase()}
                  </Badge>
                  {row.ledgerWouldHaveCovered ? (
                    <p className="mt-1 text-[11px] leading-relaxed text-negative">
                      ledger covered it · available did not
                    </p>
                  ) : null}
                </td>

                <td className={`${TD_CLASS} max-w-[26rem]`}>
                  {row.disposition === "raised" ? (
                    <span className="text-xs text-muted">
                      Instruction{" "}
                      <span className="font-mono text-[11px]">
                        {row.instructionId?.slice(0, 8)}
                      </span>{" "}
                      raised into the approvals queue. Money moves when a second
                      human releases it, not when the schedule fires.
                    </span>
                  ) : row.disposition === "refused" ? (
                    <>
                      <span className="font-mono text-[11px]">{row.refusalCode}</span>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted">
                        {row.refusalReason}
                      </p>
                    </>
                  ) : (
                    <span className="text-xs leading-relaxed text-muted">
                      Claimed and not yet decided. Nothing moved. The next tick
                      re-drives this occurrence to the same instruction, because
                      the key is derived from the mandate and the date.
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}
