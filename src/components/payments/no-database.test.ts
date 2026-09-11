/**
 * WITH NO DATABASE, `/payments` REFUSES TO DRAW A PAYMENT FORM.
 *
 * ============================================================================
 * THIS SCREEN DID NOT FAIL AT RENDER TIME EITHER. IT FAILED AT IMPORT TIME.
 *
 * `page.tsx` imported `PaymentsView`, whose first line was
 * `import { createLivePaymentsSource } from "@/app/(app)/payments/live-source"`.
 * That module imports `@/lib/ledger/db` -> `@/lib/env`, which parses
 * `process.env` at module scope and throws `EnvironmentError` when
 * `APP_DATABASE_URL` is absent — deliberately, so a malformed database URL
 * kills the process at boot rather than at the first request that needs money.
 *
 * So the page MODULE never finished evaluating, and the operator got the
 * framework's error page. The three fixture states went with it:
 * `?state=loading`, `?state=empty` and `?state=error` read nothing, wanted no
 * database, and were unreachable because of one.
 * ============================================================================
 *
 * TWO STATES ARE LIVE HERE, WHICH IS ONE MORE THAN `/approvals`. `default` and
 * `edge` both read the account list, the KYB gate and the policy table
 * (`demo-state.ts` argues why the edge case in particular has to be live), so
 * both must refuse. A form drawn from an account list nobody read would offer
 * a "Pay from" choice nobody checked and quote a threshold nobody fetched, and
 * this screen's own error panel already says what is wrong with that: "the one
 * thing worse than refusing to draw a payment form is drawing one that quotes
 * a threshold it made up".
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { PAYMENTS_BOOK_UNREADABLE } from "./unreadable";

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

/** `default` and `edge`, the two states that read Neon. */
for (const state of [undefined, "edge"] as const) {
  const label = state === undefined ? "?state=default" : `?state=${state}`;

  describe(`/payments ${label} with no database configured`, () => {
    let html = "";

    beforeAll(async () => {
      delete process.env["APP_DATABASE_URL"];
      // Dynamic, and after the delete. See the harness header.
      const page = await import("@/app/(app)/payments/page");
      html = await renderPage(page, state === undefined ? {} : { state });
    }, 30_000);

    afterAll(() => {
      if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
    });

    it("renders instead of throwing while the page module is being loaded", () => {
      expect(html.length).toBeGreaterThan(0);
    });

    it("says the book was not read, with the code", () => {
      expect(html).toContain(PAYMENTS_BOOK_UNREADABLE.code);
      expect(html).toContain("This screen did not read the account list");
    });

    it("draws no form, no gate table and no policy table", () => {
      expect(html).not.toContain(">Raise a payment instruction<");
      expect(html).not.toContain(">Threshold policy, every version<");
      expect(html).not.toContain("The KYB gate, read for every account");
      // The gate verdict, which only a read produces — and the one word on
      // this screen that must never be printed about an account nobody looked
      // at.
      expect(html).not.toContain(">may transact<");
      expect(html).not.toContain("ach@2026-01-01");
      // The edge state's prefilled boundary amount, and the threshold it is
      // equal to. A figure, from a policy row, on a deployment with no rows.
      expect(html).not.toContain("$2,500.00");
    });

    it("draws no submit control for an instruction it cannot raise", () => {
      expect(html).not.toContain("Queue this payment for a checker");
    });

    it("does not print the empty book as if it had counted the accounts", () => {
      // Asserted on the RENDERED form of the panel rather than on the bare
      // words. The demo-state bar links to `?state=empty` with the tooltip "No
      // account on this book can originate a payment.", which is a true
      // sentence about a fixture state that exists; the thing under test is
      // whether the BOARD printed it about this deployment.
      //
      // `EmptyBook` says that, and then "Not an error", about a book that WAS
      // read and holds no payable account. Both must be unreachable when
      // nothing was read: a book nobody opened is not a book with no accounts
      // in it.
      expect(html).not.toContain(">No account on this book can originate a payment.<");
      expect(html).not.toContain("A deposit account exists only after a business has been onboarded");
    });

    it("makes exactly one claim about its data source", () => {
      expect(claimsIn(html, BADGES)).toEqual(["NO DATABASE"]);
    });

    it("offers no retry for a failure a retry cannot clear", () => {
      expect(html).toContain("Retryable");
      expect(hasRetryControl(html)).toBe(false);
    });

    it("does not promise that this state submits for real", () => {
      expect(html).not.toContain("This state submits for real");
    });
  });
}

/**
 * The fixture demo states still draw, and still say FIXTURE, once, on a machine
 * with no database.
 *
 * Here so the fix above cannot be "make every state refuse". `loading` and
 * `empty` read nothing and were never going to; the only reason they were
 * unreachable is that they were parked behind a module that could not load. A
 * drawn board is legitimate and says so.
 *
 * `?state=error` is left out because its panel's retry control is a client
 * component calling `useRouter()`, and no app router is mounted in a unit test
 * — the same limit `ClientScreens.render.test.ts` documents. The refusal panel
 * IS rendered for real above: that failure is not retryable, so it draws no
 * button.
 */
describe("/payments demo states with no database configured", () => {
  beforeAll(() => {
    delete process.env["APP_DATABASE_URL"];
  });

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  for (const state of ["loading", "empty"]) {
    it(`?state=${state} claims FIXTURE and claims it once`, async () => {
      const page = await import("@/app/(app)/payments/page");
      const html = await renderPage(page, { state });
      expect(claimsIn(html, BADGES)).toEqual(["FIXTURE"]);
    }, 30_000);
  }
});
