/**
 * list_payees — the payee book, with each destination's verification state.
 *
 * THE ARGUMENT FOR PUTTING THIS ON AN AGENT SURFACE.
 *
 * `initiate_payment` takes a destination as arguments: a holder name, a
 * routing number and four digits. An agent composing one from an invoice PDF
 * is composing it from untrusted text, and the single most valuable thing it
 * can do before writing that row is check whether this business has paid this
 * counterparty before and what happened when the destination was last
 * verified. Without this tool the agent has no way to ask, so it types what
 * the invoice said and the first person to notice a changed account number is
 * the approver, working from memory. With it, a mismatch against the book is
 * something the agent can put in the `reason` field where the approver will
 * read it.
 *
 * That is also the honest limit of the tool: it makes the agent a better
 * DRAFTER. It does not make the agent a checker. `gatePaymentOnPayee()` runs
 * inside `requestPayment()`'s transaction and it is the thing that actually
 * refuses a payment; nothing an agent reads here changes that gate, and an
 * agent that reads "verified, fresh" has learned that a person once looked,
 * not that this payment is safe.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *
 *   - No write of any kind. There is no `add_payee` and no `propose_payee`:
 *     the payee book is a CONTROL INPUT, not a queue. A row in it changes what
 *     `gatePaymentOnPayee()` will allow through later, so writing one is
 *     moving the boundary of what needs a human rather than asking a human for
 *     something. See docs/AGENT-LIMITS.md §12.
 *   - No acknowledgement. A `warn` finding clears only when a named person
 *     signs a reason, and that signature is the entire content of the control.
 *     See docs/AGENT-LIMITS.md §11.
 *   - No full account number. The book does not hold one — only the last four
 *     — so this surface cannot leak what it never had.
 *
 * FRESHNESS IS THE COLUMN THAT AGES BADLY. `verified` is a fact about the day
 * the check ran. `freshness` is what turns it into a fact about today, and it
 * is computed by `payee_verification_freshness()` in migration 0016 rather
 * than recomputed here, so this tool and the payee screen cannot come to
 * different conclusions about the same row.
 */

import { z } from "zod";

import { FINDING_CODES, PAYEE_RAILS } from "@/lib/payees/types";

import { parseArgs } from "./validate";
import type { JsonSchemaObject, ToolContext, ToolDefinition, ToolOutcome } from "./types";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const OUTCOMES = ["verified", "warned", "blocked"] as const;
const FRESHNESS = ["fresh", "ageing", "stale", "never"] as const;

const argsSchema = z.strictObject({
  rail: z.enum(PAYEE_RAILS).optional(),
  outcome: z.enum(OUTCOMES).optional(),
  freshness: z.enum(FRESHNESS).optional(),
  holder_name_contains: z.string().min(2).max(200).optional(),
  include_archived: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

type Args = z.infer<typeof argsSchema>;

const inputSchema: JsonSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    rail: {
      type: "string",
      enum: [...PAYEE_RAILS],
      description: "Only payees on this rail. A payee is keyed by rail: the same company on ACH and on wire is two rows, because the details differ and so does what was checked.",
    },
    outcome: {
      type: "string",
      enum: [...OUTCOMES],
      description:
        "Last verification outcome. verified = nothing to answer. warned = a named human must acknowledge before a payment goes. blocked = arithmetic refused it (a failed ABA check digit) and no acknowledgement exists that would let it through.",
    },
    freshness: {
      type: "string",
      enum: [...FRESHNESS],
      description:
        "How old the last check is: fresh (under 30 days), ageing, stale (over 90 days), never. Computed by the database, not here.",
    },
    holder_name_contains: {
      type: "string",
      minLength: 2,
      maxLength: 200,
      description:
        "Case-insensitive substring of the holder name or the display name. Use it to ask whether this business has ever paid a counterparty before composing a destination for initiate_payment.",
    },
    include_archived: {
      type: "boolean",
      description:
        "Include payees somebody archived. Default false. An archived payee is not deleted — nothing here is — and seeing one is how you learn that a destination was retired rather than never used.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Maximum payees to return, 1-${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}. Newest first.`,
    },
  },
  required: [],
  additionalProperties: false,
};

