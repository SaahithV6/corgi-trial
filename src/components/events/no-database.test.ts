/**
 * WITH NO DATABASE, `/events` REFUSES. It does not report an idle queue.
 *
 * ============================================================================
 * The guard this replaces could not run. `page.tsx` asked
 * `live.hasDatabase()` after `const live = await import("./live-source")`, and
 * that module opens with `import { sql } from "@/lib/ledger/db"`, which reaches
 * `@/lib/env` and throws `EnvironmentError` at module scope when
 * `APP_DATABASE_URL` is absent. The import on the line above only succeeds when
 * a database IS configured; the predicate on the line below returns false only
 * when one is not. It is the seventh instance of the shape on this console.
 * ============================================================================
 *
 * AND WHAT THE UNREACHABLE BRANCH WOULD HAVE DONE IS A ZERO THAT MEANS TWO
 * THINGS. It returned `createFixtureEventsSource("empty")`, which draws the
 * delivery counters — delivered, pending, dead — and the queue cursor against
 * the ledger head, all reading nought.
 *
 * On a delivery log those are not decorations, they are the answer to the only
 * question the screen is opened to settle: is anything stuck. "Nothing is
 * queued and nothing is dead" is the reassuring answer, and it is the one this
 * screen would have given on a deployment that had opened no connection — with
 * a FIXTURE badge beside it, which tells a reader the ROWS are invented and not
 * that the COUNTS are unknown. Somebody whose webhooks are not arriving would
 * have read "0 pending, 0 dead" and gone to look at their own server.
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { EVENTS_LOG_UNREADABLE } from "./unreadable";

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/** Every word this screen can use to claim it read something. */
const BADGES = ["LIVE", "FIXTURE", "NO DATABASE"] as const;

describe("/events with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/events/page");
    html = await renderPage(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of throwing on the import that asks whether there is a database", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says it could not read the delivery log, with the code", () => {
    expect(html).toContain(EVENTS_LOG_UNREADABLE.code);
  });

  it("counts no delivery, because an unread queue is not an empty one", () => {
    // The four counters the `empty` fixture drew. Each is the answer to "is
    // anything stuck", and nought from an unread book answers it wrongly.
    expect(html).not.toContain("delivered");
    expect(html).not.toContain("pending");
    expect(html).not.toContain("dead letter");
    expect(html).not.toContain("behind");
  });

  it("registers no endpoint, because the form writes to a book it cannot see", () => {
    expect(html).not.toContain("Register an endpoint");
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
 * or less drawn.
 */
describe("/events demo states with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  for (const state of ["empty", "edge"]) {
    it(`?state=${state} claims FIXTURE and claims it once`, async () => {
      const page = await import("@/app/(app)/events/page");
      const html = await renderPage(page, { state });
      expect(claimsIn(html, BADGES)).toEqual(["FIXTURE"]);
    }, 30_000);
  }
});
