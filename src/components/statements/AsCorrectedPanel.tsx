import { Money } from "@/components/ui/Money";
import { Badge, Note, Panel, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";
import { formatDate, formatTimestamp } from "@/lib/format/datetime";
import { formatUsd } from "@/lib/format/money";

import type { CorrectionGroupView, StatementDetailView } from "./data-contract";

/**
 * "…and here is what we now know that day to be, and why it differs."
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A LIST OF ACTS AND NOT A LIST OF ROWS
 * ---------------------------------------------------------------------------
 *
 * A reversal and its re-book are two entries and ONE act: the merchant took a
 * different amount than it first presented. An operator asking "why is that
 * day different now" is asking about acts, so the entries are grouped by
 * `correction_group_id` and each group carries its own net. Entries that are
 * not part of a correction — an ordinary settlement that simply arrived after
 * the close — each stand alone, because each is its own act.
 *
 * Two kinds of act land here and the panel keeps them apart. Most are postings
 * on the day itself. Some are backdated to BEFORE the period and moved the
 * opening balance instead, which changes the closing figure without ever
 * appearing as a line on the statement — the case that is invisible unless a
 * screen names it, and the one the integration suite caught this panel getting
 * wrong.
 *
 * ---------------------------------------------------------------------------
 * THE ARITHMETIC IS SHOWN, NOT ASSERTED
 * ---------------------------------------------------------------------------
 *
 * The panel states the identity it depends on:
 *
 *     as corrected − as published = Σ (the acts listed here)
 *
 * and says whether it holds. If it does not, the panel says so in the negative
 * colour instead of printing the delta and moving on. A difference the system
 * cannot itemise is a fact about the system; hiding it would train whoever
 * reads this screen to stop checking, which is the same argument DECISIONS 014
 * makes about breaks whose net is zero.
 */
export function AsCorrectedPanel({
  detail,
  businessDate,
}: {
  readonly detail: StatementDetailView;
  readonly businessDate: string;
}) {
  const { corrections, deltaCents, explained, published, correctedDocument } = detail;

  return (
    <Panel
      title="What we now know that day to be, and why it differs"
      description={`Everything booked above watermark ${published.bookingWatermark} that changes what ${formatDate(businessDate)} closed at — postings on the day itself, and anything backdated before it that moved the opening balance. Legal, expected, and the reason a later version exists.`}
      actions={
        <Badge tone={explained ? "neutral" : "negative"}>
          {explained ? "FULLY ITEMISED" : "UNEXPLAINED DIFFERENCE"}
        </Badge>
      }
    >
      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Corrections and late postings that changed this day after its statement
            was issued
          </caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH_CLASS}>
                Act
              </th>
              <th scope="col" className={TH_CLASS}>
                Entries
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Booked
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Net effect
              </th>
            </tr>
          </thead>
          <tbody>
            {corrections.map((group) => (
              <CorrectionRow key={group.id} group={group} />
            ))}

            <tr>
              <td className={`${TD_CLASS} font-medium`} colSpan={3}>
                Total movement since the statement was issued
                <span className="mt-0.5 block text-xs font-normal text-muted">
                  as corrected {formatUsd(correctedDocument.closingBalanceCents)} −
                  as published {formatUsd(detail.publishedDocument.closingBalanceCents)}
                </span>
              </td>
              <td className={`${TD_CLASS} text-right font-medium`}>
                <Money cents={deltaCents} tone="direction" signed />
              </td>
            </tr>
          </tbody>
        </table>
      </TableScroll>

      <div className="border-t border-border px-5 py-4">
        {explained ? (
          <Note title="The difference is accounted for">
            The acts above sum to exactly the difference between the two
            readings. Nothing on this day changed that we cannot name and point
            at. Both figures stay true: the published one is what the customer
            was told, the corrected one is what the book says now, and neither
            overwrote the other.
          </Note>
        ) : (
          <Note emphasis title="The difference is NOT accounted for">
            The entries above do not sum to the difference between the two
            readings. That should be impossible — every posting inside the
            period above the published watermark is listed here by construction
            — so treat it as an incident rather than a rounding artefact.
          </Note>
        )}
      </div>
    </Panel>
  );
}

function CorrectionRow({ group }: { readonly group: CorrectionGroupView }) {
  const firstPosting = group.postings[0];
  return (
    <tr className="border-b border-border align-top">
      <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
        <span className="flex flex-wrap items-center gap-2">
          {group.isCorrection ? (
            <>
              Correction
              <Badge tone="negative" title="A reversal at the original value date, plus a re-book">
                REVERSAL + RE-BOOK
              </Badge>
            </>
          ) : (
            <>
              Late posting
              <Badge tone="quiet" title="Booked after the close; not a correction of anything">
                AFTER THE CLOSE
              </Badge>
            </>
          )}
        </span>
        {group.postings.some((p) => p.affectsOpening) ? (
          <span className="mt-1 block">
            <Badge tone="quiet" title="Value-dated before this period: it moved the opening balance, not a line">
              MOVED THE OPENING BALANCE
            </Badge>
          </span>
        ) : null}
        {group.correctionGroupId === null ? null : (
          <span className="mt-0.5 block font-mono text-[11px] text-muted">
            group {group.correctionGroupId.slice(0, 8)}
          </span>
        )}
      </th>

      <td className={TD_CLASS}>
        <ul className="space-y-1.5">
          {group.postings.map((posting) => (
            <li key={posting.entryId}>
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span>{posting.description}</span>
                <span className="text-xs uppercase tracking-[0.06em] text-muted">
                  {posting.entryType}
                </span>
                <Money cents={posting.amountCents} tone="direction" signed className="text-xs" />
              </span>
              <span className="mt-0.5 block text-[11px] text-muted">
                value date {formatDate(posting.valueDate)}
                {posting.affectsOpening ? " (before this period)" : ""} · booked at
                seq {posting.bookingSeq}
                {posting.reversesEntryId === null
                  ? null
                  : ` · reverses ${posting.reversesEntryId.slice(0, 8)}`}
              </span>
            </li>
          ))}
        </ul>
      </td>

      <td className={`${TD_CLASS} text-right text-xs text-muted`}>
        {firstPosting === undefined ? "—" : formatTimestamp(firstPosting.bookingTime)}
      </td>

      <td className={`${TD_CLASS} text-right`}>
        <Money cents={group.netCents} tone="direction" signed />
      </td>
    </tr>
  );
}
