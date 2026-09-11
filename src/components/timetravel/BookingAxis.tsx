import { formatTimestamp } from "@/lib/format/datetime";
import { Money } from "@/components/ui/Money";
import { Badge, Panel } from "@/components/ui/primitives";

import type { PendingAct, TimePoint } from "./contract";

/**
 * THE PICTURE THAT MAKES THE TWO AXES DIFFERENT THINGS.
 *
 * ===========================================================================
 * THE ONE IDEA THIS HAS TO CARRY
 * ===========================================================================
 *
 * Two numbers for one business day is a confusing claim until you can see WHY
 * there are two, and the reason is geometric: a correction sits at the SAME
 * position on the value axis as the thing it corrects, and a STRICTLY HIGHER
 * position on the booking axis. Same day, later knowledge. Nothing was edited;
 * something was added above.
 *
 * So this renders the booking axis VERTICALLY, newest at the top, with the
 * reader's cut drawn through it as a line. Every act above the line shows the
 * same value date as the day being read — printed on every row, so the "same
 * x, different y" is on the page rather than in a caption.
 *
 * Cross the line and the day's closing balance changes by exactly the acts you
 * crossed. That identity is asserted numerically elsewhere on the screen; this
 * is where it becomes obvious.
 *
 * ===========================================================================
 * WHY A VERTICAL LIST AND NOT A SCATTER PLOT
 * ===========================================================================
 *
 * A two-dimensional plot of (value date, booking time) is the honest shape of
 * the model and it is unreadable here: this book's value dates span 1980 to
 * 2027 while its booking times span a few hours, so every point collapses onto
 * one horizontal line. The list keeps the vertical axis — the one that carries
 * the information — and states the horizontal coordinate as text on each row.
 */
export function BookingAxis({
  point,
  pending,
  valueDate,
}: {
  readonly point: TimePoint;
  readonly pending: readonly PendingAct[];
  readonly valueDate: string;
}) {
  return (
    <Panel
      title="The booking axis, with your cut drawn through it"
      description="Newest at the top. Everything above the line had not been learned at the point you are standing at; everything below it had. Each act carries the value date of the thing it corrects — the same day you are reading."
      actions={
        point.mode === "travelled" ? (
          <Badge tone="neutral">travelled</Badge>
        ) : (
          <Badge tone="positive">live</Badge>
        )
      }
    >
      <div className="px-5 py-4">
        <ol className="space-y-0">
          <li className="flex items-baseline gap-3 pb-2">
            <span className="w-24 shrink-0 text-right font-mono text-[11px] text-muted">
              {point.liveWatermark.toString()}
            </span>
            <span className="text-xs text-muted">
              the top of the book — everything we have learned
            </span>
          </li>

          {pending.length === 0 ? (
            <li className="flex items-baseline gap-3 py-2">
              <span className="w-24 shrink-0" />
              <span className="max-w-prose text-xs text-muted">
                Nothing was learned about {valueDate} after your cut. The two
                readings of this day are the same reading — which is the common
                case, and is a fact about this day rather than a failure of the
                control.
              </span>
            </li>
          ) : (
            pending.map((act) => (
              <li
                key={act.correctionGroupId}
                className="flex items-baseline gap-3 border-l-2 border-border py-2 pl-3"
              >
                <span className="w-24 shrink-0 text-right font-mono text-[11px] text-muted">
                  {act.entries.map((entry) => entry.bookingSeq.toString()).join(", ")}
                </span>
                <div className="min-w-0">
                  <p className="text-xs">
                    <span className="font-mono text-[11px] text-muted">
                      {act.correctionGroupId.slice(0, 8)}
                    </span>{" "}
                    <span className="text-muted">value date</span>{" "}
                    <span className="font-mono">{act.valueDate}</span>
                    {act.valueDate === valueDate ? (
                      <span className="ml-1.5 text-[10px] uppercase tracking-[0.08em] text-muted">
                        · the day you are reading
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    learned {formatTimestamp(act.learnedAt)} ·{" "}
                    {act.entries.map((entry) => entry.entryType).join(" + ")} ·{" "}
                    <Money cents={act.netCents} tone="direction" signed />
                  </p>
                </div>
              </li>
            ))
          )}

          {/* THE CUT. Drawn, labelled, and carrying its own number. */}
          <li className="relative my-1 flex items-center gap-3 border-t-2 border-dashed border-border-strong pt-2">
            <span className="w-24 shrink-0 text-right font-mono text-[11px] font-medium">
              {point.snapshot.bookingWatermark.toString()}
            </span>
            <span className="text-xs font-medium">
              you are standing here
              {point.requestedKnownAt === null ? null : (
                <span className="ml-1.5 font-normal text-muted">
                  · {formatTimestamp(point.requestedKnownAt.toISOString())}
                </span>
              )}
            </span>
          </li>

          <li className="flex items-baseline gap-3 pt-2">
            <span className="w-24 shrink-0 text-right font-mono text-[11px] text-muted">
              1
            </span>
            <span className="text-xs text-muted">
              the first entry ever booked — everything below the line is in the
              figures on this page
            </span>
          </li>
        </ol>
      </div>
    </Panel>
  );
}
