/**
 * Every read the pots screen makes.
 *
 * There is not a single stored balance among them. A pot's balance comes from
 * `v_pot_balance`, which is `SUM(journal_line)` over the pot's account; the
 * identity's other side comes from `v_pot_subtree`, which walks
 * `account.parent_id` recursively and never looks at the `pot` table at all.
 * Two routes to one number, so the screen can show agreement rather than claim
 * it.
 *
 * The write path lives in `transfer.ts`. This module never posts.
 */

import "server-only";

import type { Sql } from "@/lib/ledger/db";
import { availableBalance } from "@/lib/ledger/balances";
import {
  findEntryByIdempotencyKey,
  listBusinesses,
  readAccountIdentities,
  readAccountIdentity,
} from "@/lib/ledger/queries";

import type { Availability, MoveDirection, PotFigure } from "./model";

/* -------------------------------------------------------------------------- */
/* Businesses                                                                 */
/* -------------------------------------------------------------------------- */

export interface PotBusinessRow {
  readonly businessId: string;
  readonly legalName: string;
  readonly mainAccountId: string;
}

/**
 * Every business with a deposit account, i.e. everyone who can hold a pot.
 *
 * `code = '2100'` exactly — the main leaf, never a pot. Pot accounts are coded
 * `'2100.<uuid>'` and this equality is one of the several in the codebase that
 * they are deliberately invisible to.
 */
export async function listPotBusinesses(
  conn: Sql,
): Promise<readonly PotBusinessRow[]> {
  // `code = '2100'` exactly, financial book, open — which is the LEDGER's
  // definition of a customer's spendable leaf and was written down here a
  // second time. `listBusinesses()` is where it lives; this filter is the only
  // part that belonged to pots.
  return (await listBusinesses(conn))
    .filter((b) => b.depositOpen && b.depositAccountId !== null)
    .map((b) => ({
      businessId: b.businessId,
      legalName: b.legalName,
      mainAccountId: b.depositAccountId as string,
    }));
}

/* -------------------------------------------------------------------------- */
/* Pots                                                                       */
/* -------------------------------------------------------------------------- */

export interface PotRow extends PotFigure {
  readonly businessId: string;
  readonly accountId: string;
  /** `account.code`, shown on the screen so the chart position is legible. */
  readonly accountCode: string;
  readonly purpose: string | null;
  readonly openedAt: Date;
}

export async function listPots(
  businessId: string,
  conn: Sql,
): Promise<readonly PotRow[]> {
  const rows = await conn<
    {
      pot_id: string;
      business_id: string;
      account_id: string;
      name: string;
      purpose: string | null;
      opened_at: Date;
      balance_cents: bigint;
    }[]
  >`
    SELECT pb.pot_id,
           pb.business_id,
           pb.account_id,
           pb.name,
           pb.purpose,
           pb.opened_at,
           pb.balance_cents
      FROM v_pot_balance pb
     WHERE pb.business_id = ${businessId}::uuid
     ORDER BY pb.opened_at`;

  // `account.code` is the one column the join was for, and it is the ledger's
  // column. The view already decides which pots belong to this business.
  const accounts = await readAccountIdentities(
    rows.map((r) => r.account_id),
    conn,
  );

  return rows.map((row) => ({
    potId: row.pot_id,
    businessId: row.business_id,
    accountId: row.account_id,
    accountCode: accounts.get(row.account_id)?.code ?? "",
    name: row.name,
    purpose: row.purpose,
    openedAt: row.opened_at,
    balanceCents: row.balance_cents,
  }));
}

