/**
 * The test that fails without the fix.
 *
 * It does not ask the policy module whether a customer may open `/accounts` —
 * the policy module is the thing being claimed, and a claim that checks itself
 * proves nothing. It builds a real request with the demo credential on it, runs
 * it through the REAL `middleware()` export that Next.js invokes in production,
 * and reads the response.
 *
 * Against the code this replaced, `middleware()` answered `NextResponse.next()`
 * for `GET /accounts` with `corgi_demo_role=customer` — the customer was SERVED
 * the operator console, with every business on the book in one table. That
 * output is quoted in the report. An invariant never seen to fail is not
 * trusted here.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { middleware } from "@/middleware";
import {
  CONSOLE_NOT_CONFIGURED,
  SESSION_COOKIE,
  SIGN_IN_REQUIRED,
  mintSession,
} from "@/lib/auth/session";

import { OPERATOR_ONLY } from "./policy";

const ORIGIN = "https://corgi-trial-psi.vercel.app";

/**
 * ============================================================================
 * WHY THIS FILE NOW SIGNS IN FIRST
 * ============================================================================
 *
 * Every check below used to run with no session, because there was nothing to
 * sign into. `src/middleware.ts` control 3 now requires a verified session on
 * every operator route, so an unauthenticated request to `/accounts` is
 * refused BEFORE the role is read — which is the correct order and which made
 * six assertions in this file fail for the right reason.
 *
 * The fix is not to weaken them. Each one is a claim about AUTHORISATION, and
 * authorisation is what happens after you are through the door: so the
 * requests carry a valid session cookie, and the gate itself is asserted
 * separately in its own block at the bottom, including the two states that
 * matter most — no session, and a forged one.
 *
 * The passphrase is generated per run. There is no credential literal in this
 * repository and there must not be one.
 */
const PASSPHRASE = `test-${randomUUID()}`;
let savedPassword: string | undefined;
let session = "";

beforeAll(async () => {
  savedPassword = process.env["CONSOLE_PASSWORD"];
  process.env["CONSOLE_PASSWORD"] = PASSPHRASE;
  session = (await mintSession()) ?? "";
  expect(session, "the test could not mint a session to sign in with").not.toBe("");
});

afterAll(() => {
  if (savedPassword === undefined) delete process.env["CONSOLE_PASSWORD"];
  else process.env["CONSOLE_PASSWORD"] = savedPassword;
});

function request(
  path: string,
  role?: string,
  method = "GET",
  options: { readonly signedIn?: boolean; readonly sessionValue?: string } = {},
): NextRequest {
  const headers = new Headers();
  const jar: string[] = [];
  if (role !== undefined) jar.push(`corgi_demo_role=${role}`);
  const token = options.sessionValue ?? (options.signedIn === false ? undefined : session);
  if (token !== undefined) jar.push(`${SESSION_COOKIE}=${token}`);
  if (jar.length > 0) headers.set("cookie", jar.join("; "));
  return new NextRequest(new URL(path, ORIGIN), { method, headers });
}

/** What the middleware did, in the two terms that matter. */
async function run(
  path: string,
  role?: string,
  method = "GET",
  options: { readonly signedIn?: boolean; readonly sessionValue?: string } = {},
) {
  const res = await middleware(request(path, role, method, options));
  return {
    status: res.status,
    authz: res.headers.get("x-corgi-authz"),
    body: await res.clone().text(),
  };
}

