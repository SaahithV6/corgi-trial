import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";

import type { AnchorOptionView, BothReadingsView } from "./data-contract";
import { statementHref, type StatementFilter } from "./view-state";

/**
 * Where the LEFT-HAND column stands on the booking axis.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A CONTROL AND NOT A CONSTANT
 * ---------------------------------------------------------------------------
 *
 * "What did we believe" is not one question. It is a family of questions
 * indexed by a point in transaction time, and the interesting ones are
 * different on different days: on a stated day it is "what did the document
 * say", on a closed-but-unstated day it is "what had we signed off", and on a
 * day that is still open — which is where a correction that arrived this
 * morning actually lives — it is "what did we believe one instant before the
 * reversal landed".
 *
 * Making that a link rather than a hidden default means the reader can move
 * the booking axis themselves and watch the right-hand column stay still,
 * which is the fastest way to understand that there are two axes at all.
 *
 * ---------------------------------------------------------------------------
 * UNAVAILABLE ANCHORS ARE STILL SHOWN
 * ---------------------------------------------------------------------------
 *
 * Greyed, unlinked, with the reason in the tooltip and the watermark column
 * blank. "No statement was ever issued for this day" is a fact the reader
 * needs; a chip that quietly disappears communicates nothing at all. Same
 * argument the breaks screen makes about a break whose net is zero.
 */
export function AnchorPicker({
  view,
  filter,
}: {
  readonly view: BothReadingsView;
  readonly filter: StatementFilter;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="w-24 shrink-0 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        Read as at
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {view.anchors.map((option) => (
          <Anchor
            key={option.anchor}
            option={option}
            current={option.anchor === view.anchor}
            filter={filter}
          />
        ))}
      </div>
    </div>
  );
}

function Anchor({
  option,
  current,
  filter,
}: {
  readonly option: AnchorOptionView;
  readonly current: boolean;
  readonly filter: StatementFilter;
}) {
  const body = (
    <>
      {option.label}
      <span className="tabular-nums text-[10px] text-muted">
        {option.bookingWatermark === null ? "—" : `seq ${option.bookingWatermark}`}
      </span>
    </>
  );

  if (!option.available) {
    return (
      <span
        title={option.note}
        aria-disabled="true"
        className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted/60"
      >
        {body}
      </span>
    );
  }

  return (
    <Link
      href={statementHref(filter, { anchor: option.anchor })}
      aria-current={current ? "true" : undefined}
      title={option.note}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${FOCUS_RING} ${
        current
          ? "border-border-strong bg-surface-raised font-medium text-text"
          : "border-border text-muted hover:text-text"
      }`}
    >
      {body}
    </Link>
  );
}
