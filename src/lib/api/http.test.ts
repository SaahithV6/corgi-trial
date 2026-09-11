/**
 * The wire conventions, tested without a database.
 *
 * Money, cursors and parameter handling are the three things every endpoint on
 * this surface shares, so a bug in one of them is a bug in all of them at
 * once.
 */

import { describe, expect, it } from "vitest";

import { ApiError, fromRefusal, registeredErrorCodes } from "./errors";
import {
  decodeCursor,
  encodeCursor,
  dateParam,
  enumParam,
  errorResponse,
  jsonResponse,
  limitParam,
  money,
  page,
  rejectUnknownParams,
} from "./http";

const url = (query: string): URL => new URL(`http://localhost/api/v1/transactions${query}`);

describe("money never crosses the wire as a number", () => {
  it("renders cents as a decimal string, including zero and negatives", () => {
    expect(money(0n)).toEqual({ cents: "0", display: "$0.00" });
    expect(money(-1234n).cents).toBe("-1234");
    expect(typeof money(1n).cents).toBe("string");
  });

  it("survives a value a double cannot represent", () => {
    // 2^53 + 1 cents. A JSON number would come back as 9007199254740992 with
    // no warning; the string comes back exactly.
    const beyondDouble = 9_007_199_254_740_993n;
    const rendered = money(beyondDouble);
    expect(rendered.cents).toBe("9007199254740993");
    const roundTripped = BigInt(JSON.parse(JSON.stringify(rendered)).cents as string);
    expect(roundTripped).toBe(beyondDouble);
  });

  it("refuses to serialise a payload that leaked a bigint", () => {
    // The backstop. A serialiser that forgets to call money() fails the
    // request with a message naming the path, rather than shipping a
    // TypeError out of JSON.stringify.
    expect(() => jsonResponse({ amount_cents: 5n }, 200, "req_1")).toThrow(/leaked a bigint/);
    expect(() => jsonResponse({ rows: [{ deep: { seq: 7n } }] }, 200, "req_1")).toThrow(
      /\$\.rows\[0\]\.deep\.seq/,
    );
  });
});

describe("cursors are opaque and fail closed", () => {
  it("round-trips a booking sequence", () => {
    const encoded = encodeCursor(123456789012345678n);
    expect(encoded).not.toContain("123456789");
    expect(decodeCursor(encoded)).toBe(123456789012345678n);
  });

  it("returns null for an absent cursor", () => {
    expect(decodeCursor(null)).toBeNull();
  });

  it("refuses a constructed or tampered cursor rather than paging from the top", () => {
    // Silently starting from the newest row is how a paging loop skips rows
    // without anyone noticing, so a bad cursor is an error and not a default.
    for (const bad of ["12345", "not-base64!!", Buffer.from('{"v":2,"s":"1"}').toString("base64url")]) {
      expect(() => decodeCursor(bad)).toThrow(ApiError);
    }
    try {
      decodeCursor("12345");
    } catch (error) {
      expect((error as ApiError).code).toBe("INVALID_CURSOR");
      expect((error as ApiError).status).toBe(400);
    }
  });
});

