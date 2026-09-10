/**
 * Raising a payment instruction, and reading the queue back.
 *
 * ============================================================================
 * `requestPayment()` IS THE FUNCTION THE MCP WRITE TOOL CALLS.
 *
 * It takes an actor id and does not care what kind of actor it is. An agent
 * raising a $4,200 supplier payment lands in exactly the same queue, under
 * exactly the same policy version, with exactly the same content hash as Priya
 * typing it in — because there is no second path. The agent's inability to
 * approve is not a check inside this function; it is
 *
 *     CONSTRAINT actor_only_humans_approve CHECK (NOT (kind <> 'human' AND can_approve))
 *
 * on the `actor` table, which makes an approving agent unrepresentable, plus
 * the belt-and-braces branch in `assert_maker_checker()` that refuses an
 * `approved` event from a non-human actor. Nothing this function could do would
 * let an agent self-approve, and nothing it could FAIL to do would either.
 * That is the whole reason the rule lives in the schema.
 * ============================================================================
 *
 * The instruction row is written once and never updated: `payment_instruction`
 * carries the append-only trigger from 0001 §13 and `corgi_app` holds no UPDATE
 * on it. Every fact about a payment after creation is an event.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { transactGateForAccount } from "@/lib/kyb/wire";
import { fail, ok, type Result } from "@/lib/result";

import { contentHash } from "./hash";
import { effectivePolicyFor } from "./policy-store";
import { refuse } from "./refusal";
import { foldState, isPending, normaliseKind } from "./state";
import {
  destinationSchema,
  policyVersion,
  requestPaymentSchema,
  type ActorKind,
  type ApprovalPolicy,
  type PaymentDestination,
  type PaymentEventKind,
  type PaymentInstruction,
  type PaymentInstructionEvent,
  type PayoutRail,
  type QueuedPayment,
  type RequestPaymentInput,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Row shapes                                                                 */
/* -------------------------------------------------------------------------- */

type InstructionRow = {
  readonly id: string;
  readonly account_id: string;
  readonly account_name: string;
  readonly business_name: string | null;
  readonly rail: PayoutRail;
  readonly amount_cents: bigint;
  readonly currency: string;
  readonly counterparty: unknown;
  readonly value_date: string;
  readonly requested_by: string;
  readonly requested_by_name: string;
  readonly requested_by_kind: ActorKind;
  readonly requested_at: Date;
  readonly idempotency_key: string;
  readonly content_hash: string;
  readonly policy_id: string;
  readonly policy_rail: PayoutRail;
  readonly policy_effective_from: string;
  readonly threshold_cents: bigint;
  readonly required_approvals: number;
  readonly policy_note: string;
};

type EventRow = {
  readonly id: string;
  readonly instruction_id: string;
  readonly kind: PaymentEventKind;
  readonly actor_id: string;
  readonly actor_name: string;
  readonly actor_kind: ActorKind;
  readonly approved_content_hash: string | null;
  readonly reason: string | null;
  readonly value_date: string;
  readonly occurred_at: Date;
  readonly entry_id: string | null;
};

/**
 * The stored destination is jsonb, which means it was written by some earlier
 * version of this code or by the MCP tool. It is re-validated on the way out
 * rather than trusted: a row that no longer parses is a row the screen must not
 * render as if it understood it.
 */
function parseDestination(raw: unknown): PaymentDestination {
  const parsed = destinationSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return {
    type: "internal",
    accountId: "00000000-0000-0000-0000-000000000000",
    holderName: "Unrecognised destination — do not approve",
  };
}

function toPolicy(row: InstructionRow): ApprovalPolicy {
  return {
    id: row.policy_id,
    rail: row.policy_rail,
    effectiveFrom: row.policy_effective_from,
    thresholdCents: row.threshold_cents,
    requiredApprovals: row.required_approvals,
    note: row.policy_note,
    version: policyVersion(row.policy_rail, row.policy_effective_from),
  };
}

