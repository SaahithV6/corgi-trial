/**
 * WITH NO DATABASE, `/standing-orders` REFUSES. It does not reassure.
 *
 * ============================================================================
 * The guard this replaces could not run. `page.tsx` asked `hasDatabase()` by
 * destructuring it off `await import("@/lib/standing/screen")`, and importing
 * that module evaluates `@/lib/ledger/db` -> `@/lib/env`, which parses
 * `process.env` at module scope and throws `EnvironmentError` when
 * `APP_DATABASE_URL` is absent. The import on the line above only succeeds when
 * a database IS configured; the predicate on the line below returns false only
 * when one is not. Measured with the variable deleted, the render threw and the
 * operator got the framework's error page.
 * ============================================================================
 *
 * AND WHAT IT WOULD HAVE DONE INSTEAD WAS WORSE THAN THE CRASH. The unreachable
 * branch returned `createFixtureStandingSource("default")`, which draws:
 *
 *     book date Sep 10, 2026 · mandates 3 · occurrences 4
 *     Live mandates 2      Next occurrence Sep 11, 2026
 *     Raised $4,900.00     Refused 1 · 0 claimed and undecided
 *
 * on a deployment that had not read a row. The last figure is this screen's
 * entire claim — an occurrence fires once and only once, and nothing is left
 * claimed and undecided — and it was rendered as zero by a page that had
 * counted nothing. "No occurrence fired twice" and "I could not look" are not
 * the same sentence.
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { STANDING_NO_DATABASE } from "./unreadable";

/**
 * WHY THE ACTION MODULE IS STUBBED, and it is the only stub here.
 *
 * `MandateForms` is a `"use client"` component importing
 * `@/app/(app)/standing-orders/actions` for its two action functions, and the
 * Next build replaces that
 * import with a server-action reference rather than loading the module into the
 * page render. Vitest has no such loader, so it evaluates the real actions
 * module, which reaches `@/lib/ledger/db` -> `@/lib/env` and throws for want of
 * the very variable this file is about. The stub stands in for the boundary the
 * framework draws; `page.tsx`, its guard and every component below it are the
 * real ones. Same reasoning, and the same shape, as
 * `src/components/pots/no-database.test.ts`, which measured it against a
 * production build served with `APP_DATABASE_URL` empty.
 *
 * THIS FILE WENT RED WHEN `MandatePanel` LANDED, and that is the point of it.
 * `/standing-orders` was repaired for the no-database defect earlier today; a
 * new panel added one static import — page -> MandatePanel -> MandateForms ->
 * actions -> db — and the screen went straight back to the framework error
 * page. The guard caught the regression on the same afternoon it was written,
 * which is the argument for having written it.
 */
vi.mock("@/app/(app)/standing-orders/actions", () => ({
  createStandingOrderAction: () => undefined,
  cancelStandingOrderAction: () => undefined,
}));

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/** Every word this screen can use to claim it read something. */
const BADGES = ["LIVE DATABASE", "FIXTURE DATA", "NO DATABASE"] as const;

describe("/standing-orders with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/standing-orders/page");
    html = await renderPage(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of throwing on the import that asks whether there is a database", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says it could not read the schedule, with the code", () => {
    expect(html).toContain(STANDING_NO_DATABASE.code);
    expect(html).toContain("This screen cannot see the schedule");
  });

  it("draws no mandate, no occurrence and no invariant tile", () => {
    // Every one of these is a figure the `default` fixture printed.
    expect(html).not.toContain("Live mandates");
    expect(html).not.toContain("Next occurrence");
    expect(html).not.toContain("claimed and undecided");
    expect(html).not.toContain("book date");
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
 * The demo states still say FIXTURE DATA, once, on a machine with no database.
 *
 * Here so that the fix above cannot be "make every state refuse": a drawn board
 * is legitimate and says so, and "no database" does not make a drawing any more
 * or less drawn. `?state=error` is left out because its panel's retry control
 * is a client component calling `useRouter()`, and no app router is mounted in
 * a unit test — the same limit `ClientScreens.render.test.ts` documents. The
 * refusal panel IS rendered for real above: that failure is not retryable, so
 * it draws no button.
 */
describe("/standing-orders demo states with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  for (const state of ["loading", "empty", "edge"]) {
    it(`?state=${state} claims FIXTURE DATA and claims it once`, async () => {
      const page = await import("@/app/(app)/standing-orders/page");
      const html = await renderPage(page, { state });
      expect(claimsIn(html, BADGES)).toEqual(["FIXTURE DATA"]);
    }, 30_000);
  }
});
