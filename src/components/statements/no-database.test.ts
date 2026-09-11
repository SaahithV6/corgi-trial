/**
 * WITH NO DATABASE, `/statements` REFUSES. It does not reproduce a hash it
 * never took.
 *
 * ============================================================================
 * THIS IS THE WORST OF THE SIX, and it is the only one where the guard RAN.
 * ============================================================================
 *
 * `page.tsx` asked `hasDatabase()` by destructuring it off
 * `await import("./live-source")`, which is the same unreachable shape the
 * other five screens carried — but this page's module graph happens not to
 * evaluate `@/lib/env` at module scope, so the import survived. On luck: one
 * new import in `live-source.ts` would have turned this screen into the
 * framework error page without anybody touching `page.tsx`.
 *
 * What it did when it ran was the defect. `createFixtureStatementsScreen("default")`
 * rendered, measured with `APP_DATABASE_URL` deleted, a complete statement:
 *
 *     business Ridgeline Robotics, Inc. · value date Jul 24, 2026
 *     day close Jul 24, 2026 · 19:02 ET · seq 485
 *     As published $19,006.55      As corrected $19,006.55
 *     "It was re-derived from the ledger on this page load and hashed to the
 *      stored value"
 *     HASH REPRODUCED
 *
 * on a deployment that had opened no connection. The entire claim of this
 * screen is that the two figures are derived from the journal at request time
 * and that the hash proves it. A FIXTURE DATA badge twelve lines further down
 * does not withdraw that sentence, and a screenshot of this page would have
 * been the most misleading artefact this repository could produce.
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { STATEMENTS_NO_DATABASE } from "./unreadable";

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/** Every word this screen can use to claim it read something. */
const BADGES = ["LIVE LEDGER", "FIXTURE DATA", "NO DATABASE"] as const;

describe("/statements with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/statements/page");
    html = await renderPage(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of throwing on the import that asks whether there is a database", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says it could not read the book, with the code", () => {
    expect(html).toContain(STATEMENTS_NO_DATABASE.code);
    expect(html).toContain("This screen cannot see the book");
  });

  it("derives no reading, issues no document and reproduces no hash", () => {
    // Every one of these was on the page the old fallback rendered.
    expect(html).not.toContain("HASH REPRODUCED");
    expect(html).not.toContain("re-derived from the ledger on this page load");
    expect(html).not.toContain("As published");
    expect(html).not.toContain("As corrected");
    expect(html).not.toContain("$19,006.55");
  });

  it("makes exactly one claim about its data source", () => {
    expect(claimsIn(html, BADGES)).toEqual(["NO DATABASE"]);
  });

  it("offers no retry for a failure a retry cannot clear", () => {
    expect(html).toContain("Retryable");
    expect(hasRetryControl(html)).toBe(false);
  });

  /**
   * `?asKnownAt=` renders its own panel above the document, and that panel
   * issues its own reads. With no database it would throw inside a boundary
   * whose fallback is `null` — a panel that silently vanishes on the one screen
   * whose claim is that a past belief can be reproduced. It does not render,
   * and the refusal below it says why nothing was read.
   */
  it("does not open the time-travel panel it has nothing to read for", async () => {
    const page = await import("@/app/(app)/statements/page");
    const travelled = await renderPage(page, { asKnownAt: "2026-07-24T19:00:00Z" });
    expect(travelled).toContain(STATEMENTS_NO_DATABASE.code);
    expect(claimsIn(travelled, BADGES)).toEqual(["NO DATABASE"]);
  }, 30_000);
});

/**
 * The three fixture states still say FIXTURE DATA, once, on a machine with no
 * database.
 *
 * Here so that the fix above cannot be "make every state refuse": a drawn board
 * is legitimate and says so, and "no database" does not make a drawing any more
 * or less drawn. `?state=error` is left out because its panel's retry control
 * is a client component calling `useRouter()`, and no app router is mounted in
 * a unit test — the same limit `ClientScreens.render.test.ts` documents. The
 * refusal panel IS rendered for real above: that failure is not retryable, so
 * it draws no button.
 */
describe("/statements demo states with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  for (const state of ["loading", "empty"]) {
    it(`?state=${state} claims FIXTURE DATA and claims it once`, async () => {
      const page = await import("@/app/(app)/statements/page");
      const html = await renderPage(page, { state });
      expect(claimsIn(html, BADGES)).toEqual(["FIXTURE DATA"]);
    }, 30_000);
  }
});
