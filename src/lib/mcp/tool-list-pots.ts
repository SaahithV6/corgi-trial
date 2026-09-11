/**
 * list_pots — the customer's sub-accounts and what is earmarked in each.
 *
 * WHY THIS TOOL EXISTS, AND IT IS NOT "pots shipped, so expose pots".
 *
 * `get_balance` answers about chart code `2100`, the customer's main deposit
 * leaf. A pot is a SEPARATE account, coded `2100.<uuid>` and parented on that
 * leaf, and moving money into one is a pure book transfer: two lines, both
 * inside the customer's own deposit subtree. So the moment a business opens a
 * pot, `get_balance` alone stops being able to answer "how much money do we
 * have" — it answers "how much is in the main leaf", which is a smaller
 * number, and an agent that does not know pots exist will report the smaller
 * number as the whole truth. That is the failure this tool prevents: not a
 * missing feature, a confidently wrong answer.
 *
 * The two numbers are both real and they mean different things:
 *
 *   main available   what can be spent right now without touching a pot
 *   main + Σ pots    every cent of the customer's money on our book
 *
 * Both are returned, named, and the note says which question each answers.
 *
 * THE IDENTITY IS REPORTED, NOT ASSERTED. `main + Σ pots` is computed from
 * `v_pot_identity`; `deposit_subtree` comes from `v_pot_subtree`, which walks
 * `account.parent_id` recursively and never reads the `pot` table. Two routes
 * to one number. They agree because the schema makes them agree
 * (`v_pot_identity_drift` is an invariant view with zero rows), and this tool
 * shows the arithmetic rather than claiming the property — if they ever
 * disagreed, the agent would be told, which is better than the agent quoting
 * one of them.
 *
 * READ ONLY, AND THERE IS NO WRITE SIBLING. Moving money between a pot and the
 * main balance is a ledger posting. It is refused for the same reason
 * `post_entry` is refused — see docs/AGENT-LIMITS.md §8 — with the extra sting
 * that a pot move looks harmless (nothing leaves the bank) right up until the
 * moment an agent empties the payroll pot to make an available-balance check
 * pass.
 */

import { z } from "zod";

import { MONEY_SCHEMA, money, parseArgs } from "./validate";
import { ToolError } from "./types";
import type { JsonSchemaObject, ToolContext, ToolDefinition, ToolOutcome } from "./types";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

/** The main deposit leaf. Pots hang off it; it is never a pot itself. */
const MAIN_CODE = "2100";

const argsSchema = z.strictObject({
  include_empty: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

type Args = z.infer<typeof argsSchema>;

const inputSchema: JsonSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    include_empty: {
      type: "boolean",
      description:
        "Include pots holding exactly zero. Default true: an empty pot is still a standing intention to set money aside, and hiding it makes a pot the customer created look like one that does not exist.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Maximum pots to return, 1-${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}. The totals are computed over ALL pots, never over the page.`,
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
    as_of_book_date: { type: "string", description: "Book-time today, America/New_York." },
    main_account: {
      type: "object",
      description: "Chart code 2100 — the spendable leaf. Pots are separate accounts beneath it.",
      properties: {
        code: { type: "string" },
        name: { type: "string" },
        ledger_balance: MONEY_SCHEMA,
        available_balance: MONEY_SCHEMA,
        card_authorisation_holds: MONEY_SCHEMA,
        operator_holds: {
          allOf: [MONEY_SCHEMA],
          description: "Holds a person placed deliberately. Withheld from available.",
        },
        uncleared_credits: MONEY_SCHEMA,
        pending_outbound: {
          allOf: [MONEY_SCHEMA],
          description:
            "Debits already booked to leave on a future value date. In the ledger balance, not spendable.",
        },
      },
      required: [
        "code",
        "name",
        "ledger_balance",
        "available_balance",
        "card_authorisation_holds",
        "operator_holds",
        "uncleared_credits",
        "pending_outbound",
      ],
      additionalProperties: false,
    },
    pots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pot_id: { type: "string" },
          name: { type: "string" },
          purpose: { type: ["string", "null"] },
          account_code: {
            type: "string",
            description: "`2100.<pot id>` — its position in this business's chart of accounts.",
          },
          opened_at: { type: "string" },
          balance: MONEY_SCHEMA,
          share_percent: {
            type: "integer",
            description:
              "Whole percent of total customer money held in this pot, floored. Integer arithmetic on cents; no float is used to compute it.",
          },
        },
        required: [
          "pot_id",
          "name",
          "purpose",
          "account_code",
          "opened_at",
          "balance",
          "share_percent",
        ],
        additionalProperties: false,
      },
    },
    totals: {
      type: "object",
      properties: {
        pot_count: { type: "integer" },
        pots_total: { allOf: [MONEY_SCHEMA], description: "Σ of every pot, page or no page." },
        main_plus_pots: {
          allOf: [MONEY_SCHEMA],
          description: "Every cent of this customer's money on our book.",
        },
        deposit_subtree: {
          allOf: [MONEY_SCHEMA],
          description:
            "The same figure reached the other way, by walking account.parent_id from the main leaf. Independent of the pot table.",
        },
        identity_holds: {
          type: "boolean",
          description: "main + Σ pots == deposit subtree. Must be true; reported, not assumed.",
        },
        identity_difference: {
          allOf: [MONEY_SCHEMA],
          description: "main_plus_pots − deposit_subtree. Zero on a healthy book.",
        },
      },
      required: [
        "pot_count",
        "pots_total",
        "main_plus_pots",
        "deposit_subtree",
        "identity_holds",
        "identity_difference",
      ],
      additionalProperties: false,
    },
    truncated: {
      type: "boolean",
      description: "True when more pots exist than the limit returned.",
    },
    note: { type: "string" },
  },
  required: ["business", "as_of_book_date", "main_account", "pots", "totals", "truncated", "note"],
  additionalProperties: false,
};

