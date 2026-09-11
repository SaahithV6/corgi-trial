/**
 * WITH NO DATABASE, `/team` REFUSES. It does not print a green nought under a
 * guard nobody queried.
 *
 * ============================================================================
 * There was no guard here at all — not even an unreachable one. `page.tsx`
 * imported `@/lib/approvals/session`, `@/lib/team/screen` and
 * `@/lib/team/store` at the TOP of the file, and all three reach
 * `@/lib/ledger/db` -> `@/lib/env`, which parses `process.env` at module scope
 * and throws `EnvironmentError` when `APP_DATABASE_URL` is absent. The PAGE
 * MODULE could not be loaded, so there was nowhere for a guard to run: the
 * operator got the framework's error page before a line of this screen was
 * rendered.
 * ============================================================================
 *
 * THREE SEPARATE FAULTS ARE FIXED HERE AND EACH HAS ITS OWN CASE BELOW:
 *
 *   1. The page module could not be loaded, so no state rendered — including
 *      the two fixture states, which need no database and had no reason to
 *      fail.
 *   2. A failed read was a bare `<Note>` carrying the message and nothing
 *      else: no code, no `retryable`, no retry control. An operator could not
 *      tell a transient timeout from a book with no business on it, and had
 *      nothing to press either way.
 *   3. `?state=empty` printed TWO GREEN ZEROES under the caption "2
 *      invariants, counted on this request", from a fixture that queried
 *      nothing. `v_approved_auth_for_dead_member` reading 0 is the claim that
 *      no purchase was ever approved under suspended member terms. A fixture
 *      cannot make that claim, and a green badge is how this console says a
 *      guard held.
 *
 * `loading` is a LIVE state and refuses too. The page's own doc comment used to
 * call it a fixture; `TeamStateBar` had it right, and `page.tsx` was and is the
 * one that does the real read, three seconds slow.
 *
 * WHY THE ACTION MODULE IS STUBBED, and it is the only stub here. `TeamForms`
 * is a `"use client"` component that imports `@/app/(app)/team/actions`, and
 * the Next build replaces that import with a server-action reference rather
 * than loading the module into the page render — the same boundary `/pots` and
 * `/disputes` record against a production build served with `APP_DATABASE_URL`
 * empty. Vitest has no such loader, so it evaluates the real actions module,
 * which reaches `@/lib/team/store` -> `@/lib/ledger/db` and throws for want of
 * the variable this whole file is about. The stub stands in for the boundary
 * the framework draws. `page.tsx` itself, its guard and every component below
 * it are the real ones.
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { TEAM_BOOK_UNREADABLE } from "./unreadable";

// Only the four actions. `TEAM_IDLE` is NOT stubbed here any more: it lives in
// `./action-result`, a plain module that reaches no database, and the client
// imports it from there. It was exported from this `"use server"` module once,
// which made it a server reference on the client and blanked the whole screen.
vi.mock("@/app/(app)/team/actions", () => ({
  addMemberAction: () => undefined,
  endMembershipAction: () => undefined,
  issueMemberCardAction: () => undefined,
  setTermsAction: () => undefined,
}));

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/**
 * Every word this screen can use to claim it read something.
 *
 * The board's source line is lowercase — it is the value of a `source` term in
 * a meta list, not a title — so `>fixture<` matches the claim and the longer
 * banner title "FIXTURE — no database was read for this state" does not.
 */
const BADGES = ["live database", "fixture", "NO DATABASE"] as const;

