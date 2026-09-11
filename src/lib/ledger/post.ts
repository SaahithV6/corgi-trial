/**
 * The posting API. Every money write in the system goes through here, and
 * here goes through exactly one SQL function: ledger_append().
 *
 * Why a thin wrapper rather than SQL in the caller: the guarantees that make
 * this ledger trustworthy — serialised booking_seq, monotonic booking_time,
 * the hash chain, idempotent replay, denormalised clocks on the lines — all
 * live inside that function, holding an advisory lock. A caller that writes
 * its own INSERT gets none of them and the database will not stop it, because
 * corgi_app legitimately holds INSERT. So the discipline is: nothing in this
 * codebase INSERTs into journal_entry or journal_line except ledger_append,
 * and this module is the only thing that calls it.
 */

import "server-only";
import { sql, type Sql } from "./db";

export type Rail = "card" | "ach" | "usdc" | "wire" | "internal";

/** A debit is POSITIVE, a credit is NEGATIVE. One signed column. */
export interface PostingLine {
  readonly accountId: string;
  readonly amountCents: bigint;
  readonly currency?: string;
  readonly memo?: string;
}

export interface PostEntryInput {
  readonly entityId: string;
  /** WHEN IT HAPPENED, in book time (America/New_York). Not when we learned. */
  readonly valueDate: string;
  readonly book: "financial" | "memo";
  readonly entryType?: "original" | "reversal" | "rebook";
  readonly description: string;
  /**
   * Derived from the SOURCE FACT, never from a uuid we generate. If two
   * deliveries of the same provider event produce the same key, the second is
   * a no-op decided by Postgres. Shapes in use:
   *   card:clearing:<provider_event_id>
   *   hold:<hold_id>:after:<provider_event_id>
   *   ach:return:<transfer_id>:<trace_number>
   */
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly lines: readonly PostingLine[];
  readonly rail?: Rail;
  readonly externalRef?: string;
  readonly inboxId?: string;
  readonly holdId?: string;
  readonly reversesEntryId?: string;
  readonly correctionGroupId?: string;
}

export class UnbalancedEntryError extends Error {
  override readonly name = "UnbalancedEntryError";
  constructor(readonly deltaCents: bigint) {
    super(`refusing unbalanced entry: lines sum to ${deltaCents} cents, must be 0`);
  }
}

/**
 * Post one entry. Returns the entry id.
 *
 * Replaying the same idempotencyKey returns the ORIGINAL entry's id and writes
 * nothing. Callers must treat the return value as "the entry that represents
 * this fact", not "the entry I just created" — there is no way to distinguish
 * them and no reason to want to.
 */
export async function postEntry(input: PostEntryInput, conn: Sql = sql): Promise<string> {
  // Fail in TypeScript before the round trip. The database enforces this too,
  // twice (a fail-fast check inside ledger_append and a deferred constraint
  // trigger at commit) — this exists only to produce an error at the call
  // site with the offending number in it.
  const delta = input.lines.reduce((acc, l) => acc + l.amountCents, 0n);
  if (delta !== 0n) throw new UnbalancedEntryError(delta);
  if (input.lines.length === 0) throw new UnbalancedEntryError(0n);
  for (const l of input.lines) {
    if (l.amountCents === 0n) {
      // A zero line is always a bug in an allocation, never a legitimate
      // posting. The schema CHECKs it; catching it here names the account.
      throw new Error(`zero-amount line on account ${l.accountId}: always an allocation bug`);
    }
  }

  // NOTE: passed through the driver's json() helper, not JSON.stringify.
  // Interpolating a stringified array and casting ::jsonb double-encodes it —
  // Postgres receives a jsonb STRING SCALAR, and jsonb_array_elements inside
  // ledger_append fails with "cannot extract elements from a scalar". Found by
  // the integration test on its first run against the real database.
  const linesJson = conn.json(
    input.lines.map((l) => ({
      account_id: l.accountId,
      // bigint does not survive JSON.stringify; send the decimal string and
      // let Postgres cast it. Never Number(l.amountCents).
      amount_cents: l.amountCents.toString(),
      currency: l.currency ?? "USD",
      memo: l.memo ?? null,
    })),
  );

  const rows = await conn<{ ledger_append: string }[]>`
    SELECT ledger_append(
      ${input.entityId}::uuid,
      ${input.valueDate}::date,
      ${input.book}::account_book,
      ${input.entryType ?? "original"}::entry_type,
      ${input.description},
      ${input.idempotencyKey},
      ${input.actorId}::uuid,
      ${linesJson},
      ${input.rail ?? null}::rail,
      ${input.externalRef ?? null},
      ${input.inboxId ?? null}::uuid,
      ${input.holdId ?? null}::uuid,
      ${input.reversesEntryId ?? null}::uuid,
      ${input.correctionGroupId ?? null}::uuid
    ) AS ledger_append`;

  const id = rows[0]?.ledger_append;
  if (!id) throw new Error("ledger_append returned no id — this should be impossible");
  return id;
}

