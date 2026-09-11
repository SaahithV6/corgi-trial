import { describe, expect, it } from "vitest";

import {
  compareNames,
  jaro,
  jaroWinkler,
  NAME_CLOSE_THRESHOLD,
  NAME_MATCH_THRESHOLD,
  nameMatchBand,
  nameTokens,
  normaliseName,
  structuralScore,
} from "./name-match";

/**
 * The comparison, pinned against a real provider's answers.
 *
 * The table in the first block is not invented. Plaid's `/identity/match` was
 * called live against a sandbox Item holding `Alberta Bobbeth Charleson` with
 * the credentials in `.env`; six calls, six 200s, and the `legal_name.score`
 * each returned. docs/PAYEES.md carries the responses. This test asserts our
 * algorithm reproduces Plaid's ORDERING and lands in the bands a payments
 * person would agree with — including at the one place it is deliberately
 * stricter than Plaid.
 */

const BANK_HOLDS = "Alberta Bobbeth Charleson";

describe("calibration against Plaid /identity/match, measured", () => {
  const cases: readonly {
    readonly typed: string;
    readonly plaid: number;
    readonly band: "match" | "close_match" | "no_match";
  }[] = [
    { typed: "Alberta Bobbeth Charleson", plaid: 100, band: "match" },
    { typed: "ALBERTA B CHARLESON", plaid: 99, band: "match" },
    { typed: "Alberta Charleson", plaid: 99, band: "match" },
    { typed: "Alberta Charlson", plaid: 93, band: "close_match" },
    { typed: "Roberto Gonzalez", plaid: 28, band: "no_match" },
    { typed: "Acme Widgets LLC", plaid: 0, band: "no_match" },
  ];

  for (const c of cases) {
    it(`"${c.typed}" → ${c.band} (Plaid scored it ${c.plaid})`, () => {
      expect(compareNames(c.typed, BANK_HOLDS).band).toBe(c.band);
    });
  }

  it("reproduces Plaid's ordering wherever Plaid is making a distinction that matters", () => {
    // The honest form of this claim, and worth stating precisely because the
    // sloppy form ("we reproduce Plaid's ranking") is false.
    //
    // ABOVE THE CLOSE THRESHOLD the two agree on rank: wherever Plaid scores
    // one name strictly higher than another, so do we. That is the region
    // where the number decides something.
    //
    // BELOW IT they do not, and need not: Plaid puts `Acme Widgets LLC` at 0
    // and `Roberto Gonzalez` at 28, we put them at 54 and 46. Jaro-Winkler
    // over two English strings shares vowels and never approaches zero, so
    // our floor is higher and its internal order is arbitrary. Nothing below
    // 80 behaves differently from anything else below 80 — both warn, both
    // need the same signature — so the disagreement is invisible to the
    // product. Asserting a rank we do not have would be a test that lies.
    const scored = cases.map((c) => ({ ...c, ours: compareNames(c.typed, BANK_HOLDS).score }));

    for (const a of scored) {
      for (const b of scored) {
        if (a.plaid <= b.plaid) continue;
        if (b.plaid < 80) {
          expect(nameMatchBand(b.ours)).toBe("no_match");
          continue;
        }
        expect(a.ours).toBeGreaterThan(b.ours);
      }
    }
  });

  it("is deliberately STRICTER than Plaid on a one-letter surname difference", () => {
    // Plaid scores `Charlson` at 93 and its own guidance treats >= 90 as a
    // match, which would wave through the exact typo this feature exists to
    // catch. Ours does not, and this test is the record of that choice.
    const comparison = compareNames("Alberta Charlson", BANK_HOLDS);
    expect(comparison.score).toBeLessThan(NAME_MATCH_THRESHOLD);
    expect(comparison.band).toBe("close_match");
  });
});

