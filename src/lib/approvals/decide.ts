/**
 * Approve, reject, cancel.
 *
 * ============================================================================
 * READ THIS BEFORE ADDING A CHECK TO THIS FILE.
 *
 * There is no `if (approverId === instruction.requestedBy) return refuse(...)`
 * in `approvePayment()`, and there must never be one. The refusal is
 *
 *     IF NEW.actor_id = v_pi.requested_by THEN
 *       RAISE EXCEPTION 'maker-checker: actor % initiated instruction % and
 *                        cannot approve it', ... USING ERRCODE = '42501';
 *
 * in `assert_maker_checker()`, `db/migrations/0001_ledger.sql`. This function
 * builds the INSERT, sends it, and lets the trigger fire. `refusal.ts` turns
 * the SQLSTATE 42501 that comes back into a sentence an operator can read.
 *
 * Why that way round, when a TypeScript guard would be one line and faster:
 *
 *   * The guard would be a SECOND copy of the rule. Two copies drift, and the
 *     one that drifts is always the one nobody tested. The MCP write tool, a
 *     future batch importer and a support script would each need their own.
 *   * A control that is only exercised on the happy path is not a control. By
 *     routing every approval through the trigger, the refusal is exercised by
 *     every single approval this system ever performs, not just by the one test
 *     that goes looking for it.
 *   * `approvals.integration.test.ts` asserts that the DATABASE refuses a
 *     self-approval, against the live Neon instance. If the rule lived here,
 *     that test would be asserting the behaviour of the thing it is testing.
 *
 * The application's job is to make the refusal legible, not to pre-empt it.
 * ============================================================================
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { ok, type Result } from "@/lib/result";

import { requireContentHash } from "./hash";
import { refuse } from "./refusal";

export type DecisionInput = {
  readonly instructionId: string;
  /** The actor recording the decision. Never derived from anything client-side. */
  readonly actorId: string;
  /**
   * The hash of the payment the approver was actually looking at, carried
   * through the form. NOT re-read from the row on the server — re-reading it
   * would make the check tautological and is precisely the mistake
   * approve-the-hash exists to prevent.
   */
  readonly contentHash: string;
  readonly reason?: string;
};

export type Decision = {
  readonly eventId: string;
  readonly occurredAt: string;
};

type DecisionRow = { readonly id: string; readonly occurred_at: Date };

/**
 * Approve a payment.
 *
 * The `approved_content_hash` written here is the one the caller passed, which
 * came from the rendered queue row. If the payment on screen was not the
 * payment in the database — different amount, different destination, different
 * rail — the hashes differ and the trigger refuses. The approver approved a
 * payment; if that payment is not this row, no approval has occurred.
 *
 * `value_date` on the event is the BOOK DATE OF THE DECISION, not the payment's
 * value date: "when was this approved" is a fact about the checker's day, and
 * the payment's own value date is already on the instruction. `book_date(now())`
 * is 0001's function and resolves in America/New_York, so an approval recorded
 * at 21:00 in Denver books to the banking day the rails agree it happened on.
 */
export async function approvePayment(
  input: DecisionInput,
  conn: Sql = sql,
): Promise<Result<Decision>> {
  return record("approved", input, conn);
}

/** Reject a payment. A reason is required by the console, not by the schema. */
export async function rejectPayment(
  input: DecisionInput,
  conn: Sql = sql,
): Promise<Result<Decision>> {
  return record("rejected", input, conn);
}

/**
 * Withdraw a payment before it is released.
 *
 * Recorded by whoever withdraws it — including the initiator, who is allowed to
 * cancel their own instruction. Cancelling is not approving: it takes money off
 * the table rather than putting it on, so maker-checker has nothing to say
 * about it and the trigger does not gate it.
 */
export async function cancelPayment(
  input: DecisionInput,
  conn: Sql = sql,
): Promise<Result<Decision>> {
  return record("cancelled", input, conn);
}

async function record(
  kind: "approved" | "rejected" | "cancelled",
  input: DecisionInput,
  conn: Sql,
): Promise<Result<Decision>> {
  let hash: string;
  try {
    hash = requireContentHash(input.contentHash);
  } catch {
    // A malformed hash never reaches the database. Not because the database
    // would accept it — `octet_length(content_hash) = 32` would refuse — but
    // because "the form field was mangled" and "this approval is stale" are
    // different problems and must not produce the same message.
    return refuse({
      code: "22P02",
      message: "content hash is not 32 bytes of hex",
    });
  }

  const reason = input.reason?.trim();

  try {
    const rows = await conn<DecisionRow[]>`
      INSERT INTO payment_instruction_event
        (instruction_id, kind, actor_id, approved_content_hash, reason, value_date)
      VALUES
        (${input.instructionId}::uuid,
         ${kind}::payment_event_kind,
         ${input.actorId}::uuid,
         ${kind === "approved" ? conn`decode(${hash}, 'hex')` : conn`NULL`},
         ${reason === undefined || reason === "" ? null : reason},
         book_date(now()))
      RETURNING id, occurred_at`;

    const row = rows[0];
    if (row === undefined) {
      return refuse(new Error("the decision was not recorded and no error was raised"));
    }
    return ok({ eventId: row.id, occurredAt: row.occurred_at.toISOString() });
  } catch (thrown) {
    return refuse(thrown);
  }
}
