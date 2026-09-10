/**
 * The audit log for the agent surface.
 *
 * Every call gets exactly one record, including the ones that were refused
 * before they ran. A surface that only logs what it allowed cannot answer the
 * question people actually ask after an incident, which is "what did it try?"
 *
 * WHERE THIS LANDS. One JSON line per call through `@/lib/log`, event
 * `mcp.audit`, which is the same drain every other line in this system goes
 * to. There is no `mcp_audit` table because migrations are owned by another
 * worker in this build; the DDL I would add is at the bottom of this file so
 * it is a five-minute change rather than a design question.
 *
 * What is NOT missing in the meantime: the write tool's audit trail is already
 * in the database and already immutable. `payment_instruction` plus its
 * `requested` event in `payment_instruction_event` record the agent's actor
 * id, the exact amount, the destination, the value date and the content hash,
 * on tables `corgi_app` holds no UPDATE or DELETE on. The log line is the
 * complete record for reads and a convenience for writes.
 *
 * ARGUMENTS ARE REDACTED BEFORE THEY ARE WRITTEN. An audit log that captures a
 * full bank account number becomes the most sensitive store in the system and
 * gets shipped to a third-party log aggregator by an unrelated deploy. Last
 * four digits identify a payment in an investigation; the other ten only
 * create liability. The payment tool never accepts a full account number in
 * the first place; this is the second line of that defence, for whatever a
 * future tool accepts.
 */

import type { Logger } from "@/lib/log";

export type AuditOutcome =
  | "ok"
  /** The tool ran, was scoped, and refused — a business answer, not a crash. */
  | "tool_error"
  /** Rejected before dispatch: bad protocol, unknown method, bad arguments. */
  | "protocol_error"
  /** Rejected at the door: no token, unknown token, wrong actor kind, throttled. */
  | "refused"
  /** An unexpected throw. Always paired with a separate error-level line. */
  | "internal_error";

export interface AuditRecord {
  readonly at: string;
  readonly requestId: string;
  readonly method: string;
  readonly tool: string | null;
  readonly outcome: AuditOutcome;
  readonly errorCode: string | null;
  /** Null when authentication itself failed. */
  readonly actorId: string | null;
  readonly businessId: string | null;
  readonly grantLabel: string | null;
  /**
   * First four bytes of the token's sha256. NOT called `tokenFingerprint`:
   * `@/lib/log` redacts any field whose name contains "token", and this value
   * is deliberately non-secret — it is what tells two tokens sharing a label
   * apart in an investigation. A field that is always `[redacted]` is a field
   * that is not in the audit log.
   */
  readonly grantFingerprint: string | null;
  readonly clientKey: string;
  readonly argumentsRedacted: Record<string, unknown> | null;
  readonly durationMs: number;
  /** Ids a reader can walk to: an instruction id, an entry id, a row count. */
  readonly result: Record<string, unknown> | null;
}

export interface AuditSink {
  record(entry: AuditRecord): void;
}

/** The production sink: one structured line, at info, always. */
export function loggerAuditSink(log: Logger): AuditSink {
  return {
    record(entry) {
      // `info` and not `warn` even for refusals: a refusal is this surface
      // working. Alerting is a query over `outcome`, not a log level.
      log.info("mcp.audit", { ...entry });
    },
  };
}

/** Test sink. Also useful from a REPL when chasing a scoping question. */
export class MemoryAuditSink implements AuditSink {
  readonly records: AuditRecord[] = [];
  record(entry: AuditRecord): void {
    this.records.push(entry);
  }
}

/** Sinks that both receive every record. Used to add a table without losing the line. */
export function teeAuditSink(...sinks: readonly AuditSink[]): AuditSink {
  return {
    record(entry) {
      for (const sink of sinks) sink.record(entry);
    },
  };
}

/**
 * Keys whose values never appear in full.
 *
 * Deliberately not the same list as the logger's: this one knows about payment
 * instructions. `routing_number` is absent on purpose — an ABA routing number
 * is published by the Fed and is exactly what an investigator needs to
 * identify the receiving institution. Redacting public data only makes the log
 * useless.
 */
const MASK_TO_LAST_4 = ["account_number", "accountnumber", "iban", "card_number", "pan"];

/**
 * Fields that LOOK like an account number and are already the safe tail.
 * `account_number_last4` matches "account_number" as a substring, and masking
 * a four-character value hides it entirely — which would strip the audit log
 * of the one field an investigator uses to identify the beneficiary.
 */
const ALREADY_TRUNCATED = /(?:_|\b)last_?4$/;
const MASK_ENTIRELY = ["ssn", "tax_id", "taxid", "secret", "token", "api_key", "apikey", "password"];

const MAX_STRING = 512;
const MAX_DEPTH = 6;

export function redactArguments(args: unknown): Record<string, unknown> | null {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
  const out = redact(args, 0);
  return out as Record<string, unknown>;
}

function redact(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[truncated: too deep]";
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const k = key.toLowerCase();
    if (MASK_ENTIRELY.some((needle) => k.includes(needle))) {
      out[key] = "[redacted]";
      continue;
    }
    if (
      MASK_TO_LAST_4.some((needle) => k.includes(needle)) &&
      typeof raw === "string" &&
      !ALREADY_TRUNCATED.test(k)
    ) {
      out[key] = maskToLast4(raw);
      continue;
    }
    out[key] = redact(raw, depth + 1);
  }
  return out;
}

/** `123456789` becomes `••••6789`. Short values are hidden entirely. */
export function maskToLast4(value: string): string {
  const digits = value.replace(/[^0-9A-Za-z]/g, "");
  if (digits.length <= 4) return "[redacted]";
  return `••••${digits.slice(-4)}`;
}

/*
 * TODO(migrations owned elsewhere) — the table this should also write to.
 * Append-only, same treatment as every other record of a fact in this schema:
 *
 *   CREATE TABLE mcp_audit (
 *     id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *     at             timestamptz NOT NULL DEFAULT now(),
 *     request_id     text NOT NULL,
 *     method         text NOT NULL,
 *     tool           text,
 *     outcome        text NOT NULL,
 *     error_code     text,
 *     actor_id       uuid REFERENCES actor(id),
 *     business_id    uuid REFERENCES business(id),
 *     grant_label    text,
 *     token_fp       text,
 *     client_key     text NOT NULL,
 *     arguments      jsonb,          -- redacted by redactArguments() first
 *     result         jsonb,
 *     duration_ms    integer NOT NULL
 *   );
 *   CREATE INDEX mcp_audit_actor_idx ON mcp_audit (actor_id, at DESC);
 *   CREATE INDEX mcp_audit_outcome_idx ON mcp_audit (outcome, at DESC);
 *   GRANT INSERT ON mcp_audit TO corgi_app;
 *   -- and the same no_update_delete / no_truncate triggers as the money
 *   -- tables, since an audit row a process can edit is not an audit row.
 *
 * It is a `teeAuditSink(loggerAuditSink(log), tableAuditSink(sql))` away.
 */
