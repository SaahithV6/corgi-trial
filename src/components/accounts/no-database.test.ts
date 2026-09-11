/**
 * WITH NO DATABASE, `/accounts` AND `/accounts/holds/[holdId]` REFUSE. They do
 * not crash, and they do not draw a console.
 *
 * ============================================================================
 * THESE TWO PAGE MODULES USED TO DIE WHILE THEY WERE BEING LOADED. Not in the
 * render — in the import. Three separate static chains reached
 * `@/lib/ledger/db`, which value-imports `@/lib/env`, which parses
 * `process.env` at module scope and throws `EnvironmentError` when
 * `APP_DATABASE_URL` is absent:
 *
 *   page.tsx -> ./actions                  -> @/lib/ledger/db
 *   page.tsx -> ./live-source              -> @/lib/ledger/balances -> db
 *   page.tsx -> ./fixtures                 -> @/lib/holds (index) -> store -> db
 *   page.tsx -> CardControlsPanel          -> @/lib/cards/store    -> db
 *   page.tsx -> CardControlsPanel -> Forms -> CardControlsActions  -> db
 *   holds/[holdId]/page.tsx -> ./live-source                       -> db
 *
 * So the operator got the framework's error page, and the hold route's
 * FIXTURE branch — `fixtureHoldDetail(holdId)`, which reads nothing and was
 * written so an over-capture could be drilled into without a book — was
 * unreachable for want of a database it never wanted.
 * ============================================================================
 *
 * AND THE THREE SOURCE CLAIMS. On one render this screen said `fixture` at the
 * top ("nothing here was read from or written to the database, and the
 * controls are inert"), `live ledger` over a directory it really had read
 * live, and a third badge over the card controls from a third predicate on a
 * different query axis. Three predicates, one screen, and no reader could tell
 * which of them the page meant. The assertions below are on the SET of claims,
 * because "the badge is right" and "the screen makes one claim" are different
 * assertions and only the second catches two badges disagreeing.
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { ACCOUNTS_NO_DATABASE, HOLD_NO_DATABASE } from "./unreadable";

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/**
 * Every badge on this screen that claims A BOOK WAS READ.
 *
 * `fixture` is deliberately not in this list and is asserted separately. The
 * demo-account table at the bottom of this screen is a drawing and says so on
 * its face; "no database" does not make a drawing any more or less drawn, and
 * deleting it would be answering a false claim with a missing screen.
 */
const LEDGER_CLAIMS = ["live ledger", "live", "NO DATABASE"] as const;

describe("/accounts with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/accounts/page");
    html = await renderPage(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of dying on the import that asks whether there is a database", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says what it could not read, with the code", () => {
    expect(html).toContain(ACCOUNTS_NO_DATABASE.code);
    expect(html).toContain("No database is configured for this deployment");
  });

  it("draws no console, no directory and no control panel", () => {
    // The live directory's own description, and the two headline notes the
    // console prints over figures it folded.
    expect(html).not.toContain("The whole book, folded at request time");
    expect(html).not.toContain("still withholding money");
    expect(html).not.toContain("How much of this customer");
    expect(html).not.toContain("Every decision, with the rule that fired");
  });

  it("does not claim every figure below was folded from journal lines", () => {
    expect(html).not.toContain("Every figure below is a fold over journal lines");
  });

  it("makes exactly one claim about a book being read", () => {
    expect(claimsIn(html, LEDGER_CLAIMS)).toEqual(["NO DATABASE"]);
  });

  it("still says the demo table is a fixture, because it is", () => {
    expect(claimsIn(html, ["fixture"])).toEqual(["fixture"]);
    expect(html).toContain("Demo accounts");
  });

  it("offers no retry for a failure a retry cannot clear", () => {
    expect(html).toContain("Retryable");
    expect(hasRetryControl(html)).toBe(false);
  });
});

describe("/accounts?controls=edge with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    const page = await import("@/app/(app)/accounts/page");
    html = await renderPage(page, { state: "edge", controls: "edge" });
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders the drawn states and claims nothing was read live", () => {
    expect(claimsIn(html, LEDGER_CLAIMS)).toEqual(["NO DATABASE"]);
    expect(claimsIn(html, ["fixture"])).toEqual(["fixture"]);
  });
});

describe("/accounts/holds/[holdId] with no database configured", () => {
  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("still opens the fixture hold, which never wanted a database", async () => {
    delete process.env["APP_DATABASE_URL"];
    const fixtures = await import("./fixtures");
    const page = await import("@/app/(app)/accounts/holds/[holdId]/page");
    const html = await renderPage({
      default: () => page.default({ params: Promise.resolve({ holdId: fixtures.EDGE_HOLD_ID }) }),
    });
    expect(html).toContain("A(E)");
    expect(claimsIn(html, LEDGER_CLAIMS)).toEqual([]);
  }, 30_000);

  it("refuses a real hold id rather than reporting a read failure", async () => {
    delete process.env["APP_DATABASE_URL"];
    const page = await import("@/app/(app)/accounts/holds/[holdId]/page");
    const html = await renderPage({
      default: () =>
        page.default({
          params: Promise.resolve({ holdId: "3fa85f64-5717-4562-b3fc-2c963f66afa6" }),
        }),
    });
    expect(html).toContain(HOLD_NO_DATABASE.code);
    expect(html).toContain("Retryable");
    expect(hasRetryControl(html)).toBe(false);
  }, 30_000);
});
