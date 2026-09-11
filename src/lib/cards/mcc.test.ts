import { describe, expect, it } from "vitest";

import { MCC_GROUPS, describeMcc, isMcc, parseMccList, withGroup } from "./mcc";

describe("isMcc", () => {
  it("accepts exactly four digits", () => {
    expect(isMcc("5542")).toBe(true);
    expect(isMcc("0742")).toBe(true);
  });

  it("rejects everything else", () => {
    for (const bad of ["554", "55421", "55a2", "", " 5542", "5542 ", 5542, null, undefined]) {
      expect(isMcc(bad)).toBe(false);
    }
  });
});

describe("parseMccList", () => {
  it("takes commas, spaces and newlines, because a pasted list has all three", () => {
    const parsed = parseMccList("5542, 7995\n6011  5812");
    expect(parsed.ok && parsed.codes).toEqual(["5542", "5812", "6011", "7995"]);
  });

  it("deduplicates and sorts, so two saves of the same list compare equal", () => {
    const parsed = parseMccList("7995,5542,7995");
    expect(parsed.ok && parsed.codes).toEqual(["5542", "7995"]);
  });

  it("returns an empty list for empty input rather than failing", () => {
    const parsed = parseMccList("   ");
    expect(parsed.ok && parsed.codes).toEqual([]);
  });

  it("REFUSES a malformed code instead of dropping or padding it", () => {
    // Padding '763' to '0763' blocks agricultural co-operatives, which nobody
    // asked for. Dropping it produces a control set that does not block what
    // the screen said it would. Both are worse than an error message.
    const parsed = parseMccList("5542, 763");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("763");
  });

  it("names at most three offenders and counts the rest", () => {
    const parsed = parseMccList("a b c d e");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("2 more");
  });

  it("keeps codes as strings so a leading zero survives the round trip", () => {
    const parsed = parseMccList("0742");
    expect(parsed.ok && parsed.codes).toEqual(["0742"]);
  });
});

describe("MCC groups", () => {
  it("only contains well-formed codes", () => {
    for (const group of MCC_GROUPS) {
      for (const code of group.codes) expect(isMcc(code)).toBe(true);
    }
  });

  it("includes the automated fuel dispenser the brief's live fire uses", () => {
    const fuel = MCC_GROUPS.find((g) => g.id === "fuel");
    expect(fuel?.codes).toContain("5542");
  });

  it("unions into an existing list without duplicating", () => {
    const fuel = MCC_GROUPS.find((g) => g.id === "fuel");
    if (fuel === undefined) throw new Error("fuel group missing");
    expect(withGroup(["5542", "7995"], fuel)).toEqual(["5541", "5542", "5983", "7995"]);
  });
});

describe("describeMcc", () => {
  it("names a code it knows", () => {
    expect(describeMcc("5542")).toBe("5542 · Automated fuel dispenser");
  });

  it("returns the bare code for one it does not, rather than inventing a name", () => {
    expect(describeMcc("9999")).toBe("9999");
  });
});
