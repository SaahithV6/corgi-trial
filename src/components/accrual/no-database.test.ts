/**
 * WITH NO DATABASE, `/accruals` REFUSES. It does not report an exact book.
 *
 * ============================================================================
 * The guard this replaces could not run. `page.tsx` destructured `hasDatabase`
 * off `await import("@/lib/accrual/screen")`, and that module reaches
 * `@/lib/ledger/db` -> `@/lib/env`, which parses `process.env` at module scope
 * and throws `EnvironmentError` when `APP_DATABASE_URL` is absent. The import
 * on the line above only succeeds when a database IS configured; the predicate
 * on the line below returns false only when one is not. Measured with the
 * variable deleted, the render threw and the operator got the framework's
 * error page.
 * ============================================================================
 *
 * AND WHAT THE UNREACHABLE BRANCH WOULD HAVE DONE IS A ZERO THAT MEANS TWO
 * THINGS. It returned `createFixtureAccrualSource("default")`, and this
 * screen's summary tiles render the invariant counts as a VERDICT:
 *
 *     Exactness  EXACT   no closed month is a cent out · 0 claimed and undecided
 *     Residual pennies placed  0
 *
 * `v_accrual_month_drift` at nought rows means a complete month summed to its
 * monthly price to the cent — it means that BECAUSE THE VIEW WAS QUERIED.
 * Nought from a deployment that opened no connection is a clean bill on a book
 * nobody looked at, printed on the screen somebody opens to find out whether a
 * customer has been billed correctly. The gap tile fails the same way pointing
 * the other direction: "days are owed that nothing has claimed" is the line
 * that says the nightly tick has stopped, and a gap of nought from an unread
 * book is the reason nobody goes to look.
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { ACCRUAL_LEDGER_UNREADABLE } from "./unreadable";

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/** Every word this screen can use to claim it read something. */
const BADGES = ["LIVE DATABASE", "FIXTURE DATA", "NO DATABASE"] as const;

describe("/accruals with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/accruals/page");
    html = await renderPage(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of throwing on the import that asks whether there is a database", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says the accrual ledger was not read, with the code", () => {
    expect(html).toContain(ACCRUAL_LEDGER_UNREADABLE.code);
  });

  it("passes no book, because an unread ledger is not an exact one", () => {
    // The verdict the `default` fixture drew. `EXACT` is the answer to the only
    // question this screen settles, and nought rows from an unread book is not
    // a month that summed to its price.
    expect(html).not.toContain("EXACT");
    expect(html).not.toContain("Exactness");
    expect(html).not.toContain("Residual pennies placed");
    expect(html).not.toContain("Enrolled accounts");
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
 * The drawn demo states still say FIXTURE DATA, once, on a machine with no
 * database.
 *
 * Here so that the fix above cannot be "make every state refuse": a drawn board
 * is legitimate and says so, and "no database" does not make a drawing any more
 * or less drawn. It matters more on this screen than on most — an accrual tick
 * posts money to a customer with no human in between, so the four fixture
 * states exist to be walked in front of a panel without running one.
 */
describe("/accruals demo states with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  for (const state of ["empty", "edge"]) {
    it(`?state=${state} claims FIXTURE DATA and claims it once`, async () => {
      const page = await import("@/app/(app)/accruals/page");
      const html = await renderPage(page, { state });
      expect(claimsIn(html, BADGES)).toEqual(["FIXTURE DATA"]);
    }, 30_000);
  }
});
