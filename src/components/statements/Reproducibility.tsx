import { Money } from "@/components/ui/Money";
import { Badge, Panel, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";
import { formatDate } from "@/lib/format/datetime";

import type { BothReadingsView } from "./data-contract";
import { Hash, ReproductionBadge } from "./Provenance";

/**
 * WHY THIS DAY'S FIGURES CANNOT CHANGE.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS BEING CLAIMED
 * ---------------------------------------------------------------------------
 *
 * A statement is a PERIOD AND A BOOKING WATERMARK, not a period. Fix both and
 * the document is a pure function of immutable rows, so re-rendering it
 * produces the same bytes forever — which is what `corgi.statement.v1` and a
 * sha256 over its canonical form make checkable rather than asserted.
 *
 * Both readings get a hash, not only the published one. That is the point the
 * panel exists to make: reproducibility is a property of `(period,
 * watermark)`, not of the act of publishing. The as-corrected reading is
 * pinned to today's watermark, so it too reproduces — for exactly as long as
 * nothing further is learned, and the moment something is, its watermark moves
 * and its hash changes while every earlier reading stays where it was.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STORED FIGURE IS SHOWN NEXT TO THE DERIVED ONE
 * ---------------------------------------------------------------------------
 *
 * `statement.closing_balance_cents` exists because a published figure has to
 * stay queryable exactly as published. It is NOT what this screen prints: the
 * screen re-derives the document from the ledger and then shows the stored
 * figure beside it, so that two numbers which must agree are both on the page.
 * Printing only the stored one would prove nothing. Printing only the derived
 * one would leave the stored one unexamined, which is how a stored figure
 * drifts for a year before anybody notices.
 *
 * ---------------------------------------------------------------------------
 * THE ANTI-TAMPER ARGUMENT, IN ONE SENTENCE
 * ---------------------------------------------------------------------------
 *
 * No row can appear BELOW a watermark after the fact, because `booking_seq` is
 * drawn while holding the ledger append lock, so sequence order is commit
 * order; and no row below it can change, because the money tables carry
 * append-only triggers and the application role holds no `UPDATE` or `DELETE`.
 * A correction therefore cannot reach back into a reading — it can only be
 * appended above it, which is exactly what the panel above shows happening.
 */
export function Reproducibility({ view }: { readonly view: BothReadingsView }) {
  const { believed, corrected, published } = view;

  return (
    <Panel
      title="Why these figures cannot change"
      description={`Each reading is ${formatDate(view.valueDate)} pinned to a booking watermark, re-derived from the ledger on this page load, and fingerprinted. Fix the watermark and the document is a pure function of immutable rows.`}
      actions={
        published === null ? (
          <Badge tone="quiet" title="Both readings are derived; neither has been issued as a document">
            DERIVED, NOT STORED
          </Badge>
        ) : (
          <ReproductionBadge reproduced={view.reproduced} formatChanged={view.formatChanged} />
        )
      }
    >
      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Each reading&rsquo;s booking watermark, closing figure and content hash
          </caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH_CLASS}>
                Reading
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Booking watermark
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Lines
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Closing
              </th>
              <th scope="col" className={TH_CLASS}>
                Content hash, recomputed now
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border">
              <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                {believed.label}
                <span className="mt-0.5 block text-[11px] text-muted">
                  {published === null
                    ? "derived at this watermark; no document was issued against it"
                    : `issued as v${published.version}`}
                </span>
              </th>
              <td className={`${TD_CLASS} text-right tabular-nums`}>
                {believed.bookingWatermark}
              </td>
              <td className={`${TD_CLASS} text-right tabular-nums`}>
                {believed.document.lineCount}
              </td>
              <td className={`${TD_CLASS} text-right`}>
                <Money cents={believed.closingBalanceCents} />
              </td>
              <td className={TD_CLASS}>
                <Hash value={believed.contentHash} label="as-believed content hash" />
              </td>
            </tr>

            <tr className="border-b border-border">
              <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                As corrected
                <span className="mt-0.5 block text-[11px] text-muted">
                  everything we have learned, as of this read
                </span>
              </th>
              <td className={`${TD_CLASS} text-right tabular-nums`}>
                {corrected.bookingWatermark}
              </td>
              <td className={`${TD_CLASS} text-right tabular-nums`}>
                {corrected.document.lineCount}
              </td>
              <td className={`${TD_CLASS} text-right`}>
                <Money cents={corrected.closingBalanceCents} />
              </td>
              <td className={TD_CLASS}>
                <Hash value={corrected.contentHash} label="as-corrected content hash" />
              </td>
            </tr>

            {published === null ? null : (
              <tr>
                <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                  Stored on the <code>statement</code> row
                  <span className="mt-0.5 block text-[11px] text-muted">
                    the as-published figure, kept queryable exactly as issued
                  </span>
                </th>
                <td className={`${TD_CLASS} text-right tabular-nums`}>
                  {published.bookingWatermark}
                </td>
                <td className={`${TD_CLASS} text-right tabular-nums`}>
                  {published.lineCount}
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={published.closingBalanceCents} />
                  <span
                    className={`ml-2 text-[11px] ${
                      published.closingBalanceCents === believed.closingBalanceCents
                        ? "text-muted"
                        : "text-negative"
                    }`}
                  >
                    {published.closingBalanceCents === believed.closingBalanceCents
                      ? "agrees"
                      : "DISAGREES"}
                  </span>
                </td>
                <td className={TD_CLASS}>
                  <Hash value={published.contentHash} label="stored content hash" />
                  <span
                    className={`ml-2 text-[11px] ${view.reproduced ? "text-muted" : "text-negative"}`}
                  >
                    {view.reproduced ? "identical" : "DOES NOT MATCH"}
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableScroll>

      <div className="border-t border-border px-5 py-4">
        <p className="max-w-prose text-[11px] leading-relaxed text-muted">
          Neither figure above is stored anywhere. Both are{" "}
          <code>renderStatement(period, watermark)</code> — the same function, the
          same rows, the same canonical form — run twice with one argument changed,
          on this request. Re-running either at its own watermark produces the same
          bytes forever: no row can appear below a watermark after the fact, because{" "}
          <code>booking_seq</code> is drawn while holding the ledger append lock, so
          sequence order is commit order; and no row below it can change, because
          the money tables are append-only and the application role holds no{" "}
          <code>UPDATE</code>. A correction therefore cannot reach back into a
          reading. It can only be appended above one.
        </p>
      </div>
    </Panel>
  );
}
