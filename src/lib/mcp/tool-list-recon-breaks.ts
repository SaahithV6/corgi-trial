/**
 * list_recon_breaks — open reconciliation breaks, with age and category.
 *
 * A break is a disagreement between what the network's settlement file says
 * and what our journal says. There are exactly three shapes it can take, and
 * naming them separately is the whole discipline: a single "mismatch" bucket
 * hides which of three very different things went wrong.
 *
 *   in_ledger_not_file  We booked it; the file has never mentioned it. Young,
 *                       this is ordinary timing. Old, it means we recorded a
 *                       settlement that never happened.
 *   amount_mismatch     Same reference, different money. Someone is wrong
 *                       about the amount and it is not always them.
 *   in_file_not_ledger  The network settled something we have no record of.
 *
 * AGE IS THE POINT, not decoration. Every one of these categories is normal at
 * one day old and an incident at ten, and the age is the only field that tells
 * them apart. So breaks come back oldest first and `min_age_days` exists to
 * let an agent ask the escalation question directly.
 *
 * THE SCOPING DECISION WORTH ARGUING WITH. `in_file_not_ledger` breaks are
 * COUNTED for a tenant token but never listed. By definition such a break has
 * no journal line, so it has no account, so it has no owner — attributing it
 * to a business would mean guessing, and a wrong guess hands one customer a
 * row describing another customer's money. The count is reported so that an
 * agent is never told "no breaks" when the truth is "none that are yours",
 * which would let it reassure a customer that the books tie out while an
 * unmatched settlement sits in ops. A house/ops token, scoped differently, is
 * the right place to enumerate them.
 */

import { z } from "zod";

import { BREAK_KINDS, BREAK_KIND_MEANINGS, REASON_CODE_LABELS, SEVERITIES } from "@/lib/recon/types";

import { MONEY_SCHEMA, money, parseArgs } from "./validate";
import type { JsonSchemaObject, ToolContext, ToolDefinition, ToolOutcome } from "./types";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const argsSchema = z.strictObject({
  category: z.enum(BREAK_KINDS).optional(),
  min_age_days: z.number().int().min(0).max(3650).optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  include_explained: z.boolean().optional(),
});

type Args = z.infer<typeof argsSchema>;

const inputSchema: JsonSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    category: {
      type: "string",
      enum: [...BREAK_KINDS],
      description:
        "Restrict to one break category. in_file_not_ledger breaks cannot be attributed to a business and are counted rather than listed for a tenant-scoped token.",
    },
    min_age_days: {
      type: "integer",
      minimum: 0,
      maximum: 3650,
      description:
        "Only breaks at least this many days old, measured from value date in book time. Use 2 or 3 to skip ordinary settlement timing and see the ones that need a human.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Maximum breaks to return, 1-${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}.`,
    },
    include_explained: {
      type: "boolean",
      description:
        "Include breaks the book already answers — a reversal-and-rebook that nets to the file's number, or one a human adjudicated with a note. Default false. They are never hidden from a person; they are excluded here so an agent's default view is the work that is still open.",
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
    as_of_book_date: { type: "string" },
    open_breaks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: { type: "string", enum: [...BREAK_KINDS] },
          category_meaning: { type: "string" },
          reason_code: { type: "string", description: "Why it is a break, within its category." },
          reason: { type: "string" },
          severity: {
            type: "string",
            enum: [...SEVERITIES],
            description:
              "open = its business day has not been closed yet. aged = it survived one day close. stale = two or more. critical = two or more and material, or older than a month. explained = the book already answers it.",
          },
          age_days: { type: "integer" },
          age_bucket: { type: "string" },
          break_key: {
            type: "string",
            description: "Journal entry id, scheme file row id or match id, as text. Joins recon_break_note.",
          },
          external_ref: { type: "string", description: "The network reference both sides key on." },
          value_date: { type: "string" },
          rail: { type: "string" },
          provider: { type: "string" },
          entry_id: { type: ["string", "null"] },
          ledger_amount: { anyOf: [MONEY_SCHEMA, { type: "null" }] },
          file_amount: { anyOf: [MONEY_SCHEMA, { type: "null" }] },
          break_amount: {
            allOf: [MONEY_SCHEMA],
            description: "Signed on the file's axis: how much the file is out by.",
          },
          description: { type: ["string", "null"] },
          explained_by: { type: ["string", "null"] },
        },
        required: [
          "category",
          "category_meaning",
          "reason_code",
          "reason",
          "severity",
          "age_days",
          "age_bucket",
          "break_key",
          "external_ref",
          "value_date",
          "rail",
          "provider",
          "entry_id",
          "ledger_amount",
          "file_amount",
          "break_amount",
          "description",
          "explained_by",
        ],
        additionalProperties: false,
      },
    },
    counts_by_category: { type: "object", additionalProperties: true, properties: {}, description: "How many of each category are in open_breaks." },
    counts_by_severity: { type: "object", additionalProperties: true, properties: {}, description: "How many of each severity are in open_breaks." },
    oldest_age_days: { type: ["integer", "null"], description: "Age of the oldest break returned." },
    total_break_amount: { allOf: [MONEY_SCHEMA], description: "Sum of break_amount across the breaks returned." },
    unattributable_open_breaks: {
      type: "integer",
      description:
        "Open in_file_not_ledger breaks across the platform. Not attributable to any one business, so counted here and never enumerated to a tenant token.",
    },
    note: { type: "string" },
  },
  required: [
    "business",
    "as_of_book_date",
    "open_breaks",
    "counts_by_category",
    "counts_by_severity",
    "oldest_age_days",
    "total_break_amount",
    "unattributable_open_breaks",
    "note",
  ],
  additionalProperties: false,
};

