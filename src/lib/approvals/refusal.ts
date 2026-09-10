/**
 * Turning a database refusal into something a person can read.
 *
 * ============================================================================
 * THE RULE THIS MODULE ENCODES: call the control, let it fire, translate.
 *
 * The application does NOT check whether the initiator is the approver. It does
 * not check whether the actor is human, whether the hash still matches, or
 * whether enough distinct approvers have signed. Every one of those is a
 * trigger in `db/migrations/0001_ledger.sql`, and re-implementing any of them
 * here would create a second, weaker copy of a control that would then rot
 * independently — the classic way a maker-checker rule ends up enforced on one
 * of three code paths.
 *
 * So the write paths in this directory build the INSERT, send it, and let
 * Postgres decide. What arrives back is a `PostgresError` carrying an SQLSTATE
 * and the text of a `RAISE EXCEPTION` written for a DBA. This module is the one
 * place that becomes a refusal an operator can act on, and the mapping is
 * keyed on the exception text from the migrations, quoted beside each branch so
 * a future edit to either side is obvious.
 *
 * What is deliberately NOT done: the raw Postgres text is never rendered to a
 * user. It names internal ids and table structure, and `ErrorShape.message` is
 * documented as "safe to show". The raw text goes to the structured log with
 * the SQLSTATE, where an operator investigating a refusal will find it.
 * ============================================================================
 */

import { fail, type ErrorShape, type Err } from "@/lib/result";

/**
 * Every way a maker-checker write can be refused. Machine-readable, because a
 * screen branches on these and the MCP tool will too.
 */
