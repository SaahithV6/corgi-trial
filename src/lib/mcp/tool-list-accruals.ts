/**
 * list_accruals — the platform fee, day by day, with the arithmetic.
 *
 * ===========================================================================
 * WHY THIS TOOL EXISTS
 * ===========================================================================
 *
 * Accrual is the one feature on this surface that posts to the customer's
 * ledger EVERY DAY, with no human anywhere on the path, in amounts small
 * enough that nobody looks. That combination is exactly what produces a
 * confidently wrong agent, in three distinct ways:
 *
 * 1. **"There are unexplained daily debits on your account."** A $25.00 plan
 *    accrues 83¢ or 84¢ a day. In `list_transactions` that is thirty tiny
 *    postings a month with a terse description and no visible cause, and an
 *    agent asked "what are these" has, until now, had nothing to read.
 *
 * 2. **"You have been charged the wrong amount — some days are 84¢ and some
 *    are 83¢."** They are, and it is correct. `$25.00 ÷ 30 = 83¢ with 10¢ left
 *    over`, and largest-remainder gives the extra penny to the first ten days
 *    of the month so that the month sums to the price EXACTLY rather than
 *    within a penny. An agent that does not know this reports a rounding bug;
 *    an agent that computes it itself in floating point invents one.
 *
 * 3. **"Your fee this month is $8.40."** Mid-month, the accrued figure is
 *    month-to-date and the plan price is the month. Quoting the first as
 *    though it were the second understates the bill, and the customer finds
 *    out on the last day of the month.
 *
 * So the day rows carry THE WORKING, not the answer: the price, the days in
 * the month, the day ordinal, the base share, the residual pennies, whether
 * this day carries one, the amount, the month-to-date and what is still to
 * come. Every one of those is a stored column that `accrual_posting_arithmetic`
 * re-derived with `accrual_daily_share()` before Postgres would accept the
 * row — so they are not a claim about the rounding rule, they are the rule,
 * checked by the thing that persisted them. The sentence in
 * `arithmetic.explanation` is built by `explainAllocation()` from those same
 * integers, which is why it cannot disagree with the figures beside it.
 *
 * ===========================================================================
 * THE INVARIANTS ARE RETURNED, INCLUDING THE ONE THAT IS ALLOWED TO BE NONZERO
 * ===========================================================================
 *
 * `month_drift` and `ledger_drift` must be zero forever — a complete month
 * whose postings do not sum to the price, and a posting that disagrees with
 * the journal entry it cites. They are reported rather than assumed, scoped to
 * this business, because an agent quoting a fee while the books disagree with
 * themselves should be told.
 *
 * `gap_days` is the interesting one: days a schedule owes that nothing has
 * claimed. Non-zero is normal the moment a schedule is created and before the
 * first tick. Persistently non-zero means the cron is not running, which is
 * the single failure a silent accrual job otherwise hides — the customer is
 * simply not billed and nothing anywhere is red. An agent is shown it rather
 * than a tidy "all good", because "your fee has not been charged for nine
 * days" is a true and useful sentence that no other tool here can produce.
 *
 * ===========================================================================
 * WHAT THIS TOOL DOES NOT COVER, STATED RATHER THAN IMPLIED
 * ===========================================================================
 *
 * The FEE leg only — `accrual_schedule`, `accrual_day`, `accrual_posting`.
 * Migration 0024 added an INTEREST leg with its own tables, and at the time
 * this reader was written `interest_posting` held zero rows against a live
 * database: the schedules exist, the tick has not booked anything, and the
 * feature belongs to another worker in this build. Projecting an empty table
 * would let this tool claim a capability no call has proved, which is the one
 * thing this repository treats as an automatic fail. So it is named here and
 * in the tool's own `note` instead. When interest starts posting, the honest
 * change is a second section in this result — not a silent widening of the
 * word "accrual".
 *
 * ===========================================================================
 * READ ONLY
 * ===========================================================================
 *
 * Two writes came with this feature and both are refused, in
 * docs/AGENT-LIMITS.md §19 and §20. Enrolling or re-pricing a schedule is not
 * queueing anything — the daily entries that follow are posted by a cron with
 * no human in the path, so a wrong monthly price is a wrong journal entry
 * every day until somebody notices, each one individually correct against the
 * schedule that was wrong. Skipping a day is the quieter one: it is the single
 * place in this feature where money is knowingly not charged, and an agent
 * with that tool could zero a customer's bill one defensible-looking day at a
 * time.
 */

