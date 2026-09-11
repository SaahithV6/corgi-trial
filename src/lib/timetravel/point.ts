/**
 * THE POINT — a request's two coordinates, resolved into a ledger snapshot.
 *
 * ===========================================================================
 * WHAT THE CUT IS DEFINED ON, AND WHY
 * ===========================================================================
 *
 * **THE CUT IS `booking_seq`. It is never `booking_time`.**
 *
 * `booking_seq` is the ledger's total order. `booking_time` is a stamp: it is
 * what a human can put in a URL, and it is nothing else. So `asKnownAt` is
 * resolved EXACTLY ONCE, here, into a single `bigint` watermark, and every
 * downstream read in this feature filters `booking_seq <= watermark`. No
 * screen, no reader and no component below this line ever sees the timestamp
 * as a predicate.
 *
 * Two reasons, one structural and one measured.
 *
 *   STRUCTURAL. `booking_time` does not order the book. Two entries may carry
 *   the same stamp; nothing in the schema forbids it. A predicate on a
 *   non-total order can include half of a tie and there is no total order to
 *   appeal to about which half. A predicate on `booking_seq` cannot, because
 *   `booking_seq` IS the order.
 *
 *   MEASURED. `bookingWatermarkAt()` — the existing reader, and the one this
 *   module calls — is `MAX(booking_seq) WHERE booking_time <= t`. That is
 *   already tie-safe: `MAX` over a set selected by a time predicate takes the
 *   whole tie or none of it, because every member of a tie satisfies the same
 *   predicate. What it is NOT immune to is a SEQUENCE INVERSION — an entry
 *   with a lower `booking_seq` and a later `booking_time`, which two
 *   concurrent `ledger_append()`s can produce if one calls `nextval` first and
 *   stamps `clock_timestamp()` second. Under an inversion the `MAX` leaks an
 *   entry we had not yet learned into the prefix.
 *
 *   Measured against this book on 2026-09-11: **0 inversions across 2,289
 *   entries, and 0 shared booking timestamps.** So the two definitions
 *   coincide today.
 *
 *   That measurement was taken by script, because there is no named reader for
 *   it — see `docs/TIMETRAVEL.md`, "what is missing". What this module CAN
 *   check live, on every travelled request, with a reader that does exist, is
 *   the leak AT THE CUT: `prefixLeak()` below compares `bookingTimeOfSeq(W)`
 *   with the instant asked about, and a watermark entry stamped LATER than the
 *   instant is an inversion that has reached the answer. The screen reports it
 *   rather than the module assuming it away. An assumption nobody measures is
 *   how a book acquires its first inversion unnoticed.
 *
 * ===========================================================================
 * THE ONE PLACE THE INSTANT SURVIVES, AND WHY IT MUST
 * ===========================================================================
 *
 * `LedgerSnapshot` carries THREE fields and only one of them is the cut:
 *
 *     valueDate         the VALUE axis        — `asOf`
 *     bookingWatermark  the BOOKING axis      — `asKnownAt`, resolved to a seq
 *     asOf  (an instant)                      — see below
 *
 * `snapshot.asOf` is not decoration. `accountAvailability()` evaluates the
 * HOLD RELEASE PREDICATE at it, because `hold_closure` carries `closed_at` and
 * no booking sequence — a hold closure is a fact whose only clock is a
 * timestamp. So availability at a past point genuinely needs both clocks, and
 * this module sets `snapshot.asOf` to the REQUESTED `asKnownAt` rather than to
 * the wall clock.
 *
 * That is the only coherent choice. `booking_seq <= watermark` and
 * `closed_at <= asKnownAt` are the same cut — "everything stamped at or before
 * this instant" — expressed on the two clocks the schema actually has. Setting
 * `snapshot.asOf` to the wall clock instead would evaluate today's closures
 * against a past ledger and release holds we had not yet released. Snapping it
 * DOWN to the booking time of the watermark entry would be worse in the other
 * direction: it would forget closures that genuinely happened between the last
 * posting and the instant asked about.
 *
 * `watermarkBookedAt` carries the snapped instant anyway, as a DISPLAY fact,
 * so a screen can say "you asked about 14:32:00; the last thing this book had
 * learned by then was entry 2,460, booked at 14:29:32." The gap between what
 * you asked and where the book was is information, not an error.
 *
 * ===========================================================================
 * THE CUT MUST LAND WHERE THE BOOK COULD BE OBSERVED
 * ===========================================================================
 *
 * `bookingWatermarkAt()` can return a position in the MIDDLE of one atomic
 * write. A reversal and its re-book are written by ONE transaction — measured,
 * 12 of 12 recent pairs share an `xmin` — and cutting between them renders a
 * state that never existed, as a coherent balance, under the reader's own
 * heading.
 *
 * So every travelled watermark goes through `observableWatermark()` in
 * `./integrity.ts`, which moves it DOWN below any correction act it would
 * otherwise split. Down, never up: `booking_time` is stamped before commit, so
 * an instant inside a write is an instant at which none of that write had been
 * learned. Both numbers survive on `TimePoint.cut`, so the screen can say the
 * cut moved and why instead of silently answering a different question.
 *
 * ===========================================================================
 * DEFAULT BEHAVIOUR IS UNCHANGED, AND IT IS UNCHANGED BY CONSTRUCTION
 * ===========================================================================
 *
 * With neither parameter present, `resolveTimePoint` returns `readSnapshot()`
 * verbatim: the same function, the same single query, the same three values,
 * no extra round trip. It is not "equivalent to" the default path — it IS the
 * default path. `point.test.ts` asserts the query text is the only one issued.
 */

