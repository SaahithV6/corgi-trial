/**
 * THE CUT'S SAFETY RULE, PROVED WITHOUT A DATABASE.
 *
 * `straddle()` and `snapTarget()` are pure functions over the output of
 * `readCorrectionGroup`, which is why they can be pinned here with no
 * credentials — which is what CI is.
 *
 * The cases below are not invented. Each one is a shape MEASURED on this book
 * on 2026-09-11 and recorded in `integrity.ts`'s header, so a change that
 * breaks one is a change that contradicts the ledger rather than a test.
 */

import { describe, expect, it } from "vitest";

import {
  pendingActs,
  snapTarget,
  straddle,
  type EntryType,
} from "./integrity";
import type { CorrectionGroupEntry, LateEntry } from "@/lib/ledger/readers";

const GROUP = "fae83e96-72ac-400e-9fa3-818b8573c7b9";

function member(
  seq: number,
  entryType: EntryType,
  bookingTime: string,
  groupId = GROUP,
): CorrectionGroupEntry {
  return {
    entryId: `entry-${String(seq)}`,
    bookingSeq: BigInt(seq),
    bookingTime,
    valueDate: "2011-10-01",
    entryType,
    description: `${entryType} at ${String(seq)}`,
    externalRef: null,
    idempotencyKey: `key-${String(seq)}`,
    reversesEntryId: entryType === "reversal" ? "entry-2000" : null,
    correctionGroupId: groupId,
  };
}

/**
 * The measured act. Original booked hours earlier in its own transaction;
 * reversal and re-book written together, 76ms apart on the wall clock.
 */
const MEASURED_ACT: readonly CorrectionGroupEntry[] = [
  member(2000, "original", "2026-09-11T02:14:07.001Z"),
  member(2460, "reversal", "2026-09-11T04:29:32.382Z"),
  member(2461, "rebook", "2026-09-11T04:29:32.458Z"),
];

describe("straddle — the state that never existed", () => {
  it("refuses a cut between a reversal and its re-book", () => {
    // The trap. seq 2460 is in, 2461 is out: the settlement wiped and nothing
    // put back. One transaction wrote both, so no reader ever saw this.
    const crossed = straddle(MEASURED_ACT, 2460n);

    expect(crossed).not.toBeNull();
    expect(crossed?.presentSeqs).toEqual([2460n]);
    expect(crossed?.missingSeqs).toEqual([2461n]);
    // Below the FIRST correcting entry — the whole atomic write is excluded.
    expect(crossed?.snapBelow).toBe(2459n);
    expect(crossed?.intraWriteGapMs).toBe(76);
  });

  it("ALLOWS a cut between the original and its correction", () => {
    // The demonstration, and the case a naive "never split a correction group"
    // rule would have destroyed. These are two different transactions, hours
    // apart, and standing between them is the entire point of the feature.
    expect(straddle(MEASURED_ACT, 2459n)).toBeNull();
    expect(straddle(MEASURED_ACT, 2100n)).toBeNull();
    expect(straddle(MEASURED_ACT, 1999n)).toBeNull();
  });

  it("allows a cut above a completed act and below an untouched one", () => {
    expect(straddle(MEASURED_ACT, 2461n)).toBeNull();
    expect(straddle(MEASURED_ACT, 9999n)).toBeNull();
  });

  it("ignores an act with a single correcting entry", () => {
    // One correcting entry cannot be half-landed: there is no second half.
    const single = [
      member(2000, "original", "2026-09-11T02:14:07.001Z"),
      member(2460, "reversal", "2026-09-11T04:29:32.382Z"),
    ];
    expect(straddle(single, 2000n)).toBeNull();
    expect(straddle(single, 2460n)).toBeNull();
  });

  it("handles a three-entry correcting run", () => {
    const wide = [
      member(2000, "original", "2026-09-11T02:14:07.001Z"),
      member(2504, "reversal", "2026-09-11T04:31:00.100Z"),
      member(2505, "rebook", "2026-09-11T04:31:00.140Z"),
      member(2506, "rebook", "2026-09-11T04:31:00.180Z"),
    ];
    for (const cut of [2504n, 2505n]) {
      const crossed = straddle(wide, cut);
      expect(crossed).not.toBeNull();
      expect(crossed?.snapBelow).toBe(2503n);
    }
    expect(straddle(wide, 2503n)).toBeNull();
    expect(straddle(wide, 2506n)).toBeNull();
  });
});