describe("THE RULE: character similarity may never assert a match", () => {
  it("an inserted letter scores 99 on Jaro-Winkler and still does not match", () => {
    const typed = "Alberta Bobbeth Charleston"; // one letter added to the surname
    const textual = jaroWinkler(
      nameTokens(typed).join(""),
      nameTokens(BANK_HOLDS).join(""),
    );
    // The raw similarity really is that high. This is the number an algorithm
    // that trusted Jaro-Winkler would act on.
    expect(textual).toBeGreaterThan(0.98);

    const comparison = compareNames(typed, BANK_HOLDS);
    expect(comparison.textual).toBeGreaterThanOrEqual(98);
    // And the clamp holds it one point below the threshold, in front of a
    // human, which is the whole design.
    expect(comparison.score).toBe(NAME_MATCH_THRESHOLD - 1);
    expect(comparison.band).toBe("close_match");
  });

  it("no input reaches `match` without structural agreement", () => {
    // Brute force over a family of one-edit surnames: none may match.
    const surname = "CHARLESON";
    for (let i = 0; i < surname.length; i += 1) {
      for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
        if (surname[i] === letter) continue;
        const typo = `Alberta Bobbeth ${surname.slice(0, i)}${letter}${surname.slice(i + 1)}`;
        const comparison = compareNames(typo, BANK_HOLDS);
        expect(comparison.band).not.toBe("match");
        expect(comparison.score).toBeLessThan(NAME_MATCH_THRESHOLD);
      }
    }
  });
});

describe("differences that are presentational, and must not warn", () => {
  const same: readonly [string, string][] = [
    ["Ridgeline Coffee Roasters LLC", "Ridgeline Coffee Roasters, L.L.C."],
    ["Ridgeline Coffee Roasters LLC", "RIDGELINE COFFEE ROASTERS L.L.C."],
    ["Acme Corp", "ACME CORPORATION"],
    ["Acme Co", "Acme Company"],
    ["Widgets P.C.", "Widgets PC"],
    ["Smith & Jones", "Smith and Jones"],
    ["Jose Ramirez", "José Ramírez"],
    ["The Home Depot", "Home Depot"],
    ["John Smith", "Smith John"],
    ["John Smith", "John Q Smith"],
    ["Alberta Charleson", "Alberta Bobbeth Charleson"],
    ["  Ridgeline   Coffee  ", "Ridgeline Coffee"],
  ];

  for (const [a, b] of same) {
    it(`"${a}" matches "${b}"`, () => {
      expect(compareNames(a, b).band).toBe("match");
      expect(compareNames(b, a).band).toBe("match");
    });
  }
});

describe("differences that are real, and must warn", () => {
  const different: readonly [string, string, "close_match" | "no_match"][] = [
    // A missing terminal word is a different business, not a shorter name.
    ["Ridgeline Coffee", "Ridgeline Coffee Roasters LLC", "close_match"],
    // A trading name against a registered one. The legitimate case, warned.
    ["RCR Holdings LLC", "Ridgeline Coffee Roasters LLC", "no_match"],
    // One letter in a surname.
    ["Northwind Trading", "Northwind Traders", "close_match"],
    // A single token standing in for a full name.
    ["Charleson", "Alberta Bobbeth Charleson", "no_match"],
    // Entirely different.
    ["Roberto Gonzalez", "Alberta Bobbeth Charleson", "no_match"],
  ];

  for (const [a, b, band] of different) {
    it(`"${a}" vs "${b}" → ${band}`, () => {
      expect(compareNames(a, b).band).toBe(band);
    });
  }

  it("a terminal difference always drops out of match, however long the name", () => {
    expect(compareNames("Alpha Beta Gamma", "Alpha Beta Gamma Delta").band).not.toBe("match");
    expect(compareNames("Beta Gamma Delta", "Alpha Beta Gamma Delta").band).not.toBe("match");
  });

  it("no number of interior differences can drop it out of match", () => {
    // Middle names and initials are free; that asymmetry is deliberate and is
    // what makes `Alberta Charleson` a match while `Ridgeline Coffee` is not.
    expect(compareNames("Alpha Delta", "Alpha Beta Gamma Delta").band).toBe("match");
  });
});

