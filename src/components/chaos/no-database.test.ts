/**
 * WITH NO DATABASE, `/chaos` REFUSES. It does not report that chaos is off.
 *
 * ============================================================================
 * The guard this replaces could not run. `page.tsx` destructured `hasDatabase`
 * off `await import("./live-source")`, and that module opens with
 * `import { sql } from "@/lib/ledger/db"`, which reaches `@/lib/env` and throws
 * `EnvironmentError` at module scope when `APP_DATABASE_URL` is absent. The
 * import on the line above only succeeds when a database IS configured; the
 * predicate on the line below returns false only when one is not. Measured with
 * the variable deleted, the render threw and the operator got the framework's
 * error page.
 * ============================================================================
 *
 * AND WHAT THE UNREACHABLE BRANCH WOULD HAVE DONE IS A ZERO THAT MEANS TWO
 * THINGS — with a comment above it calling that the honest answer. It returned
 * `createFixtureChaosSource("empty")`, which draws two things:
 *
 *     CHAOS OFF — four controls unarmed, four expiry clocks at nought
 *     Invariants, measured now — fifteen views at nought rows, badge: they hold
 *
 * Those are the two questions this screen is opened to settle, and neither was
 * asked. `InvariantPanel` is explicit in the other direction — it renders a view
 * it could not read as a FAILURE and never as a pass, "because a guard that
 * reports healthy when it cannot see is the exact pattern this repository keeps
 * finding in its own guards". Fifteen of them reporting healthy off a fixture is
 * that pattern one level up, and the FIXTURE badge does not withdraw it: a badge
 * tells a reader the rows are invented, not that the state of the switches is
 * unknown.
 *
 * WHY THE ACTION MODULE IS STUBBED, and it is the only stub of its kind here.
 * `ChaosControls` is a `"use client"` component that imports
 * `@/app/(app)/chaos/actions`, and the Next build replaces that import with a
 * server-action reference rather than loading the module into the page render.
 * Vitest has no such loader, so it evaluates the real actions module, which
 * reaches `@/lib/ledger/db` -> `@/lib/env` and throws for want of the variable
 * this whole file is about. The stub stands in for the boundary the framework
 * draws. `next/headers` is supplied for the same reason: `cookies()` throws
 * outside a request scope, and rendering the page is the point. `page.tsx`
 * itself, its guard and every component below it are the real ones.
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { CHAOS_STATE_UNREADABLE } from "./unreadable";

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined }),
}));

vi.mock("@/app/(app)/chaos/actions", () => ({
  armControlAction: () => undefined,
  disarmControlAction: () => undefined,
  allChaosOffAction: () => undefined,
  startEpisodeAction: () => undefined,
  releaseNowAction: () => undefined,
  registerCardAction: () => undefined,
}));

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/** Every word this screen can use to claim it read something. */
const BADGES = ["LIVE LEDGER", "FIXTURE DATA", "NO DATABASE"] as const;

describe("/chaos with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/chaos/page");
    html = await renderPage(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of throwing on the import that asks whether there is a database", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says the chaos state was not read, with the code", () => {
    expect(html).toContain(CHAOS_STATE_UNREADABLE.code);
  });

  it("does not report that chaos is off, because nothing asked the switches", () => {
    // The BADGE, matched by the tags around it — the words also occur inside
    // the refusal's own message, which is the sentence withdrawing the claim
    // rather than making it.
    expect(html).not.toContain(">CHAOS OFF<");
    expect(html).not.toContain(">CHAOS ARMED<");
  });

  it("passes no invariant, because a view nobody opened is not a view that held", () => {
    expect(html).not.toContain("Invariants, measured now");
  });

  it("arms nothing, because a control that writes needs a book it can see", () => {
    expect(html).not.toContain("The four controls");
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
 * or less drawn.
 */
describe("/chaos demo states with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  for (const state of ["empty"]) {
    it(`?state=${state} makes no live claim`, async () => {
      const page = await import("@/app/(app)/chaos/page");
      const html = await renderPage(page, { state });
      expect(claimsIn(html, BADGES)).not.toContain("LIVE LEDGER");
      expect(claimsIn(html, BADGES)).not.toContain("NO DATABASE");
    }, 30_000);
  }
});
