/**
 * The durable sink for the agent surface's audit log.
 *
 * ============================================================================
 * WIRED. `src/app/api/mcp/route.ts` tees every MCP audit record into this file
 * and awaits the insert before the response leaves. The registration in
 * `audit_source` moved from `awaiting_wiring` to `projected` in
 * `0037_mcp_audit_wiring.sql`, which is the only thing that may move it: the
 * disposition is a claim about a call site, so it is flipped by the change that
 * makes the claim true and never in advance of it.
 * ============================================================================
 *
 * WHAT IT WRITES. Exactly the `AuditRecord` the MCP server already builds,
 * whose `argumentsRedacted` has been through `redactArguments()` — account
 * numbers masked to the last four, secrets and tokens dropped entirely, the
 * grant identified by the first four bytes of its sha256 and never by the
 * token. This file adds no field of its own and redacts nothing a second time:
 * a sink that re-derives its own redaction is a second policy to keep in step
 * with the first, and the two drift apart at exactly the moment a new tool
 * starts accepting a new kind of secret.
 *
 * ============================================================================
 * WHICH WAY AN AUDIT FAILURE FAILS, AND THE ARGUMENT
 * ----------------------------------------------------------------------------
 * It fails OPEN for the call and CLOSED for the claim. The tool call is served;
 * the assertion that the call is on the trail is withdrawn, out loud, in two
 * places that do not share the failing dependency.
 *
 * The house position in `docs/AGENT-LIMITS.md`, and the one the payee gate
 * enforces, is that a check which cannot record its own failure is worse than
 * no check. It binds here, and it is satisfied here — but not by refusing the
 * read. Three reasons, in the order they decided it:
 *
 * 1. FAIL-CLOSED AT THIS CALL SITE CANNOT PREVENT THE READ, ONLY THE REPLY.
 *    `server.handlePost` builds the audit record in a `finally`, which runs
 *    after dispatch. By the time this sink is called the gateway has already
 *    issued its SELECTs and the customer's balance is already sitting in the
 *    response object. Refusing there withholds the answer while leaving the
 *    data access identical — a gate that runs after the thing it gates is
 *    theatre, and it would buy a serving outage for no reduction in exposure.
 *    The honest fail-closed design is two-phase: an `attempted` row inserted
 *    BEFORE dispatch, a `completed` row after. That is the right build the day
 *    this surface grows a read whose mere execution is the sensitive act. It
 *    has none today — see point 3.
 *
 * 2. THE CORRELATED CASE IS ALREADY CLOSED, AND IT IS THE COMMON ONE. Every
 *    read tool queries the same Postgres pool this insert uses. If the database
 *    is gone, the read has already failed on its own and there is nothing for a
 *    refusal to withhold. The only case where the audit write fails while the
 *    read succeeds is a fault specific to this INSERT — a constraint, a
 *    privilege, a mis-shaped record. Failing the customer's balance query
 *    because of a defect in the audit schema inverts which of the two is load
 *    bearing.
 *
 * 3. THE ONE WRITE ON THIS SURFACE DOES NOT DEPEND ON THIS FILE. An
 *    agent-initiated payment is recorded synchronously and transactionally in
 *    `payment_instruction` plus its `requested` event, both append-only, both
 *    already on the timeline, and both written by the tool itself rather than
 *    by a sink. `mcp_audit` is the record of what the agent READ and what it
 *    was REFUSED. Losing one line of that is survivable in a way losing the
 *    payment is not, and the payment cannot be lost this way at all.
 *
 * WHAT MAKES IT NOT A SILENT SUCCESS — which is the failure this replaces:
 *
 * a. THE INSERT IS AWAITED INSIDE THE REQUEST. The obvious shape here is
 *    `void insert(entry).catch(log)`, and it is the trap. On a serverless
 *    runtime the instance is frozen the moment the response is returned, so a
 *    detached insert can be dropped *along with its own catch handler*: no
 *    row, no error line, no gap anybody can see. `settle()` exists so the route
 *    waits for the write it claimed to make. The cost is one INSERT round-trip
 *    (~10-40ms to Neon) on every MCP call, and it is the price of the table
 *    meaning anything.
 *
 * b. THE STDOUT LINE IS WRITTEN FIRST AND DOES NOT DEPEND ON POSTGRES. The tee
 *    in the route puts `loggerAuditSink` ahead of this sink, so the record
 *    survives total loss of the database — degraded from durable to a log
 *    retention window, not to nothing.
 *
 * c. THE FAILURE IS ITSELF RECORDED, TWICE. An error-level
 *    `mcp.audit.persist_failed` line naming the request id, the tool and the
 *    outcome; and `x-corgi-audit: degraded` on the response, so the caller
 *    learns that this call is not on the trail rather than only the operator.
 *
 * d. THE DEADLINE OVER-REPORTS RATHER THAN UNDER-REPORTS. A write still in
 *    flight at the deadline is reported as degraded even though it may land a
 *    moment later. Over-reporting a gap costs one look; under-reporting one
 *    costs an audit — the same direction `v_audit_source_unclaimed` is pointed
 *    in, and for the same reason.
 * ============================================================================
 */

import "server-only";

import type { AuditRecord, AuditSink } from "@/lib/mcp/audit";
import type { Sql } from "@/lib/ledger/db";
import { logger, type Logger } from "@/lib/log";

/**
 * The database handle is resolved LAZILY and the type import above is erased.
 *
 * `@/lib/ledger/db` builds a Postgres pool at module scope and `@/lib/env`
 * parses the environment at module scope, so a static import here would make
 * merely LOADING this file a boot-time dependency on a valid database URL.
 * That has two costs worth avoiding: `sink.test.ts` could not inject a failing
 * handle to prove the degraded path without real credentials, and a
 * misconfigured environment would take the MCP route down at import rather
 * than degrading one audit write and saying so. Deferring it turns the second
 * case into exactly the failure this file already knows how to report.
 */
