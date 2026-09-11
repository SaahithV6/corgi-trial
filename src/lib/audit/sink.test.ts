/**
 * The durable audit sink, and specifically ITS FAILURE MODES.
 *
 * The happy path is proven against the real database by the live calls in
 * docs/AUDIT.md §2.1 and by `audit.integration.test.ts`. What cannot be proven
 * there is the half that decides the design: what this file does when the
 * INSERT does not land. A sink whose failure path nobody has executed is a
 * comment, and this one carries the whole "fail open for the call, closed for
 * the claim" argument on its back.
 *
 * These run with no credentials and no database. That is the point of the
 * lazy handle in `sink.ts`: a fake `Sql` can be injected, so the degraded path
 * is exercised in CI rather than only in an incident.
 */

import { describe, expect, it } from "vitest";

import { logger } from "@/lib/log";
import type { Sql } from "@/lib/ledger/db";
import type { AuditRecord } from "@/lib/mcp/audit";

import { durableAuditSink } from "./sink";

const REFUSAL: AuditRecord = {
  at: "2026-09-11T06:29:13.756Z",
  requestId: "req_7a85e4f1e11042da9df0d9ebef94ca73",
  method: "tools/call",
  tool: "approve_payment",
  outcome: "protocol_error",
  errorCode: "REFUSED_OPERATION",
  actorId: "3743dc53-4e1c-577e-9a0f-e4469ffc1761",
  businessId: "e274546d-6bdd-5266-b0fb-cc839a7811f9",
  grantLabel: "demo-read-and-propose",
  grantFingerprint: "7b5c37ab",
  clientKey: "::ffff:127.0.0.1",
  argumentsRedacted: { instruction_id: "any" },
  durationMs: 1,
  result: null,
};

/**
 * The smallest thing shaped like the `postgres` handle this file uses: a tag
 * function plus `.json`. `.json` is called while the template's arguments are
 * being evaluated, before the tag itself, so it has to exist even on a handle
 * that is going to reject.
 */
function fakeSql(tag: () => Promise<unknown>): Sql {
  const handle = tag as unknown as { json: (v: unknown) => unknown };
  handle.json = (v: unknown) => v;
  return handle as unknown as Sql;
}

const rejecting = (message: string): Sql =>
  fakeSql(() => Promise.reject(new Error(message)));

const slow = (ms: number): Sql =>
  fakeSql(() => new Promise((resolve) => setTimeout(resolve, ms)));

function capture() {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    log: logger({
      level: "debug",
      emit: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
  };
}

describe("durableAuditSink", () => {
  it("persists, and says so, when the insert lands", async () => {
    const sink = durableAuditSink({ sql: fakeSql(() => Promise.resolve([])) });
    sink.sink.record(REFUSAL);
    await expect(sink.settle()).resolves.toMatchObject({
      state: "persisted",
      attempted: 1,
      written: 1,
      failures: [],
    });
  });

  it("reports DEGRADED rather than throwing when the insert fails", async () => {
    // The decision under test. A failed audit write must not become a failed
    // tool call — the record is built in the server's `finally`, after the
    // database has already served the read, so refusing there would withhold
    // an answer without withholding the access.
    const { log } = capture();
    const sink = durableAuditSink({ sql: rejecting("permission denied for table mcp_audit"), log });

    expect(() => sink.sink.record(REFUSAL)).not.toThrow();

    const persistence = await sink.settle();
    expect(persistence.state).toBe("degraded");
    expect(persistence.written).toBe(0);
    expect(persistence.attempted).toBe(1);
  });

  it("records the fact that the record was lost, naming the refused call", async () => {
    // The house position — a check that cannot record its own failure is worse
    // than no check — is satisfied HERE and not by a refusal. The gap has to be
    // greppable, and it has to name enough of the call to be actionable.
    const { lines, log } = capture();
    const sink = durableAuditSink({ sql: rejecting("connect ETIMEDOUT"), log });
    sink.sink.record(REFUSAL);
    await sink.settle();

    const failure = lines.find((l) => l["event"] === "mcp.audit.persist_failed");
    expect(failure).toBeDefined();
    expect(failure?.["level"]).toBe("error");
    expect(failure?.["requestId"]).toBe(REFUSAL.requestId);
    expect(failure?.["tool"]).toBe("approve_payment");
    expect(failure?.["errorCode"]).toBe("REFUSED_OPERATION");
    expect(String(failure?.["error"])).toContain("ETIMEDOUT");
  });

  it("never puts a token or a secret in the line it writes about the loss", async () => {
    const { lines, log } = capture();
    const sink = durableAuditSink({ sql: rejecting("nope"), log });
    sink.sink.record({
      ...REFUSAL,
      argumentsRedacted: { api_key: "[redacted]", account_number: "••••9012" },
    });
    await sink.settle();

    const text = JSON.stringify(lines);
    expect(text).not.toContain("7f3a91c4e05b2d68a4c1");
    // The failure line carries ids and the outcome, never the arguments.
    expect(text).not.toContain("9012");
  });

  it("gives up at the deadline rather than holding the response open", async () => {
    // Over-reports on purpose: the insert may still land after this resolves,
    // and "it might have been written" is not a claim an audit trail gets to
    // make. Over-reporting a gap costs one look; under-reporting costs an audit.
    const { lines, log } = capture();
    const sink = durableAuditSink({ sql: slow(200), log, deadlineMs: 10 });
    sink.sink.record(REFUSAL);

    const persistence = await sink.settle();
    expect(persistence.state).toBe("degraded");
    expect(persistence.failures[0]).toContain("did not complete within 10ms");
    expect(lines.some((l) => l["event"] === "mcp.audit.persist_timeout")).toBe(true);
  });

  it("is idle, not persisted, when nothing was recorded", async () => {
    // A request that records nothing is a bug in the server, not a clean run,
    // so it must not report the same state as a request that wrote its row.
    const sink = durableAuditSink({ sql: fakeSql(() => Promise.resolve([])) });
    await expect(sink.settle()).resolves.toMatchObject({ state: "idle", attempted: 0 });
  });

  it("reports degraded if one of several records fails", async () => {
    let call = 0;
    const flaky = fakeSql(() => {
      call += 1;
      return call === 2 ? Promise.reject(new Error("deadlock detected")) : Promise.resolve([]);
    });
    const { log } = capture();
    const sink = durableAuditSink({ sql: flaky, log });
    sink.sink.record(REFUSAL);
    sink.sink.record(REFUSAL);
    sink.sink.record(REFUSAL);

    await expect(sink.settle()).resolves.toMatchObject({
      state: "degraded",
      attempted: 3,
      written: 2,
    });
  });
});
