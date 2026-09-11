/**
 * THE CUT'S SAFETY RULE — never observe a state that never existed.
 *
 * ===========================================================================
 * THE TRAP, AND THE MEASUREMENT THAT DEFINES IT
 * ===========================================================================
 *
 * A correction is an ACT that produces a reversal and a re-book, both carrying
 * the ORIGINAL value date and both booked strictly later. Nothing is edited.
 * The two entries land at two different `booking_seq` values and carry two
 * different `booking_time` stamps:
 *
 *     seq 2460   reversal   value date 2011-10-01   booked 04:29:32.382Z
 *     seq 2461   re-book    value date 2011-10-01   booked 04:29:32.458Z
 *
 * Seventy-six milliseconds apart. The obvious reading is that for 76ms this
 * book contained the reversal and not the re-book, and that a cut placed in
 * that window shows a real, if awkward, historical state.
 *
 * THAT READING IS WRONG, AND THE MEASUREMENT SAYS SO.
 *
 * Both rows carry the SAME `xmin`. Measured against this book, every one of
 * the twelve most recent reversal → re-book pairs was written by ONE
 * transaction:
 *
 *     reversal@2460 -> rebook@2461     1 transaction
 *     reversal@2508 -> rebook@2509     1 transaction
 *     reversal@2375 -> rebook@2376     1 transaction        (… 12 of 12)
 *
 * The 76ms gap is not a window of visibility. It is two `clock_timestamp()`
 * calls inside one transaction — the very same phenomenon that produced the
 * `readSnapshot()`/`now()` defect recorded in `docs/BALANCE-DEFINITIONS.md`
 * §5. MVCC made the pair atomic. **No reader could ever have observed the
 * half-landed state, because it never existed.**
 *
 * So a cut between seq 2460 and 2461 does not render an awkward truth. It
 * renders a state that was never true, as a coherent balance, under a heading
 * the reader chose. That is exactly the lie this feature must not tell, and it
 * is worse than not offering the feature, because it looks real.
 *
 * ===========================================================================
 * THE INVARIANT, STATED PRECISELY
 * ===========================================================================
 *
 * The unit that must not be split is THE TRANSACTION, not the correction
 * group. Those are different sets and the difference is the whole subtlety:
 *
 *   * an ORIGINAL and its later reversal are in DIFFERENT transactions, hours
 *     or days apart. Measured: 254 of 254 multi-entry correction groups span
 *     several transactions. That boundary is real, was genuinely observable,
 *     and MUST be crossable — a cut standing between an original and its
 *     reversal is the entire demonstration this feature exists for.
 *
 *   * a REVERSAL and its RE-BOOK are in the SAME transaction. That boundary
 *     was never observable and must NOT be crossable.
 *
 * A rule phrased as "never split a correction group" would forbid the first
 * and is therefore wrong in the direction that destroys the feature. The rule
 * is:
 *
 *     THE CUT MUST FALL ON A TRANSACTION BOUNDARY.
 *
 * ===========================================================================
 * SNAP DOWN, NEVER UP
 * ===========================================================================
 *
 * When a requested watermark falls inside an atomic write, it is moved DOWN to
 * the position below that write's first entry.
 *
 * Down is not the cautious choice; it is the CORRECT one, and it is a
 * derivation rather than a preference. `booking_time` is stamped DURING the
 * transaction, before it commits. An instant between two stamps of one
 * transaction is therefore an instant at which that transaction had not yet
 * committed — so a reader standing there would have seen NONE of its entries.
 * Excluding all of them is what was true.
 *
 * Snapping UP would do the opposite: it would answer a question about
 * 04:29:32.400Z with the state of the book at 04:29:32.458Z, silently. That
 * invents knowledge, which is the one thing an append-only bitemporal ledger
 * exists to make impossible.
 *
 * ===========================================================================
 * WHAT THIS MODULE CAN PROVE, AND WHAT IT CANNOT
 * ===========================================================================
 *
 * IT CAN PROVE: the cut does not fall inside the correcting run of any
 * correction act — the reversal/re-book pair. That is the case the brief's
 * live-fire scenario runs, it is the case a demo lands on, and it is exact,
 * because `readCorrectionGroup` returns every member of an act with its
 * booking position.
 *
 * IT CANNOT PROVE: that the cut falls on a transaction boundary in general.
 * The ledger records `booking_seq`, which totally orders entries, and records
 * NOTHING about which entries committed together. `xmin` is a system column
 * and reading it from here would breach `src/lib/ledger/boundary.test.ts`.
 *
 * The gap is real and it is measurable. One transaction on this book wrote
 * TWENTY-SEVEN reversal entries at seqs 2474–2500 — a bulk correction — and
 * those twenty-seven carry twenty-seven DIFFERENT `correction_group_id`s. A
 * cut at seq 2487 splits that transaction, shows fourteen reversals without
 * the other thirteen, and no reader available outside `src/lib/ledger/**` can
 * see that it has done so.
 *
 * So this module guards what it can guard exactly, and the screen STATES the
 * residual. `docs/TIMETRAVEL.md` names the one-line reader that would close it
 * — a `writeBatchOf(seq)` over `xmin`, or better a real `write_batch_id`
 * column — and it is reported rather than reached around.
 *
 * Measured facts this rests on, re-measured 2026-09-11 at 2,432 entries:
 *   * every multi-entry transaction is CONTIGUOUS in `booking_seq` (0 of 248
 *     non-contiguous), so an atomic write is a RUN and a window scan is sound
 *   * the widest transaction observed spans 27 positions
 *   * 0 `booking_seq` / `booking_time` inversions, 0 tied timestamps
 */

