/**
 * WITH NO DATABASE, `/transactions` REFUSES — and says so ONCE.
 *
 * ============================================================================
 * This screen already refused before this pass, and that part was right. Three
 * things about it were not, and this file is what makes each of them stay
 * fixed.
 * ============================================================================
 *
 * 1. THE GUARD WAS THE UNREACHABLE SHAPE. `page.tsx` asked `hasDatabase()` by
 *    destructuring it off `await import("./live-source")`. On five sibling
 *    screens that exact line throws without `APP_DATABASE_URL`, because
 *    importing a live source evaluates `@/lib/ledger/db` -> `@/lib/env`. Here
 *    it happened not to. It survived on luck, not on design, and one new
 *    import in `live-source.ts` would have turned the screen into the framework
 *    error page. The question is now asked of `@/lib/has-database`, which
 *    imports nothing.
 *
 * 2. TWO BADGES, BOTH SAYING `live`. The demo-state bar badged the screen
 *    `live` for every state but `error`, and the refusal panel badged it `live`
 *    because the failure was not a fixture — on a deployment that had listed no
 *    account and folded no posting. Both now come from one value resolved once
 *    in the page.
 *
 * 3. A RETRY BUTTON BESIDE `retryable: false`. A refresh does not configure a
 *    database.
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { TRANSACTIONS_NO_DATABASE } from "./unreadable";

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/**
 * Every word this screen can use to claim it read something.
 *
 * Lower case for two of them because that is what this screen's bar prints;
 * the assertion is on what a reader sees, not on a normalised form of it.
 */
const BADGES = ["live", "fixture", "NO DATABASE"] as const;

describe("/transactions with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/transactions/page");
    html = await renderPage(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of throwing on the import that asks whether there is a database", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says it could not read the book, with the code", () => {
    expect(html).toContain(TRANSACTIONS_NO_DATABASE.code);
    expect(html).toContain("This screen cannot see the book");
  });

  it("resolves no point and folds no day", () => {
    expect(html).not.toContain("Closing balance, read twice");
    expect(html).not.toContain("The postings, as they stood at that point");
  });

  it("makes exactly one claim about its data source", () => {
    // This is the assertion the old code failed: the bar said `live` and the
    // panel said `live`, twelve lines apart, on a screen that had read nothing.
    expect(claimsIn(html, BADGES)).toEqual(["NO DATABASE"]);
  });

  it("offers no retry for a failure a retry cannot clear", () => {
    expect(html).toContain("Retryable");
    expect(hasRetryControl(html)).toBe(false);
  });
});

/**
 * `?state=error` still says `fixture`, once, on a machine with no database.
 *
 * Here so that the fix above cannot be "make every state refuse". This is the
 * one drawn state on this screen — there is no honest way to make a live read
 * fail on demand — and a drawing is no more and no less drawn for the absence
 * of a database. It renders through the refusal panel with a retryable failure,
 * so it DOES carry a retry button, which is a client component calling
 * `useRouter()`; no app router is mounted in a unit test, so this case asserts
 * the claim on the state bar alone, rendered outside the Suspense boundary.
 */
describe("/transactions ?state=error with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("claims fixture and claims it once", async () => {
    const page = await import("@/app/(app)/transactions/page");
    const node = await page.default({
      searchParams: Promise.resolve({ state: "error" }),
    });
    // Rendered without waiting on the boundary: the fallback is the skeleton
    // and the state bar is above it, which is the surface under test.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(node);
    expect(claimsIn(html, BADGES)).toEqual(["fixture"]);
  }, 30_000);
});
