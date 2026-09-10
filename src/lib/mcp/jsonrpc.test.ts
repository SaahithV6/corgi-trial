import { describe, expect, it } from "vitest";

import {
  INVALID_PARAMS,
  INVALID_REQUEST,
  PARSE_ERROR,
  decodeMessage,
  failure,
  isNotification,
  success,
} from "./jsonrpc";

describe("decodeMessage", () => {
  it("decodes a request with params", () => {
    const decoded = decodeMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } }),
    );
    expect(decoded.kind).toBe("request");
    if (decoded.kind !== "request") return;
    expect(decoded.request.method).toBe("tools/call");
    expect(decoded.request.id).toBe(1);
    expect(decoded.request.params).toEqual({ name: "x" });
  });

  it("decodes a notification as a request with no id", () => {
    const decoded = decodeMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(decoded.kind).toBe("request");
    if (decoded.kind !== "request") return;
    expect(isNotification(decoded.request)).toBe(true);
  });

  it("reports a parse error with a null id", () => {
    const decoded = decodeMessage("{not json");
    expect(decoded.kind).toBe("error");
    if (decoded.kind !== "error") return;
    expect(decoded.failure.error.code).toBe(PARSE_ERROR);
    expect(decoded.failure.id).toBeNull();
  });

  it("refuses batches, naming the revision that removed them", () => {
    const decoded = decodeMessage(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]));
    expect(decoded.kind).toBe("error");
    if (decoded.kind !== "error") return;
    expect(decoded.failure.error.code).toBe(INVALID_REQUEST);
    expect(decoded.failure.error.message).toContain("2025-06-18");
  });

  it("refuses a wrong jsonrpc version but still echoes the id", () => {
    const decoded = decodeMessage(JSON.stringify({ jsonrpc: "1.0", id: "abc", method: "ping" }));
    expect(decoded.kind).toBe("error");
    if (decoded.kind !== "error") return;
    // The id survives so the client can correlate the failure with the call it
    // made, rather than guessing which of several in flight went wrong.
    expect(decoded.failure.id).toBe("abc");
    expect(decoded.failure.error.code).toBe(INVALID_REQUEST);
  });

  it("refuses a missing method", () => {
    const decoded = decodeMessage(JSON.stringify({ jsonrpc: "2.0", id: 1 }));
    expect(decoded.kind).toBe("error");
    if (decoded.kind !== "error") return;
    expect(decoded.failure.error.message).toContain("method");
  });

  it("refuses positional params", () => {
    const decoded = decodeMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: [1, 2] }),
    );
    expect(decoded.kind).toBe("error");
    if (decoded.kind !== "error") return;
    expect(decoded.failure.error.code).toBe(INVALID_PARAMS);
  });

  it("refuses a non-object body", () => {
    for (const body of ["null", '"hello"', "42"]) {
      const decoded = decodeMessage(body);
      expect(decoded.kind).toBe("error");
    }
  });

  it("refuses an id that is neither string nor finite number", () => {
    const decoded = decodeMessage(
      JSON.stringify({ jsonrpc: "2.0", id: { nested: true }, method: "ping" }),
    );
    expect(decoded.kind).toBe("error");
    if (decoded.kind !== "error") return;
    expect(decoded.failure.error.message).toContain("id");
  });
});

describe("envelopes", () => {
  it("builds a success", () => {
    expect(success(7, { ok: true })).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
  });

  it("builds a failure and omits absent data", () => {
    expect(failure(null, -32000, "nope")).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "nope" },
    });
    expect(failure(1, -32000, "nope", { why: "x" }).error.data).toEqual({ why: "x" });
  });
});