import "server-only";

import {
  bookingWatermarkAt,
  historicSnapshot,
  readSnapshot,
  type LedgerSnapshot,
  type Sql,
} from "@/lib/ledger/balance-definitions";
import { bookingTimeOfSeq, currentBookingWatermark } from "@/lib/ledger/readers";

import { observableWatermark, type CutSafety } from "./integrity";
import type { RequestClock } from "./clock";
import { timeTravelQuery, type TimeTravelRequest } from "./params";

/* -------------------------------------------------------------------------- */
/* The point                                                                  */
/* -------------------------------------------------------------------------- */

export type TimeMode = "live" | "travelled";

export interface TimePoint {
  /** `live` when the URL pinned neither axis. */
  readonly mode: TimeMode;

  /**
   * The snapshot every read in this feature takes. Both axes, one instant.
   *
   * Handed unchanged to `accountAvailability`, `settledBalanceCents` and
   * `readAccountPeriod`, so a time-travelled figure and a live one come out of
   * the SAME function with a different argument — which is the entire claim.
   */
  readonly snapshot: LedgerSnapshot;

  /** The reader pinned the value axis. */
  readonly valuePinned: boolean;
  /** The reader pinned the booking axis. */
  readonly bookingPinned: boolean;
  /** `asKnownAt` lands before `asOf` begins: a belief about the future. */
  readonly foresight: boolean;

  /** The book's own today, whatever the reader asked for. */
  readonly liveValueDate: string;
  /** Everything the book has learned, whatever the reader asked for. */
  readonly liveWatermark: bigint;
  /** The wall clock this request was resolved against. */
  readonly resolvedAt: Date;

  /** Exactly the instant the URL asked about. `null` when the axis is open. */
  readonly requestedKnownAt: Date | null;
  /**
   * `booking_time` of the newest entry AT OR BELOW the watermark.
   *
   * A display fact, never a predicate. The distance between this and
   * `requestedKnownAt` is how long the book had been quiet when you asked.
   */
  readonly watermarkBookedAt: Date | null;

  /**
   * WHAT THE CUT IS ALLOWED TO BE, AND WHAT IT WAS ASKED TO BE.
   *
   * `asKnownAt` resolves to a raw watermark, and a raw watermark can land in
   * the middle of one atomic write. `./integrity.ts` proves that state was
   * never observable and moves the cut DOWN below the whole write. This
   * carries both numbers so the screen can say it happened rather than quietly
   * answering a different question than the one in the URL.
   */
  readonly cut: CutSafety;