/**
 * Correct a past entry: reverse it at its ORIGINAL value date, then re-book at
 * the correct one. Never an edit.
 *
 * The reversal carries the original's value_date — not today's. That is the
 * whole point: Tuesday's statement must show the corrected position, so the
 * money must move on Tuesday in valid time while being *recorded* on Thursday
 * in transaction time. A reversal booked at today's value date would leave
 * Tuesday wrong forever and silently move the correction into Thursday.
 *
 * Returns both new entry ids and the correction group that ties all three
 * together for the audit trail.
 */
export async function reverseAndRebook(
  args: {
    readonly originalEntryId: string;
    readonly reason: string;
    readonly actorId: string;
    /** The rebook. Omit to reverse only (e.g. an event that never should have posted). */
    readonly rebook?: Omit<PostEntryInput, "entityId" | "actorId" | "correctionGroupId">;
  },
  conn: Sql = sql,
): Promise<{ reversalEntryId: string; rebookEntryId: string | null; correctionGroupId: string }> {
  return conn.begin(async (tx) => {
    const [orig] = await tx<
      {
        id: string;
        entity_id: string;
        value_date: string;
        book: "financial" | "memo";
        correction_group_id: string;
        hold_id: string | null;
        rail: string | null;
        external_ref: string | null;
      }[]
    >`SELECT id, entity_id, value_date::text AS value_date, book,
             correction_group_id, hold_id, rail, external_ref
        FROM journal_entry WHERE id = ${args.originalEntryId}::uuid`;
    if (!orig) throw new Error(`no such entry ${args.originalEntryId}`);

    const lines = await tx<{ account_id: string; amount_cents: bigint; currency: string }[]>`
      SELECT account_id, amount_cents, currency
        FROM journal_line WHERE entry_id = ${args.originalEntryId}::uuid
       ORDER BY ordinal`;

    const reversalEntryId = await postEntry(
      {
        entityId: orig.entity_id,
        // The original's date, deliberately. See the note above.
        valueDate: orig.value_date,
        book: orig.book,
        entryType: "reversal",
        description: `Reversal of ${args.originalEntryId}: ${args.reason}`,
        idempotencyKey: `reversal:${args.originalEntryId}`,
        actorId: args.actorId,
        lines: lines.map((l) => ({
          accountId: l.account_id,
          amountCents: -l.amount_cents,
          currency: l.currency,
        })),
        ...(orig.rail ? { rail: orig.rail as Rail } : {}),
        ...(orig.external_ref ? { externalRef: orig.external_ref } : {}),
        ...(orig.hold_id ? { holdId: orig.hold_id } : {}),
        reversesEntryId: args.originalEntryId,
        correctionGroupId: orig.correction_group_id,
      },
      tx as unknown as Sql,
    );

    let rebookEntryId: string | null = null;
    if (args.rebook) {
      rebookEntryId = await postEntry(
        {
          ...args.rebook,
          entityId: orig.entity_id,
          entryType: "rebook",
          actorId: args.actorId,
          correctionGroupId: orig.correction_group_id,
        },
        tx as unknown as Sql,
      );
    }

    return { reversalEntryId, rebookEntryId, correctionGroupId: orig.correction_group_id };
  });
}