import { z } from "zod";

import { explainAllocation, type DailyAllocation } from "@/lib/accrual/types";

import { MONEY_SCHEMA, money, parseArgs } from "./validate";
import type { JsonSchemaObject, ToolContext, ToolDefinition, ToolOutcome } from "./types";

const MAX_DAYS = 120;
const DEFAULT_DAYS = 31;
const MAX_MONTHS = 24;
const DEFAULT_MONTHS = 3;
const SCHEDULE_LIMIT = 25;

const argsSchema = z.strictObject({
  days: z.number().int().min(0).max(MAX_DAYS).optional(),
  months: z.number().int().min(0).max(MAX_MONTHS).optional(),
  include_skipped: z.boolean().optional(),
});

type Args = z.infer<typeof argsSchema>;

const inputSchema: JsonSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    days: {
      type: "integer",
      minimum: 0,
      maximum: MAX_DAYS,
      description: `How many individual accrual days to return, newest first, 0-${MAX_DAYS}. Defaults to ${DEFAULT_DAYS} — about a month, which is the span that answers "what are these small daily charges". Zero returns the schedules and month roll-ups alone.`,
    },
    months: {
      type: "integer",
      minimum: 0,
      maximum: MAX_MONTHS,
      description: `How many month roll-ups to return, newest first, 0-${MAX_MONTHS}. Defaults to ${DEFAULT_MONTHS}. A month is only comparable to the plan price once month_complete is true.`,
    },
    include_skipped: {
      type: "boolean",
      description:
        "Include days a tick decided NOT to charge, with the reason. Default true: a day that was skipped is the only reason a complete month could be short, and hiding it turns a visible decision into a mystery.",
    },
  },
  required: [],
  additionalProperties: false,
};

