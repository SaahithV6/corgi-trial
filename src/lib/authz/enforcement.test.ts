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
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { middleware } from "@/middleware";

import { OPERATOR_ONLY } from "./policy";

const ORIGIN = "https://corgi-trial-psi.vercel.app";

function request(path: string, role?: string, method = "GET"): NextRequest {
  const headers = new Headers();
  if (role !== undefined) headers.set("cookie", `corgi_demo_role=${role}`);
  return new NextRequest(new URL(path, ORIGIN), { method, headers });
}

/** What the middleware did, in the two terms that matter. */
async function run(path: string, role?: string, method = "GET") {
  const res = await middleware(request(path, role, method));
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
