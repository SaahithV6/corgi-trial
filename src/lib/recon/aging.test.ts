/**
 * The aging policy, with no database.
 *
 * This is the file to read if you want to argue with the thresholds — that is
 * the whole reason severity is TypeScript and not a CASE expression inside
 * `v_recon_break`. The SQL returns facts; this decides what they mean; and the
 * decision is covered here, in CI, on every push.
 */
import { describe, expect, it } from "vitest";

import {
  MATERIAL_BREAK_CENTS,
  STALE_AGE_DAYS,
  ageBucketOf,
  compareBreaks,
  compareSeverity,
  severityOf,
  severityReason,
} from "./aging";
import { AGE_BUCKETS, SEVERITIES, type Severity } from "./types";

const small = 1_000n; // $10.00
const material = MATERIAL_BREAK_CENTS; // $1,000.00

function sev(
  closesCrossed: number,
  ageDays = closesCrossed,
  breakAmountCents = small,
  explainedBy: "reversal_and_rebook" | "adjudicated" | null = null,
): Severity {
  return severityOf({ ageDays, closesCrossed, breakAmountCents, explainedBy });
}

describe("ageBucketOf", () => {
  it("uses the buckets DESIGN.md §15 names", () => {
    expect(ageBucketOf(0)).toBe("0-1");
    expect(ageBucketOf(1)).toBe("0-1");
    expect(ageBucketOf(2)).toBe("2-3");
    expect(ageBucketOf(3)).toBe("2-3");
    expect(ageBucketOf(4)).toBe("4-7");
    expect(ageBucketOf(7)).toBe("4-7");
    expect(ageBucketOf(8)).toBe("8-30");
    expect(ageBucketOf(30)).toBe("8-30");
    expect(ageBucketOf(31)).toBe("31+");
    expect(ageBucketOf(4_000)).toBe("31+");
  });

  it("buckets a forward-dated file as new rather than throwing", () => {
    // A warehoused ACH effective date is legitimately in the future. It is not
    // aged; it has not happened yet.
    expect(ageBucketOf(-3)).toBe("0-1");
  });

  it("covers every bucket the type declares", () => {
    const produced = new Set([0, 2, 5, 12, 99].map(ageBucketOf));
    expect([...produced].sort()).toEqual([...AGE_BUCKETS].sort());
  });
});

describe("severityOf — a day close, not a clock", () => {
  it("is `open` while the break's own business day is still open", () => {
    expect(sev(0)).toBe("open");
    // Days can pass without a close: a weekend, a holiday, an outage. The
    // break has still not got past a control, so it is still `open`.
    expect(sev(0, 3)).toBe("open");
  });

  it("is `aged` once one day close has happened over it", () => {
    // This is the requirement, stated as a test: a break that has been open
    // across a day close is worse than one from this morning.
    expect(sev(1)).toBe("aged");
    expect(compareSeverity(sev(1), sev(0))).toBeLessThan(0); // aged sorts first
  });

  it("is `stale` after two", () => {
    expect(sev(2)).toBe("stale");
    expect(sev(9)).toBe("stale");
  });

  it("is `critical` when it is both old and material", () => {
    expect(sev(2, 2, material)).toBe("critical");
    expect(sev(2, 2, -material)).toBe("critical"); // direction is not size
    expect(sev(2, 2, material - 1n)).toBe("stale"); // the threshold is exact
    expect(sev(1, 1, material)).toBe("aged"); // one close is not two
  });

  it("is `critical` past the age threshold however few closes ran", () => {
    expect(sev(0, STALE_AGE_DAYS + 1)).toBe("critical");
    expect(sev(0, STALE_AGE_DAYS)).toBe("open");
  });

  it("is `explained` first and unconditionally", () => {
    // A break whose entry was reversed and re-booked to the file's own number
    // is not a $900 emergency however long it has sat. It stays on the screen;
    // it is ranked as what it is.
    expect(sev(45, 400, material, "reversal_and_rebook")).toBe("explained");
    expect(sev(45, 400, material, "adjudicated")).toBe("explained");
  });

  it("treats a negative close count as zero rather than trusting it", () => {
    expect(sev(-4, 0)).toBe("open");
  });

  it("produces every severity the type declares", () => {
    const produced = new Set<Severity>([
      sev(0),
      sev(1),
      sev(2),
      sev(2, 2, material),
      sev(0, 0, small, "adjudicated"),
    ]);
    expect([...produced].sort()).toEqual([...SEVERITIES].sort());
  });
});

describe("compareBreaks", () => {
  const make = (severity: Severity, ageDays: number, cents: bigint, key: string) => ({
    severity,
    ageDays,
    breakAmountCents: cents,
    breakKey: key,
  });

  it("puts the worst first, then the oldest, then the largest", () => {
    const rows = [
      make("open", 0, 100n, "d"),
      make("critical", 40, 500n, "a"),
      make("aged", 1, 100n, "c"),
      make("aged", 5, 100n, "b"),
    ];
    expect([...rows].sort(compareBreaks).map((r) => r.breakKey)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("ranks by magnitude, so a large credit outranks a small debit", () => {
    const rows = [
      make("aged", 1, 10n, "small"),
      make("aged", 1, -900n, "large-negative"),
    ];
    expect([...rows].sort(compareBreaks)[0]?.breakKey).toBe("large-negative");
  });

  it("is a total order, so a re-render never reshuffles equal rows", () => {
    const a = make("aged", 1, 100n, "aaa");
    const b = make("aged", 1, 100n, "bbb");
    expect(compareBreaks(a, b)).toBeLessThan(0);
    expect(compareBreaks(b, a)).toBeGreaterThan(0);
    expect(compareBreaks(a, a)).toBe(0);
  });

  it("sorts `explained` to the bottom", () => {
    const rows = [
      make("explained", 400, 900_000n, "explained"),
      make("open", 0, 1n, "open"),
    ];
    expect([...rows].sort(compareBreaks).map((r) => r.breakKey)).toEqual([
      "open",
      "explained",
    ]);
  });
});

describe("severityReason", () => {
  it("says what happened rather than restating the label", () => {
    const facts = {
      ageDays: 3,
      closesCrossed: 3,
      breakAmountCents: small,
      explainedBy: null,
    };
    expect(severityReason(facts, "stale")).toContain("3 day closes");
    expect(severityReason({ ...facts, closesCrossed: 0, ageDays: 0 }, "open")).toContain(
      "not been closed",
    );
    expect(
      severityReason({ ...facts, explainedBy: "reversal_and_rebook" }, "explained"),
    ).toContain("reversed and re-booked");
  });
});
