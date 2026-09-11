/**
 * WITH NO DATABASE, `/accounts/[accountId]` SAYS SO. It does not offer to try
 * again.
 *
 * ============================================================================
 * This page module loads fine without `APP_DATABASE_URL` — unlike `/accounts`
 * next door, every ledger import on its chain is a type or a lazily-connecting
 * function. That is what made its failure quiet rather than loud.
 *
 * `createLiveAccountDataSource()` calls `ledgerConnection()` inside `context()`,
 * which throws `EnvironmentError`; the `try/catch` in every method turns that
 * into `readFailure(...)`, which is `LEDGER_READ_FAILED` with
 * `{ retryable: true }` — right for a query that did not come back, wrong for a
 * query that was never issued. The panel then printed "Retrying is safe."
 * beside a live Retry button, and the button re-ran a render that could only
 * fail the same way. A screen that offers a control which cannot work is worse
 * than one that says what is wrong: the operator spends the outage pressing it.
 * ============================================================================
 *
 * NOTHING HERE OPENS A CONNECTION — there is no database to open one to, which
 * is the premise, and it is why this file is not gated on `RUN_DB_TESTS`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReactNode } from "react";

import { claimsIn, hasRetryControl, renderPage } from "@/test/no-database-render";

import { ACCOUNT_NO_DATABASE } from "./unreadable";

/** Restored afterwards: vitest shares one process across the files in a run. */
const SAVED = process.env["APP_DATABASE_URL"];

/** Every word this screen can use to claim it read something. */
const BADGES = ["live ledger", "fixture", "NO DATABASE"] as const;

/** A real 2100 account id would do; the point is that nothing looks it up. */
const ACCOUNT_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

type AccountPage = {
  default: (props: {
    params: Promise<{ accountId: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
};

async function render(
  page: AccountPage,
  searchParams: Record<string, string | string[] | undefined> = {},
): Promise<string> {
  return renderPage({
    default: () =>
      page.default({
        params: Promise.resolve({ accountId: ACCOUNT_ID }),
        searchParams: Promise.resolve(searchParams),
      }),
  });
}

describe("/accounts/[accountId] with no database configured", () => {
  let html = "";

  beforeAll(async () => {
    delete process.env["APP_DATABASE_URL"];
    // Dynamic, and after the delete. See the harness header.
    const page = await import("@/app/(app)/accounts/[accountId]/page");
    html = await render(page);
  }, 30_000);

  afterAll(() => {
    if (SAVED !== undefined) process.env["APP_DATABASE_URL"] = SAVED;
  });

  it("renders instead of throwing", () => {
    expect(html.length).toBeGreaterThan(0);
  });

  it("names the condition rather than reporting a generic read failure", () => {
    expect(html).toContain(ACCOUNT_NO_DATABASE.code);
    expect(html).not.toContain("LEDGER_READ_FAILED");
  });

  it("draws no balance, no hold and no posting", () => {
    expect(html).not.toContain("Booking watermark");
    expect(html).not.toContain("Available balance");
  });

  it("makes exactly one claim about its data source", () => {
    expect(claimsIn(html, BADGES)).toEqual(["NO DATABASE"]);
  });

  it("offers no retry, and does not say retrying is safe", () => {
    expect(html).toContain("Retryable");
    expect(hasRetryControl(html)).toBe(false);
    // The affirmative rendered form, not `not.toContain("retry")` — the
    // refusal's own copy is entitled to use the word to negate it.
    expect(html).not.toContain("Retrying is safe.");
  });
});

/**
 * WHAT IS NOT ASSERTED HERE, AND WHY.
 *
 * The four drawn states — `?state=empty`, `edge`, `loading`, `error` — are not
 * rendered by this file. They succeed, and a successful render reaches
 * `readRole()`, which calls `cookies()`, which throws `\`cookies\` was called
 * outside a request scope` with no request mounted. That is the same limit
 * `ClientScreens.render.test.ts` documents for the whole app surface, and it
 * is why `readRole()` now happens BELOW the failure branch in `AccountView`
 * rather than beside the three reads: the refusal path above renders in a unit
 * test because it no longer asks for a cookie it does not use.
 *
 * So the claim "a drawn state still draws with no database" is carried by the
 * `/accounts` suite next door, whose demo table is a fixture that renders no
 * role, and by `getAccountDataSource(view, noDatabase)` returning the fixture
 * source for every non-live view regardless of the flag.
 */