import "server-only";

import {
  listLedgerLines,
  readCorrectionGroup,
  type CorrectionGroupEntry,
  type LateEntry,
} from "@/lib/ledger/readers";
import type { Sql } from "@/lib/ledger/balance-definitions";

export type EntryType = "original" | "reversal" | "rebook";

/**
 * How far above a requested cut this module looks for an act that straddles it.
 *
 * The widest transaction measured on this book spans 27 booking positions, and
 * every multi-entry transaction is contiguous. 64 is that measurement with
 * more than twice its own headroom. It is a constant with a number behind it,
 * not a round guess, and `docs/TIMETRAVEL.md` records the measurement so the
 * next person can re-take it rather than trust it.
 */
export const STRADDLE_SCAN_POSITIONS = 64n;

/**
 * Lines — not entries — pulled in one scan. An entry carries two to four
 * lines, so this covers well over 128 entries' worth of the 64 positions
 * above the cut.
 */
const SCAN_LINE_LIMIT = 512;

/* -------------------------------------------------------------------------- */
/* An act the cut would have run through                                      */
/* -------------------------------------------------------------------------- */

export interface StraddledAct {
  readonly correctionGroupId: string;
  /** The correcting members below or at the requested cut. */
  readonly presentSeqs: readonly bigint[];
  /** The correcting members above it. */
  readonly missingSeqs: readonly bigint[];
  /** The position the cut must move below to exclude the whole act. */
  readonly snapBelow: bigint;
  /** Wall gap inside the atomic write, in ms. Display only; see the header. */
  readonly intraWriteGapMs: number;
}

/**
 * The correcting members of an act — everything that is not the original.
 *
 * The original is a separate transaction and a legitimate place to stand
 * either side of. The correcting members are the atomic unit.
 */
function correctingMembers(
  members: readonly CorrectionGroupEntry[],
): readonly CorrectionGroupEntry[] {
  return members.filter((member) => member.entryType !== "original");
}

/**
 * Does this act's correcting run straddle the cut?
 *
 * Pure, so the rule is testable with no database. `null` when the act is
 * wholly on one side — which is the overwhelmingly common case, and the case
 * that needs no words on the screen.
 */