describe("a customer session against the operator console", () => {
  /**
   * `/accounts` is the one from the bug report: it lists every deposit account
   * on the platform, for every business, with balances.
   */
  it("is REFUSED on /accounts, by the server, with a named code", async () => {
    const res = await run("/accounts", "customer");
    expect(res.status, "the operator console answered a customer session").toBe(403);
    expect(res.authz).toBe(`deny; ${OPERATOR_ONLY}`);
    expect(res.body).toContain(OPERATOR_ONLY);
  });

  /**
   * A second operator route, and deliberately not one adjacent to the first:
   * `/approvals` moves money and `/audit` is the history of who moved it. If
   * the guard were a list of screens somebody typed, one of these would be off
   * it.
   */
  it("is REFUSED on /approvals and /audit too", async () => {
    for (const path of ["/approvals", "/audit"]) {
      const res = await run(path, "customer");
      expect(res.status, `${path} answered a customer session`).toBe(403);
      expect(res.authz, path).toBe(`deny; ${OPERATOR_ONLY}`);
    }
  });

  /**
   * A route that does not exist yet, standing in for the seventeenth operator
   * screen. Nobody will add it to a list; it is refused because it is not on
   * the customer's list, which is the whole design.
   */
  it("is REFUSED on an operator route that has not been written yet", async () => {
    const res = await run("/ledger-exports", "customer");
    expect(res.status).toBe(403);
  });

  /** A POST is refused too, so a server action cannot run behind a hidden nav. */
  it("is REFUSED on a POST to an operator route, so the action never runs", async () => {
    const res = await run("/payments", "customer", "POST");
    expect(res.status).toBe(403);
  });

  it("the refusal says what happened and where they may go", async () => {
    const { body } = await run("/accounts", "customer");
    expect(body).toContain("/client");
    expect(body).toContain("operator");
    expect(body.length, "the refusal is a page, not an empty 403").toBeGreaterThan(400);
  });
});

describe("a customer session against their own surface", () => {
  it("is SERVED /client", async () => {
    const res = await run("/client", "customer");
    expect(res.status).toBe(200);
    expect(res.authz).not.toBe(`deny; ${OPERATOR_ONLY}`);
  });

  it("is SERVED every screen under /client, including ones not built yet", async () => {
    for (const path of ["/client/activity", "/client/cards", "/client/open"]) {
      const res = await run(path, "customer");
      expect(res.status, path).toBe(200);
    }
  });

  /**
   * `/` carries the role switch. Refusing it would strand a person in the
   * customer role with no way back, and `docs/DEMO.md` promises the credential
   * IS the switch. See the argument in `policy.ts`.
   */
  it("is SERVED /, because that is where the role switch lives", async () => {
    const res = await run("/", "customer");
    expect(res.status).toBe(200);
  });
});

describe("an operator session", () => {
  it("is unchanged: staff and approver are served the console", async () => {
    for (const role of ["staff", "approver", undefined]) {
      for (const path of ["/accounts", "/approvals", "/audit", "/client", "/"]) {
        const res = await run(path, role);
        expect(res.status, `${role ?? "no cookie"} on ${path}`).toBe(200);
      }
    }
  });

  it("is what an unparseable credential falls back to, at the LEAST privilege", async () => {
    // A cookie nobody recognises must not widen anything and must not lock a
    // reader out of the demo. `staff` is the floor this build has always used.
    const res = await run("/accounts", "not-a-role");
    expect(res.status).toBe(200);
  });
});

describe("the platform-header strip", () => {
  /**
   * The control that was already here. It is asserted in this file because the
   * matcher had to widen to cover every page, and a widened matcher is exactly
   * where an existing control quietly stops running.
   */
  it("still deletes x-vercel-cron, and still says so on the response", async () => {
    const req = new NextRequest(new URL("/api/drain", ORIGIN), {
      headers: new Headers({ "x-vercel-cron": "1" }),
    });
    const res = await middleware(req);
    expect(res.headers.get("x-stripped-request-headers")).toBe("x-vercel-cron");
  });
});