const FINDING_SCHEMA = {
  type: "object",
  properties: {
    code: { type: "string", enum: [...FINDING_CODES] },
    severity: {
      type: "string",
      enum: ["block", "warn", "note"],
      description:
        "block is reserved for arithmetic — a failed routing check digit — and nothing else may carry it.",
    },
    title: { type: "string" },
    detail: { type: "string" },
  },
  required: ["code", "severity", "title", "detail"],
  additionalProperties: false,
} as const;

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
    payees: {
      type: "array",
      items: {
        type: "object",
        properties: {
          payee_id: { type: "string" },
          display_name: { type: "string", description: "What our customer calls them. Never sent to a provider." },
          holder_name: { type: "string", description: "The name that would go on the payment. This is what gets compared." },
          rail: { type: "string", enum: [...PAYEE_RAILS] },
          routing_number: { type: ["string", "null"], description: "Nine digits, ACH/wire only. Public information; the account number is not held at all." },
          account_number_last4: { type: ["string", "null"], description: "Last four only. The full number is not in this system." },
          account_type: { type: ["string", "null"] },
          created_at: { type: "string" },
          created_by: { type: "string" },
          archived: { type: "boolean" },
          archived_at: { type: ["string", "null"] },
          verification: {
            type: "object",
            properties: {
              outcome: { type: ["string", "null"], enum: [...OUTCOMES, null] },
              freshness: { type: "string", enum: [...FRESHNESS] },
              checked_at: { type: ["string", "null"] },
              checked_days_ago: { type: ["integer", "null"] },
              checked_by: { type: ["string", "null"] },
              evidence: {
                type: ["string", "null"],
                enum: ["live", "simulated", null],
                description: "Whether the providers that answered were live sandboxes or a built simulator. Labelled, never implied.",
              },
              routing_checksum_ok: { type: ["boolean", "null"] },
              routing_prefix_assigned: { type: ["boolean", "null"] },
              directory: { type: ["string", "null"], description: "found, not_listed, unavailable or not_checked." },
              directory_provider: { type: ["string", "null"] },
              institution_name: { type: ["string", "null"] },
              name_match: { type: ["string", "null"], description: "match, close_match, no_match or unavailable." },
              name_match_score: { type: ["integer", "null"], description: "0-100 whole points, or null when nobody was asked." },
              name_source: {
                type: ["string", "null"],
                description:
                  "payer_asserted means we compared two strings our own side typed and the check proves nothing about the real account holder. linked_account_holder and confirmation_of_payee mean a third party answered.",
              },
              counterparty_name: { type: ["string", "null"] },
              findings: { type: "array", items: FINDING_SCHEMA },
            },
            required: [
              "outcome",
              "freshness",
              "checked_at",
              "checked_days_ago",
              "checked_by",
              "evidence",
              "routing_checksum_ok",
              "routing_prefix_assigned",
              "directory",
              "directory_provider",
              "institution_name",
              "name_match",
              "name_match_score",
              "name_source",
              "counterparty_name",
              "findings",
            ],
            additionalProperties: false,
          },
          acknowledgement: {
            type: "object",
            description:
              "A warn clears only when a named person signs a reason. An agent cannot sign one, and this object is read-only evidence that somebody did.",
            properties: {
              acknowledged: { type: "boolean" },
              acknowledged_by: { type: ["string", "null"] },
              acknowledged_at: { type: ["string", "null"] },
              reason: { type: ["string", "null"] },
            },
            required: ["acknowledged", "acknowledged_by", "acknowledged_at", "reason"],
            additionalProperties: false,
          },
          has_conflicting_twin: {
            type: "boolean",
            description:
              "Another payee on the book shares this holder name with different bank details. The classic changed-bank-details fraud, and the classic duplicate-payee mistake, look identical here.",
          },
          payable: {
            type: "boolean",
            description:
              "Whether a payment to this destination would pass the payee gate today: not archived, not blocked, and either not warned or warned-and-acknowledged. Derived from the columns beside it, and NOT the gate itself — gatePaymentOnPayee() re-decides inside the transaction that writes the instruction.",
          },
        },
        required: [
          "payee_id",
          "display_name",
          "holder_name",
          "rail",
          "routing_number",
          "account_number_last4",
          "account_type",
          "created_at",
          "created_by",
          "archived",
          "archived_at",
          "verification",
          "acknowledgement",
          "has_conflicting_twin",
          "payable",
        ],
        additionalProperties: false,
      },
    },
    counts: {
      type: "object",
      description: "How many of each outcome and freshness are in the returned page.",
      properties: {},
      additionalProperties: true,
    },
    truncated: { type: "boolean" },
    note: { type: "string" },
  },
  required: ["business", "as_of_book_date", "payees", "counts", "truncated", "note"],
  additionalProperties: false,
};