const ARITHMETIC_SCHEMA = {
  type: "object",
  description:
    "The hand calculation for this day, as the database stored and re-derived it. Every field is a column checked by accrual_posting_arithmetic against accrual_daily_share() — no figure here was computed by this tool.",
  properties: {
    monthly_price: { allOf: [MONEY_SCHEMA], description: "F — the quoted monthly price." },
    days_in_month: { type: "integer", description: "N — 28 to 31." },
    day_of_month: { type: "integer", description: "d — the ordinal that breaks the tie." },
    base_share: { allOf: [MONEY_SCHEMA], description: "q = F div N. What every day gets first." },
    residual_pennies: {
      type: "integer",
      description:
        "r = F mod N. Pennies largest-remainder must place this month so the month sums to the price exactly.",
    },
    residual_applied: {
      type: "boolean",
      description: "Whether THIS day is one of the first r and therefore carries one of them.",
    },
    amount: { allOf: [MONEY_SCHEMA], description: "share(d) = q + (d <= r). Posted today." },
    month_to_date: { allOf: [MONEY_SCHEMA], description: "cum(d), including today." },
    remaining_this_month: { allOf: [MONEY_SCHEMA], description: "F - cum(d). Zero on day N." },
    explanation: {
      type: "string",
      description:
        "The same arithmetic as a sentence, built from the same integers — so it cannot disagree with the figures beside it.",
    },
  },
  required: [
    "monthly_price",
    "days_in_month",
    "day_of_month",
    "base_share",
    "residual_pennies",
    "residual_applied",
    "amount",
    "month_to_date",
    "remaining_this_month",
    "explanation",
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
    schedules: {
      type: "array",
      items: {
        type: "object",
        properties: {
          schedule_id: { type: "string" },
          plan_name: { type: "string" },
          product: { type: "string" },
          account_name: { type: "string" },
          monthly_price: MONEY_SCHEMA,
          currency: { type: "string" },
          start_date: { type: "string" },
          end_date: { type: ["string", "null"] },
          active: { type: "boolean", description: "No end date, or an end date still ahead." },
        },
        required: [
          "schedule_id",
          "plan_name",
          "product",
          "account_name",
          "monthly_price",
          "currency",
          "start_date",
          "end_date",
          "active",
        ],
        additionalProperties: false,
      },
    },
    months: {
      type: "array",
      items: {
        type: "object",
        properties: {
          schedule_id: { type: "string" },
          plan_name: { type: "string" },
          month_start: { type: "string" },
          days_in_month: { type: "integer" },
          monthly_price: MONEY_SCHEMA,
          accrued: {
            allOf: [MONEY_SCHEMA],
            description:
              "Month-to-date until month_complete is true. Do NOT quote this as the month's bill before then.",
          },
          remaining: { allOf: [MONEY_SCHEMA], description: "price - accrued." },
          days_posted: { type: "integer" },
          days_skipped: { type: "integer" },
          days_decided: { type: "integer" },
          residual_pennies_in_month: { type: "integer" },
          residual_pennies_applied: { type: "integer" },
          month_complete: {
            type: "boolean",
            description: "Every day of the month has been decided. Only then must accrued == price.",
          },
          sums_to_price: {
            type: "boolean",
            description:
              "For a complete month, whether it does. Must be true; reported rather than assumed.",
          },
        },
        required: [
          "schedule_id",
          "plan_name",
          "month_start",
          "days_in_month",
          "monthly_price",
          "accrued",
          "remaining",
          "days_posted",
          "days_skipped",
          "days_decided",
          "residual_pennies_in_month",
          "residual_pennies_applied",
          "month_complete",
          "sums_to_price",
        ],
        additionalProperties: false,
      },
    },
    days: {
      type: "array",
      items: {
        type: "object",
        properties: {
          schedule_id: { type: "string" },
          plan_name: { type: "string" },
          accrual_date: {
            type: "string",
            description: "The day the fee accrued FOR, which is the entry's value date.",
          },
          disposition: {
            type: ["string", "null"],
            enum: ["posted", "skipped", null],
            description: "Null means a tick claimed the day and has not decided it yet.",
          },
          amount: { anyOf: [MONEY_SCHEMA, { type: "null" }] },
          entry_id: { type: ["string", "null"], description: "The journal entry, on a posted day." },
          skip_reason: { type: ["string", "null"] },
          arithmetic: { anyOf: [ARITHMETIC_SCHEMA, { type: "null" }] },
          claimed_at: { type: "string" },
          decided_at: { type: ["string", "null"] },
        },
        required: [
          "schedule_id",
          "plan_name",
          "accrual_date",
          "disposition",
          "amount",
          "entry_id",
          "skip_reason",
          "arithmetic",
          "claimed_at",
          "decided_at",
        ],
        additionalProperties: false,
      },
    },
    accrued_to_date: {
      allOf: [MONEY_SCHEMA],
      description: "Every posted day for this business, over all time.",
    },
    invariants: {
      type: "object",
      properties: {
        month_drift: {
          type: "integer",
          description:
            "Complete months whose postings do not sum to the price. MUST be 0 — largest-remainder guarantees exactness, not closeness.",
        },
        ledger_drift: {
          type: "integer",
          description:
            "Postings that disagree with the journal entry they cite, on amount or value date. MUST be 0.",
        },
        unresolved: {
          type: "integer",
          description: "Days a tick claimed and did not finish. Safe — nothing posted — and re-driven next tick.",
        },
        gap_days: {
          type: "integer",
          description:
            "Days a schedule owes that nothing has claimed. Non-zero right after enrolment is normal; persistently non-zero means the accrual job is not running and the customer is silently not being billed.",
        },
        healthy: { type: "boolean", description: "month_drift and ledger_drift are both zero." },
      },
      required: ["month_drift", "ledger_drift", "unresolved", "gap_days", "healthy"],
      additionalProperties: false,
    },
    note: { type: "string" },
  },
  required: [
    "business",
    "as_of_book_date",
    "schedules",
    "months",
    "days",
    "accrued_to_date",
    "invariants",
    "note",
  ],
  additionalProperties: false,
};

/**
 * Rebuild the allocation from the stored columns so `explainAllocation` can
 * write the sentence.
 *
 * Deliberately NOT `allocateForDate(monthlyCents, accrualDate)`. That would
 * recompute today's share from today's price and print a sentence about a
 * number the ledger might not hold — if a plan were re-priced, the stored row
 * and the fresh computation would differ and the sentence would describe the
 * wrong one. `remainingCents` is the only field not stored, and it is
 * `F - cum(d)` by definition rather than by arithmetic of ours.
 */
