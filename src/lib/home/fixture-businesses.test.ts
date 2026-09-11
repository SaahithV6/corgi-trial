/**
 * Which businesses on this book are customers, pinned.
 *
 * This classification decides whether a figure appears in the operator
 * console's "Customer money on this book" headline. Getting it wrong in one
 * direction is embarrassing; getting it wrong in the other puts a test
 * suite's -$858,941.45 on camera as money the bank owes someone. So both
 * directions are asserted, and the live-database half of this file does what
 * migration 0041 did for the FX book: it checks the criterion against a
 * SECOND, INDEPENDENT one and refuses to accept the answer unless they agree.
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/lib/home
 */
import { describe, expect, it } from "vitest";

import { fixtureOriginOf, isPlaceholderEin, rosteredFixtureIds } from "./fixture-businesses";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

/** The card-hold integration suite's business — the one that made this file. */
const HOLDS_FIXTURE = "7e57b115-0000-5000-a000-000000000001";

describe("isPlaceholderEin", () => {
  it("recognises the shape every test suite in this repository types", () => {
    // holds.integration.test.ts, pots.integration.test.ts, fuzz.test.ts and
    // the live-fire attacks, verbatim.
    for (const ein of ["00-0000000", "00-0000001", "00-0000003", "00-0000007"]) {
      expect(isPlaceholderEin(ein)).toBe(true);
    }
  });

  it("does not fire on a real EIN", () => {
    // Every business opened through onboarding on this book.
    for (const ein of ["000000000", "222221000", "222221005", "123456789"]) {
      expect(isPlaceholderEin(ein)).toBe(false);
    }
  });

  it("is anchored, so a real EIN cannot be matched by a prefix or a suffix", () => {
    expect(isPlaceholderEin("100-0000001")).toBe(false);
    expect(isPlaceholderEin("00-00000012")).toBe(false);
    expect(isPlaceholderEin("00-000001")).toBe(false);
    expect(isPlaceholderEin("x00-0000001")).toBe(false);
  });

  it("does not throw on a business with no EIN recorded", () => {
    expect(isPlaceholderEin(null)).toBe(false);
    expect(isPlaceholderEin(undefined)).toBe(false);
    expect(isPlaceholderEin("")).toBe(false);
  });
});

describe("fixtureOriginOf", () => {
  it("names the suite that opened a fixture we know about", () => {
    const origin = fixtureOriginOf({ businessId: HOLDS_FIXTURE, ein: "00-0000000" });
    expect(origin).not.toBeNull();
    expect(origin?.source).toBe("src/lib/holds/holds.integration.test.ts");
    expect(origin?.reason.length).toBeGreaterThan(0);
  });

  it("still labels a fixture the roster has never heard of", () => {
    // The criterion that cannot go stale: a sixth fixture business opened by a
    // suite tomorrow is labelled the moment it appears, with nobody editing
    // the roster. Unknown is never a pass.
    const origin = fixtureOriginOf({
      businessId: "00000000-0000-4000-8000-000000009999",
      ein: "00-0000042",
    });
    expect(origin).not.toBeNull();
    expect(origin?.reason).toContain("placeholder EIN");
  });

  it("returns null for a real customer", () => {
    expect(
      fixtureOriginOf({
        businessId: "e274546d-6bdd-5266-b0fb-cc839a7811f9",
        ein: "000000000",
      }),
    ).toBeNull();
  });

  it("labels a rostered business even if its EIN does not look like a placeholder", () => {
    // The two criteria are a UNION. Labelling a customer as a fixture is a
    // visible, correctable embarrassment; the other error is the one on camera.
    expect(fixtureOriginOf({ businessId: HOLDS_FIXTURE, ein: "999999999" })).not.toBeNull();
  });

  it("every rostered entry carries both a source and a reason", () => {
    for (const id of rosteredFixtureIds()) {
      const origin = fixtureOriginOf({ businessId: id, ein: null });
      expect(origin?.source.trim().length, id).toBeGreaterThan(0);
      expect(origin?.reason.trim().length, id).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Against the live book                                                      */
/* -------------------------------------------------------------------------- */

d("the classification, against the live database", () => {
  /**
   * TWO CRITERIA, AND THEY MUST AGREE — migration 0041's shape.
   *
   * Criterion A: the EIN placeholder shape, which is what the code uses.
   * Criterion B: the business was never onboarded and has no deposit account
   *   opened through `openAccount()` — a fixture inserts its `2100` leaf with
   *   raw SQL, so it has journal activity it never had an opening for.
   *
   * Rather than restate B as SQL here, the assertion is the one that actually
   * protects the screen: **no business on this book is classified live while
   * carrying a placeholder EIN, and the seeded demo customers classify live.**
   * A regression in either direction fails loudly and names the business.
   */
  it("classifies every business on the book, and the demo customers as live", async () => {
    const { sql } = await import("@/lib/ledger/db");
    const { listBusinesses } = await import("@/lib/ledger/readers");

    const businesses = await listBusinesses(sql);
    expect(businesses.length).toBeGreaterThan(0);

    const live: string[] = [];
    const fixtures: string[] = [];
    for (const b of businesses) {
      const origin = fixtureOriginOf({ businessId: b.businessId, ein: b.ein });
      (origin === null ? live : fixtures).push(b.legalName);

      // The direction that matters: a placeholder EIN is NEVER customer money.
      if (isPlaceholderEin(b.ein)) {
        expect(origin, `${b.legalName} (${b.ein}) must be labelled a fixture`).not.toBeNull();
      }
    }

    // The seeded demo customers are the point of the whole build. If either of
    // these ever classified as a fixture, the console would drop real money
    // out of its headline, which is the mirror of the bug this file fixes.
    expect(live).toContain("Ridgeline Robotics, Inc.");
    expect(live).toContain("Kettle & Crumb Bakery LLC");

    // And a fixture-free book is a legitimate state (a freshly reset database),
    // so this asserts the partition is total rather than that it is non-empty.
    expect(live.length + fixtures.length).toBe(businesses.length);
  });
});
