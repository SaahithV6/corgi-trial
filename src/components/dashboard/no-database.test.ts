/**
 * WITH NO DATABASE, `/dashboard` REFUSES. It does not reassure.
 *
 * ============================================================================
 * This is instance 26 of this repository's catalogued failure — a guard that
 * reports healthy because what it excluded was shaped exactly like the failure
 * it existed to catch — and this file is the thing that makes the invariant
 * believed rather than intended.
 * ============================================================================
 *
 * WHAT IT RENDERS. The real page component, with `APP_DATABASE_URL` removed
 * from the environment: `DashboardPage` itself, not a stand-in for it, because
 * the defect lived in the three lines of `page.tsx` that choose a source and
 * in nothing else. `renderToReadableStream` rather than `renderToStaticMarkup`
 * so `stream.allReady` waits for the Suspense boundary — a throw inside it
 * fails this test instead of quietly leaving the skeleton in the markup — and
 * `onError` re-throws, because React's default is to log a recoverable error
 * and emit the fallback, which would let a crashed screen render and pass.
 *
 * NO DATABASE IS NEEDED TO RUN IT, so it is not gated and it runs in CI, which
 * holds no credentials on purpose. That is the point: CI is a machine with no
 * `APP_DATABASE_URL`, which is exactly the deployment this test describes.
 *
 * WHAT IT ASSERTS, and each line is a thing the old code did:
 *
 *   1. The page renders at all. It did not: `page.tsx` reached `hasDatabase()`
 *      through `await import("./live-source")`, and importing that module
 *      evaluates `@/lib/ledger/db` -> `@/lib/env`, which throws
 *      `EnvironmentError` when `APP_DATABASE_URL` is absent. The guard was
 *      unreachable in the one case it was written for.
 *
 *   2. The refusal is on the page, with its code.
 *
 *   3. No all-clear is on the page. `headline()` opens "Nothing new." for a
 *      book with nothing red, and the empty fixture the old code fell back to
 *      produced exactly that sentence — a clean board on a deployment that had
 *      not read a row.
 *
 *   4. One screen, one claim about its data source. Two badges, LIVE on the
 *      state bar and FIXTURE on the board, is the second half of the defect.
 *
 * NOTHING HERE WRITES A ROW, and nothing here opens a connection — there is no
 * database to open one to, which is the premise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderToReadableStream } from "react-dom/server";
import type { ReactNode } from "react";

import { NO_DATABASE } from "./unreadable";

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/**
 * Every word the screen can use to claim it read something. The assertion is
 * on the SET of them appearing in the markup, not on one string, because "the
 * badge is right" and "the screen makes exactly one claim" are different
 * assertions and only the second one catches two badges disagreeing.
 */
const BADGES = ["LIVE", "FIXTURE", "NO DATABASE"] as const;

function claimsIn(html: string): string[] {
  // NO DATABASE contains no other badge as a substring; LIVE does not appear
  // inside FIXTURE. A badge is rendered as the whole text of its own element,
  // so the delimiters are the tags around it.
  return BADGES.filter((badge) => html.includes(`>${badge}<`));
}

async function markup(node: ReactNode): Promise<string> {
  const stream = await renderToReadableStream(node, {
    onError(thrown: unknown) {
      throw thrown;
    },
  });
  await stream.allReady;
  return await new Response(stream).text();
}

describe("/dashboard with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete: a static import would evaluate the page
    // module while the variable is still set, and the page's own dynamic
    // import of `./live-source` is what this test is about.
    const page = await import("@/app/(app)/dashboard/page");
    html = await markup(await page.default({ searchParams: Promise.resolve({}) }));
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of throwing on the import that asks whether there is a database", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says it could not read the book, with the code", () => {
    expect(html).toContain(NO_DATABASE.code);
    expect(html).toContain("This screen cannot see the book");
  });

  it("draws no board and reports no all-clear", () => {
    // The headline the empty fixture produces, and the three section titles
    // that only exist when a board was drawn.
    expect(html).not.toContain("Nothing new.");
    expect(html).not.toContain("Is anything wrong right now?");
    expect(html).not.toContain("What is waiting on a human?");
    expect(html).not.toContain("What did the machine do while I was away?");
  });

  it("makes exactly one claim about its data source", () => {
    expect(claimsIn(html)).toEqual(["NO DATABASE"]);
  });

  it("offers no retry for a failure a retry cannot clear", () => {
    expect(html).toContain("retryable");
    expect(html).not.toContain("Retry");
  });
});

/**
 * The four demo states still say FIXTURE, once, on a machine with no database.
 *
 * Here so that the fix above cannot be "make every state refuse": a drawn
 * board is legitimate and says so, and the claim it makes has to be the same
 * word on both surfaces.
 */
describe("/dashboard demo states with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  // `?state=error` and `?state=loading` are not in this loop, and the reason
  // is not that they pass. `error` renders the refusal panel, whose retry
  // control is a client component calling `useRouter()`, and no app router is
  // mounted in a unit test — the same limit `ClientScreens.render.test.ts`
  // documents for its own pages. `loading` holds the read open for 1.2s on
  // purpose. The refusal panel IS rendered for real by the block above: the
  // no-database failure is not retryable, so it draws no button.
  for (const state of ["empty", "edge"]) {
    it(`?state=${state} claims FIXTURE and claims it once`, async () => {
      const page = await import("@/app/(app)/dashboard/page");
      const html = await markup(
        await page.default({ searchParams: Promise.resolve({ state }) }),
      );
      expect(claimsIn(html)).toEqual(["FIXTURE"]);
    }, 30_000);
  }
});