function toInstruction(row: InstructionRow): PaymentInstruction {
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name,
    businessName: row.business_name,
    rail: row.rail,
    amountCents: row.amount_cents,
    currency: row.currency,
    destination: parseDestination(row.counterparty),
    valueDate: row.value_date,
    requestedByActorId: row.requested_by,
    requestedByName: row.requested_by_name,
    requestedByKind: row.requested_by_kind,
    requestedAt: row.requested_at.toISOString(),
    policy: toPolicy(row),
    idempotencyKey: row.idempotency_key,
    contentHash: row.content_hash,
  };
}

function toEvent(row: EventRow): PaymentInstructionEvent {
  return {
    id: row.id,
    kind: row.kind,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorKind: row.actor_kind,
    approvedContentHash: row.approved_content_hash,
    reason: row.reason,
    valueDate: row.value_date,
    occurredAt: row.occurred_at.toISOString(),
    entryId: row.entry_id,
  };
}

/**
 * The projection, built fresh per call.
 *
 * A module-level fragment would be one `Query` object shared by every caller,
 * and postgres.js binds state onto it as it executes — so a shared fragment is
 * a race between two concurrent reads. A function costs nothing and cannot be
 * misused that way.
 */
function instructionColumns(conn: Sql) {
  return conn`
    pi.id, pi.account_id, acc.name AS account_name, b.legal_name AS business_name,
    pi.rail::text AS rail, pi.amount_cents, pi.currency, pi.counterparty,
    pi.value_date::text AS value_date,
    pi.requested_by, ra.display_name AS requested_by_name, ra.kind::text AS requested_by_kind,
    pi.requested_at, pi.idempotency_key,
    encode(pi.content_hash, 'hex') AS content_hash,
    ap.id AS policy_id, ap.rail::text AS policy_rail,
    ap.effective_from::text AS policy_effective_from,
    ap.threshold_cents, ap.required_approvals, ap.note AS policy_note`;
}

/* -------------------------------------------------------------------------- */
/* Raising one                                                                */
/* -------------------------------------------------------------------------- */

export type RequestedPayment = {
  readonly instructionId: string;
  readonly contentHash: string;
  readonly policy: ApprovalPolicy;
  readonly approvalsRequired: number;
  /** True when this call created the row; false when it replayed an existing one. */
  readonly created: boolean;
};

/**
 * Raise a payment instruction. THE ENTRY POINT FOR THE MCP WRITE TOOL.
 *
 * Four things happen, in one transaction:
 *
 *   1. the input is validated against `requestPaymentSchema` — the caller is a
 *      model handing us JSON, so nothing is assumed about its shape;
 *   2. the `approval_policy` version in force for this rail ON THIS PAYMENT'S
 *      VALUE DATE is selected and its id written onto the row, so the payment
 *      cites the version it was judged under and a later policy change cannot
 *      retroactively make this approval look wrong;
 *   3. the content hash is computed over (account, rail, amount, destination,
 *      value date) and stored;
 *   4. a `requested` event is appended, attributing it to the actor.
 *
 * Replaying the same `idempotencyKey` returns the ORIGINAL instruction and
 * writes nothing — the unique index decides, not an `if`. A model that retries
 * a tool call cannot raise the same payment twice.
 */
