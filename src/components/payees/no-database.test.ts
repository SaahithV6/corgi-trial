/**
 * WITH NO DATABASE, `/payees` REFUSES. It does not draw a payee book.
 *
 * ============================================================================
 * There was no guard here at all — not even an unreachable one. `page.tsx`
 * imported `@/lib/payees/store` and `@/lib/payees/screen` at the TOP of the
 * file, and both reach `@/lib/ledger/db` -> `@/lib/env`, which parses
 * `process.env` at module scope and throws `EnvironmentError` when
 * `APP_DATABASE_URL` is absent. The PAGE MODULE could not be loaded, so there
 * was nowhere for a guard to run: the operator got the framework's error page
 * before a line of this screen was rendered.
 * ============================================================================
 *
 * AND THIS SCREEN IS ONE WHERE DRAWING FROM NOTHING WOULD BE WORSE THAN THE
 * CRASH. Its subject is the confirmation step in front of an outbound payment.
 * The `default` fixture draws:
 *
 *     Ridgeline Coffee Roasters LLC · 101050001 · First Bank of the United States
 *     unsigned warnings 0   stale or unchecked 0   typos caught 2
 *
 * `unsigned warnings 0` is a statement that nobody on this book is waiting for
 * a human to put their name to a name mismatch. From an unread book it is the
 * same character saying something nobody checked, above a table captioned
 * "Append-only. Every check ever run is a row."
 *
 * WHY THE ACTION MODULE IS STUBBED, and it is the only stub here.
 * `AddPayeeForm`, `RecheckForm` and `SignWarningForm` are `"use client"`
 * components that import `@/app/(app)/payees/actions`, and the Next build
 * replaces that import with a server-action reference rather than loading the
 * module into the page render — the same boundary `/pots` and `/disputes`
 * record against a production build served with `APP_DATABASE_URL` empty.
 * Vitest has no such loader, so it evaluates the real actions module, which
 * reaches `@/lib/payees/gate` -> `@/lib/ledger/db` -> `@/lib/env` and throws
 * for want of the variable this whole file is about. The stub stands in for
 * the boundary the framework draws. `page.tsx` itself, its guard and every
 * component below it are the real ones.
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { PAYEE_BOOK_UNREADABLE } from "./unreadable";

vi.mock("@/app/(app)/payees/actions", () => ({
  addPayeeAction: () => undefined,
  recheckPayeeAction: () => undefined,
  signWarningAction: () => undefined,
}));

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/** Every word this screen can use to claim it read something. */
const BADGES = ["LIVE DATABASE", "FIXTURE DATA", "NO DATABASE"] as const;

describe("/payees with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/payees/page");
    html = await renderPage(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of throwing while the page module is being loaded", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says it could not read the payee book, with the code", () => {
    expect(html).toContain(PAYEE_BOOK_UNREADABLE.code);
    expect(html).toContain("This screen cannot see the payee book");
  });

  it("names no payee, no routing number and no institution", () => {
    // Every one of these is drawn by the `default` fixture.
    expect(html).toContain("Payees");
    expect(html).not.toContain("Ridgeline Coffee Roasters LLC");
    expect(html).not.toContain("101050001");
    expect(html).not.toContain("FIRST BANK OF THE UNITED STATES");
  });

  it("counts no warning and no caught typo, because counting nothing is not a count of none", () => {
    // The four summary tiles, by their labels. `unsigned warnings 0` rendered
    // from no read at all is a clean bill from a screen that checked nothing.
    expect(html).not.toContain("unsigned warnings");
    expect(html).not.toContain("stale or unchecked");
    expect(html).not.toContain("typos caught");
    expect(html).not.toContain("Append-only. Every check ever run is a row");
  });

  it("makes exactly one claim about its data source", () => {
    expect(claimsIn(html, BADGES)).toEqual(["NO DATABASE"]);
  });

  it("offers no retry for a failure a retry cannot clear", () => {
    expect(html).toContain("Retryable");
    expect(hasRetryControl(html)).toBe(false);
  });

  /**
   * The claims a reader has to hover to find count too. The `default` link in
   * the state bar carries a `title=` hint promising "the live payee book and
   * every check recorded against it", which would otherwise have stayed
   * hoverable over a screen whose badge says NO DATABASE.
   */
  it("leaves no live promise standing in a tooltip", () => {
    expect(html).not.toContain("every check recorded against it");
  });
});

/**
 * The drawn demo states still say FIXTURE DATA, once, on a machine with no
 * database.
 *
 * Here so that the fix above cannot be "make every state refuse": a drawn book
 * is legitimate and says so, and "no database" does not make a drawing any more
 * or less drawn. `?state=error` is left out because its panel's retry control
 * is a client component calling `useRouter()`, and no app router is mounted in
 * a unit test — the same limit the sibling screens' files document. The refusal
 * panel IS rendered for real above: that failure is not retryable, so it draws
 * no button.
 */
describe("/payees demo states with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  for (const state of ["loading", "empty", "edge"]) {
    it(`?state=${state} claims FIXTURE DATA and claims it once`, async () => {
      const page = await import("@/app/(app)/payees/page");
      const html = await renderPage(page, { state });
      expect(claimsIn(html, BADGES)).toEqual(["FIXTURE DATA"]);
    }, 30_000);
  }
});

/**
 * A fixture state never says the book could not be read because of the
 * environment.
 *
 * The sentence under the FIXTURE DATA badge used to offer two explanations for
 * the same rows — "either a demo state other than default is selected, or no
 * database is configured" — and after this repair the second one cannot
 * happen: with no database the `default` state yields a refusal, not a
 * fixture. A sentence that names a cause the screen can no longer have teaches
 * the reader to discount the badge.
 */
describe("/payees fixture wording with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  /**
   * And the book IS drawn here, which is what makes the refusal's seven
   * `not.toContain`s above mean something: these are the exact strings a
   * rendered payee book produces, and they are absent there and present here.
   */
  it("draws the book, the tiles and the names a refusal does not", async () => {
    const page = await import("@/app/(app)/payees/page");
    const html = await renderPage(page, { state: "loading" });
    expect(html).toContain("Ridgeline Coffee Roasters LLC");
    expect(html).toContain("101050001");
    expect(html).toContain("FIRST BANK OF THE UNITED STATES");
    expect(html).toContain("unsigned warnings");
    expect(html).toContain("stale or unchecked");
    expect(html).toContain("typos caught");
    expect(html).toContain("Append-only. Every check ever run is a row");
  }, 30_000);

  it("explains a fixture by the demo state alone", async () => {
    const page = await import("@/app/(app)/payees/page");
    const html = await renderPage(page, { state: "empty" });
    expect(html).toContain("a demo state other than");
    expect(html).not.toContain("no database is configured");
  });

  /**
   * The unsigned-warnings note points at a signature form only where one is
   * rendered. Every fixture state hands `businesses = []` to the view, which
   * makes it read-only, so "Open one below" named a form that is not there.
   */
  it("does not send the reader to a signature form no fixture state renders", async () => {
    const page = await import("@/app/(app)/payees/page");
    const html = await renderPage(page, { state: "edge" });
    expect(html).toContain("nobody has signed for");
    expect(html).not.toContain("Open one below");
  });
});