async function run(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const limit = args.limit ?? DEFAULT_LIMIT;

  const page = await ctx.gateway.listReconBreaks(ctx.grant.businessId, {
    category: args.category ?? null,
    minAgeDays: args.min_age_days ?? null,
    includeExplained: args.include_explained ?? false,
    limit,
  });

  const breaks = page.rows.map((row) => ({
    category: row.category,
    category_meaning: BREAK_KIND_MEANINGS[row.category],
    reason_code: row.reasonCode,
    reason: REASON_CODE_LABELS[row.reasonCode],
    severity: row.severity,
    age_days: row.ageDays,
    age_bucket: row.ageBucket,
    break_key: row.breakKey,
    external_ref: row.externalRef,
    value_date: row.valueDate,
    rail: row.rail,
    provider: row.provider,
    entry_id: row.entryId,
    ledger_amount: row.ledgerAmountCents === null ? null : money(row.ledgerAmountCents),
    file_amount: row.fileAmountCents === null ? null : money(row.fileAmountCents),
    break_amount: money(row.breakAmountCents),
    description: row.description,
    explained_by: row.explainedBy,
  }));

  const counts: Record<string, number> = {
    in_ledger_not_file: 0,
    amount_mismatch: 0,
    in_file_not_ledger: 0,
  };
  for (const b of breaks) counts[b.category] = (counts[b.category] ?? 0) + 1;

  const worst = breaks.filter((b) => b.severity === "critical" || b.severity === "stale").length;
  const oldest = breaks[0]?.age_days ?? null;
  const totalOut = breaks.reduce((acc, b) => acc + BigInt(b.break_amount.cents), 0n);

  const data = {
    business: { id: ctx.grant.businessId, legal_name: ctx.grant.businessLegalName },
    as_of_book_date: ctx.bookToday,
    open_breaks: breaks,
    counts_by_category: counts,
    counts_by_severity: countBy(breaks.map((b) => b.severity)),
    oldest_age_days: oldest,
    total_break_amount: money(totalOut),
    unattributable_open_breaks: page.unattributableOpenBreaks,
    note:
      "Categories, reason codes, age buckets and severities come from the reconciliation engine's own view (v_recon_break) and aging rules, not from a second calculation here. Severity is about day closes, not about money: aged means somebody signed off a book day with this break open. This tool reads breaks and cannot adjudicate, resolve or adjust one — that needs a human and a correcting entry.",
  };

  const summary =
    breaks.length === 0
      ? `No open reconciliation breaks attributable to ${ctx.grant.businessLegalName}` +
        (args.min_age_days === undefined ? "" : ` at or above ${args.min_age_days} day(s) old`) +
        `. ${page.unattributableOpenBreaks} unmatched settlement-file row(s) exist platform-wide that cannot be attributed to any business; those sit with ops.`
      : `${breaks.length} open break(s) for ${ctx.grant.businessLegalName}, ${money(totalOut).display} out in total: ` +
        `${counts["in_ledger_not_file"] ?? 0} booked but absent from the settlement file, ` +
        `${counts["amount_mismatch"] ?? 0} matched with an amount disagreement, ` +
        `${counts["in_file_not_ledger"] ?? 0} in the file with no entry. ` +
        `Oldest is ${oldest} day(s)${worst === 0 ? "" : `, and ${worst} have survived two or more book-day closes`}. ` +
        `${page.unattributableOpenBreaks} further unmatched file row(s) cannot be attributed to a business.`;

  return { summary, data };
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

export const listReconBreaksTool: ToolDefinition = {
  name: "list_recon_breaks",
  title: "List reconciliation breaks",
  description:
    "Open reconciliation breaks, oldest first, each with a category (in_ledger_not_file, amount_mismatch, in_file_not_ledger), a reason code, an age in days from its value date and a severity that counts book-day closes survived. Filter by category, minimum age and whether to include already-explained breaks. Read-only and scoped to the single business this token belongs to; it reports breaks and cannot resolve, adjudicate or adjust one.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "List reconciliation breaks",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  readOnly: true,
  parse: (args) => parseArgs(argsSchema, args),
  run: run as ToolDefinition["run"],
};
