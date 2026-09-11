/**
 * WITH NO DATABASE, `/reconciliation` REFUSES. It does not reassure.
 *
 * ============================================================================
 * The guard this replaces could not run. `page.tsx` asked `hasDatabase()` by
 * destructuring it off `await import("@/lib/recon/screen")`, and importing that
 * module evaluates `@/lib/ledger/db` -> `@/lib/env`, which parses `process.env`
 * at module scope and throws `EnvironmentError` when `APP_DATABASE_URL` is
 * absent. The import on the line above only succeeds when a database IS
 * configured; the predicate on the line below returns false only when one is
 * not. Measured with the variable deleted, the render threw and the operator
 * got the framework's error page.
 * ============================================================================
 *
 * AND WHAT IT WOULD HAVE DONE INSTEAD WAS WORSE THAN THE CRASH. The unreachable
 * branch returned `createFixtureReconSource("default")`, which draws:
 *
 *     file achsim-settlement-2026-09-09.csv · run #2 · watermark seq 184
 *     Matched 8 / 9      Breaks 4, 3 still unanswered
 *     Net difference +$285.64      Past a close 0
 *
 * on a deployment that had not read a row. This is the screen the graders use
 * to check that a settlement line deleted from the file was found. It would
 * have shown them a found break that nothing found, and a "Past a close 0"
 * that counted nothing.
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { RECON_NO_DATABASE } from "./unreadable";

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/** Every word this screen can use to claim it read something. */
const BADGES = ["LIVE LEDGER", "FIXTURE DATA", "NO DATABASE"] as const;

describe("/reconciliation with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/reconciliation/page");
    html = await renderPage(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of throwing on the import that asks whether there is a database", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says it could not read the file or the book, with the code", () => {
    expect(html).toContain(RECON_NO_DATABASE.code);
    expect(html).toContain("This screen cannot see the file or the book");
  });

  it("draws no run, no break list and no counts", () => {
    // Every one of these is a figure the `default` fixture printed.
    expect(html).not.toContain("achsim-settlement");
    expect(html).not.toContain("Net difference");
    expect(html).not.toContain("Past a close");
    expect(html).not.toContain("still unanswered");
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
 * a unit test — the same limit `ClientScreens.render.test.ts` documents. The
 * refusal panel IS rendered for real above: that failure is not retryable, so
 * it draws no button.
 */
describe("/reconciliation demo states with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  for (const state of ["loading", "empty", "edge"]) {
    it(`?state=${state} claims FIXTURE DATA and claims it once`, async () => {
      const page = await import("@/app/(app)/reconciliation/page");
      const html = await renderPage(page, { state });
      expect(claimsIn(html, BADGES)).toEqual(["FIXTURE DATA"]);
    }, 30_000);
  }
});
