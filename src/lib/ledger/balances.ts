/**
 * Thin aliases over `balance-definitions.ts`. NOTHING IS DEFINED HERE.
 *
 * This file used to hold a second, third and fourth answer to "what is the
 * balance". It now holds the default connection and a name for each question,
 * and every name says which of the three questions it asks:
 *
 *   ledgerBalanceAsOf   -> Q1, with the watermark left open
 *   balanceAsBelieved   -> Q3, what we believed at a past watermark
 *   bookingWatermarkAt  -> the watermark Q3 needs
 *   availableBalance    -> Q2, reached by business id
 *   trialBalanceCents   -> the whole financial book, which must be zero
 *
 * The signatures are unchanged on purpose. `src/lib/mcp/**`, `src/lib/cards/**`
 * and `src/lib/rails/**` are owned by other workers on this build and call
 * every one of these; changing a name would have meant editing files that are
 * not this worker's to edit. The BEHAVIOUR changed, deliberately, and every
 * figure that moved is named in `docs/BALANCE-DEFINITIONS.md`.
 *
 * There is no balance column in this schema. Not on account, not on business,
 * not anywhere — `pnpm db:check` fails the build if one appears.
 */

import "server-only";
import { sql, type Sql } from "./db";
import {
  accountAvailability,
  believedBalanceCents,
  businessAvailability,
  bookingWatermarkAt as bookingWatermarkAtConn,
  historicSnapshot,
  readSnapshot,
  settledBalanceCents,
  trialBalanceCents as trialBalanceCentsConn,
  type Availability,
} from "./balance-definitions";

export type {
  Availability,
  LedgerSnapshot,
} from "./balance-definitions";
export {
  accountAvailability,
  believedBalanceCents,
  businessAvailability,
  houseAccountId,
  mainDepositAccountId,
  readSnapshot,
  settledBalanceCents,
  balanceDefinitionDrift,
} from "./balance-definitions";

export interface Balance {
  readonly accountId: string;
  readonly balanceCents: bigint;
}

/**
 * Q1 with the booking axis left open: "what does the ledger say about this
 * business day, using everything we know NOW".
 *
 * This is the question a CORRECTED statement answers — the reversal booked on
 * Thursday counts towards Tuesday's figure, because Tuesday's value date is
 * what the reversal carries. `balanceAsBelieved` is the other axis.
 *
 * The watermark is read, not assumed infinite, so the two axes are still two
 * arguments to the same body rather than two bodies.
 */
export async function ledgerBalanceAsOf(
  accountId: string,
  asOfValueDate: string,
  conn: Sql = sql,
): Promise<bigint> {
  const snapshot = await readSnapshot(conn);
  return settledBalanceCents(
    accountId,
    historicSnapshot(asOfValueDate, snapshot.bookingWatermark, snapshot.asOf),
    conn,
  );
}

/**
 * Q3. Balance for a business day AS WE BELIEVED IT at a point in transaction
 * time. Two predicates, two axes — the entire bitemporal model.
 */
export async function balanceAsBelieved(
  accountId: string,
  asOfValueDate: string,
  asOfBookingSeq: bigint,
  conn: Sql = sql,
): Promise<bigint> {
  return believedBalanceCents(accountId, asOfValueDate, asOfBookingSeq, conn);
}

/** The booking watermark for a wall-clock instant. What Q3 takes as its axis. */
export async function bookingWatermarkAt(at: Date, conn: Sql = sql): Promise<bigint> {
  return bookingWatermarkAtConn(at, conn);
}

/**
 * Q2, business-scoped. `Availability` with the field names this call site has
 * always used.
 *
 * `pendingOutboundCents` is new and is the largest behaviour change in this
 * commit: see `accountAvailability` for the argument, and
 * `docs/BALANCE-DEFINITIONS.md` for the figures.
 */
export type AvailableBalance = Availability;

export async function availableBalance(
  businessId: string,
  conn: Sql = sql,
): Promise<AvailableBalance> {
  const snapshot = await readSnapshot(conn);
  return businessAvailability(businessId, snapshot, conn);
}

/** Q2, account-scoped, taking its own snapshot. */
export async function availableBalanceForAccount(
  accountId: string,
  conn: Sql = sql,
): Promise<AvailableBalance> {
  const snapshot = await readSnapshot(conn);
  return accountAvailability(accountId, snapshot, conn);
}

/** Trial balance: every line in the financial book must sum to zero. */
export async function trialBalanceCents(conn: Sql = sql): Promise<bigint> {
  return trialBalanceCentsConn(conn);
}
