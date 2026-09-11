import { Money } from "@/components/ui/Money";
import { Badge, FieldLabel, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";
import { formatDate, formatTimestamp } from "@/lib/format/datetime";

import type { CorrectionStepView } from "./explain-contract";

/**
 * The causal timeline: original → reversal → re-book, with BOTH axes.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS COMPONENT IS FOR
 * ---------------------------------------------------------------------------
 *
 * A breaks table says "these two numbers differ". This says "here is what
 * happened, here is when we learned it, and here is where that leaves us". The
 * one fact it exists to put in front of an operator is in the two date columns
 * of the reversal row: the value date is the ORIGINAL's, and the booking date
 * is the day we found out. Those two columns sitting side by side, disagreeing,
 * on an immutable row, are the whole bitemporal claim — made concrete rather
 * than asserted in a README.
 *
 * ---------------------------------------------------------------------------
 * WHY A TABLE AND NOT A DRAWN TIMELINE
 * ---------------------------------------------------------------------------
 *
 * Because the axes are the content. A horizontal rail with three dots on it
 * has to choose ONE axis to lay out against, and whichever it chose would be
 * the claim this screen exists to complicate. A table gives both columns equal
 * weight, aligns the money, reads correctly in a screen reader, and can be
 * pasted into a ticket.
 *
 * Money is `Money`, which is `bigint` cents formatted through
 * `src/lib/format/money.ts`. There is no arithmetic in this file at all: the
 * running net arrives computed, in cents, from `buildTimeline`.
 */

const STEP_LABEL: Record<CorrectionStepView["entryType"], string> = {
  original: "Original",
  reversal: "Reversal",
  rebook: "Re-book",
};

const STEP_MEANING: Record<CorrectionStepView["entryType"], string> = {
  original: "What we booked when the event first reached us.",
  reversal: "Un-books the original in full. Carries the original's value date, not today's.",
  rebook: "The corrected posting, at the original's value date.",
};

export function CorrectionTimeline({
  steps,
  /** Rendered under the last row: what the file said, for the comparison. */
  fileAmountCents,
  /** True when the group has no re-book yet. Changes the closing sentence. */
  incomplete,
}: {
  readonly steps: readonly CorrectionStepView[];
  readonly fileAmountCents: number | null;
  readonly incomplete: boolean;
}) {
  if (steps.length === 0) {
    return (
      <p className="px-5 py-6 text-xs leading-relaxed text-muted">
        No journal entry stands behind this break, so there is no history to
        reconstruct. That is the shape of an{" "}
        <em>in file, not in ledger</em> break: the provider says it happened and
        we have nothing at all. The thing to explain is the absence.
      </p>
    );
  }

  const last = steps[steps.length - 1] as CorrectionStepView;

  return (
    <div>
      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            The correction group, oldest booking first, with the value date and
            the booking position of each entry
          </caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH_CLASS}>
                Step
              </th>
              <th scope="col" className={TH_CLASS}>
                Value date
                <span className="mt-0.5 block font-normal normal-case tracking-normal text-muted">
                  when it happened
                </span>
              </th>
              <th scope="col" className={TH_CLASS}>
                Booked
                <span className="mt-0.5 block font-normal normal-case tracking-normal text-muted">
                  when we learned
                </span>
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                On the rail
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Group nets to
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {steps.map((step) => (
              <tr key={step.entryId}>
                <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                  <span className="font-medium">{STEP_LABEL[step.entryType]}</span>
                  <span className="mt-0.5 block max-w-[36ch] text-xs text-muted">
                    {STEP_MEANING[step.entryType]}
                  </span>
                  <span className="mt-1 block font-mono text-[11px] text-muted">
                    {step.entryId}
                  </span>
                </th>

                <td className={TD_CLASS}>
                  <span className="tabular-nums">{formatDate(step.valueDate)}</span>
                </td>

                <td className={TD_CLASS}>
                  <span className="tabular-nums">{formatTimestamp(step.bookingTime)}</span>
                  <span className="mt-0.5 block text-xs text-muted">
                    seq {step.bookingSeq}
                  </span>
                  <BackdatedNote step={step} />
                </td>

                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={step.railCents} tone="direction" signed />
                </td>

                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={step.runningNetCents} tone="neutral" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>

      <div className="border-t border-border px-5 py-4">
        <FieldLabel>Where that leaves us</FieldLabel>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          The group nets to <Money cents={last.runningNetCents} tone="neutral" />
          {fileAmountCents === null ? (
            <> and the provider&rsquo;s file does not carry this reference at all.</>
          ) : (
            <>
              {" "}
              and the file says <Money cents={fileAmountCents} tone="neutral" />.
            </>
          )}{" "}
          {incomplete ? (
            <>
              There is no re-book yet, so the book is currently carrying nothing
              where the provider is carrying money. This is explainable and it is
              not resolved: the correction is half done and the second half is
              somebody&rsquo;s open item.
            </>
          ) : fileAmountCents !== null && last.runningNetCents === fileAmountCents ? (
            <>
              The two agree, so the difference on the break row is the record of
              a mistake we have already corrected — not money anybody has to
              chase.
            </>
          ) : (
            <>
              They do not agree, so the correction is part of this story and not
              the whole of it. The remainder is a live break.
            </>
          )}
        </p>
      </div>
    </div>
  );
}

/**
 * The gap between the two axes, stated in days, on the row where it exists.
 *
 * Zero is not rendered: a posting booked on its own value date is unremarkable
 * and a badge on every row would drain the meaning from the one that matters.
 * A NEGATIVE gap is rendered, and differently — it means the book learned
 * about money before its value date, which is a warehoused ACH effective date
 * or a synthetic business date from a live-fire file, and an operator seeing
 * one should know it is not a backdated correction.
 */
function BackdatedNote({ step }: { readonly step: CorrectionStepView }) {
  if (step.backdatedDays === 0) return null;

  if (step.backdatedDays < 0) {
    return (
      <span className="mt-1 inline-block">
        <Badge tone="quiet" title="The value date is in the future relative to the booking">
          forward-dated {-step.backdatedDays}d
        </Badge>
      </span>
    );
  }

  return (
    <span className="mt-1 inline-block">
      <Badge
        tone="neutral"
        title="Booked this many days after the value date it carries"
      >
        backdated {step.backdatedDays}d
      </Badge>
    </span>
  );
}
