/**
 * WITH NO DATABASE, `/economics` REFUSES. It does not report a blank programme.
 *
 * ============================================================================
 * TWO FAULTS, AND THE SECOND IS THE ONE WORTH THE FILE.
 *
 * 1. THE GUARD COULD NOT RUN, AND NEITHER COULD THE PAGE. `page.tsx` asked
 *    `hasDatabase()` by destructuring it off `await import("@/lib/interchange/screen")`,
 *    which is the unreachable shape five other screens carried: importing that
 *    module evaluates `@/lib/ledger/db` -> `@/lib/env`, which throws
 *    `EnvironmentError` at module scope without `APP_DATABASE_URL`, so the
 *    predicate on the line below could only be reached when the answer was yes.
 *
 *    On this screen it was worse than unreachable. `EconomicsView.tsx` imports
 *    `portfolioTotals` and `formatBps` from that same module as VALUES, and
 *    `page.tsx` imports `EconomicsView` statically, so the page MODULE never
 *    finished evaluating. Measured with the variable deleted, the render threw
 *    at `src/lib/ledger/db.ts:18` before the component function was called, and
 *    every fixture state went down with it.
 *
 * 2. WHAT THE UNREACHABLE BRANCH WOULD HAVE DONE IS A ZERO THAT MEANS TWO
 *    THINGS. It returned `createFixtureEconomicsSource("empty")`, and the empty
 *    state of this screen is not a blank page — it is an ASSERTION:
 *
 *        "No card has settled yet"
 *        "Interchange is earned on the clearing. Until a card transaction
 *         settles there is nothing to price, and this page will not invent a
 *         figure to fill itself."
 *        "The rate card, already in force"   — over four invented bands
 *
 *    Every word of that is a statement about a book. "No card has settled yet"
 *    is a finding; "nothing was read" is a different fact with a different
 *    remedy, and an operator who sees the first will not go looking for the
 *    second. The rate card panel is sharper still: it says the card is in
 *    force whether or not anything has priced against it, which is true of a
 *    rate card that was read and meaningless over four rows from a fixture.
 *
 *    And the state bar prints its `fixture` badge only when the state is not
 *    `default` — so on the no-database path the screen made NO claim about its
 *    data source at all while asserting that no card had ever settled.
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { ECONOMICS_BOOK_UNREADABLE } from "./unreadable";

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/** Every word this screen can use to claim it read something. */
const BADGES = ["fixture", "NO DATABASE"] as const;

describe("/economics with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/economics/page");
    html = await renderPage(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of failing to load the page module", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says it could not read the book, with the code", () => {
    expect(html).toContain(ECONOMICS_BOOK_UNREADABLE.code);
    expect(html).toContain("This screen cannot see the book");
  });

  it("does not report that no card has settled, which is a finding it did not make", () => {
    expect(html).not.toContain("No card has settled yet");
    expect(html).not.toContain("this page will not invent a figure to fill itself");
  });

  it("prints no rate card, because a card nobody read is not a card in force", () => {
    expect(html).not.toContain("already in force");
    expect(html).not.toContain("Effective-dated");
  });

  it("counts no guard, because a guard nobody queried is a comment", () => {
    // The guards panel's own claim. It is the one panel on this screen whose
    // whole point is that the invariants were run on THIS render.
    expect(html).not.toContain("Counted live, on every render");
    expect(html).not.toContain("v_interchange_unreversed");
  });

  it("makes exactly one claim about its data source", () => {
    expect(claimsIn(html, BADGES)).toEqual(["NO DATABASE"]);
  });

  it("offers no retry for a failure a retry cannot clear", () => {
    expect(html).toContain("Retryable");
    expect(hasRetryControl(html)).toBe(false);
  });
});

/**
 * The four demo states still say `fixture`, once, on a machine with no
 * database.
 *
 * Here so that the fix above cannot be "make every state refuse": a drawn board
 * is legitimate and says so, and "no database" does not make a drawing any more
 * or less drawn. All four were unreachable before this repair, because the page
 * module itself could not load — so this is not only a guard against
 * over-correction, it is the first time three of them have rendered on a
 * machine with no database at all.
 */
describe("/economics demo states with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  for (const state of ["empty", "edge"]) {
    it(`?state=${state} claims fixture and claims it once`, async () => {
      const page = await import("@/app/(app)/economics/page");
      const html = await renderPage(page, { state });
      expect(claimsIn(html, BADGES)).toEqual(["fixture"]);
    }, 30_000);
  }
});
