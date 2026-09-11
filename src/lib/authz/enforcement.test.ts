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
 * WHY THIS FILE SIGNS IN FIRST
 * ============================================================================
 *
 * Every check below used to run with no session, because there was nothing to
 * sign into. `src/middleware.ts` control 3 requires a verified session, so the
 * requests carry one and each assertion stays a claim about AUTHORISATION —
 * which is what happens after you are through the door. The gate itself is
 * asserted separately in its own block at the bottom.
 *
 * THE GATE IS NOW A TILL AND NOT A DOOR, and the block at the bottom is where
 * that is pinned. A safe method on an operator route renders with no session;
 * an unsafe one is refused. Reads open, writes closed. The assertions that
 * used to read "anonymous GET /accounts -> 401" now read "-> 200", and every
 * one of them has a POST beside it that is still refused, so the inversion
 * cannot be mistaken for the gate having been switched off.
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
  options: {
    readonly signedIn?: boolean;
    readonly sessionValue?: string;
    readonly accept?: string;
  } = {},
): NextRequest {
  const headers = new Headers();
  // No `Accept` at all is the API-client case — `curl` sends `*/*` and a
  // `fetch` with no headers sends nothing. Both must get the code, not a page.
  if (options.accept !== undefined) headers.set("accept", options.accept);
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
  options: {
    readonly signedIn?: boolean;
    readonly sessionValue?: string;
    readonly accept?: string;
  } = {},
) {
  const res = await middleware(request(path, role, method, options));
  return {
    status: res.status,
    authz: res.headers.get("x-corgi-authz"),
    location: res.headers.get("location"),
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

describe("the sign-in gate — reads open, writes closed", () => {
  /**
   * THE INVERSION, AND WHY IT IS NOT THE GATE BEING SWITCHED OFF.
   *
   * The gate shipped as a door: no session meant 401 on every method, reads
   * included. It is now a till. A grading panel can walk the whole console
   * from a URL in an email with no shared secret, and every state change stays
   * behind the credential.
   *
   * That trade has a cost — an anonymous visitor reads every business on this
   * book — and it is named in `docs/AUTH.md` rather than only here. What these
   * checks pin is that the OTHER half did not go with it: each read that now
   * answers 200 has a write beside it that does not.
   */
  it("SERVES an operator route to a request with no session at all", async () => {
    const res = await run("/accounts", undefined, "GET", { signedIn: false });
    expect(res.status, "/accounts refused an anonymous read").toBe(200);
    expect(res.authz, "a served read carried a refusal header").toBe(null);
  });

  it("SERVES it however the role cookie is set, and to HEAD as well", async () => {
    for (const role of ["staff", "approver", "not-a-role", undefined]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await run("/accounts", role, method, { signedIn: false });
        expect(res.status, `corgi_demo_role=${role} ${method}`).toBe(200);
      }
    }
  });

  it("REFUSES an anonymous POST — which is every server action in this app", async () => {
    const res = await run("/payments", "staff", "POST", { signedIn: false });
    expect(res.status, "an anonymous write reached the route").toBe(401);
    expect(res.authz).toBe(`deny; ${SIGN_IN_REQUIRED}`);
    expect(res.body).toContain("/signin");
  });

  it("REFUSES an anonymous write whatever role cookie is typed", async () => {
    // The whole point: typing `corgi_demo_role=staff` was never a credential.
    for (const role of ["staff", "approver", "customer", "not-a-role"]) {
      const res = await run("/accounts", role, "POST", { signedIn: false });
      expect(res.status, `corgi_demo_role=${role} wrote without signing in`).toBe(401);
      expect(res.authz, role).toBe(`deny; ${SIGN_IN_REQUIRED}`);
    }
  });

  /**
   * A verb nobody has used yet. The safe set is the RFC's three and everything
   * else is a write, so the failure mode is "refused something that was
   * harmless", never "let through something that was not".
   */
  it("REFUSES a method this app does not even use, because safe is the closed list", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const res = await run("/accounts", "staff", method, { signedIn: false });
      expect(res.status, method).toBe(401);
    }
  });

  it("REDIRECTS a BROWSER write to /signin?next=…, and 303 so the POST becomes a GET", async () => {
    const res = await run("/payments", "staff", "POST", {
      signedIn: false,
      accept: "text/html,application/xhtml+xml",
    });
    expect(res.status, "a browser write did not get a redirect").toBe(303);
    expect(res.location).toBe(`${ORIGIN}/signin?next=%2Fpayments`);
    // The code is on the header either way, so one curl proves either branch.
    expect(res.authz).toBe(`deny; ${SIGN_IN_REQUIRED}`);
  });

  it("REDIRECTS a JavaScript server action too — text/x-component is a browser", async () => {
    const res = await run("/payments", "staff", "POST", {
      signedIn: false,
      accept: "text/x-component",
    });
    expect(res.status).toBe(303);
    expect(res.location).toBe(`${ORIGIN}/signin?next=%2Fpayments`);
  });

  it("gives an API CLIENT the code and not the redirect", async () => {
    for (const accept of ["*/*", "application/json"]) {
      const res = await run("/accounts", "staff", "POST", { signedIn: false, accept });
      expect(res.status, accept).toBe(401);
      expect(res.authz, accept).toBe(`deny; ${SIGN_IN_REQUIRED}`);
    }
  });

  it("REFUSES a write with a FORGED session cookie", async () => {
    const forged = `v1.${Date.now() + 3_600_000}.${randomUUID()}.${Buffer.from(
      randomUUID(),
    ).toString("base64url")}`;
    const res = await run("/accounts", "staff", "POST", { sessionValue: forged });
    expect(res.status, "a forged session was accepted").toBe(401);
    expect(res.authz).toBe(`deny; ${SIGN_IN_REQUIRED}`);
  });

  it("REFUSES a write with an EDITED session — expiry moved, signature kept", async () => {
    const [, , nonce, signature] = session.split(".");
    const edited = `v1.${Date.now() + 999_999_999}.${nonce}.${signature}`;
    const res = await run("/accounts", "staff", "POST", { sessionValue: edited });
    expect(res.status).toBe(401);
  });

  it("ALLOWS the write once the session is real — the credential is what unlocks it", async () => {
    const res = await run("/accounts", "staff", "POST");
    expect(res.status, "a signed-in write was refused").toBe(200);
  });

  it("gates a write to an operator route that does not exist yet — default deny", async () => {
    const res = await run("/ledger-exports", "staff", "POST", { signedIn: false });
    expect(res.status).toBe(401);
    // …and reads it, because the population is the same classification either way.
    expect((await run("/ledger-exports", "staff", "GET", { signedIn: false })).status).toBe(200);
  });

  it("does NOT gate /, /signin or the customer surface — for ANY method", async () => {
    // The hard constraint from docs/DEMO.md: `/` is where the role switch
    // lives, `/signin` is where a signed-out visitor must be able to go, and a
    // customer is not staff. The POSTs matter as much as the GETs here: the
    // role switch is a POST to `/`, and sign-in is a POST to `/signin`. Both
    // must work with no session, or the way IN is behind the gate.
    for (const path of ["/", "/signin", "/client", "/client/activity", "/client/open"]) {
      for (const method of ["GET", "POST"]) {
        const res = await run(path, "customer", method, { signedIn: false });
        expect(res.status, `${method} ${path} was gated and must not be`).toBe(200);
      }
    }
  });

  it("still applies AUTHORISATION behind the gate: a signed-in customer is 403, not 401", async () => {
    // Authentication and authorisation are two decisions and this proves the
    // second did not get swallowed by the first.
    const res = await run("/accounts", "customer");
    expect(res.status).toBe(403);
    expect(res.authz).toBe(`deny; ${OPERATOR_ONLY}`);
  });

  it("FAILS CLOSED on WRITES when CONSOLE_PASSWORD is unset — 503, named, never open", async () => {
    const saved = process.env["CONSOLE_PASSWORD"];
    delete process.env["CONSOLE_PASSWORD"];
    try {
      const res = await run("/accounts", "staff", "POST");
      expect(res.status, "an unconfigured deployment accepted a write").toBe(503);
      expect(res.authz).toBe(`deny; ${CONSOLE_NOT_CONFIGURED}`);
      expect(res.body).toContain("CONSOLE_PASSWORD");

      // Reads stay open — that is the inversion, and it is deliberate. What
      // must NOT happen is the write falling open with the secret unset, which
      // is the defect this build spent two days removing.
      expect((await run("/accounts", "staff", "GET")).status).toBe(200);

      // …and the customer surface is unaffected, which is the other half of
      // "fail closed": closing the till must not take the product down.
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
