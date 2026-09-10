import { Money } from "@/components/ui/Money";
import { FieldLabel } from "@/components/ui/primitives";
import { formatDate } from "@/lib/format/datetime";

import type { StatementDetailView } from "./data-contract";

/**
 * The headline: both figures, side by side, neither subordinate to the other.
 *
 * This is the single most demoable thing in the track, so the layout says the
 * argument before any of the prose does — two equal columns, not a figure and
 * a footnote. The as-published number is not stale and the as-corrected number
 * is not authoritative; they answer different questions and they are both
 * true.
 *
 * The middle tile is the difference, and it is signed. `+$50.00` means the day
 * is worth fifty dollars MORE to the customer than the document they received
 * said. That direction is the first thing anybody asks and the last thing a
 * screen should make them work out.
 *
 * When the two agree, the difference tile says so explicitly rather than
 * rendering `$0.00` and leaving it ambiguous whether the comparison ran.
 */
export function BothReadings({
  detail,
  businessDate,
}: {
  readonly detail: StatementDetailView;
  readonly businessDate: string;
}) {
  const { published, publishedDocument, correctedDocument, deltaCents, differs } =
    detail;

  return (
    <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
      <Figure
        label="As published"
        value={publishedDocument.closingBalanceCents}
        note={`v${published.version}, at booking watermark ${published.bookingWatermark}`}
        detail={`What the statement for ${formatDate(businessDate)} said when it was issued.`}
      />

      <div
        className={`bg-surface px-5 py-4 ${
          differs ? "shadow-[inset_0_0_0_1px_var(--color-border-strong)]" : ""
        }`}
      >
        <FieldLabel>Difference</FieldLabel>
        <p className="mt-1.5 text-2xl leading-none tracking-tight">
          {differs ? (
            <Money cents={deltaCents} tone="direction" signed className="text-2xl" />
          ) : (
            <span className="text-2xl text-muted">none</span>
          )}
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-muted">
          {differs
            ? detail.explained
              ? `Accounted for, entry by entry, by ${detail.corrections.length} later ${
                  detail.corrections.length === 1 ? "act" : "acts"
                } below.`
              : "NOT fully accounted for by the entries below. Treat this as an incident."
            : "The ledger still says what the document said. Nothing landed after the close."}
        </p>
      </div>

      <Figure
        label="As corrected"
        value={correctedDocument.closingBalanceCents}
        note={`the book now, at watermark ${correctedDocument.bookingWatermark}`}
        detail={`What we now know ${formatDate(businessDate)} to be.`}
      />
    </div>
  );
}

function Figure({
  label,
  value,
  note,
  detail,
}: {
  readonly label: string;
  readonly value: number;
  readonly note: string;
  readonly detail: string;
}) {
  return (
    <div className="bg-surface px-5 py-4">
      <FieldLabel>{label}</FieldLabel>
      <p className="mt-1.5">
        <Money cents={value} className="text-2xl leading-none tracking-tight" />
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-muted">
        {detail}
        <span className="mt-0.5 block tabular-nums">{note}</span>
      </p>
    </div>
  );
}
