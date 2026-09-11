/**
 * WHOSE MONEY IS THIS? — the lookup, and the one table that can answer it.
 *
 * ─── THE GAP THIS CLOSES ────────────────────────────────────────────────────
 *
 * An inbound ACH credit and an inbound wire both name a destination ACCOUNT
 * NUMBER, never a customer. Until 2026-09-11 this programme had exactly one:
 *
 *     GET /account_numbers -> ONE object
 *       sandbox_account_number_96mzhz3n61f5p0jpvytc
 *       account_number 7467448488  routing_number 123308582  name "primary"
 *       on the programme's own FBO account sandbox_account_zkfx1wcn4brwoaiyksj6
 *
 * — shared by every business on the book. So the field that is supposed to say
 * whose money it is said "the programme's", every inbound credit parked as
 * unattributable, and `docs/GAUNTLET.md` item 5 was half an item: a real
 * outbound return on the book and an inbound recall that could never happen,
 * because there was never a credit to recall.
 *
 * `POST /account_numbers` issues a second, third, Nth number on the SAME
 * account, each with its own digits and its own id, and an inbound payment
 * addressed to one arrives naming THAT id. `scripts/provision-account-numbers.mjs`
 * issues one per business; `db/migrations/0042_virtual_account_numbers.sql`
 * records whose it is; this file reads it back.
 *
 * ─── WHY THIS IS A LOOKUP AND NEVER A DERIVATION ────────────────────────────
 *
 * There is no rule that turns an account number into a business. Not a prefix,
 * not a checksum, not the order they were issued in. The digits are allocated
 * by the provider out of a pool it does not describe, so any code that appeared
 * to derive an owner would be a heuristic — and a heuristic about whose money
 * this is mis-attributes somebody's deposit the first time the provider changes
 * how it allocates. It is a FACT, stored once by the operator action that
 * created the number, and read for ever after.
 *
 * ─── AND WHY A MISS IS A REFUSAL, NOT A FALLBACK ────────────────────────────
 *
 * `findVirtualAccountNumber()` returns null for a number nobody has mapped, and
 * every caller must PARK on null. There is deliberately no "default account",
 * no "the only business on the book", and no "the one this originator paid last
 * time". The value of this build's parking behaviour is precisely that it
 * refuses to guess, and an attribution path with a fallback would destroy it
 * while making every screen look better. The programme's own `primary` number
 * is mapped to nobody ON PURPOSE: the five historical inbound ACH deliveries
 * and twenty-three inbound wires that named it were addressed to the programme,
 * and the honest answer for them is still "an operator must attribute this".
 */

import "server-only";

import type { Sql } from "@/lib/ledger/db";

/** The Increase slug used in `virtual_account_number.provider`. */
export const VIRTUAL_ACCOUNT_NUMBER_PROVIDER = "increase";

/**
 * One number, and whose it is.
 *
 * Note what is NOT here: an account id of ours. `business_id` is the fact;
 * which leaf of the chart a credit lands on is the ledger's question, answered
 * by `mainDepositAccountId()` — the one reader that knows a pot sub-account
 * (`2100.<uuid>`) is not the spendable leaf. A second copy of that answer in
 * this table would be a second opinion about where money goes.
 */
export interface VirtualAccountNumber {
  readonly provider: string;
  readonly providerAccountNumberId: string;
  readonly providerAccountId: string;
  readonly routingNumber: string;
  readonly accountNumber: string;
  readonly businessId: string;
  readonly legalName: string;
  readonly name: string;
  readonly recordedAt: Date;
}

interface Row {
  readonly provider: string;
  readonly provider_account_number_id: string;
  readonly provider_account_id: string;
  readonly routing_number: string;
  readonly account_number: string;
  readonly business_id: string;
  readonly legal_name: string;
  readonly name: string;
  readonly recorded_at: Date;
}

function toVirtualAccountNumber(row: Row): VirtualAccountNumber {
  return {
    provider: row.provider,
    providerAccountNumberId: row.provider_account_number_id,
    providerAccountId: row.provider_account_id,
    routingNumber: row.routing_number,
    accountNumber: row.account_number,
    businessId: row.business_id,
    legalName: row.legal_name,
    name: row.name,
    recordedAt: row.recorded_at,
  };
}

/**
 * The business that owns this provider account number, or null.
 *
 * Null is an ANSWER, not an error: it means nobody has ever said whose this
 * number is, which is exactly true of the programme's own FBO number and of any
 * number issued at the provider without being recorded here. The caller parks.
 */
export async function findVirtualAccountNumber(
  providerAccountNumberId: string | null | undefined,
  conn: Sql,
  provider: string = VIRTUAL_ACCOUNT_NUMBER_PROVIDER,
): Promise<VirtualAccountNumber | null> {
  // An inbound object with no `account_number_id` at all is not a miss to be
  // looked up — there is nothing to look up — and asking the database with an
  // empty string would be a query whose answer we already know.
  if (providerAccountNumberId === null || providerAccountNumberId === undefined) return null;
  if (providerAccountNumberId.length === 0) return null;

  const [row] = await conn<Row[]>`
    SELECT v.provider,
           v.provider_account_number_id,
           v.provider_account_id,
           v.routing_number,
           v.account_number,
           v.business_id::text AS business_id,
           v.name,
           v.recorded_at,
           b.legal_name
      FROM virtual_account_number v
      JOIN business b ON b.id = v.business_id
     WHERE v.provider = ${provider}
       AND v.provider_account_number_id = ${providerAccountNumberId}
     LIMIT 1`;

  return row === undefined ? null : toVirtualAccountNumber(row);
}

/** Every mapped number, for an operator screen and for a refusal that counts. */
export async function listVirtualAccountNumbers(
  conn: Sql,
  provider: string = VIRTUAL_ACCOUNT_NUMBER_PROVIDER,
): Promise<readonly VirtualAccountNumber[]> {
  const rows = await conn<Row[]>`
    SELECT v.provider,
           v.provider_account_number_id,
           v.provider_account_id,
           v.routing_number,
           v.account_number,
           v.business_id::text AS business_id,
           v.name,
           v.recorded_at,
           b.legal_name
      FROM virtual_account_number v
      JOIN business b ON b.id = v.business_id
     WHERE v.provider = ${provider}
     ORDER BY b.legal_name`;
  return rows.map(toVirtualAccountNumber);
}

/**
 * How many numbers are mapped — for the refusal message, and only for that.
 *
 * A park that says "no mapping for X" leaves an operator wondering whether the
 * table is empty or whether this one number is genuinely a stranger. "no
 * mapping for X; 7 numbers are mapped" answers it in the same sentence, and
 * costs one count.
 */
export async function countVirtualAccountNumbers(
  conn: Sql,
  provider: string = VIRTUAL_ACCOUNT_NUMBER_PROVIDER,
): Promise<number> {
  const [row] = await conn<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM virtual_account_number
     WHERE provider = ${provider}`;
  return row?.n ?? 0;
}
