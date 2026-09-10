import { describe, expect, it } from "vitest";

import { parseEnv } from "@/lib/env.schema";
import type { EnvironmentError } from "@/lib/env.schema";
import { logger } from "@/lib/log";
import { err, fail, isErr, isOk, ok, toResponseBody, unwrap } from "@/lib/result";

/**
 * Scaffold smoke tests. These exist to prove the harness runs, not to specify
 * behaviour — the ledger, the rails and the schema are another worker's.
 */

describe("result", () => {
  it("discriminates Ok from Err", () => {
    const good = ok(42);
    const bad = err("nope");

    expect(isOk(good)).toBe(true);
    expect(isErr(bad)).toBe(true);
    expect(unwrap(good)).toBe(42);
  });

  it("serialises an Err into a stable response body", () => {
    const body = toResponseBody(fail("INSUFFICIENT_FUNDS", "Not enough money."));
    expect(body).toEqual({
      error: { code: "INSUFFICIENT_FUNDS", message: "Not enough money." },
    });
  });
});

describe("env", () => {
  it("names every INVALID key at once, not just the first", () => {
    // Contract changed deliberately: provider keys are optional now, because a
    // missing key selects that slot's simulator rather than killing the app.
    // See src/lib/env.schema.ts. What must still hold is that when keys ARE
    // invalid, the error names all of them in one pass.
    try {
      parseEnv({ APP_DATABASE_URL: "not-a-uri", USDC_SENDER_ADDRESS: "nope" });
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as EnvironmentError;
      expect(err.keys).toContain("APP_DATABASE_URL");
      expect(err.keys).toContain("USDC_SENDER_ADDRESS");
    }
  });
});

describe("log", () => {
  it("emits one JSON line carrying the request id", () => {
    const lines: string[] = [];
    const log = logger({
      requestId: "req_test",
      level: "debug",
      emit: (line) => lines.push(line),
    });

    log.info("scaffold.ready", { wired: false });

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(record["requestId"]).toBe("req_test");
    expect(record["event"]).toBe("scaffold.ready");
    expect(record["level"]).toBe("info");
    expect(record["wired"]).toBe(false);
    expect(typeof record["ts"]).toBe("string");
  });

  it("redacts secret-shaped fields", () => {
    const lines: string[] = [];
    const log = logger({
      requestId: "req_test",
      level: "debug",
      emit: (line) => lines.push(line),
    });

    log.warn("provider.call", { lithicApiKey: "super-secret" });

    const record = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(record["lithicApiKey"]).toBe("[redacted]");
  });
});
