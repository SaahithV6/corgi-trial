import { Money } from "@/components/ui/Money";
import { Badge, FieldLabel } from "@/components/ui/primitives";
import { formatDate, formatTimestamp } from "@/lib/format/datetime";

import type { BothReadingsView } from "./data-contract";

/**
 * THE HEADLINE: both time axes, as two numbers a person can see at once.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A ROW OF THREE AND NOT A FIGURE WITH A FOOTNOTE
 * ---------------------------------------------------------------------------
 *
 * The layout has to make the argument before any of the prose does. The
 * as-believed number is not stale and the as-corrected number is not
 * authoritative: they answer two different questions and they are both true at
 * the same instant. Two equal columns say that. A big number with an asterisk
 * says the opposite, and a reader takes the layout's word over the caption's.
 *
 * The middle tile is the DIFFERENCE, and it is signed and stated rather than
 * left to be subtracted by eye. `-$73.40` means this day is worth seventy-three
 * dollars forty LESS to the customer than we believed at the anchor on the
 * left. Direction is the first thing anybody asks and the last thing a screen
 * should make them work out.
 *
 * ---------------------------------------------------------------------------
 * IT HAS TO READ WELL ON A DAY THAT WAS NEVER CORRECTED
 * ---------------------------------------------------------------------------
 *
 * Which is the overwhelmingly common case. So when the two agree the middle
 * tile says `none` in words, not `$0.00` — a zero leaves it ambiguous whether
 * the comparison ran at all — and the caption says what that means: nothing
 * with this value date has been booked above the anchor. A screen that only
 * makes sense on corrected days is a screen nobody trusts on the other three
 * hundred and sixty-four.
 *
 * ---------------------------------------------------------------------------
 * THE WATERMARKS ARE ON THE FACE, NOT IN A TOOLTIP
 * ---------------------------------------------------------------------------
 *
 * Every figure here is `(value date, booking watermark)`. Printing the money
 * without the watermark would be printing half of each fact — and the
 * watermark is the half that makes the reading reproducible, because every row
 * at or below it is immutable and no row can appear below it later.
 */
export function BothReadings({ view }: { readonly view: BothReadingsView }) {
  const { believed, corrected, deltaCents, differs, valueDate } = view;

  return (
    <div className="space-y-3">
      <div className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
        <Figure
          label={believed.label}
          value={believed.closingBalanceCents}
          watermark={believed.bookingWatermark}
          detail={believedCaption(view)}
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
              ? view.explained
                ? `Accounted for, entry by entry, by ${view.acts.length} later ${
                    view.acts.length === 1 ? "act" : "acts"
                  } below.`
                : "NOT fully accounted for by the entries below. Treat this as an incident."
              : "Nothing with this value date has been booked above the left-hand watermark. The two readings are one reading."}
            <span className="mt-0.5 block tabular-nums">
              as corrected − {believed.label.toLowerCase()}
            </span>
          </p>
        </div>

        <Figure
          label="As corrected"
          value={corrected.closingBalanceCents}
          watermark={corrected.bookingWatermark}
          detail={`What we now know ${formatDate(valueDate)} to be, using everything learned since.`}
        />
      </div>

      <Publication view={view} />
    </div>
  );
}

/**
 * What the left-hand figure IS, in one sentence, named by its anchor.
 *
 * Four anchors, four genuinely different claims. "What the document said" and
 * "what we had signed off" and "what we believed one instant before the
 * reversal" are not paraphrases of each other, and a caption that blurred them
 * would undo the work the anchor picker does.
 */
function believedCaption(view: BothReadingsView): string {
  const day = formatDate(view.valueDate);
  switch (view.anchor) {
    case "published":
      return `What the statement for ${day} said when it was issued.`;
    case "close":
      return `What ${day} closed at when the business day was signed off.`;
    case "before":
      return `What ${day} closed at one instant before we learned otherwise.`;
    case "now":
      return `${day} at the same watermark as the reading on the right: there is nothing earlier to stand at.`;
  }
}

function Figure({
  label,
  value,
  watermark,
  detail,
}: {
  readonly label: string;
  readonly value: number;
  readonly watermark: number;
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
        <span className="mt-0.5 block tabular-nums">booking watermark {watermark}</span>
      </p>
    </div>
  );
}

/**
 * Whether the left-hand reading is a document somebody issued, or only a
 * reading somebody can reproduce.
 *
 * Rendered on every load, in both directions, because "as published" is a
 * claim about an act — we sent this to a customer — and "as believed" is a
 * claim about the ledger. Letting the reader guess which one they are looking
 * at from the column heading alone would be exactly the ambiguity this screen
 * exists to remove, and an unpublished day silently borrowing the word
 * "published" would be the worst version of it.
 */
function Publication({ view }: { readonly view: BothReadingsView }) {
  const { published, learnedAt, believed } = view;

  if (published !== null) {
    return (
      <p className="max-w-prose text-[11px] leading-relaxed text-muted">
        <Badge tone="neutral">AS PUBLISHED</Badge>{" "}
        <span className="ml-1">
          The left-hand reading is a document that went out: version{" "}
          {published.version}, issued {formatTimestamp(published.generatedAt)} by{" "}
          {published.generatedBy}, at booking watermark {published.bookingWatermark}. It
          was re-derived from the ledger on this page load and{" "}
          {view.reproduced ? "hashed to the stored value" : "did NOT hash to the stored value"}.
          {learnedAt === null
            ? " Nothing has been booked above that watermark since."
            : ` We learned otherwise at ${formatTimestamp(learnedAt)}, and the correction was appended at the original value date rather than applied to this document.`}
        </span>
      </p>
    );
  }

  return (
    <p className="max-w-prose text-[11px] leading-relaxed text-muted">
      <Badge tone="quiet">NOT PUBLISHED</Badge>{" "}
      <span className="ml-1">
        No statement has been issued for {formatDate(view.valueDate)}, so there is no{" "}
        <em>as published</em> document to put on the left. The reading there is{" "}
        <em>as believed</em>: the same ledger, the same value date, read at booking
        watermark {believed.bookingWatermark}. Issuing a document at that watermark
        would produce exactly those figures and exactly that hash — publishing is an
        operator action with an actor attached, not something a render may do.
        {learnedAt === null
          ? ""
          : ` We learned otherwise at ${formatTimestamp(learnedAt)}.`}
      </span>
    </p>
  );
}
