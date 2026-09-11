/**
 * WITH NO DATABASE, `/audit` REFUSES. It does not name a business.
 *
 * ============================================================================
 * The guard this replaces could not run. `page.tsx` asked `hasDatabase()` by
 * destructuring it off `await import("@/lib/audit/view")`, and importing that
 * module reaches `@/lib/ledger/db` -> `@/lib/env`, which parses `process.env`
 * at module scope and throws `EnvironmentError` when `APP_DATABASE_URL` is
 * absent. The import on the line above only succeeds when a database IS
 * configured; the predicate on the line below returns false only when one is
 * not. Same unreachable shape as `/reconciliation`, `/pots`, `/disputes`,
 * `/standing-orders` and `/breaks`.
 * ============================================================================
 *
 * AND THIS SCREEN IS THE ONE WHERE DRAWING FROM NOTHING IS WORST. The
 * unreachable branch returned `createFixtureSource()`, which draws:
 *
 *     Example Trading Co.
 *     "Every action recorded against this business, from every append-only
 *      store on the book, in order."
 *     showing 2 of 2 matching · business total 2 · sources 0 reconciled
 *
 * An audit trail is a claim about COMPLETENESS — that every store was read and
 * nothing was dropped. "0 reconciled" and "dropped 0" rendered from a
 * deployment that opened no connection are that claim made by a screen that
 * read nothing. The `fixture` badge in the panel header does not withdraw the
 * sentence "from every append-only store on the book" printed beside it.
 *
 * THREE SEPARATE FAULTS ARE FIXED HERE AND EACH HAS ITS OWN TEST BELOW:
 *
 *   1. The guard could not run, so the operator got the framework error page.
 *   2. What it would have done was draw a named business from nothing.
 *   3. The screen made TWO claims about its data source that could disagree —
 *      the state bar's `default` note reads "read live from the book" while
 *      the board beneath it badged `fixture`. Both are now one value, resolved
 *      once in `page.tsx`.
 *   4. `AuditErrorPanel` offered "Retry the read" for every failure including
 *      this one. A refresh does not configure a database.
 *
 * `?state=empty` gets its own case because it is the sharpest: that state is
 * LIVE by design — a real business filtered to agent actions, which genuinely
 * returns nothing — and the no-database fallback answered it with a fixture
 * holding TWO actions, under a state label reading "Empty".
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { AUDIT_NO_DATABASE } from "./unreadable";

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/**
 * Every word this screen can use to claim it read something.
 *
 * The board's two badges are lowercase and the state-bar link labels are
 * capitalised, so `>live<` matches the claim and `>Live<` — which is only ever
 * the name of a link to a demo state — does not.
 */
const BADGES = ["live", "fixture", "NO DATABASE"] as const;

describe("/audit with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/audit/page");
    html = await renderPage(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of throwing on the import that asks whether there is a database", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says it could not read the trail, with the code", () => {
    expect(html).toContain(AUDIT_NO_DATABASE.code);
    expect(html).toContain("This screen cannot see the trail");
  });

  it("names no business and lists no action", () => {
    // Every one of these is drawn by the fixture this used to return.
    expect(html).not.toContain("Example Trading Co.");
    expect(html).not.toContain("ACH payment requested");
    expect(html).not.toContain("Director kyc");
  });

  it("claims no completeness, because a projection that read nothing reconciled nothing", () => {
    // The AFFIRMATIVE forms only. The refusal's own message uses the word
    // "reconciled" to say that nothing was, which is the opposite claim and
    // the one this screen should be making.
    expect(html).not.toContain("0 reconciled");
    expect(html).not.toContain("business total");
    expect(html).not.toContain("from every append-only store on the book");
  });

  it("makes exactly one claim about its data source", () => {
    expect(claimsIn(html, BADGES)).toEqual(["NO DATABASE"]);
  });

  it("does not leave the word live standing in the state note over a screen that read nothing", () => {
    expect(html).not.toContain("read live from the book");
  });

  it("offers no retry for a failure a retry cannot clear", () => {
    expect(html).toContain("Retryable");
    expect(hasRetryControl(html)).toBe(false);
    expect(html).not.toContain("Retry the read");
  });
});

/**
 * `?state=empty` is LIVE on this screen, so with no database it refuses too.
 *
 * It is the sharpest case on `/audit`: the fallback answered a state whose
 * whole point is "this really did return nothing" with a fixture holding two
 * actions, under a state label reading "Empty" and a note reading "A business
 * that exists and has had nothing done to it". Two actions is not nothing, and
 * an unread book is not an empty one.
 */
describe("/audit ?state=empty with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    const page = await import("@/app/(app)/audit/page");
    html = await renderPage(page, { state: "empty" });
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("refuses rather than drawing two actions under the word Empty", () => {
    expect(html).toContain(AUDIT_NO_DATABASE.code);
    expect(html).not.toContain("Example Trading Co.");
    expect(claimsIn(html, BADGES)).toEqual(["NO DATABASE"]);
  });
});

/**
 * The one genuinely drawn state still says `fixture`, once, with no database.
 *
 * Here so that the fix above cannot be "make every state refuse": a drawn board
 * is legitimate and says so, and "no database" does not make a drawing any more
 * or less drawn. `?state=loading` is the only state on this screen that is a
 * fixture by design — `default`, `empty` and `edge` are all live reads and all
 * three now refuse — and `?state=error` is left out because its panel's retry
 * control is a client component calling `useRouter()`, with no app router
 * mounted in a unit test. The refusal panel IS rendered for real above: that
 * failure is not retryable, so it draws no button.
 */
describe("/audit ?state=loading with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("claims FIXTURE and claims it once", async () => {
    const page = await import("@/app/(app)/audit/page");
    const html = await renderPage(page, { state: "loading" });
    expect(claimsIn(html, BADGES)).toEqual(["fixture"]);
  }, 30_000);
});