export function straddle(
  members: readonly CorrectionGroupEntry[],
  watermark: bigint,
): StraddledAct | null {
  const correcting = correctingMembers(members);
  if (correcting.length < 2) return null;

  const present = correcting.filter((member) => member.bookingSeq <= watermark);
  const missing = correcting.filter((member) => member.bookingSeq > watermark);
  if (present.length === 0 || missing.length === 0) return null;

  const first = correcting[0];
  const last = correcting[correcting.length - 1];
  if (first === undefined || last === undefined) return null;

  const gap = Date.parse(last.bookingTime) - Date.parse(first.bookingTime);

  return {
    correctionGroupId: first.correctionGroupId,
    presentSeqs: present.map((member) => member.bookingSeq),
    missingSeqs: missing.map((member) => member.bookingSeq),
    // Below the FIRST correcting member: the whole atomic write is excluded.
    snapBelow: first.bookingSeq - 1n,
    intraWriteGapMs: Number.isNaN(gap) ? 0 : gap,
  };
}

/**
 * The lowest snap target among several straddled acts.
 *
 * Several acts can straddle one cut when their writes interleave. Moving below
 * the lowest of them clears all of them at once, and moving below only the
 * highest could leave the cut inside another.
 *
 * Takes `Pick<StraddledAct, "snapBelow">` rather than the whole act, because
 * that is the only field it reads. Narrowing the parameter to what the body
 * uses is what lets a caller — and a test — pass a value without a cast, and a
 * cast here would be the compiler being told to stop checking the one shape in
 * this module that matters.
 */
export function snapTarget(
  acts: readonly Pick<StraddledAct, "snapBelow">[],
): bigint | null {
  let lowest: bigint | null = null;
  for (const act of acts) {
    if (lowest === null || act.snapBelow < lowest) lowest = act.snapBelow;
  }
  return lowest;
}

/* -------------------------------------------------------------------------- */
/* The safety check                                                           */
/* -------------------------------------------------------------------------- */

export interface CutSafety {
  /** What `asKnownAt` resolved to before the rule was applied. */
  readonly requested: bigint;
  /** What every read in this feature actually uses. */
  readonly effective: bigint;
  readonly snapped: boolean;
  /** The acts that forced the move. Empty when nothing did. */
  readonly straddled: readonly StraddledAct[];
  /**
   * What the check covers. Deliberately a value on the result rather than a
   * sentence in a comment, so the screen prints the limit of the guarantee
   * instead of implying there isn't one.
   */
  readonly proves: "no correction act is split";
  /** The residual, named on the screen. See this module's header. */
  readonly cannotProve: "the cut falls on a transaction boundary";
  readonly scanPositions: bigint;
}

function safe(watermark: bigint): CutSafety {
  return {
    requested: watermark,
    effective: watermark,
    snapped: false,
    straddled: [],
    proves: "no correction act is split",
    cannotProve: "the cut falls on a transaction boundary",
    scanPositions: STRADDLE_SCAN_POSITIONS,
  };
}

/**
 * Move a requested watermark down until no correction act straddles it.
 *
 * Iterated, because a snap can land inside a second act whose write interleaved
 * with the first. Bounded at four passes: each pass moves strictly DOWN, so it
 * terminates, and four is far past anything this book can produce. Exhausting
 * the bound returns the last safe-as-far-as-checked position rather than
 * looping, and the screen still reports what it found.
 */
export async function observableWatermark(
  requested: bigint,
  conn: Sql,
): Promise<CutSafety> {
  if (requested <= 0n) return safe(requested);

  const found: StraddledAct[] = [];
  let cut = requested;

  for (let pass = 0; pass < 4; pass += 1) {
    const acts = await straddlingActsAt(cut, conn);
    if (acts.length === 0) break;

    found.push(...acts);
    const target = snapTarget(acts);
    if (target === null || target >= cut) break;
    cut = target;
  }

  if (found.length === 0) return safe(requested);

  return {
    requested,
    effective: cut,
    snapped: cut !== requested,
    straddled: found,
    proves: "no correction act is split",
    cannotProve: "the cut falls on a transaction boundary",
    scanPositions: STRADDLE_SCAN_POSITIONS,
  };
}

