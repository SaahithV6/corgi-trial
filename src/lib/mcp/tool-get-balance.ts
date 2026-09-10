/**
 * get_balance — ledger balance, available balance, and the difference between
 * them itemised.
 *
 * The difference is the interesting part and it is never a single number here.
 * "Available is $412.60 less than ledger" is not actionable; "two card
 * authorisations totalling $362.60 and one uncleared ACH credit of $50.00" is
 * a customer-service answer. Both subtrahends are SUMs over the memo book at
 * query time — there is no `available_balance` column anywhere in this schema
 * to drift out of agreement with them.
 *
 * The as-of parameters are the bitemporal query, exposed. `as_of_value_date`
 * moves along valid time ("what does the ledger say about Tuesday"), and
 * `as_of_booking_time` moves along transaction time ("what did we BELIEVE on
 * Wednesday"). They are independent, and both are answerable at once, which is
 * the published live-fire question: a merchant reverses Tuesday's settlement on
 * Thursday; show Tuesday's statement now, and prove what you believed on
 * Wednesday. An agent that can only ask the first question will confidently
 * tell a customer that a corrected figure was always there.
 */

import { z } from "zod";

import { bookDate } from "./time";
import {
  MONEY_SCHEMA,
  accountCodeString,
  isoDateString,
  isoInstantString,
  money,
  parseArgs,
} from "./validate";
import { ToolError, type JsonSchemaObject, type ToolContext, type ToolDefinition, type ToolOutcome } from "./types";

const DEFAULT_ACCOUNT_CODE = "2100";

const argsSchema = z.strictObject({
  account_code: accountCodeString.optional(),
  as_of_value_date: isoDateString.optional(),
  as_of_booking_time: isoInstantString.optional(),
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
        "Chart-of-accounts code within THIS business, e.g. \"2100\" for the business current account. Defaults to 2100. Account uuids are not accepted and house accounts are not addressable.",
    },
    as_of_value_date: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description:
        "Valid time. The business day to report, in book time (America/New_York). Omit for the current position including future-dated entries.",
    },
    as_of_booking_time: {
      type: "string",
      description:
        "Transaction time, ISO 8601. Report the balance AS WE BELIEVED IT at this instant, ignoring everything learned afterwards. Use with as_of_value_date to reproduce a statement exactly as it was issued.",
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
    account: {
      type: "object",
      properties: {
        code: { type: "string" },
        name: { type: "string" },
        currency: { type: "string" },
        book: { type: "string", enum: ["financial", "memo"] },
      },
      required: ["code", "name", "currency", "book"],
      additionalProperties: false,
    },
    as_of: {
      type: "object",
      properties: {
        value_date: { type: "string" },
        basis: {
          type: "string",
          enum: ["current", "as_of_value_date", "as_believed"],
          description:
            "current = everything known, all value dates. as_of_value_date = one business day, everything known now. as_believed = one business day, as we believed it at a past instant.",
        },
        booking_time: { type: ["string", "null"] },
        booking_watermark: {
          type: ["string", "null"],
          description: "Highest booking_seq included. Null when no transaction-time cut was applied.",
        },
      },
      required: ["value_date", "basis", "booking_time", "booking_watermark"],
      additionalProperties: false,
    },
    ledger_balance: MONEY_SCHEMA,
    available_balance: MONEY_SCHEMA,
    difference: {
      type: "object",
      properties: {
        total: MONEY_SCHEMA,
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["card_auth_holds", "uncleared_credits"] },
              count: { type: "integer" },
              amount: MONEY_SCHEMA,
              explanation: { type: "string" },
            },
            required: ["kind", "count", "amount", "explanation"],
            additionalProperties: false,
          },
        },
      },
      required: ["total", "items"],
      additionalProperties: false,
    },
    formula: { type: "string" },
  },
  required: [
    "business",
    "account",
    "as_of",
    "ledger_balance",
    "available_balance",
    "difference",
    "formula",
  ],
  additionalProperties: false,
};

