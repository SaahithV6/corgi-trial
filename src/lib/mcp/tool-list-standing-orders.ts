/**
 * list_standing_orders — the mandates, when they next come round, and what
 * happened the last few times they did.
 *
 * THE QUESTION THIS TOOL ANSWERS is "did the rent go out, and if not, why
 * not". Before it existed, an agent could see the money that DID move
 * (`list_transactions`) and nothing at all about the money that was supposed
 * to and did not. An absence is not a row, so no amount of reading the journal
 * finds it — which is exactly the failure standing orders are prone to and
 * exactly why `standing_order_occurrence` exists: a refused occurrence is a
 * PRESENT row carrying a code, a sentence and the four balance figures the
 * decision was made against.
 *
 * So the refusal history is not a decoration on this tool, it is the tool. An
 * agent that can read it can tell a customer "your rent was refused on the 1st
 * because available was $3,910.22 against $4,000.00, and it was not carried
 * forward — the next one is due on the 1st of next month". Every clause of
 * that sentence comes off the occurrence row.
 *
 * WHY THERE IS NO WRITE SIBLING, stated here because a mandate tool is the
 * most obvious write to add and it is the wrong one.
 *
 * A mandate is not a payment; it is the authority to make a series of them. It
 * does not itself enter the approval queue — only its occurrences do, one a
 * month, each looking like an ordinary scheduled debit long after the context
 * in which it was created has gone. And the grant's own ceiling
 * (`maxInstructionCents`) is enforced by `initiate_payment`, which is not on
 * the path: occurrences are raised by the cron under the mandate's creator, so
 * a token limited to $50,000 an instruction could create a daily $49,000
 * mandate and never meet its own ceiling again. That is a write that multiplies
 * itself, and the approval queue it lands in is the wrong one — a person
 * approving occurrence #7 is not being asked about the mandate. See
 * docs/AGENT-LIMITS.md §10 and §13.
 *
 * Firing an occurrence out of band is refused for a different reason again, and
 * a sharper one: exactly-once is enforced by a UNIQUE constraint on (standing
 * order, scheduled date) plus a generated idempotency key, and a second way to
 * fire is a second way to be wrong about a date.
 */

import { z } from "zod";

import { describeDestination, type PaymentDestination } from "@/lib/approvals/types";
import {
  CATCH_UP_WINDOW_DAYS,
  INSUFFICIENT_FUNDS_CODE,
  STALE_AFTER_DAYS,
  STANDING_ORDER_CADENCES,
} from "@/lib/standing/types";

import { MONEY_SCHEMA, money, parseArgs } from "./validate";
import { signedDaysBetween } from "./time";
import type { JsonSchemaObject, ToolContext, ToolDefinition, ToolOutcome } from "./types";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;
const MAX_OCCURRENCES = 20;
const DEFAULT_OCCURRENCES = 5;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function ordinal(day: number): string {
  const rem100 = day % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/**
 * The schedule as a sentence. PRESENTATION ONLY — the dates themselves come
 * from `v_standing_order_next`, which is the database's own calendar walk. If
 * this function and that view ever disagreed, the view would still be right;
 * that is why `next_due_date` is returned beside the sentence rather than
 * derived from it.
 */
function describeSchedule(
  cadence: string,
  dayOfMonth: number | null,
  dayOfWeek: number | null,
): string {
  switch (cadence) {
    case "daily":
      return "every day";
    case "weekly":
      return dayOfWeek === null
        ? "every week"
        : `every ${WEEKDAYS[dayOfWeek] ?? `weekday ${dayOfWeek}`}`;
    case "monthly":
      return dayOfMonth === null
        ? "every month"
        : `monthly on the ${ordinal(dayOfMonth)} (a short month runs it on the last day)`;
    default:
      return cadence;
  }
}

/** "in 3 day(s)", "today", or an overdue count said out loud. */
function describeDueIn(days: number): string {
  if (days === 0) return "today";
  if (days < 0) return `${-days} day(s) ago and not yet claimed`;
  return `in ${days} day(s)`;
}

/**
 * The destination in the same snake_case shape `initiate_payment` ACCEPTS.
 *
 * The column stores the approvals module's camelCase field names, and echoing
 * those straight out would produce a payload an agent cannot feed back in: a
 * model that copies `holderName` into `initiate_payment` is refused by a strict
 * schema for a reason it cannot see. One wire vocabulary, in both directions.
 *
 * Still no full account number in any branch — there is none to render.
 */
function destinationOut(destination: PaymentDestination): Record<string, string> {
  switch (destination.type) {
    case "ach":
      return {
        type: "ach",
        holder_name: destination.holderName,
        routing_number: destination.routingNumber,
        account_number_last4: destination.accountNumberLast4,
        account_type: destination.accountType,
      };
    case "wire":
      return {
        type: "wire",
        holder_name: destination.holderName,
        bic: destination.bic,
        account_number_last4: destination.accountNumberLast4,
      };
    case "usdc":
      return { type: "usdc", chain: destination.chain, address: destination.address };
    case "internal":
      // The beneficiary account id is OUR uuid for one of our own accounts,
      // and `initiate_payment` refuses the internal rail anyway. The holder
      // name is what a person needs to recognise the mandate.
      return { type: "internal", holder_name: destination.holderName };
  }
}

const argsSchema = z.strictObject({
  include_cancelled: z.boolean().optional(),
  refused_only: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
  occurrences_per_order: z.number().int().min(0).max(MAX_OCCURRENCES).optional(),
});

type Args = z.infer<typeof argsSchema>;

const inputSchema: JsonSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    include_cancelled: {
      type: "boolean",
      description:
        "Include mandates somebody cancelled. Default false. A cancelled mandate is never deleted — its occurrence history is the evidence of what it did while it ran.",
    },
    refused_only: {
      type: "boolean",
      description:
        "Return only mandates with at least one refused occurrence in the window, and show only the refused occurrences. This is the \"why didn't it go out\" question asked directly.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Maximum mandates to return, 1-${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}.`,
    },
    occurrences_per_order: {
      type: "integer",
      minimum: 0,
      maximum: MAX_OCCURRENCES,
      description: `How many recent occurrences to attach to each mandate, newest scheduled date first. 0 for none. Defaults to ${DEFAULT_OCCURRENCES}.`,
    },
  },
  required: [],
  additionalProperties: false,
};