export const REFUSAL_CODES = [
  "SELF_APPROVAL",
  "NOT_AN_APPROVER",
  "STALE_APPROVAL",
  "INSUFFICIENT_APPROVALS",
  "ALREADY_DECIDED",
  "ALREADY_RELEASED",
  "NOT_RELEASED",
  "NO_SUCH_INSTRUCTION",
  "DUPLICATE_DECISION",
  "AGENT_CANNOT_APPROVE",
  "IMMUTABLE",
  "FORBIDDEN",
  "POLICY_MISSING",
  "INVALID_REQUEST",
  "UNAVAILABLE",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** A postgres.js error, narrowed without importing the driver's class. */
type PgErrorLike = {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly constraint_name?: unknown;
  readonly detail?: unknown;
};

function asPgError(thrown: unknown): PgErrorLike | null {
  if (typeof thrown !== "object" || thrown === null) return null;
  const candidate = thrown as PgErrorLike;
  return typeof candidate.code === "string" && typeof candidate.message === "string"
    ? candidate
    : null;
}

/** SQLSTATE, or `""` for anything that is not a Postgres error. */
export function sqlState(thrown: unknown): string {
  const pg = asPgError(thrown);
  return pg === null ? "" : String(pg.code);
}

/** The raw server text. For the log, never for a screen. */
export function rawMessage(thrown: unknown): string {
  const pg = asPgError(thrown);
  if (pg !== null) return String(pg.message);
  return thrown instanceof Error ? thrown.message : String(thrown);
}

type Rule = {
  readonly code: RefusalCode;
  readonly test: (message: string, sqlstate: string, constraint: string) => boolean;
  readonly message: string;
};

/**
 * Order matters. The self-approval refusal is listed first because an initiator
 * who also holds the approver role would otherwise be told the wrong thing by
 * a broader rule, and "you cannot approve this one" is a different fact from
 * "you cannot approve anything".
 */
const RULES: readonly Rule[] = [
  {
    // 0001: 'maker-checker: actor % initiated instruction % and cannot approve it'
    code: "SELF_APPROVAL",
    test: (m) => m.includes("maker-checker:") && m.includes("cannot approve it"),
    message:
      "You raised this payment, so you cannot approve it. Maker-checker needs a second person: the initiator is never the checker.",
  },
  {
    // 0001: 'actor % (kind %) is not an approver'
    code: "NOT_AN_APPROVER",
    test: (m) => m.includes("is not an approver"),
    message:
      "This account is not an approver. Only a human actor with approval rights can approve money out — an agent or a service account cannot be one, by table constraint.",
  },
  {
    // 0001: CHECK actor_only_humans_approve
    code: "AGENT_CANNOT_APPROVE",
    test: (_m, _s, constraint) => constraint === "actor_only_humans_approve",
    message:
      "An automated actor cannot hold approval rights. The schema has no row shape in which an agent is an approver.",
  },
  {
    // 0001: 'approval for % cites the wrong content hash'
    code: "STALE_APPROVAL",
    test: (m) => m.includes("content hash"),
    message:
      "This payment has changed since it was shown to you. An approval names a specific amount, destination and rail — not a row — so the one you are holding no longer applies. Reload the queue and read it again.",
  },
  {
    // 0001 / 0007: 'instruction % needs % approval(s) above the % cent threshold, has %'
    code: "INSUFFICIENT_APPROVALS",
    test: (m) => m.includes("approval(s) above the"),
    message:
      "This payment does not yet have the approvals its policy version requires, so it cannot be released.",
  },
  {
    // 0007: 'instruction % has already been released'
    code: "ALREADY_RELEASED",
    test: (m) => m.includes("has already been released"),
    message:
      "This payment has already been released. Nothing was posted twice: the journal entry is keyed on the instruction id.",
  },
  {
    // 0001: '... cannot be submitted'  /  0007: '... cannot be released' / 'is already closed'
    code: "ALREADY_DECIDED",
    test: (m) =>
      m.includes("was rejected or cancelled") ||
      m.includes("is already closed") ||
      m.includes("is already open"),
    message:
      "This payment has already been decided. The event stream is append-only, so a decision is never replaced — only added to.",
  },
  {
    // 0007: 'instruction % has not been released; % cannot follow'
    code: "NOT_RELEASED",
    test: (m) => m.includes("has not been released") || m.includes("has no requested event"),
    message: "That step cannot come before the payment has been released.",
  },
  {
    // 0001: UNIQUE (instruction_id, kind, actor_id)
    code: "DUPLICATE_DECISION",
    test: (_m, _s, constraint) => constraint === "pie_one_decision_per_actor",
    message:
      "You have already recorded that decision on this payment. One actor, one decision — a second approval from the same person cannot satisfy a two-approver rule.",
  },
  {
    // 0001 §13: the append-only triggers, SQLSTATE 55006
    code: "IMMUTABLE",
    test: (m) => m.includes("append-only violation"),
    message:
      "That row is immutable. Money and its lifecycle are append-only; a correction is a new row, never an edit.",
  },
  {
    // Layer 1: corgi_app simply does not hold the privilege.
    code: "FORBIDDEN",
    test: (m) => m.includes("permission denied"),
    message:
      "The application does not hold that capability. This is the privilege model refusing, not a bug — corgi_app has no UPDATE or DELETE on any money table.",
  },
  {
    code: "NO_SUCH_INSTRUCTION",
    test: (_m, sqlstate) => sqlstate === "23503",
    message: "That payment does not exist, or the actor recording the decision does not.",
  },
];

const UNKNOWN: ErrorShape = {
  code: "UNAVAILABLE",
  message:
    "The decision could not be recorded. Nothing was written: the whole step is one transaction, so a failure leaves no half-approved payment behind.",
};

/**
 * Classify a thrown value into a refusal.
 *
 * Anything unrecognised becomes `UNAVAILABLE` with a message that says nothing
 * happened — which is true, because every write path here is a single
 * transaction, and it is the only thing an operator needs to know before
 * deciding whether to retry.
 */
export function classifyRefusal(thrown: unknown): ErrorShape {
  const pg = asPgError(thrown);
  const message = rawMessage(thrown);
  const state = pg === null ? "" : String(pg.code);
  const constraint =
    pg !== null && typeof pg.constraint_name === "string" ? pg.constraint_name : "";

  for (const rule of RULES) {
    if (rule.test(message, state, constraint)) {
      return { code: rule.code, message: rule.message, details: { sqlstate: state } };
    }
  }
  return { ...UNKNOWN, details: { sqlstate: state } };
}

/** `classifyRefusal`, as an `Err` ready to return from a write path. */
export function refuse(thrown: unknown): Err<ErrorShape> {
  const shape = classifyRefusal(thrown);
  return fail(shape.code, shape.message, shape.details);
}

/** Did the database refuse this for the reason we are asking about? */
export function isRefusal(error: ErrorShape, code: RefusalCode): boolean {
  return error.code === code;
}