describe("snapTarget — clearing several interleaved acts at once", () => {
  /**
   * The acts fed to `snapTarget` are produced by `straddle()` itself, not
   * hand-written.
   *
   * That is the point. A hand-shaped `{ snapBelow }` object would type-check
   * against a narrowed parameter and could never have straddled anything, so
   * the test would pass on a fixture the detector had never looked at. Running
   * the detector to build the input means every act below is a genuine
   * half-landed correction — the exact state the guard exists to refuse.
   */
  function realStraddle(firstSeq: number, groupId: string) {
    const act = straddle(
      [
        member(1000, "original", "2026-09-11T02:00:00.000Z", groupId),
        member(firstSeq, "reversal", "2026-09-11T04:29:32.382Z", groupId),
        member(firstSeq + 1, "rebook", "2026-09-11T04:29:32.458Z", groupId),
      ],
      BigInt(firstSeq),
    );
    expect(act).not.toBeNull();
    if (act === null) throw new Error("fixture is not a straddle");
    return act;
  }

  it("takes the lowest, so one move clears all of them", () => {
    const acts = [
      realStraddle(2504, "group-c"),
      realStraddle(2460, "group-a"),
      realStraddle(2481, "group-b"),
    ];

    expect(acts.map((a) => a.snapBelow)).toEqual([2503n, 2459n, 2480n]);
    expect(snapTarget(acts)).toBe(2459n);
  });

  it("is null when nothing straddles", () => {
    expect(snapTarget([])).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */

function late(
  seq: number,
  entryType: EntryType,
  cents: bigint,
  bookingTime: string,
  groupId: string | null = GROUP,
): LateEntry {
  return {
    entryId: `entry-${String(seq)}`,
    valueDate: "2011-10-01",
    bookingSeq: BigInt(seq),
    bookingTime: new Date(bookingTime),
    entryType,
    description: `${entryType} at ${String(seq)}`,
    externalRef: null,
    reversesEntryId: null,
    correctionGroupId: groupId,
    signedCents: cents,
  };
}

describe("pendingActs — what this day is about to learn", () => {
  it("groups correcting entries into acts and nets them", () => {
    const acts = pendingActs([
      late(2460, "reversal", -12222n, "2026-09-11T04:29:32.382Z"),
      late(2461, "rebook", 13456n, "2026-09-11T04:29:32.458Z"),
    ]);

    expect(acts).toHaveLength(1);
    expect(acts[0]?.netCents).toBe(1234n);
    expect(acts[0]?.entries.map((e) => e.bookingSeq)).toEqual([2460n, 2461n]);
    expect(acts[0]?.learnedAt).toBe("2026-09-11T04:29:32.382Z");
  });

  it("drops originals — an original is not something being corrected", () => {
    const acts = pendingActs([
      late(2470, "original", 5000n, "2026-09-11T04:30:00.000Z"),
      late(2471, "reversal", -5000n, "2026-09-11T04:30:01.000Z"),
      late(2472, "rebook", 6000n, "2026-09-11T04:30:01.050Z"),
    ]);
    expect(acts).toHaveLength(1);
    expect(acts[0]?.entries).toHaveLength(2);
    expect(acts[0]?.netCents).toBe(1000n);
  });

  it("ignores entries with no correction group", () => {
    expect(pendingActs([late(2480, "original", 100n, "2026-09-11T04:31:00Z", null)])).toEqual([]);
  });

  it("orders acts by when we learned, not by booking position", () => {
    const acts = pendingActs([
      late(2500, "reversal", -100n, "2026-09-11T05:00:00.000Z", "group-b"),
      late(2400, "reversal", -200n, "2026-09-11T04:00:00.000Z", "group-a"),
      late(2401, "rebook", 250n, "2026-09-11T04:00:00.050Z", "group-a"),
      late(2501, "rebook", 150n, "2026-09-11T05:00:00.060Z", "group-b"),
    ]);
    expect(acts.map((a) => a.correctionGroupId)).toEqual(["group-a", "group-b"]);
  });
});
