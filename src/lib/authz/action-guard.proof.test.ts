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
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE, mintSession } from "@/lib/auth/session";

import { ROLE_COOKIE } from "./roles";

/**
 * The cookie jar the action reads. Set per test; nothing else is faked.
 *
 * THERE ARE TWO COOKIES NOW, and they answer two different questions. The
 * console is readable with no session and writable only with one, so a server
 * action — which is only ever a write — asks BOTH: is there a verified session
 * (`corgi_console`), and may this principal execute an operator capability
 * (`corgi_demo_role`). Authentication, then authorisation, in that order and
 * for the same reason the middleware does it in that order.
 *
 * The role checks below therefore carry a real session, so that what they are
 * proving is still the ROLE decision and not the new one standing in front of
 * it. The session decision has its own block at the bottom.
 *
 * The passphrase is generated per run. There is no credential literal in this
 * repository and there must not be one.
 */
let cookieRole = "customer";
let cookieSession: string | undefined;

const PASSPHRASE = `test-${randomUUID()}`;
let savedPassword: string | undefined;
let validSession = "";

vi.mock("next/headers", () => ({
  cookies: (): Promise<{ get: (name: string) => { value: string } | undefined }> =>
    Promise.resolve({
      get: (name: string) => {
        if (name === ROLE_COOKIE) return { value: cookieRole };
        if (name === SESSION_COOKIE && cookieSession !== undefined) {
          return { value: cookieSession };
        }
        return undefined;
      },
    }),
}));

beforeAll(async () => {
  savedPassword = process.env["CONSOLE_PASSWORD"];
  process.env["CONSOLE_PASSWORD"] = PASSPHRASE;
  validSession = (await mintSession()) ?? "";
  expect(validSession, "the test could not mint a session to sign in with").not.toBe("");
});

afterAll(() => {
  if (savedPassword === undefined) delete process.env["CONSOLE_PASSWORD"];
  else process.env["CONSOLE_PASSWORD"] = savedPassword;
});

beforeEach(() => {
  cookieRole = "customer";
  cookieSession = validSession;
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

  /* ---------------------------------------------------------------------- */
  /* The session, which the middleware cannot be trusted to have checked     */
  /* ---------------------------------------------------------------------- */

  it("refuses an operator role with NO session — a read is open, a write is not", async () => {
    // THE HOLE THIS CLOSES. `src/middleware.ts` gates writes on PATHNAME, and a
    // server action carries the pathname of the page the browser is on: an
    // operator action invoked from `/client/pay` arrives on the customer
    // surface, where the middleware's control 3 does not run at all. Without
    // this check that was a way to write to the console with no credential.
    const { assertOperatorAction } = await import("./action-guard");
    cookieRole = "staff";
    cookieSession = undefined;
    await expect(assertOperatorAction("drainOutboundAction")).rejects.toThrowError(
      /deny; SIGN_IN_REQUIRED/,
    );
  });

  it("refuses a FORGED session, whatever the role claims", async () => {
    const { assertOperatorAction } = await import("./action-guard");
    for (const role of ["staff", "approver"]) {
      cookieRole = role;
      cookieSession = `v1.${Date.now() + 3_600_000}.${randomUUID()}.${Buffer.from(
        randomUUID(),
      ).toString("base64url")}`;
      await expect(assertOperatorAction("anyAction"), role).rejects.toThrowError(
        /deny; SIGN_IN_REQUIRED/,
      );
    }
  });

  it("names the action and the cause, and points at the way in", async () => {
    const { assertOperatorAction } = await import("./action-guard");
    cookieRole = "staff";
    cookieSession = undefined;
    const refusal = await assertOperatorAction("drainOutboundAction").then(
      () => null,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("drainOutboundAction");
    expect((refusal as Error).message).toContain("NO_SESSION");
    expect((refusal as Error).message).toContain("/signin");
  });

  it("answers AUTHENTICATION before AUTHORISATION — no session beats a bad role", async () => {
    // A customer cookie AND no session. The refusal must be the one about who
    // you are, not the one about what you may do, because that is the order the
    // two questions are asked in everywhere else in this build.
    const { assertOperatorAction } = await import("./action-guard");
    cookieRole = "customer";
    cookieSession = undefined;
    await expect(assertOperatorAction("anyAction")).rejects.toThrowError(
      /deny; SIGN_IN_REQUIRED/,
    );
  });

  it("FAILS CLOSED with CONSOLE_PASSWORD unset — an unset secret never means 'no auth'", async () => {
    const { assertOperatorAction } = await import("./action-guard");
    const saved = process.env["CONSOLE_PASSWORD"];
    delete process.env["CONSOLE_PASSWORD"];
    try {
      cookieRole = "staff";
      await expect(assertOperatorAction("anyAction")).rejects.toThrowError(
        /deny; SIGN_IN_REQUIRED/,
      );
    } finally {
      if (saved === undefined) delete process.env["CONSOLE_PASSWORD"];
      else process.env["CONSOLE_PASSWORD"] = saved;
    }
  });

  /* ---------------------------------------------------------------------- */
  /* The two tests below REPLACE the next/headers mock and never restore it  */
  /* for this file's remaining cases — so they come last on purpose. Anything */
  /* added after them runs against the REAL next/headers, where `cookies()`  */
  /* throws outside a request and the guard correctly makes no decision at   */
  /* all. Add new cases ABOVE this line.                                     */
  /* ---------------------------------------------------------------------- */

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
