/**
 * The audit log for the agent surface.
 *
 * Every call gets exactly one record, including the ones that were refused
 * before they ran. A surface that only logs what it allowed cannot answer the
 * question people actually ask after an incident, which is "what did it try?"
 *
 * WHERE THIS LANDS. Two places, and the order is load-bearing.
 *
 *   1. One JSON line per call through `@/lib/log`, event `mcp.audit`, the same
 *      drain every other line in this system goes to. It touches no database,
 *      so it survives the database being gone.
 *   2. One row per call in `mcp_audit` — `db/migrations/0035_audit.sql` §2,
 *      written by `src/lib/audit/sink.ts`, append-only by privilege and by
 *      trigger exactly like `journal_entry`, and projected onto the actor
 *      trail by `v_actor_action`.
 *
 * `src/app/api/mcp/route.ts` tees the two in that order and AWAITS the row
 * before the response leaves, so an audit write that fails is a fact somebody
 * learns rather than a detached promise a frozen lambda drops. Which way that
 * failure falls, and why, is argued at length in the header of
 * `src/lib/audit/sink.ts`: open for the call, closed for the claim.
 *
 * The write tool never depended on either. `payment_instruction` plus its
 * `requested` event in `payment_instruction_event` record the agent's actor
 * id, the exact amount, the destination, the value date and the content hash,
 * synchronously and transactionally, on tables `corgi_app` holds no UPDATE or
 * DELETE on. These two sinks are the record of what the agent READ and what it
 * was REFUSED — the half that had no durable home until the route was wired.
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

/**
 * Sinks that all receive every record, IN ARGUMENT ORDER.
 *
 * The order is not cosmetic and the route depends on it: `loggerAuditSink`
 * goes first because it has no dependency that can be down, so the record
 * exists before anything reaches for Postgres. A sink placed here must have a
 * total `record()` — it may not throw — because this runs inside the server's
 * `finally` and a throw there would replace a correct response with a 500.
 * Both sinks in this repository satisfy that: the logger catches nothing
 * because it can fail at nothing, and the durable sink converts every database
 * failure into a logged line plus a rejected-nothing promise.
 */
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
 * The table this also writes to now exists and is wired:
 *
 *   DDL          db/migrations/0035_audit.sql §2  (privileges, BEFORE UPDATE
 *                OR DELETE trigger, TRUNCATE trigger — four layers, the same
 *                ones `journal_entry` has)
 *   writer       src/lib/audit/sink.ts            (durableAuditSink)
 *   call site    src/app/api/mcp/route.ts         (teeAuditSink, awaited)
 *   registry     audit_source → projected, 0037_mcp_audit_wiring.sql
 *   projection   v_actor_action, surface `agent`, one row per call
 *
 * `grant_fp` in the table is `grantFingerprint` here, and neither is ever the
 * token: four bytes of its sha256, enough to tell two grants sharing a label
 * apart in an investigation and useless to anyone who steals the row.
 */