async function run(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const limit = args.limit ?? DEFAULT_LIMIT;

  const rows = await ctx.gateway.listPayees(ctx.grant.businessId, {
    rail: args.rail ?? null,
    outcome: args.outcome ?? null,
    freshness: args.freshness ?? null,
    holderNameContains: args.holder_name_contains ?? null,
    includeArchived: args.include_archived ?? false,
    limit: limit + 1,
  });

  const page = rows.slice(0, limit);

  const payees = page.map((row) => ({
    payee_id: row.payeeId,
    display_name: row.displayName,
    holder_name: row.holderName,
    rail: row.rail,
    routing_number: row.routingNumber,
    account_number_last4: row.accountNumberLast4,
    account_type: row.accountType,
    created_at: row.createdAt,
    created_by: row.createdByName,
    archived: row.archived,
    archived_at: row.archivedAt,
    verification: {
      outcome: row.outcome,
      freshness: row.freshness,
      checked_at: row.checkedAt,
      checked_days_ago: row.checkedDaysAgo,
      checked_by: row.checkedByName,
      evidence: row.evidence,
      routing_checksum_ok: row.checksumOk,
      routing_prefix_assigned: row.prefixAssigned,
      directory: row.directory,
      directory_provider: row.directoryProvider,
      institution_name: row.institutionName,
      name_match: row.nameMatch,
      name_match_score: row.nameMatchScore,
      name_source: row.nameSource,
      counterparty_name: row.counterpartyName,
      findings: row.findings,
    },
    acknowledgement: {
      acknowledged: row.acknowledged,
      acknowledged_by: row.acknowledgedByName,
      acknowledged_at: row.acknowledgedAt,
      reason: row.acknowledgementReason,
    },
    has_conflicting_twin: row.hasConflictingTwin,
    // Derived from the row, and said to be derived. The gate is a function in
    // a transaction, not a column, and a tool that reported a cached "safe"
    // would be inventing an authority it does not have.
    payable:
      !row.archived &&
      row.outcome !== "blocked" &&
      (row.outcome !== "warned" || row.acknowledged),
  }));

  const counts: Record<string, number> = {};
  for (const p of payees) {
    const outcome = p.verification.outcome ?? "never_checked";
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    counts[`freshness_${p.verification.freshness}`] =
      (counts[`freshness_${p.verification.freshness}`] ?? 0) + 1;
  }

  const unpayable = payees.filter((p) => !p.payable).length;
  const twins = payees.filter((p) => p.has_conflicting_twin).length;
  const stale = payees.filter(
    (p) => p.verification.freshness === "stale" || p.verification.freshness === "never",
  ).length;

  const data = {
    business: { id: ctx.grant.businessId, legal_name: ctx.grant.businessLegalName },
    as_of_book_date: ctx.bookToday,
    payees,
    counts,
    truncated: rows.length > page.length,
    note:
      "Outcomes, freshness, name-match bands and findings come from the payee module's own verification record; nothing is recomputed here. A `verified` outcome is a fact about the day the check ran — read freshness before relying on it, and read name_source before relying on a name match, because payer_asserted means we compared two strings our own side typed. This tool cannot add, edit, archive or re-check a payee, and it cannot acknowledge a warning: that signature has to belong to a named person or the control is empty.",
  };

  const summary =
    payees.length === 0
      ? `No payees on ${ctx.grant.businessLegalName}'s book match that filter.` +
        (args.include_archived === true ? "" : " Archived payees were excluded; pass include_archived to see them.")
      : `${payees.length} payee(s) on ${ctx.grant.businessLegalName}'s book. ` +
        `${payees.length - unpayable} would pass the payee gate today; ${unpayable} would not (blocked, archived, or warned without a human acknowledgement). ` +
        `${stale} have a verification that is stale or has never run. ` +
        `${twins} share a holder name with another payee carrying different bank details, which is what a changed-bank-details fraud and an innocent duplicate both look like. ` +
        `This surface can read the book and cannot change it, re-check it, or acknowledge a warning.`;

  return { summary, data };
}

export const listPayeesTool: ToolDefinition = {
  name: "list_payees",
  title: "List payees and their verification state",
  description:
    "The payee book: every destination this business has saved, each with its last verification outcome (verified / warned / blocked), how fresh that check is, the name-match result and where the compared name came from, the directory answer, any findings, and whether a human has acknowledged a warning. Read this BEFORE composing a destination for initiate_payment, to check whether the business has paid this counterparty before and whether the details still match. Read-only and scoped to the single business this token belongs to; it cannot add, edit, archive or re-check a payee, and it cannot acknowledge a warning.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "List payees and their verification state",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  readOnly: true,
  parse: (args) => parseArgs(argsSchema, args),
  run: run as ToolDefinition["run"],
};
