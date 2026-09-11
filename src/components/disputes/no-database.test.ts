/**
 * WITH NO DATABASE, `/disputes` REFUSES. It does not print a balance next to a
 * customer's name.
 *
 * ============================================================================
 * The guard this replaces could not run. `page.tsx` asked `hasDatabase()` by
 * destructuring it off `await import("@/lib/disputes/screen")`, and importing
 * that module evaluates `@/lib/ledger/db` -> `@/lib/env`, which parses
 * `process.env` at module scope and throws `EnvironmentError` when
 * `APP_DATABASE_URL` is absent. The import on the line above only succeeds when
 * a database IS configured; the predicate on the line below returns false only
 * when one is not. Measured with the variable deleted, the render threw and the
 * operator got the framework's error page.
 * ============================================================================
 *
 * AND WHAT IT WOULD HAVE DONE INSTEAD WAS WORSE THAN THE CRASH. The unreachable
 * branch returned `createFixtureDisputesSource("default")`, which draws:
 *
 *     Fixture Co. — position now
 *     ledger $12,345.00 − holds $0.00 = available $12,345.00
 *     Cases · DSP-20260910-FIXTUR raised 2026-09-10 · goods not received
 *
 * on a deployment that had not read a row. Every figure there is a claim about
 * somebody's money, printed beside a name.
 *
 * The same page also read the role cookie and resolved an operator before it
 * had established there was anything to read. It no longer does: a screen that
 * refuses has no board to label and no control to sit beside one.
 *
 * WHY THE ACTION MODULE IS STUBBED, and it is the only stub here.
 * `DisputeForms` is a `"use client"` component that imports
 * `@/app/(app)/disputes/actions`, and the Next build replaces that import with
 * a server-action reference rather than loading the module into the page render
 * — verified by serving a production build with `APP_DATABASE_URL` empty, where
 * `/disputes` answers 200 with this refusal. Vitest has no such loader, so it
 * evaluates the real actions module, which reaches `@/lib/ledger/db` and throws
 * for want of the variable this whole file is about. The stub stands in for the
 * boundary the framework draws. `page.tsx` itself, its guard and every
 * component below it are the real ones.
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { DISPUTES_NO_DATABASE } from "./unreadable";

vi.mock("@/app/(app)/disputes/actions", () => ({
  raiseDisputeAction: () => undefined,
  disputeTransitionAction: () => undefined,
}));

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/** Every word this screen can use to claim it read something. */
const BADGES = [
  "LIVE — read from the ledger",
  "FIXTURE — not the live database",
  "NO DATABASE",
] as const;

describe("/disputes with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/disputes/page");
    html = await renderPage(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  /**
   * Also the proof that the cookie read is gone. `readRole()` calls
   * `cookies()`, which throws outside a request scope; this test has none, so a
   * page that still read the role before deciding whether it could read
   * anything would fail on this line rather than on the ones below it.
   */
  it("renders instead of throwing on the import that asks whether there is a database", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says it could not read the cases, with the code", () => {
    expect(html).toContain(DISPUTES_NO_DATABASE.code);
    expect(html).toContain("This screen cannot see the cases");
  });

  it("draws no case, no charge and no balance", () => {
    // Every one of these is a figure the `default` fixture printed.
    expect(html).not.toContain("position now");
    expect(html).not.toContain("$12,345.00");
    expect(html).not.toContain("DSP-2026");
    expect(html).not.toContain("book date");
  });

  it("makes exactly one claim about its data source", () => {
    expect(claimsIn(html, BADGES)).toEqual(["NO DATABASE"]);
  });

  it("offers no retry for a failure a retry cannot clear", () => {
    expect(html).toContain("retryable");
    expect(hasRetryControl(html)).toBe(false);
  });
});

/**
 * The fixture states still say FIXTURE, once, on a machine with no database.
 *
 * Here so that the fix above cannot be "make every state refuse": a drawn board
 * is legitimate and says so, and "no database" does not make a drawing any more
 * or less drawn. `?state=error` is left out because its panel's retry control
 * is a client component calling `useRouter()`, and no app router is mounted in
 * a unit test — the same limit `ClientScreens.render.test.ts` documents. The
 * refusal panel IS rendered for real above: that failure is not retryable, so
 * it draws no button.
 */
describe("/disputes demo states with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  for (const state of ["loading", "empty"]) {
    it(`?state=${state} claims FIXTURE and claims it once`, async () => {
      const page = await import("@/app/(app)/disputes/page");
      const html = await renderPage(page, { state });
      expect(claimsIn(html, BADGES)).toEqual(["FIXTURE — not the live database"]);
    }, 30_000);
  }
});
