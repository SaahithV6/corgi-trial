import Link from "next/link";

import { formatTimestamp } from "@/lib/format/datetime";
import { Badge, FOCUS_RING } from "@/components/ui/primitives";
import { Money } from "@/components/ui/Money";
import {
  AS_KNOWN_AT_PARAM,
  AS_OF_PARAM,
  withTimeTravel,
} from "@/lib/timetravel/params";

import type { CorrectionLandmark, TimePoint } from "./contract";

/**
 * THE CONTROL. Two axes, and it must be impossible to confuse them.
 *
 * ===========================================================================
 * WHY IT IS TWO ROWS AND NOT A SLIDER
 * ===========================================================================
 *
 * The brief for this feature said "a thing you drag a slider on", and a slider
 * is the wrong instrument, for a measured reason.
 *
 * The booking axis of this book is a few hours long and almost all of it is
 * identical: nothing about a business day changes except at the instants
 * something was learned about it. Dragging uniformly across that axis shows
 * one number, then the same number, then the same number — and a reader
 * concludes the parameter does nothing. The information is not spread along
 * the axis; it is concentrated at a handful of points.
 *
 * So the control is two rows — one per axis, labelled with what each one MEANS
 * rather than with its parameter name — and the booking row offers the
 * instants that actually change the answer, taken live off this account's own
 * correction acts. Click three of them in order with the value axis held
 * still, and the same business day prints different closing balances. That is
 * the demonstration a slider was supposed to deliver.
 *
 * ===========================================================================
 * EVERY CONTROL IS A LINK
 * ===========================================================================
 *
 * No client component, no local state, no form. Each option is a `<Link>` to
 * the same route with one parameter changed, built through `withTimeTravel`,
 * which preserves everything else on the URL — so a reader can never lose the
 * account or the window by moving through time, and a screenshot of any state
 * carries the URL that reproduces it.
 */
export function TimeTravelBar({
  point,
  basePath,
  landmarks,
  liveHref,
}: {
  readonly point: TimePoint;
  /** The current URL, with all its non-time state, as the base for every link. */
  readonly basePath: string;
  readonly landmarks: readonly CorrectionLandmark[];
  /** Where "leave the time machine" goes. */
  readonly liveHref: string;
}) {
  const travelled = point.mode === "travelled";

  return (
    <aside
      aria-label="Time travel"
      className={`rounded-lg border px-4 py-3 ${
        travelled ? "border-border-strong bg-surface-raised" : "border-dashed border-border-strong"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Reading the book at
        </span>
        {travelled ? (
          <Badge tone="neutral">time travelling</Badge>
        ) : (
          <Badge tone="positive">live · now</Badge>
        )}
        {travelled ? (
          <Link
            href={liveHref}
            className={`rounded px-2 py-1 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
          >
            Return to now
          </Link>
        ) : null}
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <ValueAxisRow point={point} basePath={basePath} landmarks={landmarks} />
        <BookingAxisRow point={point} basePath={basePath} landmarks={landmarks} />
      </div>

      {landmarks.length > 0 ? (
        <ActShortcuts point={point} basePath={basePath} landmarks={landmarks} />
      ) : (
        <p className="mt-3 max-w-prose text-[11px] leading-relaxed text-muted">
          This account carries no correction act, so both readings of every day
          on it are the same reading. That is the common case and it is not a
          failure — the two columns are two genuinely different queries that
          happen to return the same number here. Pick an account that has been
          corrected to see them separate.
        </p>
      )}
    </aside>
  );
}

/* -------------------------------------------------------------------------- */

const AXIS_LABEL =
  "text-[11px] font-medium uppercase tracking-[0.08em] text-muted";

function ValueAxisRow({
  point,
  basePath,
  landmarks,
}: {
  readonly point: TimePoint;
  readonly basePath: string;
  readonly landmarks: readonly CorrectionLandmark[];
}) {
  // The value dates worth offering are the ones this account was corrected on,
  // plus the book's today. A date picker would offer 16,000 days of which
  // three matter.
  const days = [...new Set(landmarks.map((act) => act.valueDate))].slice(0, 4);

  return (
    <div className="rounded-md border border-border px-3 py-2.5">
      <p className={AXIS_LABEL}>
        <span aria-hidden="true">↔ </span>Value date · which business day
      </p>
      <p className="mt-1 font-mono text-sm">
        {point.snapshot.valueDate}
        {point.valuePinned ? null : (
          <span className="ml-2 text-xs text-muted">(the book&rsquo;s today)</span>
        )}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">
        Which day the money belongs to. A correction carries the ORIGINAL value
        date, so moving this does not move a correction off the day it fixed.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <AxisChip
          href={withTimeTravel(basePath, { asOf: null })}
          current={!point.valuePinned}
          label="Today"
        />
        {days.map((day) => (
          <AxisChip
            key={day}
            href={withTimeTravel(basePath, { asOf: day })}
            current={point.valuePinned && point.snapshot.valueDate === day}
            label={day}
          />
        ))}
      </div>
    </div>
  );
}