/** One pot, with the account ids a transfer needs. `null` for an unknown id. */
export interface PotTarget {
  readonly potId: string;
  readonly businessId: string;
  readonly name: string;
  readonly potAccountId: string;
  readonly mainAccountId: string;
  readonly entityId: string;
  readonly balanceCents: bigint;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Resolve a pot to the two accounts its transfer will hit.
 *
 * The main account is reached through `account.parent_id`, not through a second
 * lookup by `(code, business_id)`: the pot's parent IS the main leaf by
 * construction — `v_pot_orphan` fires if it ever is not — so following the tree
 * is both cheaper and impossible to get wrong for the wrong customer.
 *
 * A non-uuid id returns `null` rather than reaching Postgres and raising
 * `22P02`. "No such pot" is an answer; a 500 is not.
 */
export async function findPot(
  potId: string,
  conn: Sql,
): Promise<PotTarget | null> {
  if (!isUuid(potId)) return null;

  const rows = await conn<
    {
      pot_id: string;
      business_id: string;
      name: string;
      pot_account_id: string;
      balance_cents: bigint;
    }[]
  >`
    SELECT p.id            AS pot_id,
           p.business_id   AS business_id,
           p.name          AS name,
           p.account_id    AS pot_account_id,
           COALESCE(pb.balance_cents, 0)::bigint AS balance_cents
      FROM pot p
      LEFT JOIN v_pot_balance pb ON pb.pot_id = p.id
     WHERE p.id = ${potId}::uuid`;

  const row = rows[0];
  if (row === undefined) return null;

  // The main leaf is the pot account's PARENT, followed through the chart
  // rather than looked up a second time by `(code, business_id)`: the pot's
  // parent IS the main leaf by construction (`v_pot_orphan` fires if it ever
  // is not), so the tree cannot point at the wrong customer. Walking it is the
  // ledger's job — `parentAccountId` is a column of `account`.
  const potAccount = await readAccountIdentity(row.pot_account_id, conn);
  const parentId = potAccount?.parentAccountId ?? null;
  const main = parentId === null ? null : await readAccountIdentity(parentId, conn);
  // Both joins were INNER: a pot whose account or whose parent has gone is not
  // a row, and must not become a half-resolved transfer target.
  if (main === null) return null;
  return {
    potId: row.pot_id,
    businessId: row.business_id,
    name: row.name,
    potAccountId: row.pot_account_id,
    mainAccountId: main.accountId,
    entityId: main.entityId,
    balanceCents: row.balance_cents,
  };
}

/* -------------------------------------------------------------------------- */
/* The identity                                                               */
/* -------------------------------------------------------------------------- */

export interface IdentityRow {
  readonly mainCents: bigint;
  readonly potsCents: bigint;
  readonly totalCents: bigint;
  readonly subtreeCents: bigint;
}

export async function readIdentity(
  businessId: string,
  conn: Sql,
): Promise<IdentityRow | null> {
  const rows = await conn<
    {
      main_cents: bigint;
      pots_cents: bigint;
      total_cents: bigint;
      subtree_cents: bigint;
    }[]
  >`
    SELECT i.main_cents,
           i.pots_cents,
           i.total_cents,
           s.subtree_cents
      FROM v_pot_identity i
      JOIN v_pot_subtree  s ON s.main_account_id = i.main_account_id
     WHERE i.business_id = ${businessId}::uuid`;

  const row = rows[0];
  return row === undefined
    ? null
    : {
        mainCents: row.main_cents,
        potsCents: row.pots_cents,
        totalCents: row.total_cents,
        subtreeCents: row.subtree_cents,
      };
}

/** `availableBalance()` verbatim — the main leaf only, pots excluded. */
export async function readAvailability(
  businessId: string,
  conn: Sql,
): Promise<Availability> {
  return availableBalance(businessId, conn);
}

/* -------------------------------------------------------------------------- */
/* The movements                                                              */
/* -------------------------------------------------------------------------- */

export interface MovementRow {
  readonly entryId: string;
  readonly valueDate: string;
  readonly bookingSeq: bigint;
  readonly bookingTime: Date;
  readonly entryType: "original" | "reversal" | "rebook";
  readonly description: string;
  readonly idempotencyKey: string;
  readonly rail: string | null;
  readonly externalRef: string | null;
  readonly holdId: string | null;
  readonly inboxId: string | null;
  readonly actorName: string;
  readonly potId: string;
  readonly potName: string;
  /** Signed, as stored. Negative on the pot line means money moved IN. */
  readonly potAmountCents: bigint;
  readonly mainAmountCents: bigint;
  readonly direction: MoveDirection;
}

/**
 * Every internal transfer this business's pots have seen, newest first.
 *
 * There is no `pot_transfer` table to read: an internal transfer IS a journal
 * entry, so this is a query over `journal_entry` and `journal_line` and nothing
 * else. The pot leg is found by joining `pot` on `journal_line.account_id`, and
 * the main leg is "the other line of the same entry" — which is a valid way to
 * find it precisely because `v_internal_transfer_impure` proves every one of
 * these entries has exactly two lines.
 *
 * `rail`, `external_ref`, `hold_id` and `inbox_id` are selected although they
 * are always `'internal'`, `NULL`, `NULL`, `NULL` here. The screen prints them
 * for that reason: the claim is that no rail was touched, and the way to show
 * it is the four columns that would carry a rail if one had been.
 */
export async function listMovements(
  businessId: string,
  limit: number,
  conn: Sql,
): Promise<readonly MovementRow[]> {
  const rows = await conn<
    {
      entry_id: string;
      value_date: string;
      booking_seq: bigint;
      booking_time: Date;
      entry_type: "original" | "reversal" | "rebook";
      description: string;
      idempotency_key: string;
      rail: string | null;
      external_ref: string | null;
      hold_id: string | null;
      inbox_id: string | null;
      actor_name: string;
      pot_id: string;
      pot_name: string;
      pot_amount_cents: bigint;
      main_amount_cents: bigint;
    }[]
  >`
    SELECT e.id                              AS entry_id,
           to_char(e.value_date,'YYYY-MM-DD') AS value_date,
           e.booking_seq,
           e.booking_time,
           e.entry_type,
           e.description,
           e.idempotency_key,
           e.rail::text                      AS rail,
           e.external_ref,
           e.hold_id::text                   AS hold_id,
           e.inbox_id::text                  AS inbox_id,
           act.display_name                  AS actor_name,
           p.id                              AS pot_id,
           p.name                            AS pot_name,
           lp.amount_cents                   AS pot_amount_cents,
           lm.amount_cents                   AS main_amount_cents
      FROM journal_entry e
      JOIN actor        act ON act.id = e.actor_id
      JOIN journal_line lp  ON lp.entry_id = e.id
      JOIN pot          p   ON p.account_id = lp.account_id
      JOIN journal_line lm  ON lm.entry_id = e.id
                           AND lm.account_id <> lp.account_id
     WHERE e.rail = 'internal'
       AND e.idempotency_key LIKE 'pot:%'
       AND p.business_id = ${businessId}::uuid
     ORDER BY e.booking_seq DESC
     LIMIT ${limit}`;

  return rows.map((row) => ({
    entryId: row.entry_id,
    valueDate: row.value_date,
    bookingSeq: row.booking_seq,
    bookingTime: row.booking_time,
    entryType: row.entry_type,
    description: row.description,
    idempotencyKey: row.idempotency_key,
    rail: row.rail,
    externalRef: row.external_ref,
    holdId: row.hold_id,
    inboxId: row.inbox_id,
    actorName: row.actor_name,
    potId: row.pot_id,
    potName: row.pot_name,
    potAmountCents: row.pot_amount_cents,
    mainAmountCents: row.main_amount_cents,
    // A CREDIT to the pot (negative, credit-normal liability going up) is
    // money arriving in it. There is no direction column and there does not
    // need to be one: the sign on the line is the direction.
    direction: row.pot_amount_cents < 0n ? "in" : "out",
  }));
}

/* -------------------------------------------------------------------------- */
/* The invariants, live                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The invariant views this feature is responsible for, plus the one it was most
 * likely to break.
 *
 * Read at request time and rendered on the screen with their row counts. Every
 * one must be zero; a non-zero count is a bug to fix and never a number for
 * anything in production to repair.
 */
export const POT_INVARIANT_VIEWS = [
  "v_deposit_control_drift",
  "v_pot_identity_drift",
  "v_pot_negative",
  "v_pot_orphan",
  "v_internal_transfer_impure",
  "v_pot_line_provenance",
  "v_pot_guard_disarmed",
  "v_entry_unbalanced",
  "v_book_not_zero",
] as const;

export type PotInvariantView = (typeof POT_INVARIANT_VIEWS)[number];

export interface InvariantResult {
  readonly view: PotInvariantView;
  readonly rows: number;
}

export async function readInvariants(
  conn: Sql,
): Promise<readonly InvariantResult[]> {
  const out: InvariantResult[] = [];
  for (const view of POT_INVARIANT_VIEWS) {
    // The view names are a frozen literal union, not input. `unsafe` is
    // reached for because an identifier cannot be a bind parameter, and the
    // only strings that get here are the seven above.
    const rows = await conn.unsafe(`SELECT 1 FROM ${view} LIMIT 50`);
    out.push({ view, rows: rows.length });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Replay                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The entry already written under this idempotency key, if there is one.
 *
 * `postEntry()` returns the original id on replay and writes nothing, but it
 * cannot tell the caller which of the two happened — by design, since there is
 * no way to distinguish them and no reason to want to. So the write path asks
 * this first, inside the same transaction and behind the same lock, and the
 * receipt can then say "already posted" and point at the entry rather than
 * implying a second one was created.
 */
export async function findEntryByKey(
  idempotencyKey: string,
  conn: Sql,
): Promise<{ entryId: string; bookingSeq: bigint; valueDate: string } | null> {
  return findEntryByIdempotencyKey(idempotencyKey, conn);
}

/** The system actor every posting on this path is attributed to. */
export async function ledgerPosterActorId(conn: Sql): Promise<string> {
  const rows = await conn<{ id: string }[]>`
    SELECT id FROM actor WHERE kind = 'system' AND display_name = 'ledger-poster' LIMIT 1`;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no 'ledger-poster' system actor; run scripts/seed.mjs");
  }
  return row.id;
}

/** Today in book time — the Fed/ACH day, from the database's own `book_date()`. */
export async function bookDate(conn: Sql): Promise<string> {
  const rows = await conn<{ d: string }[]>`
    SELECT to_char(book_date(now()),'YYYY-MM-DD') AS d`;
  const row = rows[0];
  if (row === undefined) throw new Error("book_date query returned no row");
  return row.d;
}
