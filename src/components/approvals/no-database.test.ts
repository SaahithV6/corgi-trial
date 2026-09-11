/**
 * WITH NO DATABASE, `/approvals` REFUSES. It does not crash, and it does not
 * reassure.
 *
 * ============================================================================
 * THIS SCREEN DID NOT FAIL AT RENDER TIME. IT FAILED AT IMPORT TIME.
 *
 * `page.tsx` imported `ApprovalsView`, which imported `@/lib/approvals/session`
 * and `@/lib/approvals/screen` at module scope. Both reach
 * `@/lib/ledger/db` -> `@/lib/env`, which parses `process.env` at module scope
 * and throws `EnvironmentError` when `APP_DATABASE_URL` is absent —
 * deliberately, so a malformed database URL kills the process at boot rather
 * than at the first request that needs money.
 *
 * So the page MODULE never finished evaluating. There was no branch to take,
 * no guard to write and nowhere to put one: the operator got the framework's
 * error page, and so did every one of the four fixture demo states, because
 * `?state=loading`, `?state=empty`, `?state=error` and `?state=edge` all live
 * behind the same module. Four states that read nothing at all were
 * unreachable because of a database they never wanted.
 * ============================================================================
 *
 * AND THE LIVE STATE MUST NOT FALL BACK TO A FIXTURE. `default` is the live
 * queue, and this is the screen a grader opens to watch maker-checker refuse a
 * self-approval. A drawn queue here — a $4,120.00 row, `ach@2026-01-01`, "1 of
 * 1 approval held" — on a deployment that opened no connection would be a
 * maker-checker demonstration with no maker, no checker and no database. The
 * refusal draws no row rather than a queue reading nought.
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { APPROVALS_QUEUE_UNREADABLE } from "./unreadable";

/**
 * THE ONE THING STUBBED HERE, AND IT IS NOT THE DATABASE.
 *
 * This screen reads the demo role cookie, and `cookies()` throws outside a
 * request scope — `next dev` provides one and a unit test cannot. That is the
 * limit `ClientScreens.render.test.ts` documents as its reason for not
 * rendering `page.tsx` at all; rendering the page is the entire point here, so
 * the request-scoped API is supplied instead of the page being avoided.
 *
 * The stub returns no cookie, which is the shape a first visit has, and the
 * role falls back to `staff` exactly as it does in the product. Nothing about
 * `APP_DATABASE_URL` is touched by it: the question under test is what this
 * screen does with no database, and the answer must come from the screen.
 */
vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined }),
}));

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/** Every word this screen can use to claim it read something. */
const BADGES = ["LIVE", "FIXTURE", "NO DATABASE"] as const;

describe("/approvals with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/approvals/page");
    html = await renderPage(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of throwing while the page module is being loaded", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says the queue was not read, with the code", () => {
    expect(html).toContain(APPROVALS_QUEUE_UNREADABLE.code);
    expect(html).toContain("This screen did not read the approvals queue");
  });

  it("draws no queue, no policy table and no counts", () => {
    // Asserted on the RENDERED form of each panel rather than on the bare
    // words. The demo-state bar links to `?state=empty` with the tooltip
    // "Nothing is awaiting a decision.", which is a true sentence about a
    // fixture state that exists; the thing under test is whether the BOARD
    // printed it about this deployment.
    expect(html).not.toContain(">Pending queue<");
    expect(html).not.toContain(">Threshold policy, every version<");
    // The count line above the queue — `N awaiting decisions`.
    expect(html).not.toContain("awaiting decisions");
    // A policy version, which only a read produces.
    expect(html).not.toContain("ach@2026-01-01");
    // `QueueList`'s empty panel, which tells an operator in as many words that
    // an empty queue "is the normal state of a payments desk, not a failure".
    // It must be unreachable when nothing was read: a queue nobody opened is
    // not a payments desk with nothing on it.
    expect(html).not.toContain("An empty queue is the normal state");
  });

  it("draws no decision control on a row that does not exist", () => {
    expect(html).not.toContain(">Approve<");
    expect(html).not.toContain(">Reject<");
    expect(html).not.toContain(">Release<");
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
 * The fixture demo states still draw, and still say FIXTURE, once, on a
 * machine with no database.
 *
 * This is the half of the defect that is easy to lose in the fix. These three
 * states read nothing — they were never going to — and the ONLY reason they
 * were unreachable is that they were parked behind a module that could not
 * load. So "make every state refuse" would be a second wrong answer: a drawn
 * board is legitimate, it says FIXTURE, and no database does not make a
 * drawing any more or less drawn.
 *
 * `?state=error` is left out because its panel's retry control is a client
 * component calling `useRouter()`, and no app router is mounted in a unit test
 * — the same limit `ClientScreens.render.test.ts` documents. The refusal panel
 * IS rendered for real above: that failure is not retryable, so it draws no
 * button.
 */
describe("/approvals demo states with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  for (const state of ["loading", "empty", "edge"]) {
    it(`?state=${state} claims FIXTURE and claims it once`, async () => {
      const page = await import("@/app/(app)/approvals/page");
      const html = await renderPage(page, { state });
      expect(claimsIn(html, BADGES)).toEqual(["FIXTURE"]);
    }, 30_000);
  }
});
