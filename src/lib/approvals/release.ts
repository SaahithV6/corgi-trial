/**
 * Releasing an approved payment: the one step that touches money.
 *
 * ============================================================================
 * ORDERING, AND WHY IT IS THIS WAY ROUND.
 *
 * Releasing does two writes: a journal entry, and a `released` event carrying
 * that entry's id. `payment_instruction_event` is append-only and `corgi_app`
 * holds no UPDATE on it, so the event cannot be written first and back-filled —
 * which means the posting has to happen before the event that authorises it.
 *
 * That would be alarming if they were separate transactions. They are not.
 * Both happen inside one `sql.begin()`, so if `assert_payment_lifecycle()`
 * refuses the event — not approved, already released, rejected — the journal
 * entry rolls back with it. There is no window in which money has moved and no
 * event says so, and no window in which an unapproved payment has a posting.
 *
 * DOUBLE RELEASE IS DECIDED BY POSTGRES, NOT BY A CHECK.
 * `postEntry()` is called with `payment:release:<instruction id>` — derived from
 * the instruction and nothing else. `ledger_append()` looks that key up first
 * and, on a replay, RETURNS THE ORIGINAL ENTRY ID AND WRITES NOTHING. So two
 * concurrent releases produce one journal entry; the loser's event insert then
 * trips the "already released" branch and its transaction rolls back. The money
 * is safe either way round, and it is safe because of a unique index rather
 * than because of an `if`.
 * ============================================================================
 *
 * DESIGN §16, last paragraph: "the money entry for an outbound payment is
 * appended only on submitted, so an unapproved instruction has no ledger
 * footprint at all (not even a hold), and a rejected one never becomes money."
 * That is why there is no hold placed at request time.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { postEntry } from "@/lib/ledger/post";
import { findAccount, readAccountIdentity } from "@/lib/ledger/queries";
import { fail, ok, type Result } from "@/lib/result";

import { getPayment } from "./instructions";
import { refuse } from "./refusal";
import { closeApprovalHold } from "./reserve";
import { describeDestination, type PayoutRail, type QueuedPayment } from "./types";

/**
 * Which house account the money moves to, per rail.
 *
 * The customer's deposit account is a CREDIT-NORMAL LIABILITY: paying out
 * reduces what we owe them, which is a DEBIT, which is a POSITIVE
 * `amount_cents` in this schema (§2.1, and the seed README's "the trap in it").
 * Get that backwards and every outbound payment increases the customer's
 * balance.
 *
 *   ach   -> 2300 ACH payable, outbound in transit (liability, credited: we now
 *            owe the receiving bank until the entry settles)
 *   wire  -> 1110 Cash, FBO settlement account (asset, credited: the cash is
 *            gone the moment a wire leaves; there is no in-transit window worth
 *            modelling on an irrevocable rail)
 *   usdc  -> 1140 USDC omnibus wallet (asset, credited: the wallet balance
 *            falls when the transfer is broadcast)
 *
 * `internal` has no house leg at all: both sides are customer deposit accounts
 * on our own book, so the contra is the beneficiary's account, taken from the
 * destination.
 */
const HOUSE_CONTRA_CODE: Record<Exclude<PayoutRail, "internal">, string> = {
  ach: "2300",
  wire: "1110",
  usdc: "1140",
};

export type ReleaseInput = {
  readonly instructionId: string;
  /** The actor pressing release. The database decides whether they may. */
  readonly actorId: string;
};

export type Released = {
  readonly instructionId: string;
  readonly entryId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
};

/** `payment:release:<instruction id>`. Derived from the fact, never generated. */
export function releaseIdempotencyKey(instructionId: string): string {
  return `payment:release:${instructionId}`;
}

async function contraAccountId(
  payment: QueuedPayment,
  entityId: string,
  conn: Sql,
): Promise<string | null> {
  const { rail, destination } = payment.instruction;
  if (rail === "internal") {
    return destination.type === "internal" ? destination.accountId : null;
  }
  // The house settlement leaf for this rail, by code, scoped to the entity.
  // `SELECT id FROM account WHERE code = …` appeared in six modules; this is
  // the ledger's own filter, so there is one answer to "which account is 2300".
  const account = await findAccount(
    { code: HOUSE_CONTRA_CODE[rail], scope: "house", entityId },
    conn,
  );
  return account?.accountId ?? null;
}

/**
 * Release a payment: post it, then record the release.
 *
 * Returns the entry id whether the posting was new or a replay — callers must
 * treat it as "the entry that represents this release", exactly as
 * `postEntry()` documents.
 */
export async function releasePayment(
  input: ReleaseInput,
  conn: Sql = sql,
): Promise<Result<Released>> {
  const loaded = await getPayment(input.instructionId, conn);
  if (!loaded.ok) return loaded;
  const payment = loaded.value;
  const { instruction } = payment;

  const idempotencyKey = releaseIdempotencyKey(instruction.id);

  try {
    return await conn.begin(async (tx) => {
      // `entity_id` is a column of `account` and a foreign key, not a
      // definition of money — but reading it is still the ledger's to answer.
      const account = await readAccountIdentity(
        instruction.accountId,
        tx as unknown as Sql,
      );
      if (account === null) {
        return fail("NO_SUCH_INSTRUCTION", "The account this payment leaves does not exist.");
      }

      const contraId = await contraAccountId(payment, account.entityId, tx as unknown as Sql);
      if (contraId === null) {
        return fail(
          "INVALID_REQUEST",
          `No settlement account is configured for ${instruction.rail}. The payment was not released and nothing was posted.`,
        );
      }

      const entryId = await postEntry(
        {
          entityId: account.entityId,
          valueDate: instruction.valueDate,
          book: "financial",
          description: `Outbound ${instruction.rail} · ${describeDestination(instruction.destination)}`,
          idempotencyKey,
          actorId: input.actorId,
          rail: instruction.rail,
          externalRef: instruction.idempotencyKey,
          lines: [
            // Debit the customer's deposit liability: we owe them less.
            { accountId: instruction.accountId, amountCents: instruction.amountCents },
            // Credit the settlement account the money left through.
            { accountId: contraId, amountCents: -instruction.amountCents },
          ],
        },
        tx as unknown as Sql,
      );

      // The gate. If this raises, the posting above rolls back with it.
      const rows = await tx<{ id: string }[]>`
        INSERT INTO payment_instruction_event
          (instruction_id, kind, actor_id, value_date, entry_id)
        VALUES
          (${instruction.id}::uuid, 'released', ${input.actorId}::uuid,
           ${instruction.valueDate}::date, ${entryId}::uuid)
        RETURNING id`;

      const row = rows[0];
      if (row === undefined) {
        return fail("UNAVAILABLE", "The release was not recorded. Nothing was posted.");
      }

      // The hold the approval placed comes off, in this transaction, after the
      // `released` event that licenses it. RELEASED IS THE TERMINAL FACT: the
      // financial debit above now exists, so the money is no longer promised,
      // it is gone — which is why this is the one condition that may write the
      // append-only `hold_closure` row (0061 §3, and `./reserve.ts`). If the
      // event insert above had raised, this would never run and the money would
      // still be withheld, which is the safe direction.
      await closeApprovalHold(
        {
          instructionId: instruction.id,
          actorId: input.actorId,
          reason: "released",
          note: `Payment ${instruction.id} released by entry ${entryId}`,
        },
        tx as unknown as Sql,
      );

      return ok({ instructionId: instruction.id, entryId, idempotencyKey, eventId: row.id });
    });
  } catch (thrown) {
    return refuse(thrown);
  }
}
