/**
 * The as-published / as-corrected difference, with no database.
 *
 * Two judgements live here rather than in SQL, and both are the kind a
 * reviewer should be able to argue with:
 *
 *   1. whether the itemised list actually accounts for the whole gap, and
 *   2. what counts as ONE act when several entries land together.
 *
 * A `GROUP BY` can express the second, but then the rule is buried in a query
 * and nobody can disagree with it in a test.
 */
import { describe, expect, it } from "vitest";

import { explainsDelta, groupLatePostings } from "./compare";
import type { LatePosting } from "./types";

function posting(over: Partial<LatePosting> = {}): LatePosting {
  return {
    entryId: "22222222-2222-4222-8222-222222222222",
    valueDate: "2026-07-24",
    bookingSeq: 500n,
    bookingTime: "2026-07-25T14:02:11.000Z",
    entryType: "original",
    description: "Late settlement",
    externalRef: null,
    reversesEntryId: null,
    correctionGroupId: null,
    signedCents: -1_000n,
    ...over,
  };
}

describe("explainsDelta", () => {
  it("agrees when the late postings sum to the gap", () => {
    const late = [
      posting({ bookingSeq: 500n, signedCents: 24_850n, entryType: "reversal" }),
      posting({ bookingSeq: 501n, signedCents: -19_850n, entryType: "rebook" }),
    ];
    expect(explainsDelta(5_000n, late)).toBe(true);
  });

  it("disagrees when something is missing, rather than rounding it away", () => {
    // The screen renders this answer. A difference the system cannot itemise
    // is a fact about the system, and printing the delta anyway would train
    // whoever reads the screen to stop checking — which is exactly how a real
    // break gets missed (DECISIONS 014 makes the same argument about breaks
    // whose net is zero).
    expect(explainsDelta(5_000n, [posting({ signedCents: 24_850n })])).toBe(false);
  });

  it("treats no difference and no late postings as explained", () => {
    expect(explainsDelta(0n, [])).toBe(true);
  });

  it("works in cents at a scale that would break a float", () => {
    // 2^53 cents is about $90 trillion. These are bigints precisely so the
    // answer does not quietly become approximate somewhere above a bank's
    // largest plausible balance.
    const huge = 9_007_199_254_740_993n;
    expect(explainsDelta(huge, [posting({ signedCents: huge })])).toBe(true);
    expect(explainsDelta(huge, [posting({ signedCents: huge + 1n })])).toBe(false);
  });
});

describe("groupLatePostings", () => {
  it("keeps a reversal and its re-book together as one act", () => {
    const groupId = "33333333-3333-4333-8333-333333333333";
    const groups = groupLatePostings([
      posting({
        entryId: "r",
        bookingSeq: 500n,
        entryType: "reversal",
        signedCents: 24_850n,
        correctionGroupId: groupId,
      }),
      posting({
        entryId: "b",
        bookingSeq: 501n,
        entryType: "rebook",
        signedCents: -19_850n,
        correctionGroupId: groupId,
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.postings).toHaveLength(2);
    expect(groups[0]?.netCents).toBe(5_000n);
    expect(groups[0]?.isCorrection).toBe(true);
  });

  it("does not merge two unrelated late settlements", () => {
    // Both have a null correction group. Keying on that directly would fold
    // every uncorrelated late posting into one bogus "act" — the same class of
    // bug `v_recon_ledger_group` avoids by giving reference-less entries a key
    // nothing can collide with.
    const groups = groupLatePostings([
      posting({ entryId: "a", bookingSeq: 500n, signedCents: -1_000n }),
      posting({ entryId: "b", bookingSeq: 501n, signedCents: -2_000n }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.isCorrection)).toBe(true);
  });

  it("preserves booking order across groups and within them", () => {
    const g1 = "44444444-4444-4444-8444-444444444444";
    const groups = groupLatePostings([
      posting({ entryId: "x", bookingSeq: 500n }),
      posting({ entryId: "r", bookingSeq: 501n, correctionGroupId: g1, entryType: "reversal" }),
      posting({ entryId: "b", bookingSeq: 502n, correctionGroupId: g1, entryType: "rebook" }),
    ]);
    expect(groups.map((g) => g.postings[0]?.entryId)).toEqual(["x", "r"]);
    expect(groups[1]?.postings.map((p) => p.entryId)).toEqual(["r", "b"]);
  });

  it("returns nothing for a period with nothing late", () => {
    expect(groupLatePostings([])).toEqual([]);
  });
});
