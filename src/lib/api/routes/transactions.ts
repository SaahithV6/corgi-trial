/**
 * `GET /api/v1/transactions` — the ledger, filtered, newest first.
 *
 * ===========================================================================
 * TWO DATE AXES, AND NEITHER IS "THE DATE"
 * ===========================================================================
 *
 * Every row carries `value_date` (WHEN IT HAPPENED) and `booking_date`/
 * `booking_time` (WHEN WE LEARNED IT), and they are filtered independently:
 *
 *   value_date_*    the business days the activity belongs to
 *   booking_date_*  the days we found out about it
 *
 * An integrator who treats one as "the date" gets a correct-looking answer
 * until a settlement reversal lands three days late, at which point their
 * daily file silently disagrees with the statement. Offering both filters —
 * and naming them the way the ledger names them — is the cheapest way to make
 * the distinction impossible to miss.
 *
 * A CORRECTION IS VISIBLE, NEVER HIDDEN. `entry_type` is `original`,
 * `reversal` or `rebook`; `reverses_entry_id` names what a reversal negates
 * and `correction_group_id` ties the three together. Nothing is edited and
 * nothing disappears, so an integrator reconciling against this feed sees the
 * repair as two more rows rather than as a row that changed underneath them.
 *
 * ===========================================================================
 * THE QUERY IS NOT ASSEMBLED HERE
 * ===========================================================================
 *
 * `gateway.listTransactions` is `listLedgerLines` in `@/lib/ledger/readers` —
 * the ledger's own definition of what a transaction row is, columns, sign
 * convention and all. The MCP surface used to build this WHERE clause itself
 * out of nine optional fragments, and `boundary.test.ts` exists because an
 * agent and a screen disagreeing about a customer's transactions is a failure
 * that happens in front of a customer. A third assembly of the same query, on
 * an HTTP surface with a wider audience, would be the same bug with more
 * witnesses.
 */

import { decodeCursor, encodeCursor, limitParam, money, page, rejectUnknownParams, dateParam, enumParam, stringParam } from "../http";
import type { ApiContext, RouteResult } from "../handle";

const RAILS = ["card", "ach", "usdc", "wire", "internal"] as const;
const BOOKS = ["financial", "memo"] as const;

const ACCEPTED = [
  "account_code",
  "value_date_from",
  "value_date_to",
  "booking_date_from",
  "booking_date_to",
  "rail",
  "book",
  "limit",
  "cursor",
] as const;

export async function listTransactionsRoute(ctx: ApiContext): Promise<RouteResult> {
  rejectUnknownParams(ctx.url, ACCEPTED);

  const limit = limitParam(ctx.url);
  const cursor = decodeCursor(stringParam(ctx.url, "cursor"));

  const result = await ctx.gateway.listTransactions(ctx.grant.businessId, {
    accountCode: stringParam(ctx.url, "account_code"),
    valueDateFrom: dateParam(ctx.url, "value_date_from"),
    valueDateTo: dateParam(ctx.url, "value_date_to"),
    bookingDateFrom: dateParam(ctx.url, "booking_date_from"),
    bookingDateTo: dateParam(ctx.url, "booking_date_to"),
    rail: enumParam(ctx.url, "rail", RAILS),
    book: enumParam(ctx.url, "book", BOOKS),
    limit,
    cursorBookingSeqBelow: cursor,
  });

  const data = result.rows.map((row) => ({
    object: "transaction" as const,
    entry_id: row.entryId,
    account: { code: row.accountCode, name: row.accountName },
    /** WHEN IT HAPPENED, in book time. */
    value_date: row.valueDate,
    /** WHEN WE LEARNED IT. `booking_time` is the instant, to the microsecond. */
    booking_date: row.bookingDate,
    booking_time: row.bookingTime,
    /** The ledger's total order. Also what the opaque cursor is built from. */
    booking_seq: row.bookingSeq.toString(),
    entry_type: row.entryType,
    book: row.book,
    description: row.description,
    rail: row.rail,
    external_ref: row.externalRef,
    /** Signed: positive is money in for the account holder. */
    amount: money(row.amountCents),
    currency: row.currency,
    memo: row.memo,
    reverses_entry_id: row.reversesEntryId,
    correction_group_id: row.correctionGroupId,
  }));

  return {
    status: 200,
    body: {
      ...page(data, limit, result.nextCursor === null ? null : encodeCursor(BigInt(result.nextCursor))),
      request_id: ctx.requestId,
    },
    audit: { rows: data.length },
  };
}