async function run(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const code = args.account_code ?? DEFAULT_ACCOUNT_CODE;

  // The business id comes from the grant. There is no argument that could
  // point this lookup at another tenant's chart.
  const account = await ctx.gateway.findAccount(ctx.grant.businessId, code);
  if (account === null) {
    throw new ToolError(
      "ACCOUNT_NOT_FOUND",
      `${ctx.grant.businessLegalName} has no open account with code ${code}`,
      { account_code: code, business: ctx.grant.businessLegalName },
    );
  }

  const bookingTime = args.as_of_booking_time ?? null;
  const watermark =
    bookingTime === null ? null : await ctx.gateway.bookingWatermarkAt(new Date(bookingTime));

  const basis: "current" | "as_of_value_date" | "as_believed" =
    bookingTime !== null
      ? "as_believed"
      : args.as_of_value_date !== undefined
        ? "as_of_value_date"
        : "current";

  // A transaction-time cut with no valid-time cut still needs a value date to
  // report on; book-time today is the only defensible default, and it is named
  // in the response so the caller is never guessing which day it got.
  const valueDate =
    args.as_of_value_date ?? (bookingTime === null ? ctx.bookToday : bookDate(new Date(bookingTime)));

  const snapshot =
    basis === "current"
      ? await ctx.gateway.balanceNow(ctx.grant.businessId, account.accountId)
      : await ctx.gateway.balanceAsOf(
          ctx.grant.businessId,
          account.accountId,
          valueDate,
          watermark,
        );

  const items = [
    {
      kind: "card_auth_holds" as const,
      count: snapshot.cardHoldCount,
      amount: money(-snapshot.holdsCents),
      explanation:
        "Card authorisations that are still open. The merchant has the customer's promise; the money has not left the ledger and cannot be spent twice.",
    },
    {
      kind: "uncleared_credits" as const,
      count: snapshot.unclearedHoldCount,
      amount: money(-snapshot.unclearedCents),
      explanation:
        "Inbound credits booked but not yet released under the funds-availability policy. An ACH credit is returnable for days after it lands.",
    },
  ];

  const data = {
    business: { id: ctx.grant.businessId, legal_name: ctx.grant.businessLegalName },
    account: {
      code: account.code,
      name: account.name,
      currency: account.currency,
      book: account.book,
    },
    as_of: {
      value_date: basis === "current" ? "all" : valueDate,
      basis,
      booking_time: bookingTime,
      booking_watermark: watermark === null ? null : watermark.toString(),
    },
    ledger_balance: money(snapshot.ledgerCents),
    available_balance: money(snapshot.availableCents),
    difference: {
      total: money(snapshot.availableCents - snapshot.ledgerCents),
      items,
    },
    formula:
      "available = ledger - open card authorisation holds - uncleared credits. Every term is a SUM over immutable journal lines at query time; no balance is stored anywhere in this schema.",
  };

  const asOfPhrase =
    basis === "current"
      ? "as of now"
      : basis === "as_of_value_date"
        ? `for value date ${valueDate}`
        : `for value date ${valueDate}, as believed at ${bookingTime} (booking_seq <= ${watermark ?? 0n})`;

  const summary =
    `${ctx.grant.businessLegalName}, account ${account.code} (${account.name}), ${asOfPhrase}: ` +
    `ledger balance ${data.ledger_balance.display}, available ${data.available_balance.display}. ` +
    (snapshot.holdsCents === 0n && snapshot.unclearedCents === 0n
      ? "Nothing is encumbered, so the two agree."
      : `The ${money(snapshot.availableCents - snapshot.ledgerCents).display} difference is ` +
        `${snapshot.cardHoldCount} open card authorisation hold(s) totalling ${money(snapshot.holdsCents).display} ` +
        `and ${snapshot.unclearedHoldCount} uncleared credit(s) totalling ${money(snapshot.unclearedCents).display}.`);

  return { summary, data };
}

export const getBalanceTool: ToolDefinition = {
  name: "get_balance",
  title: "Get balance",
  description:
    "Ledger balance and available balance for one of this business's accounts, with the difference between them itemised into open card authorisation holds and uncleared credits. Supports a bitemporal as-of: as_of_value_date selects the business day, as_of_booking_time reports the balance as we believed it at a past instant. Read-only; scoped to the single business this token belongs to.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Get balance",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  readOnly: true,
  parse: (args) => parseArgs(argsSchema, args),
  run: run as ToolDefinition["run"],
};
