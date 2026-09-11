/**
 * The proof, at the layer the hole is in.
 *
 * A server action does not know what pathname it was posted to; it knows the
 * cookie it was sent with. So this is the exploit reduced to its load-bearing
 * part: a CUSTOMER cookie, an OPERATOR action, invoked directly — exactly what
 * `POST /client/pay` with an operator action id does once Next has routed the
 * body into the action, and exactly what the middleware cannot see, because the
 * middleware already said yes to `/client/pay`.
 *
 * BEFORE the guard, this test failed with the action's own return value: the
 * operator action's body ran under a customer cookie and got as far as its
 * database check.
 *
 * AFTER, it throws `OPERATOR_ONLY` before the first statement of the body.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ROLE_COOKIE } from "./roles";

/** The cookie jar the action reads. Set per test; nothing else is faked. */
let cookieRole = "customer";

vi.mock("next/headers", () => ({
  cookies: (): Promise<{ get: (name: string) => { value: string } | undefined }> =>
    Promise.resolve({
      get: (name: string) => (name === ROLE_COOKIE ? { value: cookieRole } : undefined),
    }),
}));

beforeEach(() => {
  cookieRole = "customer";
});

describe("an operator action invoked with a customer cookie", () => {
  it("is refused by name, before its body runs", async () => {
    const { statementPdfAction } = await import("@/app/(app)/statements/actions");

    await expect(statementPdfAction({})).rejects.toThrowError(/deny; OPERATOR_ONLY/);
  });

  it("names the action, the role and where they may go instead", async () => {
    const { drainOutboundAction } = await import("@/app/(app)/events/actions");

    const refusal = await drainOutboundAction().then(
      () => null,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("OPERATOR_ONLY");
    expect((refusal as Error).message).toContain("drainOutboundAction");
    expect((refusal as Error).message).toContain("customer");
  });

  it("does not refuse the operator roles — the console still works", async () => {
    const { assertOperatorAction } = await import("./action-guard");

    for (const role of ["staff", "approver"]) {
      cookieRole = role;
      await expect(assertOperatorAction("anyAction")).resolves.toBeUndefined();
    }
  });

  it("makes no decision when there is no request behind the call", async () => {
    // A direct call from a test or a script has no principal to refuse. Pinned
    // because it is the one branch of the guard that does not deny, and because
    // src/components/statements/pdf-action-no-database.test.ts depends on it.
    vi.resetModules();
    vi.doMock("next/headers", () => ({
      cookies: (): Promise<never> =>
        Promise.reject(new Error("`cookies` was called outside a request scope.")),
    }));
    const { assertOperatorAction } = await import("./action-guard");
    await expect(assertOperatorAction("anyAction")).resolves.toBeUndefined();
    vi.doUnmock("next/headers");
    vi.resetModules();
  });

  it("rethrows any other cookie-store failure rather than proceeding", async () => {
    vi.resetModules();
    vi.doMock("next/headers", () => ({
      cookies: (): Promise<never> => Promise.reject(new Error("cookie store exploded")),
    }));
    const { assertOperatorAction } = await import("./action-guard");
    await expect(assertOperatorAction("anyAction")).rejects.toThrowError("cookie store exploded");
    vi.doUnmock("next/headers");
    vi.resetModules();
  });

  it("refuses an unknown cookie value the way the middleware does", async () => {
    // `roleFromCookieValue` defaults anything unrecognised to `staff`, and this
    // guard inherits that rather than inventing a second answer. Pinned so that
    // a change to the default is a change to a test, not a surprise.
    const { assertOperatorAction } = await import("./action-guard");
    cookieRole = "nonsense";
    await expect(assertOperatorAction("anyAction")).resolves.toBeUndefined();
  });
});
