import { describe, expect, it } from "vitest";

import { logger } from "@/lib/log";

import { MemoryAuditSink, loggerAuditSink, maskToLast4, redactArguments, teeAuditSink, type AuditRecord } from "./audit";

const record: AuditRecord = {
  at: "2026-09-10T18:00:00.000Z",
  requestId: "req_1",
  method: "tools/call",
  tool: "initiate_payment",
  outcome: "ok",
  errorCode: null,
  actorId: "3743dc53-4e1c-577e-9a0f-e4469ffc1761",
  businessId: "e274546d-6bdd-5266-b0fb-cc839a7811f9",
  grantLabel: "ridgeline-agent",
  grantFingerprint: "ab12cd34",
  clientKey: "127.0.0.1",
  argumentsRedacted: { rail: "ach" },
  durationMs: 12,
  result: { instruction_id: "x" },
};

describe("redactArguments", () => {
  it("masks a bank account number to its last four", () => {
    const out = redactArguments({
      counterparty: { account_number: "123456789012", routing_number: "021000021" },
    });
    const counterparty = out?.["counterparty"] as Record<string, unknown>;
    expect(counterparty["account_number"]).toBe("••••9012");
  });

  it("leaves an *_last4 field alone — it is already the safe tail", () => {
    // `account_number_last4` contains "account_number", and masking a
    // four-character value would blank the one field an investigator uses.
    const out = redactArguments({ destination: { account_number_last4: "9012" } });
    const destination = out?.["destination"] as Record<string, unknown>;
    expect(destination["account_number_last4"]).toBe("9012");
  });

  it("keeps the routing number, which is public and is what identifies the bank", () => {
    const out = redactArguments({ counterparty: { routing_number: "021000021" } });
    const counterparty = out?.["counterparty"] as Record<string, unknown>;
    expect(counterparty["routing_number"]).toBe("021000021");
  });

  it("removes secrets entirely rather than masking them", () => {
    const out = redactArguments({ api_key: "sk_test_abc", ssn: "123-45-6789" });
    expect(out?.["api_key"]).toBe("[redacted]");
    expect(out?.["ssn"]).toBe("[redacted]");
  });

  it("keeps the fields an investigator needs", () => {
    const out = redactArguments({ rail: "ach", amount_cents: "125000", value_date: "2026-09-11" });
    expect(out).toEqual({ rail: "ach", amount_cents: "125000", value_date: "2026-09-11" });
  });

  it("truncates a very long string and a very deep object", () => {
    const long = redactArguments({ reason: "x".repeat(2000) });
    expect(String(long?.["reason"]).endsWith("…[truncated]")).toBe(true);

    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };
    expect(JSON.stringify(redactArguments(deep))).toContain("too deep");
  });

  it("returns null for a non-object", () => {
    expect(redactArguments("hello")).toBeNull();
    expect(redactArguments(null)).toBeNull();
    expect(redactArguments([1, 2])).toBeNull();
  });

  it("renders bigint as a decimal string rather than throwing in JSON.stringify", () => {
    expect(redactArguments({ cents: 10n })).toEqual({ cents: "10" });
  });
});

describe("maskToLast4", () => {
  it("hides anything too short to have a safe tail", () => {
    expect(maskToLast4("123")).toBe("[redacted]");
    expect(maskToLast4("1234")).toBe("[redacted]");
    expect(maskToLast4("12345")).toBe("••••2345");
  });
});

describe("sinks", () => {
  it("writes one structured line per record", () => {
    const lines: string[] = [];
    const sink = loggerAuditSink(logger({ level: "debug", emit: (line) => lines.push(line) }));
    sink.record(record);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(parsed["event"]).toBe("mcp.audit");
    expect(parsed["tool"]).toBe("initiate_payment");
    expect(parsed["actorId"]).toBe(record.actorId);
    expect(parsed["outcome"]).toBe("ok");
  });

  it("tees to every sink so a table can be added without losing the line", () => {
    const a = new MemoryAuditSink();
    const b = new MemoryAuditSink();
    teeAuditSink(a, b).record(record);
    expect(a.records).toHaveLength(1);
    expect(b.records).toHaveLength(1);
  });
});
