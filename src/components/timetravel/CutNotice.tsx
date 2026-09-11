import { formatTimestamp } from "@/lib/format/datetime";
import { Note } from "@/components/ui/primitives";

import type { TimePoint } from "./contract";

/**
 * THE GUARD, ANNOUNCED WHEN IT FIRES.
 *
 * A cut that moved and did not say so would be the same class of lie as the
 * one it prevents: the screen would answer a different question from the one
 * in the URL, silently. So when `observableWatermark()` moves the watermark
 * down, this says by how much and why, and it names the state it refused to
 * render.
 *
 * It also states the LIMIT of the guarantee, always — not only when the guard
 * fires. "No correction act is split" is provable from named readers and is
 * proved. "The cut falls on a transaction boundary" is not provable outside
 * `src/lib/ledger/**`, because the ledger records `booking_seq` and records
 * nothing about which entries committed together. A screen that showed the
 * first and implied the second would be overclaiming, and this build fails
 * harder for a false label than for a missing feature.
 */
export function CutNotice({ point }: { readonly point: TimePoint }) {
  const { cut } = point;

  if (cut.snapped) {
    const moved = cut.requested - cut.effective;
    return (
      <Note emphasis title="The cut was moved down — that state never existed">
        <p>
          <span className="font-mono text-text">?asKnownAt=</span> resolved to
          booking watermark{" "}
          <span className="font-mono text-text">{cut.requested.toString()}</span>
          , which falls INSIDE an atomic write. It was moved down{" "}
          {moved.toString()} position{moved === 1n ? "" : "s"} to{" "}
          <span className="font-mono text-text">{cut.effective.toString()}</span>
          , below the whole act.
        </p>
        <ul className="mt-2 space-y-1.5">
          {cut.straddled.map((act) => (
            <li key={act.correctionGroupId}>
              <span className="font-mono text-text">
                {act.correctionGroupId.slice(0, 8)}
              </span>{" "}
              — a reversal and its re-book were written by ONE transaction,{" "}
              {act.intraWriteGapMs}ms apart on the wall clock. Cutting between
              them would have shown{" "}
              <span className="text-text">
                seq {act.presentSeqs.join(", ")} without seq{" "}
                {act.missingSeqs.join(", ")}
              </span>{" "}
              — the settlement reversed and nothing put back.
            </li>
          ))}
        </ul>
        <p className="mt-2">
          <span className="text-text">Down, never up.</span> `booking_time` is
          stamped before the transaction commits, so an instant inside a write
          is an instant at which none of that write had been learned. Excluding
          all of it is what was true; snapping forward would have invented
          knowledge.
        </p>
      </Note>
    );
  }

  return (
    <Note title="What this cut is proved to be">
      <p>
        The cut is on{" "}
        <span className="font-mono text-text">booking_seq &le; {point.snapshot.bookingWatermark.toString()}</span>
        , not on a timestamp.{" "}
        {point.requestedKnownAt === null ? null : (
          <>
            You asked about{" "}
            {formatTimestamp(point.requestedKnownAt.toISOString())}
            {point.watermarkBookedAt === null ? null : (
              <>
                ; the last thing this book had learned by then was booked at{" "}
                {formatTimestamp(point.watermarkBookedAt.toISOString())}
              </>
            )}
            .{" "}
          </>
        )}
      </p>
      <p className="mt-1.5">
        <span className="text-text">Proved:</span> {cut.proves} — checked
        against every act within {cut.scanPositions.toString()} booking
        positions above the cut, each read back whole.{" "}
        <span className="text-text">Not proved:</span> {cut.cannotProve}. The
        ledger records which position an entry took and nothing about which
        entries committed together, so a bulk write whose entries carry
        different correction groups could still be split. One such write exists
        on this book. See <span className="font-mono">docs/TIMETRAVEL.md</span>.
      </p>
    </Note>
  );
}

/**
 * The inversion detector, reported only when it actually fires.
 *
 * `bookingWatermarkAt` is `MAX(booking_seq) WHERE booking_time <= t`, which is
 * correct only while `booking_seq` is monotone in `booking_time`. Nothing in
 * the schema enforces that, and two concurrent appends can break it. Measured
 * on this book: zero inversions across 2,432 entries — so this renders
 * nothing, today, and would render something the day that stops being true.
 */
export function PrefixLeakNotice({ overshootMs }: { readonly overshootMs: number }) {
  return (
    <Note emphasis title="This reading includes something we had not learned">
      <p>
        The entry sitting at the watermark was booked {overshootMs}ms AFTER the
        instant you asked about. `booking_seq` and `booking_time` have gone out
        of order — two concurrent appends can do this, and nothing in the schema
        forbids it — so the prefix{" "}
        <span className="font-mono text-text">booking_seq &le; W</span> contains
        an entry that was not yet known at that moment. Every figure below
        overstates our knowledge by at least that entry.
      </p>
      <p className="mt-1.5">
        This is reported, not repaired. Choosing a different watermark here
        would put this screen out of step with the agent surface and the
        statements screen, which both use the same reader — replacing one wrong
        number with two different ones. The fix belongs in{" "}
        <span className="font-mono">src/lib/ledger/</span>, once, with every
        caller present.
      </p>
    </Note>
  );
}
