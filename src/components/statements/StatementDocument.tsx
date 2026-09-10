import { Money } from "@/components/ui/Money";
import {
  Badge,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { formatDate, formatTimestamp } from "@/lib/format/datetime";

import type { DocumentView, PublishedStatementView } from "./data-contract";
import { Hash, ReproductionBadge } from "./Provenance";

/**
 * A rendered statement: opening balance, the lines, closing balance.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THIS THE DOCUMENT AND NOT A REPORT
 * ---------------------------------------------------------------------------
 *
 * Every figure on screen is re-derived from the ledger on this page load, at
 * the watermark the document was pinned to, and the footer shows that the
 * result hashed to the value stored when it was issued. The stored
 * `closing_balance_cents` is shown beside it as a cross-check rather than as
 * the source: printing the stored number would prove nothing, and printing
 * only the derived number would leave the stored one unexamined.
 *
 * Reversals are shown, never hidden. A statement that quietly nets a
 * correction against its original is a statement nobody can audit, and the
 * whole reason this ledger corrects by reversal-plus-rebook rather than by
 * edit is so that the three rows exist to be shown.
 *
 * The running balance is a fold over the lines in `(value date, booking seq,
 * ordinal)` order — the same total order the content hash is taken over, so
 * what the reader sees down the right-hand column is literally what was
 * hashed.
 */
export function StatementDocument({
  document,
  published,
  reproduced,
  formatChanged,
  recomputedHash,
  title,
  description,
  highlightLate = false,
}: {
  readonly document: DocumentView;
  /** `null` for the as-corrected rendering: it is a query, not a document. */
  readonly published: PublishedStatementView | null;
  readonly reproduced?: boolean;
  readonly formatChanged?: boolean;
  readonly recomputedHash?: string;
  readonly title: string;
  readonly description: string;
  /** Mark lines booked above the published watermark. Only meaningful as-corrected. */
  readonly highlightLate?: boolean;
}) {
  return (
    <Panel
      title={title}
      description={description}
      actions={
        published === null ? (
          <Badge tone="quiet" title="A live query, not an issued document">
            NOT A DOCUMENT
          </Badge>
        ) : (
          <ReproductionBadge
            reproduced={reproduced === true}
            formatChanged={formatChanged === true}
          />
        )
      }
    >
      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Statement lines for {formatDate(document.periodStart)}, in value-date
            then booking order, with a running balance
          </caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH_CLASS}>
                Value date
              </th>
              <th scope="col" className={TH_CLASS}>
                Description
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Booked at
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Amount
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Balance
              </th>
            </tr>
          </thead>

          <tbody>
            <tr className="border-b border-border">
              <td className={`${TD_CLASS} text-muted`} colSpan={4}>
                Opening balance
                <span className="mt-0.5 block text-xs text-muted">
                  everything before {formatDate(document.periodStart)}, as known at
                  watermark {document.bookingWatermark}
                </span>
              </td>
              <td className={`${TD_CLASS} text-right`}>
                <Money cents={document.openingBalanceCents} />
              </td>
            </tr>

            {document.lines.length === 0 ? (
              <tr className="border-b border-border">
                <td className={`${TD_CLASS} text-center text-muted`} colSpan={5}>
                  No postings on this day.
                </td>
              </tr>
            ) : (
              document.lines.map((line) => {
                const late = highlightLate && line.late;
                return (
                  <tr
                    key={line.id}
                    className={`border-b border-border ${late ? "bg-surface-raised" : ""}`}
                  >
                    <td className={`${TD_CLASS} whitespace-nowrap`}>
                      {formatDate(line.valueDate)}
                    </td>

                    <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                      <span className="flex flex-wrap items-center gap-2">
                        {line.description}
                        {line.entryType === "reversal" ? (
                          <Badge tone="negative" title="Negates an earlier entry at its own value date">
                            REVERSAL
                          </Badge>
                        ) : null}
                        {line.entryType === "rebook" ? (
                          <Badge tone="neutral" title="The corrected posting that replaced a reversed one">
                            RE-BOOK
                          </Badge>
                        ) : null}
                        {late ? (
                          <Badge tone="negative" title="Booked after this day was closed">
                            AFTER THE CLOSE
                          </Badge>
                        ) : null}
                      </span>
                      {line.externalRef === null ? null : (
                        <span className="mt-0.5 block font-mono text-xs text-muted">
                          {line.externalRef}
                          {line.rail === null ? null : ` · ${line.rail}`}
                        </span>
                      )}
                    </th>

                    <td className={`${TD_CLASS} text-right tabular-nums text-xs text-muted`}>
                      seq {line.bookingSeq}
                    </td>

                    <td className={`${TD_CLASS} text-right`}>
                      <Money cents={line.amountCents} tone="direction" signed />
                    </td>

                    <td className={`${TD_CLASS} text-right`}>
                      <Money cents={line.runningBalanceCents} />
                    </td>
                  </tr>
                );
              })
            )}

            <tr>
              <td className={`${TD_CLASS} font-medium`} colSpan={4}>
                Closing balance
                <span className="mt-0.5 block text-xs font-normal text-muted">
                  {document.lineCount} line{document.lineCount === 1 ? "" : "s"} at
                  watermark {document.bookingWatermark}
                </span>
              </td>
              <td className={`${TD_CLASS} text-right font-medium`}>
                <Money cents={document.closingBalanceCents} />
              </td>
            </tr>
          </tbody>
        </table>
      </TableScroll>

      {published === null ? (
        <FooterNote>
          A live query at the current watermark, not a published document. It has
          no version and no hash because nothing has been issued at this
          watermark — issuing it is what <code>reissueStatement</code> does, and
          that is an operator action with an actor attached, not a render.
        </FooterNote>
      ) : (
        <PublishedFooter
          published={published}
          document={document}
          reproduced={reproduced === true}
          recomputedHash={recomputedHash ?? published.contentHash}
        />
      )}
    </Panel>
  );
}