describe("query parameters are refused, never ignored", () => {
  it("names the unknown parameter and lists what is accepted", () => {
    try {
      rejectUnknownParams(url("?business_id=abc"), ["limit", "cursor"]);
      throw new Error("should have thrown");
    } catch (error) {
      const api = error as ApiError;
      expect(api.code).toBe("UNKNOWN_QUERY_PARAMETER");
      expect(api.message).toContain("business_id");
      expect(api.details?.["accepted"]).toEqual(["limit", "cursor"]);
    }
  });

  it("accepts a declared parameter", () => {
    expect(() => rejectUnknownParams(url("?limit=5"), ["limit"])).not.toThrow();
  });

  it("refuses a limit outside the range and a non-integer limit", () => {
    expect(limitParam(url(""))).toBe(25);
    expect(limitParam(url("?limit=7"))).toBe(7);
    expect(() => limitParam(url("?limit=0"))).toThrow(ApiError);
    expect(() => limitParam(url("?limit=9999"))).toThrow(ApiError);
    expect(() => limitParam(url("?limit=ten"))).toThrow(ApiError);
  });

  it("refuses a date that is not a real calendar day", () => {
    expect(dateParam(url("?value_date_from=2026-09-10"), "value_date_from")).toBe("2026-09-10");
    expect(() => dateParam(url("?value_date_from=2026-02-30"), "value_date_from")).toThrow(ApiError);
    expect(() => dateParam(url("?value_date_from=10/09/2026"), "value_date_from")).toThrow(ApiError);
  });

  it("refuses an enum value outside the set and says what the set is", () => {
    expect(enumParam(url("?rail=ach"), "rail", ["ach", "wire"] as const)).toBe("ach");
    try {
      enumParam(url("?rail=cheque"), "rail", ["ach", "wire"] as const);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ApiError).details?.["accepted"]).toEqual(["ach", "wire"]);
    }
  });
});

describe("the error envelope says what to do", () => {
  it("carries a condition and a resolution on every registered code", () => {
    // The whole point of the register. "invalid request" tells an integrator
    // nothing; the predicate that was false and the act that would satisfy it
    // tell them what to change.
    for (const code of registeredErrorCodes()) {
      const error = fromRefusal(code, "upstream message");
      expect(error.condition.length, `${code} has no condition`).toBeGreaterThan(10);
      expect(error.resolution.length, `${code} has no resolution`).toBeGreaterThan(40);
      expect(error.message, `${code} rewrote the upstream message`).toBe("upstream message");
    }
  });

  it("covers the refusals a payment can actually hit", () => {
    const codes = registeredErrorCodes();
    for (const expected of [
      "KYB_NOT_STARTED",
      "KYB_PENDING",
      "KYB_NEEDS_REVIEW",
      "KYB_REJECTED",
      "PAYEE_ROUTING_NUMBER_IMPOSSIBLE",
      "PAYEE_WARNING_UNACKNOWLEDGED",
      "PAYEE_WIRE_ROUTING_NUMBER_MISSING",
      "INSUFFICIENT_AVAILABLE_FUNDS",
      "ABOVE_TOKEN_CEILING",
      "POLICY_MISSING",
    ]) {
      expect(codes, `${expected} is not in the register`).toContain(expected);
    }
  });

  it("is honest about a refusal it has no entry for", () => {
    // Guessing a remedy would be worse than saying there isn't one. The
    // upstream message still travels, because it is the accurate half.
    const error = fromRefusal("SOME_FUTURE_CODE", "the bank said no, specifically");
    expect(error.status).toBe(422);
    expect(error.message).toBe("the bank said no, specifically");
    expect(error.condition).toContain("SOME_FUTURE_CODE");
    expect(error.resolution).toContain("request_id");
  });

  it("renders one shape, with the request id, and the headers a refusal needs", async () => {
    const error = new ApiError({
      status: 429,
      type: "rate_limit",
      code: "RATE_LIMITED",
      message: "slow down",
      condition: "requests in the last minute < 60",
      resolution: "wait 4s",
      headers: { "retry-after": "4" },
    });
    const response = errorResponse(error, "req_abc");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("4");
    expect(response.headers.get("x-request-id")).toBe("req_abc");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as Record<string, Record<string, unknown>>;
    expect(Object.keys(body).sort()).toEqual(["error", "request_id"]);
    expect(body["request_id"]).toBe("req_abc");
    expect(Object.keys(body["error"] ?? {}).sort()).toEqual([
      "code",
      "condition",
      "message",
      "resolution",
      "type",
    ]);
  });
});

describe("list responses have one shape", () => {
  it("wraps data with a page block", () => {
    expect(page([{ a: 1 }], 25, null)).toEqual({
      object: "list",
      data: [{ a: 1 }],
      page: { limit: 25, has_more: false, next_cursor: null },
    });
    expect(page([], 10, "abc").page.has_more).toBe(true);
  });
});
