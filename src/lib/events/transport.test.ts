import { describe, expect, it } from "vitest";

import { postSigned, resolvePublicAddress, MAX_EXCERPT_CHARS } from "./transport";

/**
 * The enforcement, exercised without a network.
 *
 * Every case here is refused BEFORE a packet is sent, which is the property
 * being asserted: a refusal that happens after the connect is not a fence, it
 * is a log entry. `postSigned` never throws — a delivery worker that could
 * take an exception out of its loop would lose the rest of the batch — so each
 * case is a returned outcome with a reason a customer can act on.
 */

const HEADERS = { "content-type": "application/json" };

describe("postSigned refuses before connecting", () => {
  it.each([
    ["https://127.0.0.1/hook", /loopback/],
    ["https://169.254.169.254/latest/meta-data/", /link-local.*metadata/i],
    ["https://10.0.0.5/hook", /private address/],
    ["https://[::1]/hook", /IPv6 loopback/],
    ["https://[::ffff:127.0.0.1]/hook", /IPv4-mapped/],
    ["http://hooks.example.com/hook", /only https/],
    ["https://hooks.example.com:8443/hook", /port scanner/],
    ["https://user:pass@hooks.example.com/hook", /userinfo/],
    ["https://localhost/hook", /not a public name/],
  ])("%s", async (url, reason) => {
    const outcome = await postSigned({ url, body: "{}", headers: HEADERS });
    expect(outcome.kind).toBe("no_response");
    if (outcome.kind !== "no_response") return;
    expect(outcome.error).toMatch(/^refused before connecting/);
    expect(outcome.error).toMatch(reason);
    // Nothing was contacted, so there is no address to report. The screen
    // renders this as "never connected" rather than as a blank.
    expect(outcome.resolvedIp).toBeNull();
  });
});

describe("resolvePublicAddress", () => {
  it("refuses a real public name whose A record is loopback", async () => {
    // `localtest.me` is a genuine registered domain that resolves to
    // 127.0.0.1. Every textual check in the world passes it; only resolving
    // the name catches it. This is the whole argument for bar 5.
    const result = await resolvePublicAddress("localtest.me");
    expect("code" in result).toBe(true);
    if (!("code" in result)) return;
    expect(result.code).toBe("ADDRESS_NOT_GLOBAL");
    expect(result.message).toMatch(/loopback/);
  }, 20_000);

  it("names the failure when a hostname does not resolve at all", async () => {
    const result = await resolvePublicAddress("this-name-does-not-exist.corgi-trial.invalid");
    expect("code" in result).toBe(true);
    if (!("code" in result)) return;
    expect(result.code).toBe("DNS_FAILED");
    expect(result.message).toMatch(/could not resolve/);
  }, 20_000);
});

describe("bounds", () => {
  it("keeps the stored excerpt under the column's CHECK constraint", () => {
    // `outbound_attempt.response_excerpt` is CHECK (length <= 1024). An
    // excerpt that overflowed it would turn a customer's verbose error page
    // into a failed INSERT, which would lose the attempt row entirely — the
    // one piece of evidence the failure produced.
    expect(MAX_EXCERPT_CHARS).toBeLessThanOrEqual(1024);
  });
});