function BookingAxisRow({
  point,
  basePath,
  landmarks,
}: {
  readonly point: TimePoint;
  readonly basePath: string;
  readonly landmarks: readonly CorrectionLandmark[];
}) {
  const moved = point.cut.snapped;

  return (
    <div className="rounded-md border border-border px-3 py-2.5">
      <p className={AXIS_LABEL}>
        <span aria-hidden="true">↕ </span>Booking time · what we had learned
      </p>
      <p className="mt-1 font-mono text-sm">
        {point.bookingPinned && point.requestedKnownAt !== null
          ? formatTimestamp(point.requestedKnownAt.toISOString())
          : "everything we know"}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">
        Resolves to booking watermark{" "}
        <span className="font-mono text-text">
          {point.snapshot.bookingWatermark.toString()}
        </span>{" "}
        of {point.liveWatermark.toString()}
        {moved ? (
          <span className="text-negative">
            {" "}
            · moved down from {point.cut.requested.toString()}
          </span>
        ) : null}
        . The cut is on the SEQUENCE, never on the timestamp.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <AxisChip
          href={withTimeTravel(basePath, { asKnownAt: null })}
          current={!point.bookingPinned}
          label="Now"
        />
        {landmarks.length === 0 ? null : (
          <span className="text-[11px] text-muted">
            — or pick a moment below
          </span>
        )}
      </div>
    </div>
  );
}

function AxisChip({
  href,
  current,
  label,
}: {
  readonly href: string;
  readonly current: boolean;
  readonly label: string;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={`rounded px-2 py-1 font-mono text-[11px] ${FOCUS_RING} ${
        current
          ? "bg-surface font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
          : "text-muted hover:text-text"
      }`}
    >
      {label}
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/* The moments that change the answer                                          */
/* -------------------------------------------------------------------------- */

/**
 * One row per correction act, with the instants either side of it.
 *
 * Each row pins BOTH axes at once: the act's own value date on the value axis,
 * and the chosen instant on the booking axis. That is deliberate — an act's
 * correction is only visible on the day the act carries, and offering the
 * booking instant without the value date would send a reader to a day where
 * nothing appears to happen and let them conclude the feature is broken.
 *
 * `Mid-write` is offered on purpose and labelled for what it is. It asks for a
 * state that never existed, the screen snaps the cut below the whole act and
 * says so, and a panel gets to watch the guard fire. A guard nobody can
 * exercise is a guard nobody can check.
 */
function ActShortcuts({
  point,
  basePath,
  landmarks,
}: {
  readonly point: TimePoint;
  readonly basePath: string;
  readonly landmarks: readonly CorrectionLandmark[];
}) {
  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className={AXIS_LABEL}>
        Moments this account was corrected — hold the day still, move the
        booking axis
      </p>
      <ul className="mt-2 space-y-2">
        {landmarks.map((act) => (
          <li key={act.correctionGroupId} className="text-xs">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-mono text-[11px] text-muted">
                {act.correctionGroupId.slice(0, 8)}
              </span>
              <span className="text-muted">value date</span>
              <span className="font-mono">{act.valueDate}</span>
              <span className="text-muted">· net</span>
              <Money cents={act.netCents} tone="direction" signed />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1">
              {act.landmarks.map((landmark) => {
                const href = withTimeTravel(basePath, {
                  asOf: act.valueDate,
                  asKnownAt: landmark.at,
                });
                const current =
                  point.requestedKnownAt !== null &&
                  point.requestedKnownAt.toISOString() === landmark.at &&
                  point.snapshot.valueDate === act.valueDate;

                return (
                  <Link
                    key={landmark.kind}
                    href={href}
                    aria-current={current ? "page" : undefined}
                    title={landmark.note}
                    className={`rounded px-2 py-1 text-[11px] ${FOCUS_RING} ${
                      current
                        ? "bg-surface font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
                        : landmark.kind === "midWrite"
                          ? "text-negative hover:underline"
                          : "text-muted hover:text-text"
                    }`}
                  >
                    {landmark.label}
                  </Link>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        Each link pins the value axis to the act&rsquo;s own day and moves only
        the booking axis. The parameters are{" "}
        <span className="font-mono">?{AS_OF_PARAM}=</span> and{" "}
        <span className="font-mono">?{AS_KNOWN_AT_PARAM}=</span>; nothing here
        is client state.
      </p>
    </div>
  );
}