export async function requestPayment(
  input: RequestPaymentInput,
  conn: Sql = sql,
): Promise<Result<RequestedPayment>> {
  const parsed = requestPaymentSchema.safeParse(input);
  if (!parsed.success) {
    return fail(
      "INVALID_REQUEST",
      "The payment could not be raised: the request does not describe a payment this bank can make.",
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  const args = parsed.data;

  try {
    return await conn.begin(async (tx) => {
      const policy = await effectivePolicyFor(args.rail, args.valueDate, tx as unknown as Sql);
      if (policy === null) {
        // Not a throw: a rail with no policy version in force is an operator
        // problem (nobody wrote the row), not a caller problem, and it must not
        // be papered over with a default threshold. A payment with no policy to
        // cite is a payment nobody agreed the rules for.
        return fail(
          "POLICY_MISSING",
          `No approval policy is in force for ${args.rail} on ${args.valueDate}. A payment cannot be raised without a policy version to cite.`,
        );
      }

      // "Gate the account: unverified entities can look but not transact."
      //
      // Structurally this is already half-true — a pending business has no
      // deposit account, so there is nowhere for money to land. That is a good
      // defence and it is not this one. This is the readable refusal, with a
      // code and a reason, at the one place both the console and the MCP write
      // tool pass through.
      //
      // INSIDE the transaction, and before the INSERT, on purpose: read the
      // KYB state under the same snapshot that writes the instruction, so
      // nothing can be approved-then-revoked between the check and the write.
      const gate = await transactGateForAccount(args.accountId, {
        conn: tx as unknown as Sql,
      });
      if (!gate.allowed) return fail(gate.code, gate.message);

      const hash = contentHash({
        accountId: args.accountId,
        rail: args.rail,
        amountCents: args.amountCents,
        currency: args.currency,
        destination: args.destination,
        valueDate: args.valueDate,
      });

      const inserted = await tx<{ id: string }[]>`
        INSERT INTO payment_instruction
          (account_id, rail, amount_cents, currency, counterparty, value_date,
           requested_by, policy_id, idempotency_key, content_hash)
        VALUES
          (${args.accountId}::uuid,
           ${args.rail}::rail,
           ${args.amountCents.toString()}::bigint,
           ${args.currency},
           ${tx.json(args.destination)},
           ${args.valueDate}::date,
           ${args.requestedByActorId}::uuid,
           ${policy.id}::uuid,
           ${args.idempotencyKey},
           decode(${hash}, 'hex'))
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id`;

      const created = inserted[0];
      if (created === undefined) {
        // Replay. Return the original, untouched, and write no second
        // `requested` event — 0007's lifecycle trigger would refuse it anyway.
        const [existing] = await tx<{ id: string; content_hash: string; policy_id: string }[]>`
          SELECT id, encode(content_hash, 'hex') AS content_hash, policy_id
            FROM payment_instruction WHERE idempotency_key = ${args.idempotencyKey}`;
        if (existing === undefined) {
          return fail(
            "UNAVAILABLE",
            "The payment could not be raised. Nothing was written.",
          );
        }
        return ok({
          instructionId: existing.id,
          contentHash: existing.content_hash,
          policy,
          approvalsRequired:
            args.amountCents >= policy.thresholdCents ? policy.requiredApprovals : 0,
          created: false,
        });
      }

      await tx`
        INSERT INTO payment_instruction_event
          (instruction_id, kind, actor_id, value_date)
        VALUES
          (${created.id}::uuid, 'requested', ${args.requestedByActorId}::uuid,
           ${args.valueDate}::date)`;

      return ok({
        instructionId: created.id,
        contentHash: hash,
        policy,
        approvalsRequired:
          args.amountCents >= policy.thresholdCents ? policy.requiredApprovals : 0,
        created: true,
      });
    });
  } catch (thrown) {
    return refuse(thrown);
  }
}

/* -------------------------------------------------------------------------- */
/* Reading it back                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How many approvals this instruction actually holds.
 *
 * Counted the same way `assert_maker_checker()` counts them, and for the same
 * reason: distinct actors, human only, never the initiator, and only approvals
 * that cite THIS instruction's current content hash. A screen that counted them
 * any other way would promise a release the database then refuses.
 */
function countApprovals(
  instruction: PaymentInstruction,
  events: readonly PaymentInstructionEvent[],
): number {
  const actors = new Set<string>();
  for (const event of events) {
    if (normaliseKind(event.kind) !== "approved") continue;
    if (event.actorKind !== "human") continue;
    if (event.actorId === instruction.requestedByActorId) continue;
    if (event.approvedContentHash !== instruction.contentHash) continue;
    actors.add(event.actorId);
  }
  return actors.size;
}

function assemble(
  instruction: PaymentInstruction,
  events: readonly PaymentInstructionEvent[],
): QueuedPayment {
  const aboveThreshold = instruction.amountCents >= instruction.policy.thresholdCents;
  return {
    instruction,
    state: foldState(events),
    events,
    approvalsHeld: countApprovals(instruction, events),
    approvalsRequired: aboveThreshold ? instruction.policy.requiredApprovals : 0,
    aboveThreshold,
  };
}

async function eventsFor(
  instructionIds: string[],
  conn: Sql,
): Promise<Map<string, PaymentInstructionEvent[]>> {
  const byInstruction = new Map<string, PaymentInstructionEvent[]>();
  if (instructionIds.length === 0) return byInstruction;

  const rows = await conn<EventRow[]>`
    SELECT e.id, e.instruction_id, e.kind::text AS kind, e.actor_id,
           a.display_name AS actor_name, a.kind::text AS actor_kind,
           encode(e.approved_content_hash, 'hex') AS approved_content_hash,
           e.reason, e.value_date::text AS value_date, e.occurred_at, e.entry_id
      FROM payment_instruction_event e
      JOIN actor a ON a.id = e.actor_id
     WHERE e.instruction_id = ANY(${instructionIds}::uuid[])
     ORDER BY e.occurred_at, e.id`;

  for (const row of rows) {
    const list = byInstruction.get(row.instruction_id) ?? [];
    list.push(toEvent(row));
    byInstruction.set(row.instruction_id, list);
  }
  return byInstruction;
}

export type QueueQuery = {
  /** Only instructions still awaiting a decision or a release. Default true. */
  readonly pendingOnly?: boolean;
  readonly limit?: number;
};

/**
 * The approvals queue.
 *
 * "Pending" is filtered in SQL as the ABSENCE of any closing event, rather than
 * by reading a status column that does not exist. The fold in `state.ts` then
 * confirms it on the way out, so the two definitions are checked against each
 * other on every read instead of drifting.
 */
export async function listQueue(
  query: QueueQuery = {},
  conn: Sql = sql,
): Promise<Result<readonly QueuedPayment[]>> {
  const pendingOnly = query.pendingOnly ?? true;
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);

  try {
    const rows = await conn<InstructionRow[]>`
      SELECT ${instructionColumns(conn)}
        FROM payment_instruction pi
        JOIN actor ra ON ra.id = pi.requested_by
        JOIN account acc ON acc.id = pi.account_id
        LEFT JOIN business b ON b.id = acc.business_id
        JOIN approval_policy ap ON ap.id = pi.policy_id
       WHERE ${
         pendingOnly
           ? conn`NOT EXISTS (
               SELECT 1 FROM payment_instruction_event e
                WHERE e.instruction_id = pi.id
                  AND e.kind::text IN ('rejected','cancelled','released','submitted',
                                       'settled','returned','failed'))`
           : conn`true`
       }
       ORDER BY pi.requested_at DESC
       LIMIT ${limit}`;

    const events = await eventsFor(rows.map((row) => row.id), conn);

    const queued = rows.map((row) => {
      const instruction = toInstruction(row);
      return assemble(instruction, events.get(row.id) ?? []);
    });

    return ok(pendingOnly ? queued.filter((item) => isPending(item.state)) : queued);
  } catch (thrown) {
    return refuse(thrown);
  }
}

/** One payment, with its whole event stream. */
export async function getPayment(
  instructionId: string,
  conn: Sql = sql,
): Promise<Result<QueuedPayment>> {
  try {
    const rows = await conn<InstructionRow[]>`
      SELECT ${instructionColumns(conn)}
        FROM payment_instruction pi
        JOIN actor ra ON ra.id = pi.requested_by
        JOIN account acc ON acc.id = pi.account_id
        LEFT JOIN business b ON b.id = acc.business_id
        JOIN approval_policy ap ON ap.id = pi.policy_id
       WHERE pi.id = ${instructionId}::uuid`;

    const row = rows[0];
    if (row === undefined) {
      return fail("NO_SUCH_INSTRUCTION", "That payment does not exist.");
    }
    const events = await eventsFor([row.id], conn);
    return ok(assemble(toInstruction(row), events.get(row.id) ?? []));
  } catch (thrown) {
    return refuse(thrown);
  }
}