/**
 * Acts whose correcting run crosses this exact position.
 *
 * Candidates come from the window ABOVE the cut: an act can only straddle if
 * part of it is above, and reading upwards means a handful of lines rather
 * than a scan of the book. Each candidate group is then read back WHOLE with
 * `readCorrectionGroup`, which finds the members BELOW the cut that the window
 * by construction cannot see — so the straddle test itself is exact even
 * though the candidate search is windowed.
 *
 * `bookingSeqBelow` is the only bound `listLedgerLines` offers and it is
 * strict, so the ceiling is `cut + scan + 1`. That asymmetry is the reader's,
 * not a fence-post error: see `docs/TIMETRAVEL.md`, "what is missing", for the
 * `bookingSeqBetween` filter that would make this one bounded query with no
 * client-side filtering at all.
 */
async function straddlingActsAt(
  cut: bigint,
  conn: Sql,
): Promise<readonly StraddledAct[]> {
  const lines = await listLedgerLines(
    {
      bookingSeqBelow: cut + STRADDLE_SCAN_POSITIONS + 1n,
      limit: SCAN_LINE_LIMIT,
    },
    conn,
  );

  const candidates = new Map<string, string>();
  for (const line of lines) {
    if (line.bookingSeq <= cut) continue;
    if (line.correctionGroupId === null) continue;
    if (line.entryType === "original") continue;
    if (!candidates.has(line.correctionGroupId)) {
      candidates.set(line.correctionGroupId, line.entryId);
    }
  }

  const acts: StraddledAct[] = [];
  for (const entryId of candidates.values()) {
    const { entries } = await readCorrectionGroup(entryId, conn);
    const crossed = straddle(entries, cut);
    if (crossed !== null) acts.push(crossed);
  }

  return acts;
}

/* -------------------------------------------------------------------------- */
/* Acts the cut legitimately stands inside — the demonstration                */
/* -------------------------------------------------------------------------- */

/**
 * An act whose ORIGINAL is below the cut and whose correction is above it.
 *
 * This is the good case and the whole point of the screen: a real, observable
 * boundary between two transactions, on which the same business day reads two
 * different figures. It is listed so the screen can say "here is the act you
 * are standing before, and here is what it will do to this day when you cross
 * it" — rather than leaving a reader to infer it from a delta.
 */
export interface PendingAct {
  readonly correctionGroupId: string;
  readonly valueDate: string;
  /** Correcting entries above the cut, in booking order. */
  readonly entries: readonly LateEntry[];
  readonly netCents: bigint;
  /** Booking time of the first correcting entry: when we learned otherwise. */
  readonly learnedAt: string;
}

/**
 * Group the late entries into the acts they belong to.
 *
 * Pure: it takes the output of `listEntriesAboveWatermark`, which the screen
 * has already read in order to explain its own delta. Re-reading it here would
 * be a second round trip for an answer in hand and a second chance for the two
 * to disagree if the book moves between them.
 */
export function pendingActs(late: readonly LateEntry[]): readonly PendingAct[] {
  const byGroup = new Map<string, LateEntry[]>();
  for (const entry of late) {
    if (entry.correctionGroupId === null) continue;
    if (entry.entryType === "original") continue;
    const bucket = byGroup.get(entry.correctionGroupId);
    if (bucket === undefined) byGroup.set(entry.correctionGroupId, [entry]);
    else bucket.push(entry);
  }

  const acts: PendingAct[] = [];
  for (const [groupId, entries] of byGroup) {
    entries.sort((a, b) => (a.bookingSeq < b.bookingSeq ? -1 : 1));
    const first = entries[0];
    if (first === undefined) continue;

    let netCents = 0n;
    for (const entry of entries) netCents += entry.signedCents;

    acts.push({
      correctionGroupId: groupId,
      valueDate: first.valueDate,
      entries,
      netCents,
      learnedAt: first.bookingTime.toISOString(),
    });
  }

  acts.sort((a, b) => (a.learnedAt < b.learnedAt ? -1 : 1));
  return acts;
}