const OCCURRENCE_SCHEMA = {
  type: "object",
  properties: {
    occurrence_id: { type: "string" },
    scheduled_date: { type: "string", description: "The date the mandate was due. Book time." },
    idempotency_key: {
      type: "string",
      description:
        "`standing:<mandate id>:<date>`, generated by Postgres. Unique on payment_instruction, which is what makes a retry raise nothing rather than pay twice.",
    },
    disposition: {
      type: ["string", "null"],
      description:
        "raised = an instruction went into the approval queue. refused = the occurrence was attempted and closed with a reason. null = claimed and still undecided, which must be a transient state.",
    },
    instruction_id: { type: ["string", "null"] },
    refusal_code: { type: ["string", "null"] },
    refusal_reason: { type: ["string", "null"] },
    shortfall: { anyOf: [MONEY_SCHEMA, { type: "null" }] },
    observed: {
      description:
        "The four figures the funding decision was made against, as at the moment it was made. Kept on the row so the refusal can be explained months later without re-deriving a balance that has since moved.",
      anyOf: [
        {
          type: "object",
          properties: {
            ledger_balance: MONEY_SCHEMA,
            card_authorisation_holds: MONEY_SCHEMA,
            uncleared_credits: MONEY_SCHEMA,
            available_balance: MONEY_SCHEMA,
          },
          required: [
            "ledger_balance",
            "card_authorisation_holds",
            "uncleared_credits",
            "available_balance",
          ],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    },
    decided_at: { type: ["string", "null"] },
    claimed_at: { type: "string" },
  },
  required: [
    "occurrence_id",
    "scheduled_date",
    "idempotency_key",
    "disposition",
    "instruction_id",
    "refusal_code",
    "refusal_reason",
    "shortfall",
    "observed",
    "decided_at",
    "claimed_at",
  ],
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
    mandates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          standing_order_id: { type: "string" },
          reference: { type: "string", description: "What the customer calls it. Shown to the payee where the rail allows." },
          account_name: { type: "string" },
          rail: { type: "string" },
          amount: MONEY_SCHEMA,
          currency: { type: "string" },
          cadence: { type: "string", enum: [...STANDING_ORDER_CADENCES] },
          schedule: { type: "string", description: "The cadence as a sentence. Presentation; next_due_date is the authority." },
          day_of_month: { type: ["integer", "null"] },
          day_of_week: { type: ["integer", "null"] },
          start_date: { type: "string" },
          end_date: { type: ["string", "null"] },
          next_due_date: {
            type: ["string", "null"],
            description:
              "The next date not yet claimed, from the database's own calendar walk. Null when the mandate has run out of dates or was cancelled.",
          },
          days_until_next: {
            type: ["integer", "null"],
            description:
              "Whole days from book today to next_due_date. Negative means the date has passed and the occurrence has not been claimed, which is worth saying out loud rather than rounding to zero.",
          },
          destination: {
            type: ["object", "null"],
            additionalProperties: true,
            properties: {},
            description:
              "The beneficiary, in the same field names initiate_payment accepts, so it can be copied straight into a draft. Last four only; a full account number is never held.",
          },
          destination_summary: { type: ["string", "null"], description: "One line an approver can compare against a beneficiary they know." },
          cancelled: { type: "boolean" },
          cancelled_at: { type: ["string", "null"] },
          cancellation_reason: { type: ["string", "null"] },
          created_at: { type: "string" },
          created_by: { type: "string", description: "The actor whose authority every occurrence is raised under." },
          occurrence_counts: {
            type: "object",
            properties: {
              raised: { type: "integer" },
              refused: { type: "integer" },
              undecided: { type: "integer" },
            },
            required: ["raised", "refused", "undecided"],
            additionalProperties: false,
          },
          recent_occurrences: { type: "array", items: OCCURRENCE_SCHEMA },
        },
        required: [
          "standing_order_id",
          "reference",
          "account_name",
          "rail",
          "amount",
          "currency",
          "cadence",
          "schedule",
          "day_of_month",
          "day_of_week",
          "start_date",
          "end_date",
          "next_due_date",
          "days_until_next",
          "destination",
          "destination_summary",
          "cancelled",
          "cancelled_at",
          "cancellation_reason",
          "created_at",
          "created_by",
          "occurrence_counts",
          "recent_occurrences",
        ],
        additionalProperties: false,
      },
    },
    policy: {
      type: "object",
      description: "The written rules the firing routine applies. Constants from the standing-orders module, not restated numbers.",
      properties: {
        on_insufficient_funds: { type: "string" },
        insufficient_funds_code: { type: "string" },
        stale_after_days: { type: "integer" },
        catch_up_window_days: { type: "integer" },
      },
      required: [
        "on_insufficient_funds",
        "insufficient_funds_code",
        "stale_after_days",
        "catch_up_window_days",
      ],
      additionalProperties: false,
    },
    counts: {
      type: "object",
      properties: {
        mandates: { type: "integer" },
        active: { type: "integer" },
        cancelled: { type: "integer" },
        occurrences_shown: { type: "integer" },
        refused_shown: { type: "integer" },
      },
      required: ["mandates", "active", "cancelled", "occurrences_shown", "refused_shown"],
      additionalProperties: false,
    },
    truncated: { type: "boolean" },
    note: { type: "string" },
  },
  required: [
    "business",
    "as_of_book_date",
    "mandates",
    "policy",
    "counts",
    "truncated",
    "note",
  ],
  additionalProperties: false,
};

