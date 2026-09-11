/**
 * `retryable: false` IS SET AND IT WAS THROWN AWAY.
 *
 * ============================================================================
 * This one needs no missing database and no outage. It is reachable in two
 * clicks on a fully configured deployment: `/accounts` -> click a row in the
 * Demo accounts table -> click "Default" in the state bar. That asks the live
 * source for `acct_operating_4417`, which is a fixture id and not a uuid, so
 * `createLiveAccountDataSource()` answers with `accountNotFound()`:
 *
 *     fail("ACCOUNT_NOT_FOUND", "...", { retryable: false, ... })
 *
 * `ErrorPanel` rendered that with no Retryable row, an unconditional
 * `<RetryButton />`, and the hardcoded sentence "Retrying is safe." A Retry
 * button under the words "retrying is safe", for a failure whose own details
 * say it is not — and the reader has no way to tell which of the two the
 * screen means. Pressing it re-runs a lookup that will miss again.
 * ============================================================================
 *
 * WHY THE RETRYABLE CASE IS NOT RENDERED HERE. `RetryButton` calls
 * `useRouter()`, which throws `invariant expected app router to be mounted`
 * with no app router — the same limit `ClientScreens.render.test.ts`
 * documents, and the reason a panel that renders one unconditionally cannot be
 * unit-rendered at all. That was this test's first red. The retryable branch
 * is asserted through `isRetryable`, which is the predicate the panel branches
 * on, and the rendered half is asserted on the branch that must draw no
 * button.
 *
 * No connection is opened here. The panel is a pure function of an
 * `ErrorShape`, which is the whole reason a failure is a value in this
 * codebase and not a throw.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import type { ReactNode } from "react";

import type { ErrorShape } from "@/lib/result";
import { isRetryable } from "@/components/ui/error-detail";
import { hasRetryControl } from "@/test/no-database-render";

import { ErrorPanel } from "./ErrorPanel";

async function render(node: ReactNode): Promise<string> {
  const stream = await renderToReadableStream(node, {
    onError(thrown: unknown) {
      throw thrown;
    },
  });
  await stream.allReady;
  return await new Response(stream).text();
}

/** Exactly what `createLiveAccountDataSource()` returns for a fixture id. */
const NOT_FOUND: ErrorShape = {
  code: "ACCOUNT_NOT_FOUND",
  message:
    "No customer deposit account acct_operating_4417 exists on this book. Only 2100 accounts with a business are addressable here.",
  details: { retryable: false, source: "ledger.queries", accountId: "acct_operating_4417" },
};

/** A query that genuinely did not come back. Retrying this one IS safe. */
const READ_FAILED: ErrorShape = {
  code: "LEDGER_ECONNREFUSED",
  message: "getAccountSummary failed: connect ECONNREFUSED",
  details: { retryable: true, source: "ledger.queries", operation: "getAccountSummary" },
};

const panel = (error: ErrorShape): ReactNode =>
  createElement(ErrorPanel, { error, accountId: "acct_operating_4417" });

describe("ErrorPanel honours the failure's own retryable flag", () => {
  it("prints the flag, so the reader can see which kind of failure this is", async () => {
    const html = await render(panel(NOT_FOUND));
    expect(html).toContain("Retryable");
    expect(html).toContain(">no<");
  }, 15_000);

  it("offers no retry for a failure that says it is not retryable", async () => {
    const html = await render(panel(NOT_FOUND));
    expect(hasRetryControl(html)).toBe(false);
  }, 15_000);

  it("does not tell the operator that retrying is safe when it is not", async () => {
    const html = await render(panel(NOT_FOUND));
    expect(html).not.toContain("Retrying is safe.");
    expect(html).toContain("Trying again cannot change this answer");
  }, 15_000);

  it("keeps the retry for an ordinary failed read", () => {
    // The rendered half of this branch is the RetryButton, which needs an app
    // router. This is the predicate the panel branches on.
    expect(isRetryable(READ_FAILED)).toBe(true);
    expect(isRetryable(NOT_FOUND)).toBe(false);
  });
});