function allocationFromRow(row: {
  monthlyCents: bigint;
  daysInMonth: number;
  dayOfMonth: number;
  baseShareCents: bigint;
  residualPennies: number;
  residualApplied: boolean;
  amountCents: bigint;
  cumulativeCents: bigint;
}): DailyAllocation {
  return {
    monthlyCents: row.monthlyCents,
    daysInMonth: row.daysInMonth,
    dayOfMonth: row.dayOfMonth,
    baseShareCents: row.baseShareCents,
    residualPennies: row.residualPennies,
    residualApplied: row.residualApplied,
    amountCents: row.amountCents,
    cumulativeCents: row.cumulativeCents,
    remainingCents: row.monthlyCents - row.cumulativeCents,
  };
}

async function run(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const dayLimit = args.days ?? DEFAULT_DAYS;
  const monthLimit = args.months ?? DEFAULT_MONTHS;

  const page = await ctx.gateway.listAccruals(ctx.grant.businessId, {
    scheduleLimit: SCHEDULE_LIMIT,
    monthLimit,
    dayLimit,
    includeSkipped: args.include_skipped ?? true,
  });

  const schedules = page.schedules.map((s) => ({
    schedule_id: s.scheduleId,
    plan_name: s.planName,
    product: s.product,
    account_name: s.accountName,
    monthly_price: money(s.monthlyCents),
    currency: s.currency,
    start_date: s.startDate,
    end_date: s.endDate,
    active: s.endDate === null || s.endDate >= ctx.bookToday,
  }));

  const months = page.months.map((m) => ({
    schedule_id: m.scheduleId,
    plan_name: m.planName,
    month_start: m.monthStart,
    days_in_month: m.daysInMonth,
    monthly_price: money(m.monthlyCents),
    accrued: money(m.accruedCents),
    remaining: money(m.remainingCents),
    days_posted: m.daysPosted,
    days_skipped: m.daysSkipped,
    days_decided: m.daysDecided,
    residual_pennies_in_month: m.residualPenniesInMonth,
    residual_pennies_applied: m.residualPenniesApplied,
    month_complete: m.monthComplete,
    // Only meaningful once the month is complete; a mid-month "false" would
    // read as a fault when it is simply Tuesday.
    sums_to_price: m.monthComplete ? m.accruedCents === m.monthlyCents : true,
  }));

  const days = page.days.map((d) => {
    const complete =
      d.monthlyCents !== null &&
      d.daysInMonth !== null &&
      d.dayOfMonth !== null &&
      d.baseShareCents !== null &&
      d.residualPennies !== null &&
      d.residualApplied !== null &&
      d.amountCents !== null &&
      d.cumulativeCents !== null;

    const allocation = complete
      ? allocationFromRow({
          monthlyCents: d.monthlyCents as bigint,
          daysInMonth: d.daysInMonth as number,
          dayOfMonth: d.dayOfMonth as number,
          baseShareCents: d.baseShareCents as bigint,
          residualPennies: d.residualPennies as number,
          residualApplied: d.residualApplied as boolean,
          amountCents: d.amountCents as bigint,
          cumulativeCents: d.cumulativeCents as bigint,
        })
      : null;

    return {
      schedule_id: d.scheduleId,
      plan_name: d.planName,
      accrual_date: d.accrualDate,
      disposition: d.disposition,
      amount: d.amountCents === null ? null : money(d.amountCents),
      entry_id: d.entryId,
      skip_reason: d.skipReason,
      arithmetic:
        allocation === null
          ? null
          : {
              monthly_price: money(allocation.monthlyCents),
              days_in_month: allocation.daysInMonth,
              day_of_month: allocation.dayOfMonth,
              base_share: money(allocation.baseShareCents),
              residual_pennies: allocation.residualPennies,
              residual_applied: allocation.residualApplied,
              amount: money(allocation.amountCents),
              month_to_date: money(allocation.cumulativeCents),
              remaining_this_month: money(allocation.remainingCents),
              explanation: explainAllocation(allocation),
            },
      claimed_at: d.claimedAt,
      decided_at: d.decidedAt,
    };
  });

  const healthy = page.invariants.monthDrift === 0 && page.invariants.ledgerDrift === 0;

  const data = {
    business: { id: ctx.grant.businessId, legal_name: ctx.grant.businessLegalName },
    as_of_book_date: ctx.bookToday,
    schedules,
    months,
    days,
    accrued_to_date: money(page.accruedToDateCents),
    invariants: {
      month_drift: page.invariants.monthDrift,
      ledger_drift: page.invariants.ledgerDrift,
      unresolved: page.invariants.unresolved,
      gap_days: page.invariants.gapDays,
      healthy,
    },
    note:
      "A monthly price is allocated across the days of the month by largest remainder, not rounded per day: the first (price mod days) days carry one extra penny each, so a complete month sums to the price EXACTLY rather than within a penny. That is why consecutive days differ by a cent, and it is not an error. Before a month is complete, `accrued` is month-to-date and not the bill — quoting it as the bill understates what the customer owes. Every figure in `arithmetic` is a stored column the database re-derived before accepting the row; none of it was computed here. This tool reads only: an agent cannot enrol, re-price or end a schedule, cannot run the accrual tick, and cannot skip a day. SCOPE: this covers the platform FEE leg. A separate interest-accrual leg exists in the schema and had posted nothing when this reader was written; if a customer asks about interest, say it is not on this surface rather than reporting zero.",
  };

  const latest = days.find((d) => d.disposition === "posted");
  const currentMonth = months[0];
  const skipped = days.filter((d) => d.disposition === "skipped");

  const summary =
    schedules.length === 0
      ? `${ctx.grant.businessLegalName} is not enrolled in any platform-fee accrual schedule, so there are no daily fee postings on this account.`
      : `${ctx.grant.businessLegalName} is on ${schedules
          .map((s) => `${s.plan_name} at ${s.monthly_price.display}/month`)
          .join(" and ")}. ` +
        `${money(page.accruedToDateCents).display} has accrued in total across ${days.length} day(s) shown. ` +
        (currentMonth === undefined
          ? ""
          : `${currentMonth.month_start.slice(0, 7)}: ${currentMonth.accrued.display} of ${currentMonth.monthly_price.display} ` +
            `across ${currentMonth.days_posted} posted day(s)${
              currentMonth.month_complete
                ? currentMonth.sums_to_price
                  ? " — the month is complete and sums to the price exactly"
                  : " — WARNING: the month is complete and does NOT sum to the price; a person should look"
                : ", month-to-date, so this is not the month's bill yet"
            }. `) +
        (latest?.arithmetic === undefined || latest.arithmetic === null
          ? ""
          : `Most recent posted day ${latest.accrual_date}: ${latest.arithmetic.explanation} `) +
        (skipped.length === 0 ? "" : `${skipped.length} day(s) were deliberately skipped. `) +
        (page.invariants.gapDays === 0
          ? "No accrual days are outstanding. "
          : `${page.invariants.gapDays} day(s) are owed and unclaimed — if that number is not falling, the accrual job is not running and this account is silently not being billed. `) +
        (healthy
          ? "Month and ledger drift are both zero."
          : `WARNING: month drift ${page.invariants.monthDrift}, ledger drift ${page.invariants.ledgerDrift}. The books disagree with themselves and a person should look before any fee figure is quoted.`);

  return { summary, data };
}

export const listAccrualsTool: ToolDefinition = {
  name: "list_accruals",
  title: "List fee accrual with the daily arithmetic",
  description:
    "The business's platform-fee accrual: the schedule and its monthly price, the month roll-ups, and each individual accrual day WITH THE ARITHMETIC that produced it — price, days in month, day ordinal, base share, residual pennies, whether this day carries one, month-to-date and what remains. Use this whenever someone asks about small recurring daily debits, or why two consecutive days differ by a cent (a month's price is allocated by largest remainder so the month sums exactly, rather than rounded per day). Also returns the invariants, including days a schedule owes that nothing has claimed — the signal that the accrual job has stopped and the customer is silently not being billed. Read-only and scoped to the single business this token belongs to; it cannot enrol, re-price or end a schedule, run the tick, or skip a day.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "List fee accrual with the daily arithmetic",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  readOnly: true,
  parse: (args) => parseArgs(argsSchema, args),
  run: run as ToolDefinition["run"],
};