describe("the sign-in gate", () => {
  /**
   * THE HOLE THIS CLOSES. Until control 3 shipped, every assertion above rested
   * on a claim nobody verified: `corgi_demo_role` is a cookie a visitor sets on
   * themselves, so anyone who knew its name was staff. These checks are the
   * other half — that the claim is now only ever read from a request that
   * proved it holds a credential.
   */
  it("REFUSES an operator route with no session at all, before the role is read", async () => {
    const res = await run("/accounts", undefined, "GET", { signedIn: false });
    expect(res.status, "/accounts answered an unauthenticated request").toBe(401);
    expect(res.authz).toBe(`deny; ${SIGN_IN_REQUIRED}`);
    expect(res.body).toContain("/signin");
  });

  it("REFUSES it however the role cookie is set — a claim is not a credential", async () => {
    // The whole point: typing `corgi_demo_role=staff` used to BE the grant.
    for (const role of ["staff", "approver", "customer", "not-a-role"]) {
      const res = await run("/accounts", role, "GET", { signedIn: false });
      expect(res.status, `corgi_demo_role=${role} got in without signing in`).toBe(401);
      expect(res.authz, role).toBe(`deny; ${SIGN_IN_REQUIRED}`);
    }
  });

  it("REFUSES a POST, so a server action cannot run unauthenticated either", async () => {
    const res = await run("/payments", "staff", "POST", { signedIn: false });
    expect(res.status).toBe(401);
  });

  it("REFUSES a FORGED session cookie", async () => {
    const forged = `v1.${Date.now() + 3_600_000}.${randomUUID()}.${Buffer.from(
      randomUUID(),
    ).toString("base64url")}`;
    const res = await run("/accounts", "staff", "GET", { sessionValue: forged });
    expect(res.status, "a forged session was accepted").toBe(401);
    expect(res.authz).toBe(`deny; ${SIGN_IN_REQUIRED}`);
  });

  it("REFUSES an EDITED session cookie — expiry moved, signature kept", async () => {
    const [, , nonce, signature] = session.split(".");
    const edited = `v1.${Date.now() + 999_999_999}.${nonce}.${signature}`;
    const res = await run("/accounts", "staff", "GET", { sessionValue: edited });
    expect(res.status).toBe(401);
  });

  it("gates an operator route that does not exist yet — default deny, unchanged", async () => {
    const res = await run("/ledger-exports", "staff", "GET", { signedIn: false });
    expect(res.status).toBe(401);
  });

  it("does NOT gate /, /signin or the customer surface", async () => {
    // The hard constraint from docs/DEMO.md: `/` is where the role switch
    // lives, `/signin` is where a signed-out visitor must be able to go, and a
    // customer is not staff. All three answer with no session.
    for (const path of ["/", "/signin", "/client", "/client/activity", "/client/open"]) {
      const res = await run(path, "customer", "GET", { signedIn: false });
      expect(res.status, `${path} was gated and must not be`).toBe(200);
    }
  });

  it("still applies AUTHORISATION behind the gate: a signed-in customer is 403, not 401", async () => {
    // Authentication and authorisation are two decisions and this proves the
    // second did not get swallowed by the first.
    const res = await run("/accounts", "customer");
    expect(res.status).toBe(403);
    expect(res.authz).toBe(`deny; ${OPERATOR_ONLY}`);
  });

  it("FAILS CLOSED when CONSOLE_PASSWORD is unset — 503, named, never open", async () => {
    const saved = process.env["CONSOLE_PASSWORD"];
    delete process.env["CONSOLE_PASSWORD"];
    try {
      const res = await run("/accounts", "staff");
      expect(res.status, "an unconfigured deployment served the console").toBe(503);
      expect(res.authz).toBe(`deny; ${CONSOLE_NOT_CONFIGURED}`);
      expect(res.body).toContain("CONSOLE_PASSWORD");

      // …and the customer surface is unaffected, which is the other half of
      // "fail closed": closing the console must not take the product down.
      const client = await run("/client", "customer");
      expect(client.status, "an unconfigured deployment also closed /client").toBe(200);
      expect((await run("/", "customer")).status).toBe(200);
      expect((await run("/signin", undefined)).status).toBe(200);
    } finally {
      if (saved === undefined) delete process.env["CONSOLE_PASSWORD"];
      else process.env["CONSOLE_PASSWORD"] = saved;
    }
  });
});
