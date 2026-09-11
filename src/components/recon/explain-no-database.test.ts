/**
 * WITH NO DATABASE, `/breaks` REFUSES. It does not narrate.
 *
 * ============================================================================
 * The guard this replaces could not run. `page.tsx` asked `hasDatabase()` by
 * destructuring it off `await import("@/lib/recon/explained-view")`, and
 * importing that module evaluates `@/lib/ledger/db` -> `@/lib/env`, which
 * parses `process.env` at module scope and throws `EnvironmentError` when
 * `APP_DATABASE_URL` is absent. The import on the line above only succeeds when
 * a database IS configured; the predicate on the line below returns false only
 * when one is not. It is the same unreachable shape `/reconciliation`,
 * `/pots`, `/disputes` and `/standing-orders` carried, on the screen next door
 * to the first of them.
 * ============================================================================
 *
 * AND WHAT THE UNREACHABLE BRANCH WOULD HAVE DONE IS WORSE THAN THE CRASH. It
 * returned `createFixtureExplainSource("default")`, which draws:
 *
 *     file lithic-settlement-2026-09-11.csv · run #2 · watermark seq 2445
 *     Breaks, classified — four class tiles, each with a count and an
 *     outstanding total
 *     a causal timeline reconstructed "from the journal"
 *
 * on a deployment that had not read a row. This screen's whole claim is that a
 * discrepancy's history is RECONSTRUCTED out of immutable journal rows. A
 * reconstruction from nothing is the one thing it must never print, and a
 * FIXTURE DATA badge further down does not withdraw the sentence "reconstruct
 * its history from the journal" above it.
 *
 * The four class tiles are the sharper half. `correction_open 0` on this
 * screen means "no discrepancy is mid-correction", which is a statement about
 * a book. Rendered from no read at all it is the same three characters saying
 * something it cannot know.
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { EXPLAIN_NO_DATABASE } from "./explain-unreadable";

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/** Every word this screen can use to claim it read something. */
const BADGES = ["LIVE LEDGER", "FIXTURE DATA", "NO DATABASE"] as const;

describe("/breaks with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/breaks/page");
    html = await renderPage(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of throwing on the import that asks whether there is a database", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says it could not read the file or the journal, with the code", () => {
    expect(html).toContain(EXPLAIN_NO_DATABASE.code);
    expect(html).toContain("This screen cannot see the file or the journal");
  });

  it("draws no run, no classified break and no timeline", () => {
    // Every one of these is drawn by the `default` fixture this used to return.
    expect(html).not.toContain("lithic-settlement");
    expect(html).not.toContain("Breaks, classified");
    expect(html).not.toContain("reconstruct its history from the journal");
    expect(html).not.toContain("watermark");
  });

  it("counts no correction class, because counting nothing is not a count of none", () => {
    // The four class tiles. `correction_open 0` from an unread book is a
    // statement about a book nobody looked at.
    expect(html).not.toContain("Correction in flight");
    expect(html).not.toContain("outstanding");
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
 * The four demo states still say FIXTURE DATA, once, on a machine with no
 * database.
 *
 * Here so that the fix above cannot be "make every state refuse": a drawn board
 * is legitimate and says so, and "no database" does not make a drawing any more
 * or less drawn. `?state=error` is left out because its panel's retry control
 * is a client component calling `useRouter()`, and no app router is mounted in
 * a unit test — the same limit `/reconciliation`'s file documents. The refusal
 * panel IS rendered for real above: that failure is not retryable, so it draws
 * no button.
 */
describe("/breaks demo states with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  for (const state of ["loading", "empty", "edge"]) {
    it(`?state=${state} claims FIXTURE DATA and claims it once`, async () => {
      const page = await import("@/app/(app)/breaks/page");
      const html = await renderPage(page, { state });
      expect(claimsIn(html, BADGES)).toEqual(["FIXTURE DATA"]);
    }, 30_000);
  }
});
