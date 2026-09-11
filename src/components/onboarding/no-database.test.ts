/**
 * WITH NO DATABASE, `/onboarding` REFUSES. It does not report a verdict.
 *
 * ============================================================================
 * There was no guard here at all — not even an unreachable one.
 * `OnboardingView.tsx` opened with a STATIC
 * `import { createLiveOnboardingSource } from "@/lib/kyb/wire"`, whose graph
 * reaches `@/lib/ledger/db` -> `@/lib/env`, which parses `process.env` at
 * module scope and throws `EnvironmentError` when `APP_DATABASE_URL` is absent.
 * The PAGE MODULE could not be loaded, so there was nowhere for a guard to run:
 * the operator got the framework's error page before a line of this screen was
 * rendered, and all five states went down together — including `loading`,
 * `empty`, `error` and `edge`, which are fixtures and need no database at all.
 * ============================================================================
 *
 * AND THIS SCREEN IS ONE WHERE DRAWING FROM NOTHING WOULD BE WORSE THAN THE
 * CRASH. Its rows are verdicts, and the whole module exists to make one
 * combination unrepresentable: approved on evidence that is not live. A screen
 * that printed a KYB state no evidence row supports would be committing that
 * error one level up. Its `empty` state is a finding as well — "no businesses on
 * the book at all" — and on a compliance queue, nobody waiting is the reason
 * somebody closes the tab.
 *
 * WHY THE ACTION MODULE IS STUBBED. `VerificationForm`, `ReviewForm` and
 * `RegistryProbe` are `"use client"` components that import
 * `@/app/(app)/onboarding/actions`, and the Next build replaces that import with
 * a server-action reference rather than loading the module into the page
 * render. Vitest has no such loader, so it evaluates the real actions module,
 * which reaches `@/lib/ledger/db` -> `@/lib/env` and throws for want of the
 * variable this whole file is about. The stub stands in for the boundary the
 * framework draws. `next/headers` is supplied for the same reason: this screen
 * reads the demo role cookie and `cookies()` throws outside a request scope.
 * `page.tsx`, `OnboardingView` and every component below them are the real ones.
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { ONBOARDING_STATE_UNREADABLE } from "./unreadable";

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined }),
}));

vi.mock("@/app/(app)/onboarding/actions", () => ({
  onboardingAction: () => undefined,
  registryProbeAction: () => undefined,
  reviewAction: () => undefined,
}));

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/** Every word this screen can use to claim it read something. */
const BADGES = ["LIVE", "FIXTURE", "NO DATABASE"] as const;

describe("/onboarding with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/onboarding/page");
    html = await renderPage(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of dying while the page module loads", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("says the verification state was not read, with the code", () => {
    expect(html).toContain(ONBOARDING_STATE_UNREADABLE.code);
  });

  it("prints no verdict, because a state nobody read is not a state", () => {
    expect(html).not.toContain("APPROVED");
    expect(html).not.toContain("PENDING");
    expect(html).not.toContain("REJECTED");
  });

  it("reports no empty book, because an unread list is not a book with nobody on it", () => {
    // The BODY sentence, not the substring — the state bar carries every demo
    // state's hint as a link title, and the `empty` hint says the same words
    // about a state nobody is in.
    expect(html).not.toContain("Nothing to verify, and nothing that could transact");
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
 * or less drawn. `edge` is the one that matters most — it is the state where a
 * real Stripe Identity verification sits beside a simulated registry leg, and it
 * is the demonstration this module was built to be able to give on demand.
 */
describe("/onboarding demo states with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  for (const state of ["empty", "edge"]) {
    it(`?state=${state} claims FIXTURE and claims it once`, async () => {
      const page = await import("@/app/(app)/onboarding/page");
      const html = await renderPage(page, { state });
      expect(claimsIn(html, BADGES)).toEqual(["FIXTURE"]);
    }, 30_000);
  }
});
