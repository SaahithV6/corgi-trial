/**
 * list_transactions — postings against this business's accounts, with
 * value_date and booking_date as separate, separately filterable columns.
 *
 * WHY BOTH DATES ARE ALWAYS PRESENT AND NEVER MERGED. `value_date` is when it
 * happened; `booking_date` is when we learned. A Thursday reversal of a
 * Tuesday settlement carries value_date Tuesday and booking_date Thursday, and
 * collapsing them — which every "date" field in a naive API does — makes the
 * system unable to answer either of the two questions people actually ask.
 * Show it under Thursday and Tuesday's statement is wrong forever. Show it
 * under Tuesday with no second date and you have quietly claimed you knew on
 * Tuesday, which is what a regulator asks about.
 *
 * So the filters come in pairs, and an agent can ask "everything that happened
 * in August" (value date) and "everything we found out about in September"
 * (booking date) as different questions, because they are.
 *
 * SIGN CONVENTION. Amounts are returned from the ACCOUNT's point of view:
 * positive is money into that account. The journal stores debit-positive and
 * the deposit account is a liability of the bank, so the raw line for a
 * customer receiving $50 is -5000. Handing that to an agent unmodified is how
 * you get a support message telling a customer their deposit was a debit. The
 * gateway multiplies by `normal_side` once, in SQL, and never branches again.
 */

import { z } from "zod";

import {
  MONEY_SCHEMA,
  accountCodeString,
  isoDateString,
  money,
  parseArgs,
} from "./validate";
import { ToolError, type JsonSchemaObject, type ToolContext, type ToolDefinition, type ToolOutcome } from "./types";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const argsSchema = z.strictObject({
  account_code: accountCodeString.optional(),
  value_date_from: isoDateString.optional(),
  value_date_to: isoDateString.optional(),
  booking_date_from: isoDateString.optional(),
  booking_date_to: isoDateString.optional(),
  rail: z.enum(["card", "ach", "usdc", "wire", "internal"]).optional(),
  book: z.enum(["financial", "memo"]).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  cursor: z.string().regex(/^[0-9]{1,19}$/).optional(),
});

type Args = z.infer<typeof argsSchema>;

const inputSchema: JsonSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    account_code: {
      type: "string",
      pattern: "^[0-9]{4}$",
      description:
        "Restrict to one chart code within this business, e.g. \"2100\". Omit for every account this business owns.",
    },
    value_date_from: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "Inclusive lower bound on WHEN IT HAPPENED (book time).",
    },
    value_date_to: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "Inclusive upper bound on WHEN IT HAPPENED (book time).",
    },
    booking_date_from: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "Inclusive lower bound on WHEN WE LEARNED IT. Independent of value date.",
    },
    booking_date_to: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "Inclusive upper bound on WHEN WE LEARNED IT.",
    },
    rail: {
      type: "string",
      enum: ["card", "ach", "usdc", "wire", "internal"],
      description: "Restrict to one payment rail.",
    },
    book: {
      type: "string",
      enum: ["financial", "memo"],
      description:
        "financial is real money. memo is the hold book — authorisations and uncleared credits, which never touch the financial position. Omit for both.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Rows per page, 1-${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}.`,
    },
    cursor: {
      type: "string",
      description:
        "Opaque page cursor from next_cursor of a previous call. Pages walk backwards through booking order (newest first).",
    },
  },
  required: [],
  additionalProperties: false,
};

const outputSchema: JsonSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    business: {
      type: "object",
      properties: { id: { type: "string" }, legal_name: { type: "string" } },
      required: ["id", "legal_name"],
      additionalProperties: false,
    },
    transactions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          entry_id: { type: "string" },
          account_code: { type: "string" },
          account_name: { type: "string" },
          value_date: { type: "string", description: "WHEN IT HAPPENED, book time." },
          booking_date: { type: "string", description: "WHEN WE LEARNED IT, book time." },
          booking_time: { type: "string", description: "The same instant, to the second, UTC." },
          booking_seq: {
            type: "string",
            description: "Total order of learning. Feed to get_balance as a watermark.",
          },
          entry_type: { type: "string", enum: ["original", "reversal", "rebook"] },
          book: { type: "string", enum: ["financial", "memo"] },
          amount: MONEY_SCHEMA,
          currency: { type: "string" },
          description: { type: "string" },
          memo: { type: ["string", "null"] },
          rail: { type: ["string", "null"] },
          external_ref: { type: ["string", "null"] },
          reverses_entry_id: { type: ["string", "null"] },
          correction_group_id: {
            type: ["string", "null"],
            description: "Ties an original, its reversal and its rebook together.",
          },
          backdated_by_days: {
            type: "integer",
            description:
              "booking_date minus value_date. Zero on a same-day posting; positive on anything learned late, which is where corrections hide.",
          },
        },
        required: [
          "entry_id",
          "account_code",
          "account_name",
          "value_date",
          "booking_date",
          "booking_time",
          "booking_seq",
          "entry_type",
          "book",
          "amount",
          "currency",
          "description",
          "memo",
          "rail",
          "external_ref",
          "reverses_entry_id",
          "correction_group_id",
          "backdated_by_days",
        ],
        additionalProperties: false,
      },
    },
    next_cursor: { type: ["string", "null"] },
    filters_applied: { type: "object", additionalProperties: true, properties: {} },
    note: { type: "string" },
  },
  required: ["business", "transactions", "next_cursor", "filters_applied", "note"],
  additionalProperties: false,
};