async function poolSql(): Promise<Sql> {
  const db = await import("@/lib/ledger/db");
  return db.sql;
}

/**
 * How long the route will wait for the audit rows before giving up and saying
 * so. Generous against a cold Neon connection, far short of any client's
 * patience: an MCP call that has already produced its answer must not hang on
 * the bookkeeping behind it.
 */
export const AUDIT_WRITE_DEADLINE_MS = 2_000;

/** What the route learned about the durability of this request's audit trail. */
export type AuditPersistence =
  /** Every record for this request is a row in `mcp_audit`. */
  | "persisted"
  /** At least one record did not land, or had not landed by the deadline. */
  | "degraded"
  /** Nothing was recorded — no call reached the sink. Should not happen. */
  | "idle";

export interface AuditPersistResult {
  readonly state: AuditPersistence;
  readonly attempted: number;
  readonly written: number;
  /** One line per failure, already logged. Never echoed to the client. */
  readonly failures: readonly string[];
}

export interface DurableAudit {
  /** Hand this to `createMcpServer`. `record()` never throws and never blocks. */
  readonly sink: AuditSink;
  /**
   * Await every insert this request started. Resolves rather than rejects: the
   * caller decides what a failure means, and here it means a header, not a 500.
   */
  settle(): Promise<AuditPersistResult>;
}

export interface DurableAuditOptions {
  readonly log?: Logger;
  readonly sql?: Sql;
  readonly deadlineMs?: number;
}

/**
 * One handle per request. Per-request and not module-scope on purpose: a shared
 * pending list would make `settle()` wait on some other in-flight request's
 * write and report its failure as this one's.
 */
export function durableAuditSink(options: DurableAuditOptions = {}): DurableAudit {
  const handle = options.sql === undefined ? poolSql() : Promise.resolve(options.sql);
  const deadlineMs = options.deadlineMs ?? AUDIT_WRITE_DEADLINE_MS;
  const fallbackLog = options.log ?? logger();

  // The handle promise is consumed by every `record()` below, but a request
  // that records nothing would otherwise leave it unhandled if the import
  // failed. Attach a no-op rejection handler; the real reporting happens per
  // record, where there is a record to name.
  handle.catch(() => undefined);

  /** Each entry resolves to `null` on success or the failure message. Never rejects. */
  const pending: Promise<string | null>[] = [];

  const sink: AuditSink = {
    record(entry: AuditRecord): void {
      const log = options.log ?? logger({ requestId: entry.requestId });
      pending.push(
        handle.then((sql) => insert(entry, sql)).then(
          () => null,
          (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            // Not a bare catch: the row is gone, so the fact that it is gone
            // becomes the record. `error` and not `warn` — an audit gap is the
            // thing an on-call engineer is meant to be woken by, and the
            // refusals are the half of this table that matters.
            log.error("mcp.audit.persist_failed", {
              requestId: entry.requestId,
              method: entry.method,
              tool: entry.tool,
              outcome: entry.outcome,
              errorCode: entry.errorCode,
              error: message,
            });
            return message;
          },
        ),
      );
    },
  };

  return {
    sink,

    async settle(): Promise<AuditPersistResult> {
      if (pending.length === 0) {
        return { state: "idle", attempted: 0, written: 0, failures: [] };
      }

      const attempted = pending.length;
      const settled = await withDeadline(Promise.all(pending), deadlineMs);

      if (settled === TIMED_OUT) {
        // The inserts keep their own catch handlers and may still land. This
        // still reports degraded, because "it might have been written" is not
        // a claim an audit trail gets to make.
        fallbackLog.error("mcp.audit.persist_timeout", { attempted, deadlineMs });
        return {
          state: "degraded",
          attempted,
          written: 0,
          failures: [`audit write did not complete within ${deadlineMs}ms`],
        };
      }

      const failures = settled.filter((f): f is string => f !== null);
      return {
        state: failures.length === 0 ? "persisted" : "degraded",
        attempted,
        written: attempted - failures.length,
        failures,
      };
    },
  };
}

const TIMED_OUT = Symbol("audit-write-deadline");

/**
 * `Promise.race` with the timer cleared either way. An uncleared timer keeps a
 * Node process alive past the work it was waiting for, which on a serverless
 * runtime is billed and on a test runner is a hang.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The one statement this file issues. `corgi_app` holds INSERT and SELECT on
 * `mcp_audit` and nothing else, and a BEFORE UPDATE OR DELETE trigger refuses
 * the rest regardless of role — so there is no correction path here to get
 * wrong. A row that is wrong is superseded by the next row, exactly like every
 * other record of a fact in this schema.
 */
async function insert(entry: AuditRecord, sql: Sql): Promise<void> {
  await sql`
    INSERT INTO mcp_audit (at, request_id, method, tool, outcome, error_code,
                           actor_id, business_id, grant_label, grant_fp,
                           client_key, arguments, result, duration_ms)
    VALUES (${entry.at}, ${entry.requestId}, ${entry.method}, ${entry.tool},
            ${entry.outcome}, ${entry.errorCode}, ${entry.actorId}, ${entry.businessId},
            ${entry.grantLabel}, ${entry.grantFingerprint}, ${entry.clientKey},
            ${sql.json(entry.argumentsRedacted as never)},
            ${sql.json(entry.result as never)}, ${Math.round(entry.durationMs)})`;
}
