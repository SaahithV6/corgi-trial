/**
 * The comparator, proved without a database.
 *
 * The thing under test is the one judgement this screen makes: is a red view
 * DECIDED or is it NEW? Everything else on the page is a number someone else
 * computed. So the cases that matter are the ones where the distinction could
 * silently collapse — an unreadable view counted as a pass, a decided
 * population absorbing growth it was never argued for, a repair buying
 * permanent headroom.
 */
import { describe, expect, it } from "vitest";

import {
  DECIDED,
  REACH_LIMITS,
  classify,
  decidedFor,
  headline,
  rank,
  tally,
  type Reading,
} from "./decided";

const read = (view: string, rows: number, error: string | null = null): Reading => ({
  view,
  claim: `claim for ${view}`,
  rows,
  error,
});

describe("the register", () => {
  it("carries exactly the four dbcheck reports failing, each with a citation", () => {
    expect(DECIDED.map((d) => d.view).sort()).toEqual([
      "v_advice_delta_unsound",
      "v_hold_closure_unexplained",
      "v_hold_expiry_drift",
      "v_refused_auth_hold",
    ]);
    for (const entry of DECIDED) {
      // An entry without a citation is not an argument, it is an excuse.
      expect(entry.citation.length, `${entry.view} has no citation`).toBeGreaterThan(10);
      expect(entry.argument.length, `${entry.view} has no argument`).toBeGreaterThan(60);
      expect(entry.population.length, `${entry.view} names no population`).toBeGreaterThan(5);
      // Provenance, not a guess: a watermark with no instant is a literal.
      expect(entry.witnessedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entry.witnessed).toBeGreaterThan(0);
    }
  });

  it("does not carry a limit for a view it has no limit for", () => {
    expect(decidedFor("v_entry_unbalanced")).toBeNull();
    expect(REACH_LIMITS["v_entry_unbalanced"]).toBeUndefined();
  });
});

describe("classify", () => {
  it("calls a red with no argument NEW, whatever its size", () => {
    expect(classify(read("v_entry_unbalanced", 1)).verdict).toBe("new");
    expect(classify(read("v_book_not_zero", 9_999)).verdict).toBe("new");
  });

  it("calls a red on the register DECIDED only when it matches the watermark", () => {
    expect(classify(read("v_refused_auth_hold", 257)).verdict).toBe("decided");
  });

  it("does NOT let a decided population absorb growth it was never argued for", () => {
    const grown = classify(read("v_refused_auth_hold", 258));
    expect(grown.verdict).toBe("grown");
    expect(grown.delta).toBe(1);
  });

  it("reports a repair as a stale watermark rather than as success", () => {
    const shrunk = classify(read("v_hold_expiry_drift", 3));
    expect(shrunk.verdict).toBe("shrunk");
    expect(shrunk.delta).toBe(-9);
  });

  it("never lets the register excuse a view nobody could read", () => {
    // The failure mode this whole repository keeps finding in its own guards:
    // an exception treated as zero. Being on the register must not soften it.
    const unreadable = classify(read("v_refused_auth_hold", -1, "permission denied"));
    expect(unreadable.verdict).toBe("unreadable");
    expect(unreadable.decided).not.toBeNull();
  });

  it("attaches the reach limit to the view it belongs to, empty or not", () => {
    const pot = classify(read("v_internal_transfer_impure", 0));
    expect(pot.verdict).toBe("holding");
    expect(pot.reachLimit).toContain("THE WRITER'S OWN LABEL");
  });
});

describe("rank", () => {
  it("puts what nobody has explained above what has been decided", () => {
    const ranked = rank([
      read("v_refused_auth_hold", 257),
      read("v_book_not_zero", 0),
      read("v_entry_unbalanced", 2),
      read("v_hold_drift", -1, "timeout"),
    ]);
    expect(ranked.map((r) => r.verdict)).toEqual(["unreadable", "new", "decided", "holding"]);
  });

  it("does not reorder two findings in the same band", () => {
    // No severity is invented: within a band the order is the gate's own list.
    const ranked = rank([read("v_book_not_zero", 1), read("v_entry_unbalanced", 500)]);
    expect(ranked.map((r) => r.view)).toEqual(["v_book_not_zero", "v_entry_unbalanced"]);
  });
});

describe("tally and headline", () => {
  it("counts only the UNARGUED rows as unaccounted for", () => {
    const t = tally(
      rank([
        read("v_refused_auth_hold", 260), // 257 argued, 3 not
        read("v_entry_unbalanced", 2), // none argued
        read("v_book_not_zero", 0),
      ]),
    );
    expect(t.standingRows).toBe(262);
    expect(t.unexplainedRows).toBe(5);
    expect(t.unexplained).toBe(2);
  });

  it("refuses to say all-clear while anything is unreadable", () => {
    const t = tally(rank([read("v_hold_drift", -1, "timeout"), read("v_book_not_zero", 0)]));
    expect(headline(t)).toContain("could not be read");
    expect(headline(t)).toContain("not an all-clear");
  });

  it("says nothing new when every red is on the register", () => {
    const t = tally(
      rank([
        read("v_refused_auth_hold", 257),
        read("v_hold_expiry_drift", 12),
        read("v_advice_delta_unsound", 1),
        read("v_hold_closure_unexplained", 4),
        read("v_book_not_zero", 0),
      ]),
    );
    expect(t.unexplained).toBe(0);
    expect(t.decided).toBe(4);
    expect(headline(t)).toContain("Nothing new");
  });
});