async function run(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  if (
    args.value_date_from !== undefined &&
    args.value_date_to !== undefined &&
    args.value_date_from > args.value_date_to
  ) {
    throw new ToolError(
      "INVALID_ARGUMENTS",
      `value_date_from ${args.value_date_from} is after value_date_to ${args.value_date_to}`,
    );
  }
  if (
    args.booking_date_from !== undefined &&
    args.booking_date_to !== undefined &&
    args.booking_date_from > args.booking_date_to
  ) {
    throw new ToolError(
      "INVALID_ARGUMENTS",
      `booking_date_from ${args.booking_date_from} is after booking_date_to ${args.booking_date_to}`,
    );
  }

  if (args.account_code !== undefined) {
    // Resolved through the grant's business, so an account code that belongs
    // to a different tenant simply does not exist from here.
    const account = await ctx.gateway.findAccount(ctx.grant.businessId, args.account_code);
    if (account === null) {
      throw new ToolError(
        "ACCOUNT_NOT_FOUND",
        `${ctx.grant.businessLegalName} has no open account with code ${args.account_code}`,
        { account_code: args.account_code },
      );
    }
  }

  const limit = args.limit ?? DEFAULT_LIMIT;

  const page = await ctx.gateway.listTransactions(ctx.grant.businessId, {
    accountCode: args.account_code ?? null,
    valueDateFrom: args.value_date_from ?? null,
    valueDateTo: args.value_date_to ?? null,
    bookingDateFrom: args.booking_date_from ?? null,
    bookingDateTo: args.booking_date_to ?? null,
    rail: args.rail ?? null,
    book: args.book ?? null,
    limit,
    cursorBookingSeqBelow: args.cursor === undefined ? null : BigInt(args.cursor),
  });

  const transactions = page.rows.map((row) => ({
    entry_id: row.entryId,
    account_code: row.accountCode,
    account_name: row.accountName,
    value_date: row.valueDate,
    booking_date: row.bookingDate,
    booking_time: row.bookingTime,
    booking_seq: row.bookingSeq.toString(),
    entry_type: row.entryType,
    book: row.book,
    amount: money(row.amountCents),
    currency: row.currency,
    description: row.description,
    memo: row.memo,
    rail: row.rail,
    external_ref: row.externalRef,
    reverses_entry_id: row.reversesEntryId,
    correction_group_id: row.correctionGroupId,
    backdated_by_days: dayGap(row.valueDate, row.bookingDate),
  }));

  const backdated = transactions.filter((t) => t.backdated_by_days > 0).length;

  const data = {
    business: { id: ctx.grant.businessId, legal_name: ctx.grant.businessLegalName },
    transactions,
    next_cursor: page.nextCursor,
    filters_applied: {
      account_code: args.account_code ?? null,
      value_date_from: args.value_date_from ?? null,
      value_date_to: args.value_date_to ?? null,
      booking_date_from: args.booking_date_from ?? null,
      booking_date_to: args.booking_date_to ?? null,
      rail: args.rail ?? null,
      book: args.book ?? null,
      limit,
    },
    note:
      "value_date is when the money moved in business terms; booking_date is when this system learned of it. They differ on every correction and on every late-arriving settlement. Amounts are signed from the account's point of view: positive is money in.",
  };

  const summary =
    `${transactions.length} posting(s) for ${ctx.grant.businessLegalName}` +
    (args.account_code === undefined ? "" : ` on account ${args.account_code}`) +
    (backdated === 0
      ? "."
      : `, of which ${backdated} were booked after their value date (corrections or late settlements).`) +
    (page.nextCursor === null ? "" : " More pages are available; pass next_cursor.");

  return { summary, data };
}

function dayGap(valueDate: string, bookingDate: string): number {
  const a = Date.parse(`${valueDate}T00:00:00Z`);
  const b = Date.parse(`${bookingDate}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

export const listTransactionsTool: ToolDefinition = {
  name: "list_transactions",
  title: "List transactions",
  description:
    "Journal postings against this business's accounts, newest first, with value_date (when it happened) and booking_date (when we learned it) as separate columns and separate filters. Filter by account code, either date axis, rail and book; page with an opaque cursor. Read-only; scoped to the single business this token belongs to.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "List transactions",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  readOnly: true,
  parse: (args) => parseArgs(argsSchema, args),
  run: run as ToolDefinition["run"],
};