  /** `?asOf=…&asKnownAt=…`, canonicalised. `""` when live. */
  readonly query: string;
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A request, resolved.
 *
 * The live path is one query. The travelled path is four, and all four are
 * named readers out of `src/lib/ledger/**` — this module writes no SQL of its
 * own, which is what keeps `src/lib/ledger/boundary.test.ts` green and is also
 * the reason there is exactly one definition of "the watermark at an instant"
 * rather than a second one written here.
 */
export async function resolveTimePoint(
  request: TimeTravelRequest,
  conn: Sql,
  clock: RequestClock,
): Promise<TimePoint> {
  const live = await readSnapshot(conn);

  if (request.absent) {
    return {
      mode: "live",
      snapshot: live,
      valuePinned: false,
      bookingPinned: false,
      foresight: false,
      liveValueDate: live.valueDate,
      liveWatermark: live.bookingWatermark,
      resolvedAt: clock.now(),
      requestedKnownAt: null,
      watermarkBookedAt: null,
      // The live watermark is the top of the book. Nothing can straddle it:
      // there is nothing above it to be the other half of a write.
      cut: {
        requested: live.bookingWatermark,
        effective: live.bookingWatermark,
        snapped: false,
        straddled: [],
        proves: "no correction act is split",
        cannotProve: "the cut falls on a transaction boundary",
        scanPositions: 0n,
      },
      query: "",
    };
  }

  const valueDate = request.asOfValueDate ?? live.valueDate;

  // THE CUT. One call, one number, and from here down the booking axis is an
  // integer. `bookingWatermarkAt` is the existing reader and the same one the
  // agent surface uses, so a figure a panel reads on a screen and a figure an
  // agent reports for the same instant come from the same definition.
  const requested =
    request.asKnownAt === null
      ? live.bookingWatermark
      : await bookingWatermarkAt(request.asKnownAt, conn);

  // THE SAFETY RULE. An instant inside an uncommitted write is an instant at
  // which none of that write had been learned, so the cut moves below all of
  // it. Skipped when the booking axis is open, because the live watermark is
  // the top of the book and has nothing above it to straddle.
  const cut = request.asKnownAt === null
    ? {
        requested,
        effective: requested,
        snapped: false,
        straddled: [],
        proves: "no correction act is split" as const,
        cannotProve: "the cut falls on a transaction boundary" as const,
        scanPositions: 0n,
      }
    : await observableWatermark(requested, conn);

  const watermark = cut.effective;

  // See the header: the instant on the snapshot is the REQUESTED one, because
  // hold closures have no sequence and their only clock is a timestamp.
  const instant = request.asKnownAt ?? live.asOf;

  const watermarkBookedAt =
    request.asKnownAt === null || watermark === 0n
      ? null
      : await bookingTimeOfSeq(watermark, conn);

  return {
    mode: "travelled",
    snapshot: historicSnapshot(valueDate, watermark, instant),
    valuePinned: request.asOfValueDate !== null,
    bookingPinned: request.asKnownAt !== null,
    foresight: request.foresight,
    liveValueDate: live.valueDate,
    liveWatermark: live.bookingWatermark,
    resolvedAt: clock.now(),
    requestedKnownAt: request.asKnownAt,
    watermarkBookedAt,
    cut,
    query: timeTravelQuery(request),
  };
}

/**
 * The live point, for a screen that wants the same shape without a URL.
 *
 * Identical to `resolveTimePoint` with an absent request, and kept separate so
 * that a caller who has no `searchParams` to parse does not have to fabricate
 * one.
 */
export async function livePoint(conn: Sql, clock: RequestClock): Promise<TimePoint> {
  return resolveTimePoint(
    {
      asOfValueDate: null,
      asKnownAt: null,
      asKnownAtRaw: null,
      asOfRaw: null,
      absent: true,
      foresight: false,
    },
    conn,
    clock,
  );
}

/**
 * The live watermark, without taking a whole snapshot.
 *
 * For the screens that want to say "the book has moved N positions since the
 * point you are standing at" without re-deriving a business day they already
 * have.
 */
export async function liveWatermark(conn: Sql): Promise<bigint> {
  return currentBookingWatermark(conn);
}

/* -------------------------------------------------------------------------- */
/* Facts about the point, for the screen to state rather than assume           */
/* -------------------------------------------------------------------------- */

/** How far the book has moved since the cut, as a position gap. */
export function positionsSince(point: TimePoint): bigint {
  const gap = point.liveWatermark - point.snapshot.bookingWatermark;
  return gap < 0n ? 0n : gap;
}

/** The book had learned nothing at all at this instant. A state, not an error. */
export function beforeTheBookBegan(point: TimePoint): boolean {
  return point.bookingPinned && point.snapshot.bookingWatermark === 0n;
}

/** True when the value axis is pinned to a day the book has not reached. */
export function aheadOfTheBook(point: TimePoint): boolean {
  return point.valuePinned && point.snapshot.valueDate > point.liveValueDate;
}

/**
 * THE LIVE INVERSION CHECK, at the one position where it changes an answer.
 *
 * The watermark was chosen as `MAX(booking_seq) WHERE booking_time <= t`. If
 * `booking_seq` is monotone in `booking_time` — which it is on this book, and
 * which nothing in the schema enforces — then the entry sitting AT the
 * watermark was itself booked at or before `t`.
 *
 * If it was booked LATER than `t`, the prefix `booking_seq <= W` contains an
 * entry we had not learned by `t`, and every figure at this point overstates
 * our knowledge by at least that entry. Returns the overshoot in
 * milliseconds, or `null` when there is none.
 *
 * This is a detector, not a repair. Repairing it would mean choosing a
 * different watermark from the one `bookingWatermarkAt()` — and therefore from
 * the one the agent surface and the statements screen use — which is a
 * decision to take once, in the ledger module, with every caller present.
 * Silently disagreeing with them here would replace one wrong number with two
 * different ones.
 */
export function prefixLeak(point: TimePoint): number | null {
  if (point.requestedKnownAt === null || point.watermarkBookedAt === null) return null;
  const overshoot =
    point.watermarkBookedAt.getTime() - point.requestedKnownAt.getTime();
  return overshoot > 0 ? overshoot : null;
}