async function run(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const limit = args.limit ?? DEFAULT_LIMIT;
  const perOrder = args.occurrences_per_order ?? DEFAULT_OCCURRENCES;
  const refusedOnly = args.refused_only ?? false;

  const page = await ctx.gateway.listStandingOrders(ctx.grant.businessId, {
    includeCancelled: args.include_cancelled ?? false,
    limit: limit + 1,
  });

  const orders = page.orders.slice(0, limit);

  const mandates = orders
    .map((order) => {
      const all = page.occurrences.filter((o) => o.standingOrderId === order.id);
      const counts = {
        raised: all.filter((o) => o.disposition === "raised").length,
        refused: all.filter((o) => o.disposition === "refused").length,
        undecided: all.filter((o) => o.disposition === null).length,
      };
      const chosen = (refusedOnly ? all.filter((o) => o.disposition === "refused") : all).slice(
        0,
        perOrder,
      );

      return {
        standing_order_id: order.id,
        reference: order.reference,
        account_name: order.accountName,
        rail: order.rail,
        amount: money(order.amountCents),
        currency: order.currency,
        cadence: order.cadence,
        schedule: describeSchedule(order.cadence, order.dayOfMonth, order.dayOfWeek),
        day_of_month: order.dayOfMonth,
        day_of_week: order.dayOfWeek,
        start_date: order.startDate,
        end_date: order.endDate,
        next_due_date: order.nextDueDate,
        days_until_next:
          order.nextDueDate === null
            ? null
            : signedDaysBetween(ctx.bookToday, order.nextDueDate),
        destination: order.destination === null ? null : destinationOut(order.destination),
        destination_summary:
          order.destination === null ? null : describeDestination(order.destination),
        cancelled: order.cancelled,
        cancelled_at: order.cancelledAt,
        cancellation_reason: order.cancellationReason,
        created_at: order.createdAt,
        created_by: order.createdByName,
        occurrence_counts: counts,
        recent_occurrences: chosen.map((o) => ({
          occurrence_id: o.occurrenceId,
          scheduled_date: o.scheduledDate,
          idempotency_key: o.idempotencyKey,
          disposition: o.disposition,
          instruction_id: o.instructionId,
          refusal_code: o.refusalCode,
          refusal_reason: o.refusalReason,
          shortfall: o.shortfallCents === null ? null : money(o.shortfallCents),
          observed:
            o.observedAvailableCents === null
              ? null
              : {
                  ledger_balance: money(o.observedLedgerCents ?? 0n),
                  card_authorisation_holds: money(o.observedHoldsCents ?? 0n),
                  uncleared_credits: money(o.observedUnclearedCents ?? 0n),
                  available_balance: money(o.observedAvailableCents),
                },
          decided_at: o.decidedAt,
          claimed_at: o.claimedAt,
        })),
      };
    })
    .filter((m) => !refusedOnly || m.occurrence_counts.refused > 0);

  const occurrencesShown = mandates.reduce((n, m) => n + m.recent_occurrences.length, 0);
  const refusedShown = mandates.reduce(
    (n, m) => n + m.recent_occurrences.filter((o) => o.disposition === "refused").length,
    0,
  );
  const nextUp = mandates
    .filter((m) => m.next_due_date !== null && !m.cancelled)
    .sort((a, b) => (a.next_due_date ?? "").localeCompare(b.next_due_date ?? ""))[0];

  const data = {
    business: { id: ctx.grant.businessId, legal_name: ctx.grant.businessLegalName },
    as_of_book_date: ctx.bookToday,
    mandates,
    policy: {
      on_insufficient_funds:
        "The occurrence is refused and closed, with the reason and the four observed figures on the row. No partial payment, no carry-forward, no queue that fires whenever the money arrives. The next occurrence is unaffected and fires on its own date.",
      insufficient_funds_code: INSUFFICIENT_FUNDS_CODE,
      stale_after_days: STALE_AFTER_DAYS,
      catch_up_window_days: CATCH_UP_WINDOW_DAYS,
    },
    counts: {
      mandates: mandates.length,
      active: mandates.filter((m) => !m.cancelled).length,
      cancelled: mandates.filter((m) => m.cancelled).length,
      occurrences_shown: occurrencesShown,
      refused_shown: refusedShown,
    },
    truncated: page.orders.length > orders.length,
    note:
      "A refused occurrence is a row, not an absence: it carries the code, the sentence and the four balance figures the decision was made against, so \"it never went out and nobody knows why\" is not a state this system can be in. Exactly-once is a UNIQUE constraint on (mandate, scheduled date) plus a generated idempotency key, not a lock. This surface can read mandates and cannot create, amend, cancel or fire one — a mandate is recurring authority rather than a single payment, and firing an occurrence out of band is the one thing the exactly-once constraint cannot protect against.",
  };

  const summary =
    mandates.length === 0
      ? `${ctx.grant.businessLegalName} has no standing orders matching that filter.`
      : `${mandates.length} standing order(s) for ${ctx.grant.businessLegalName}` +
        (nextUp === undefined
          ? ""
          : `; next up is "${nextUp.reference}" for ${nextUp.amount.display} on ${nextUp.next_due_date}` +
            (nextUp.days_until_next === null
              ? ""
              : ` (${describeDueIn(nextUp.days_until_next)})`)) +
        `. ${occurrencesShown} recent occurrence(s) shown, ${refusedShown} of them refused. ` +
        `A refused occurrence was attempted and closed with a reason; it is not carried forward and the next date is unaffected. ` +
        `Nothing here can be created, amended, cancelled or fired through this surface.`;

  return { summary, data };
}

export const listStandingOrdersTool: ToolDefinition = {
  name: "list_standing_orders",
  title: "List standing orders and their occurrences",
  description:
    "Standing-order mandates for this business, each with its schedule, its next due date from the database's own calendar walk, and its recent occurrences — including refused ones, which carry the refusal code, the reason and the four balance figures the funding decision was made against. Use this to answer why a scheduled payment did or did not go out, since a payment that never happened is not in the journal. Read-only and scoped to the single business this token belongs to; it cannot create, amend, cancel or fire a mandate.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "List standing orders and their occurrences",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  readOnly: true,
  parse: (args) => parseArgs(argsSchema, args),
  run: run as ToolDefinition["run"],
};