function FooterNote({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="border-t border-border px-5 py-4">
      <p className="max-w-prose text-[11px] leading-relaxed text-muted">{children}</p>
    </div>
  );
}

/**
 * The evidence strip.
 *
 * Five facts, and every one of them is checkable by someone else: which
 * watermark the document is pinned to, what it hashes to, what re-deriving it
 * just produced, which renderer produced the stored value, and who issued it
 * when. The stored closing balance is shown next to the derived one for the
 * same reason — two numbers that must agree, both on screen.
 */
function PublishedFooter({
  published,
  document,
  reproduced,
  recomputedHash,
}: {
  readonly published: PublishedStatementView;
  readonly document: DocumentView;
  readonly reproduced: boolean;
  readonly recomputedHash: string;
}) {
  const storedAgrees = published.closingBalanceCents === document.closingBalanceCents;

  return (
    <div className="border-t border-border px-5 py-4">
      <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-[11rem_1fr]">
        <dt className="text-muted">Pinned to</dt>
        <dd className="tabular-nums">
          booking watermark {published.bookingWatermark} · frozen at the day close
        </dd>

        <dt className="text-muted">Content hash</dt>
        <dd>
          <Hash value={published.contentHash} label="stored content hash" />
          <span className="ml-2 text-muted">stored</span>
        </dd>

        <dt className="text-muted">Re-derived just now</dt>
        <dd>
          <Hash value={recomputedHash} label="recomputed content hash" />
          <span className={`ml-2 ${reproduced ? "text-muted" : "text-negative"}`}>
            {reproduced ? "identical" : "DOES NOT MATCH"}
          </span>
        </dd>

        <dt className="text-muted">Renderer</dt>
        <dd className="font-mono">{published.format}</dd>

        <dt className="text-muted">Issued</dt>
        <dd>
          v{published.version} · {formatTimestamp(published.generatedAt)} ·{" "}
          {published.generatedBy}
        </dd>

        <dt className="text-muted">Stored closing figure</dt>
        <dd>
          <Money cents={published.closingBalanceCents} />
          <span className={`ml-2 ${storedAgrees ? "text-muted" : "text-negative"}`}>
            {storedAgrees
              ? "agrees with the re-derived fold"
              : "DISAGREES with the re-derived fold"}
          </span>
        </dd>
      </dl>

      <p className="mt-3 max-w-prose text-[11px] leading-relaxed text-muted">
        Re-rendering this document at watermark {published.bookingWatermark}{" "}
        produces the same bytes forever. Every row below that watermark is
        immutable, and no row can appear below it later — <code>booking_seq</code>{" "}
        is drawn while holding the ledger append lock, so sequence order is
        commit order. Corrections do not change this document; they produce a
        new version.
      </p>
    </div>
  );
}
