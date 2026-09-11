import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authoriseScheduled } from "@/app/api/cron/_auth";
import { middleware } from "@/middleware";

import { NextRequest } from "next/server";

/**
 * D04x — the forged-header hole, in both directions.
 *
 * The two halves of the control are tested in one file because they are one
 * control: the route requires a bearer (`_auth.ts`) and the middleware deletes
 * the header that used to substitute for one (`src/middleware.ts`). Testing
 * only the first would leave "the header is gone" as a claim.
 */

const CRON = "cron-secret-value-for-tests-0000000000";
const DRAIN = "drain-token-value-for-tests-000000000";

let savedCron: string | undefined;
let savedDrain: string | undefined;

beforeEach(() => {
  savedCron = process.env["CRON_SECRET"];
  savedDrain = process.env["DRAIN_TOKEN"];
  process.env["CRON_SECRET"] = CRON;
  process.env["DRAIN_TOKEN"] = DRAIN;
});

afterEach(() => {
  if (savedCron === undefined) delete process.env["CRON_SECRET"];
  else process.env["CRON_SECRET"] = savedCron;
  if (savedDrain === undefined) delete process.env["DRAIN_TOKEN"];
  else process.env["DRAIN_TOKEN"] = savedDrain;
});

function request(headers: Record<string, string>): Request {
  return new Request("https://example.test/api/cron/accrual", { headers });
}

describe("authoriseScheduled — the forged header is refused", () => {
  it("refuses a request whose only credential is x-vercel-cron", () => {
    const verdict = authoriseScheduled(request({ "x-vercel-cron": "1" }), "accrual", "req_test");
    expect(verdict).toEqual({ ok: false, reason: "NO_BEARER" });
  });

  it("refuses x-vercel-cron even alongside a wrong bearer", () => {
    const verdict = authoriseScheduled(
      request({ "x-vercel-cron": "1", authorization: "Bearer not-the-secret" }),
      "accrual",
      "req_test",
    );
    expect(verdict).toEqual({ ok: false, reason: "WRONG_BEARER" });
  });

  it("refuses a bare request", () => {
    const verdict = authoriseScheduled(request({}), "drain", "req_test");
    expect(verdict.ok).toBe(false);
  });

  it("refuses a near-miss token of identical length", () => {
    const nearMiss = `${CRON.slice(0, -1)}X`;
    expect(nearMiss).toHaveLength(CRON.length);
    const verdict = authoriseScheduled(
      request({ authorization: `Bearer ${nearMiss}` }),
      "drain",
      "req_test",
    );
    expect(verdict).toEqual({ ok: false, reason: "WRONG_BEARER" });
  });

  it("fails CLOSED when no secret is configured, header or not", () => {
    delete process.env["CRON_SECRET"];
    delete process.env["DRAIN_TOKEN"];
    expect(authoriseScheduled(request({ "x-vercel-cron": "1" }), "holds", "req_test")).toEqual({
      ok: false,
      reason: "NOT_CONFIGURED",
    });
    expect(
      authoriseScheduled(request({ authorization: `Bearer ${CRON}` }), "holds", "req_test"),
    ).toEqual({ ok: false, reason: "NOT_CONFIGURED" });
  });

  it("does not accept the secret outside the Bearer scheme", () => {
    expect(authoriseScheduled(request({ authorization: CRON }), "drain", "req_test").ok).toBe(false);
    expect(
      authoriseScheduled(request({ authorization: `Basic ${CRON}` }), "drain", "req_test").ok,
    ).toBe(false);
    expect(
      authoriseScheduled(request({ "x-cron-secret": CRON }), "drain", "req_test").ok,
    ).toBe(false);
  });
});

describe("authoriseScheduled — the genuine caller is accepted", () => {
  it("accepts what Vercel Cron sends: Authorization: Bearer $CRON_SECRET", () => {
    const verdict = authoriseScheduled(
      request({ authorization: `Bearer ${CRON}` }),
      "standing",
      "req_test",
    );
    expect(verdict).toEqual({ ok: true, credential: "CRON_SECRET" });
  });

  it("still accepts the operator's DRAIN_TOKEN, so the demo and scripts keep working", () => {
    const verdict = authoriseScheduled(
      request({ authorization: `Bearer ${DRAIN}` }),
      "drain",
      "req_test",
    );
    expect(verdict).toEqual({ ok: true, credential: "DRAIN_TOKEN" });
  });

  it("accepts CRON_SECRET when DRAIN_TOKEN is absent, and the reverse", () => {
    delete process.env["DRAIN_TOKEN"];
    expect(
      authoriseScheduled(request({ authorization: `Bearer ${CRON}` }), "drain", "req_test").ok,
    ).toBe(true);
    process.env["DRAIN_TOKEN"] = DRAIN;
    delete process.env["CRON_SECRET"];
    expect(
      authoriseScheduled(request({ authorization: `Bearer ${DRAIN}` }), "drain", "req_test").ok,
    ).toBe(true);
  });

  it("tolerates scheme casing and padding, which proxies do rewrite", () => {
    expect(
      authoriseScheduled(request({ authorization: `bearer  ${CRON}` }), "drain", "req_test").ok,
    ).toBe(true);
  });
});

describe("middleware — x-vercel-cron never reaches a route handler", () => {
  // `middleware()` became async when the sign-in gate (control 3) shipped: the
  // session signature is verified with `crypto.subtle`, which is the only HMAC
  // available on both the Edge runtime and Node. The control asserted here is
  // unchanged — awaiting the same call is the whole edit.
  it("deletes a client-supplied x-vercel-cron from the forwarded request", async () => {
    const response = await middleware(
      new NextRequest("https://example.test/api/drain", {
        headers: { "x-vercel-cron": "1", "x-vercel-id": "trace-1", authorization: "Bearer x" },
      }),
    );

    // Next encodes the rewritten request headers onto the response. The
    // override list is what the route will actually receive.
    const overrides = (response.headers.get("x-middleware-override-headers") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== "");

    expect(overrides).not.toContain("x-vercel-cron");
    expect(response.headers.get("x-middleware-request-x-vercel-cron")).toBeNull();
    expect(response.headers.get("x-stripped-request-headers")).toBe("x-vercel-cron");

    // Observability headers survive: the trace id is not a grant and is the
    // only thing tying a log line to a Vercel invocation.
    expect(overrides).toContain("x-vercel-id");
    expect(response.headers.get("x-middleware-request-x-vercel-id")).toBe("trace-1");
    expect(response.headers.get("x-middleware-request-authorization")).toBe("Bearer x");
  });

  it("passes an ordinary request through untouched", async () => {
    const response = await middleware(
      new NextRequest("https://example.test/api/cron/holds", {
        headers: { authorization: "Bearer x" },
      }),
    );
    expect(response.headers.get("x-stripped-request-headers")).toBeNull();
  });
});
