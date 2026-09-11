/**
 * WITH NO DATABASE, `/funding` REFUSES. It does not report a position.
 *
 * ============================================================================
 * There was no guard here at all — not even an unreachable one. `FundingView.tsx`
 * opened with a STATIC
 * `import { createLiveFundingSource } from "@/app/(app)/funding/live-source"`,
 * that module opens with `import { sql } from "@/lib/ledger/db"`, and
 * `@/lib/env` parses `process.env` at module scope and throws
 * `EnvironmentError` when `APP_DATABASE_URL` is absent. The PAGE MODULE could
 * not be loaded, so there was nowhere for a guard to run: the operator got the
 * framework's error page before a line of this screen was rendered, and all
 * five states went down together — including `loading`, `empty` and `error`,
 * which are fixtures and need no database at all.
 * ============================================================================
 *
 * AND THIS SCREEN IS ONE WHERE DRAWING FROM NOTHING WOULD BE WORSE THAN THE
 * CRASH. Its headline is four numbers and the gap between the first and the
 * last is the whole product:
 *
 *     ledger  −  card holds  −  uncleared  =  available
 *
 * Every one of the four reading nought is a POSITION, stated in the one place
 * on this console a reader looks to find out whether a customer's deposit has
 * landed and whether they may spend it. `available 0` is the figure a support
 * agent repeats to a customer. The `empty` fixture is no safer: its state is a
 * finding — "no deposit account on this book for an inbound credit to land in"
 * — and an operator who reads that goes and opens an account.
 *
 * WHY THE ACTION MODULE IS STUBBED. `FundForm` and `LinkPanel` are `"use client"`
 * components that import `@/app/(app)/funding/actions`, and the Next build
 * replaces that import with a server-action reference rather than loading the
 * module into the page render. Vitest has no such loader, so it evaluates the
 * real actions module, which reaches `@/lib/ledger/db` -> `@/lib/env` and throws
 * for want of the variable this whole file is about. The stub stands in for the
 * boundary the framework draws. `next/headers` is supplied for the same reason:
 * this screen reads the demo role cookie and `cookies()` throws outside a
 * request scope. `page.tsx`, `FundingView` and every component below them are
 * the real ones.
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { FUNDING_SCREEN_UNREADABLE } from "./unreadable";

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined }),
}));

vi.mock("@/app/(app)/funding/actions", () => ({
  fundFromExternalBankAction: () => undefined,
  linkExternalBankAction: () => undefined,
  probeItemErrorsAction: () => undefined,
}));

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/** Every word this screen can use to claim it read something. */
const BADGES = ["LIVE", "FIXTURE", "NO DATABASE"] as const;

describe("/funding with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/funding/page");
    html = await renderPage(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of dying while the page module loads", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says the funding screen read nothing, with the code", () => {
    expect(html).toContain(FUNDING_SCREEN_UNREADABLE.code);
  });

  it("states no position, because an unread balance is not a balance of nought", () => {
    expect(html).not.toContain("Available to spend");
    expect(html).not.toContain("Uncleared");
    expect(html).not.toContain("Ledger balance");
  });

  it("draws no funding form, because the gate it would need was never read", () => {
    expect(html).not.toContain("Step one");
    expect(html).not.toContain("Fund this account");
  });

  it("makes exactly one claim about its data source", () => {
    expect(claimsIn(html, BADGES)).toEqual(["NO DATABASE"]);
  });

  it("states whether a retry could help, and offers none when it cannot", () => {
    expect(html).toContain("Retryable");
    expect(hasRetryControl(html)).toBe(false);
  });
});

/**
 * The drawn demo states still say FIXTURE, once, on a machine with no database.
 *
 * Here so that the fix above cannot be "make every state refuse": a drawn board
 * is legitimate and says so, and "no database" does not make a drawing any more
 * or less drawn. It is also the half of this repair that the crash destroyed —
 * these three states worked without a database and were taken down by a static
 * import on a sibling module's behalf.
 */
describe("/funding demo states with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  for (const state of ["empty"]) {
    it(`?state=${state} claims FIXTURE and claims it once`, async () => {
      const page = await import("@/app/(app)/funding/page");
      const html = await renderPage(page, { state });
      expect(claimsIn(html, BADGES)).toEqual(["FIXTURE"]);
    }, 30_000);
  }
});