describe("normalisation", () => {
  it("uppercases, strips diacritics and punctuation, collapses space", () => {
    expect(normaliseName("  José  Ramírez-Ortiz, Jr. ")).toBe("JOSE RAMIREZ ORTIZ JR");
  });

  it("spells out an ampersand even with no spaces around it", () => {
    expect(normaliseName("Smith&Jones")).toBe("SMITH AND JONES");
  });

  it("joins a dotted initialism only when it is a legal form", () => {
    expect(nameTokens("Ridgeline L.L.C.")).toEqual(["RIDGELINE"]);
    // A B are somebody's initials, not a legal form, and must survive.
    expect(nameTokens("A B Smith")).toEqual(["A", "B", "SMITH"]);
  });

  it("keeps the name when it is nothing but a legal form", () => {
    expect(nameTokens("LLC")).toEqual(["LLC"]);
  });

  it("does not strip words that are part of a name", () => {
    // TRUST, HOLDINGS, GROUP and PARTNERS are not legal forms appended to a
    // name; they ARE the name, and dropping them would equate two businesses.
    expect(nameTokens("Ridgeline Holdings")).toEqual(["RIDGELINE", "HOLDINGS"]);
    expect(compareNames("Ridgeline Holdings", "Ridgeline").band).not.toBe("match");
  });
});

describe("empty and hostile input", () => {
  it("two empty names are not a match", () => {
    const comparison = compareNames("", "");
    expect(comparison.score).toBe(0);
    expect(comparison.band).toBe("no_match");
  });

  it("one empty name is not a match", () => {
    expect(compareNames("", "Ridgeline Coffee").band).toBe("no_match");
    expect(compareNames("Ridgeline Coffee", "").band).toBe("no_match");
  });

  it("punctuation-only input is not a match", () => {
    expect(compareNames("!!!", "???").band).toBe("no_match");
  });

  it("never throws", () => {
    for (const value of ["", " ", " ", "𝔯𝔦𝔡𝔤𝔢", "x".repeat(5000)]) {
      expect(() => compareNames(value, BANK_HOLDS)).not.toThrow();
    }
  });
});

describe("Jaro-Winkler, as an implementation", () => {
  it("reproduces the textbook values", () => {
    // The canonical examples from Winkler's own paper, to three places.
    expect(jaro("MARTHA", "MARHTA")).toBeCloseTo(0.9444, 3);
    expect(jaroWinkler("MARTHA", "MARHTA")).toBeCloseTo(0.9611, 3);
    expect(jaro("DWAYNE", "DUANE")).toBeCloseTo(0.8222, 3);
    expect(jaroWinkler("DWAYNE", "DUANE")).toBeCloseTo(0.84, 3);
    expect(jaro("DIXON", "DICKSONX")).toBeCloseTo(0.7667, 3);
    expect(jaroWinkler("DIXON", "DICKSONX")).toBeCloseTo(0.8133, 3);
  });

  it("is symmetric", () => {
    expect(jaroWinkler("RIDGELINE", "RIDGLINE")).toBeCloseTo(
      jaroWinkler("RIDGLINE", "RIDGELINE"),
      10,
    );
  });

  it("is zero against nothing", () => {
    expect(jaro("", "")).toBe(0);
    expect(jaroWinkler("ABC", "")).toBe(0);
  });
});

describe("bands and thresholds", () => {
  it("applies the two thresholds and nothing else", () => {
    expect(nameMatchBand(100)).toBe("match");
    expect(nameMatchBand(NAME_MATCH_THRESHOLD)).toBe("match");
    expect(nameMatchBand(NAME_MATCH_THRESHOLD - 1)).toBe("close_match");
    expect(nameMatchBand(NAME_CLOSE_THRESHOLD)).toBe("close_match");
    expect(nameMatchBand(NAME_CLOSE_THRESHOLD - 1)).toBe("no_match");
    expect(nameMatchBand(0)).toBe("no_match");
  });

  it("scores are whole numbers between 0 and 100", () => {
    for (const [a, b] of [
      ["Ridgeline", "Ridgeline"],
      ["Ridgeline Coffee", "Ridgeline Coffee Roasters"],
      ["", "Ridgeline"],
      ["Zebra", "Ridgeline Coffee Roasters LLC"],
    ] as const) {
      const { score } = compareNames(a, b);
      expect(Number.isInteger(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });

  it("structuralScore is order-independent between the two names", () => {
    const a = nameTokens("Alberta Charleson");
    const b = nameTokens("Alberta Bobbeth Charleson");
    expect(structuralScore(a, b)).toBe(structuralScore(b, a));
  });
});