describe("/team with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/team/page");
    html = await renderPage(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of throwing while the page module is being loaded", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says it could not read the team, with the code", () => {
    expect(html).toContain(TEAM_BOOK_UNREADABLE.code);
    expect(html).toContain("This screen cannot see the team");
  });

  it("names no business, no person and no balance", () => {
    // The AFFIRMATIVE rendered forms only. The refusal's own title is "This
    // screen cannot see the team", so a bare match on the words "the team"
    // would be this screen passing its own negation off as the thing it is
    // negating.
    expect(html).not.toContain("Northwind Fabrication LLC");
    expect(html).not.toContain("— the team");
    expect(html).not.toContain(">Members<");
    expect(html).not.toContain(">Available<");
  });

  it("counts no invariant, because a guard nobody queried did not hold", () => {
    // The two views the fixture used to badge green, and the caption that
    // said they had been counted on this request.
    expect(html).not.toContain("v_approved_auth_for_dead_member");
    expect(html).not.toContain("v_member_approval_without_right");
    expect(html).not.toContain("counted on this request");
    expect(html).not.toContain("What the database refuses");
  });

  it("makes exactly one claim about its data source", () => {
    expect(claimsIn(html, BADGES)).toEqual(["NO DATABASE"]);
  });

  it("offers no retry for a failure a retry cannot clear", () => {
    expect(html).toContain("Retryable");
    expect(hasRetryControl(html)).toBe(false);
  });

  /**
   * The claims a reader has to hover to find count too. The state-bar links
   * carry `title=` hints, and the three live ones promised real people, real
   * cards and "live rows, not a fixture" over a screen that read nothing.
   */
  it("leaves no live promise standing in a tooltip", () => {
    expect(html).not.toContain("real cards issued through Lithic");
    expect(html).not.toContain("Live rows, not a fixture");
  });
});

/**
 * The other two LIVE states refuse as well.
 *
 * `edge` is a filter over the same live rows the default state reads, and
 * `loading` is that same read held open for three seconds. Neither is a
 * fixture — the page's doc comment used to say `loading` was one — so with no
 * database there is nothing for either to slow down or filter.
 */
describe("/team live states with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  for (const state of ["edge", "loading"]) {
    it(`?state=${state} refuses and claims NO DATABASE, once`, async () => {
      const page = await import("@/app/(app)/team/page");
      const html = await renderPage(page, { state });
      expect(html).toContain(TEAM_BOOK_UNREADABLE.code);
      expect(html).not.toContain("v_approved_auth_for_dead_member");
      expect(html).not.toContain("Live rows, not a fixture");
      expect(claimsIn(html, BADGES)).toEqual(["NO DATABASE"]);
    }, 30_000);
  }
});

/**
 * `?state=empty` still says fixture, once — and no longer badges a guard.
 *
 * Here so that the fix above cannot be "make every state refuse": a drawn team
 * is legitimate and says so, and "no database" does not make a drawing any more
 * or less drawn. The second half is fault 3: the fixture carried two invariants
 * with `rows: 0`, drawn as two green badges under "2 invariants, counted on
 * this request". Counting nothing is not a count of nought.
 *
 * `?state=error` is left out of the render because its panel's retry control is
 * a client component calling `useRouter()`, and no app router is mounted in a
 * unit test — the same limit the sibling screens' files document. The refusal
 * panel IS rendered for real above: that failure is not retryable, so it draws
 * no button.
 */
describe("/team ?state=empty with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    const page = await import("@/app/(app)/team/page");
    html = await renderPage(page, { state: "empty" });
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("claims fixture and claims it once", () => {
    expect(html).toContain("FIXTURE");
    expect(claimsIn(html, BADGES)).toEqual(["fixture"]);
  });

  /**
   * And the board IS drawn here, which is what makes the refusal's four
   * `not.toContain`s above mean something: these are the exact strings a
   * rendered team panel produces, and they are absent there and present here.
   */
  it("draws the board a refusal does not", () => {
    expect(html).toContain("Northwind Fabrication LLC");
    expect(html).toContain("— the team");
    expect(html).toContain(">Members<");
    expect(html).toContain(">Available<");
  });

  it("badges no invariant and says plainly that this state counted none", () => {
    expect(html).not.toContain("v_approved_auth_for_dead_member");
    expect(html).not.toContain("v_member_approval_without_right");
    expect(html).not.toContain("counted on this request");
    expect(html).toContain("nothing was counted");
  });
});