async function run(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const limit = args.limit ?? DEFAULT_LIMIT;
  const includeEmpty = args.include_empty ?? true;

  const account = await ctx.gateway.findAccount(ctx.grant.businessId, MAIN_CODE);
  if (account === null) {
    throw new ToolError(
      "ACCOUNT_NOT_FOUND",
      `${ctx.grant.businessLegalName} has no open account with chart code ${MAIN_CODE}, so it can hold no pots.`,
    );
  }

  const [balance, snapshot] = await Promise.all([
    ctx.gateway.balanceNow(ctx.grant.businessId, account.accountId),
    ctx.gateway.listPots(ctx.grant.businessId),
  ]);

  const visible = snapshot.pots.filter((pot) => includeEmpty || pot.balanceCents !== 0n);
  const page = visible.slice(0, limit);

  // Integer percent on bigint, floored. `(balance * 100) / total` and not
  // `Number(balance) / Number(total)`: this file is cents end to end and a
  // float here would be the one place the discipline was dropped for a
  // decoration.
  const total = snapshot.totalCents;
  const pots = page.map((pot) => ({
    pot_id: pot.potId,
    name: pot.name,
    purpose: pot.purpose,
    account_code: pot.accountCode,
    opened_at: pot.openedAt,
    balance: money(pot.balanceCents),
    share_percent: total === 0n ? 0 : Number((pot.balanceCents * 100n) / total),
  }));

  const difference = snapshot.totalCents - snapshot.subtreeCents;

  const data = {
    business: { id: ctx.grant.businessId, legal_name: ctx.grant.businessLegalName },
    as_of_book_date: ctx.bookToday,
    main_account: {
      code: account.code,
      name: account.name,
      ledger_balance: money(balance.ledgerCents),
      available_balance: money(balance.availableCents),
      card_authorisation_holds: money(balance.cardAuthHoldsCents),
      operator_holds: money(balance.otherHoldsCents),
      uncleared_credits: money(balance.unclearedCents),
      pending_outbound: money(balance.pendingOutboundCents),
    },
    pots,
    totals: {
      pot_count: snapshot.pots.length,
      pots_total: money(snapshot.potsCents),
      main_plus_pots: money(snapshot.totalCents),
      deposit_subtree: money(snapshot.subtreeCents),
      identity_holds: difference === 0n,
      identity_difference: money(difference),
    },
    truncated: visible.length > page.length,
    note:
      "A pot is a separate account beneath the customer's 2100 deposit leaf, and money in one is NOT part of the main available balance that get_balance reports. Quote main available for \"what can we spend now\" and main_plus_pots for \"how much money do we have\". Moving money between a pot and the main balance is a ledger posting and is not available to this surface: an agent cannot fund, empty, open or close a pot.",
  };

  const potsList =
    pots.length === 0
      ? "no pots"
      : pots.map((p) => `${p.name} ${p.balance.display}`).join(", ");

  const summary =
    `${ctx.grant.businessLegalName} holds ${money(snapshot.totalCents).display} in total: ` +
    `${money(snapshot.mainCents).display} in the main balance (of which ${money(balance.availableCents).display} is available to spend after holds and uncleared credits) ` +
    `and ${money(snapshot.potsCents).display} earmarked across ${snapshot.pots.length} pot(s) — ${potsList}. ` +
    `Pot money is not part of the main available balance. ` +
    (difference === 0n
      ? "main + pots reconciles exactly with a recursive walk of the deposit subtree."
      : `WARNING: main + pots is ${money(difference).display} away from the deposit subtree total; the books disagree with themselves and a person should look.`);

  return { summary, data };
}

export const listPotsTool: ToolDefinition = {
  name: "list_pots",
  title: "List pots and their balances",
  description:
    "The customer's pots (sub-accounts of their deposit account) with each balance, alongside the main balance and its available figure. Use this whenever the question is how much money the business has in total, because get_balance answers only about the main leaf and money earmarked in a pot is not in it. Also returns the identity check — main + pots against a recursive walk of the deposit subtree. Read-only and scoped to the single business this token belongs to; it cannot open, close, fund or empty a pot.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "List pots and their balances",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  readOnly: true,
  parse: (args) => parseArgs(argsSchema, args),
  run: run as ToolDefinition["run"],
};
