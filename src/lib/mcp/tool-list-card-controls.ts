/**
 * list_card_controls — what each card is allowed to do, and what the real-time
 * authorisation decision actually did about it.
 *
 * THE QUESTION: "why was the card declined at the pump?" It is the most common
 * support question a business current account gets, it is answerable exactly,
 * and before this tool the agent surface could not answer it at all — a
 * declined authorisation never reaches the ledger, so `list_transactions` and
 * `get_balance` both show a card that simply did nothing.
 *
 * `card_auth_decision` is the answer: every decision this system made inside
 * the provider's ASA timeout, with the rule that fired, the result code the
 * network was given, and the figures the rule compared. So the agent can say
 * "declined at 14:02, merchant category 5542 (fuel) is on this card's block
 * list, version 3 of the controls set on the 8th" — which is a sentence a
 * person can act on — rather than "the bank declined it".
 *
 * READ ONLY, AND THE WRITE IS REFUSED HARDER THAN MOST.
 *
 * A control change is not configuration. It is a real-time authorisation
 * decision made in advance: the next time that card is presented, the value in
 * `card_control_version` IS the answer the network gets, inside 2 seconds,
 * with no human anywhere on the path. An agent that can unblock an MCC or
 * raise a daily limit has not asked anybody for money — it has arranged for the
 * next spend to be approved, and no approval queue will ever see it, because
 * the queue is for payment instructions and this never becomes one. Unfreezing
 * is worse still: a freeze is usually the visible end of a process that is not
 * in this system at all. See docs/AGENT-LIMITS.md §7 and §13.
 *
 * TWO THINGS THIS TOOL DELIBERATELY DOES NOT RETURN, and they are both
 * identifiers rather than money.
 *
 *   `provider_card_token` and `provider_auth_token` are how a card and an
 *   authorisation are addressed AT LITHIC. They are not secrets in the sense a
 *   PAN is, and they are also the exact handle an agent would need to act on a
 *   card outside this system. This surface has no business holding them, so it
 *   does not return them; the card is identified by our own uuid, its last four
 *   and its nickname, which is what a support conversation uses anyway.
 */

import { z } from "zod";

import { CARD_STATES, DECISION_RULES } from "@/lib/cards/types";
import { describeMcc } from "@/lib/cards/mcc";

import { MONEY_SCHEMA, money, parseArgs } from "./validate";
import type { JsonSchemaObject, ToolContext, ToolDefinition, ToolOutcome } from "./types";

const MAX_CARDS = 50;
const DEFAULT_CARDS = 10;
const MAX_DECISIONS = 100;
const DEFAULT_DECISIONS = 20;

const argsSchema = z.strictObject({
  limit: z.number().int().min(1).max(MAX_CARDS).optional(),
  decision_limit: z.number().int().min(0).max(MAX_DECISIONS).optional(),
  declines_only: z.boolean().optional(),
});

type Args = z.infer<typeof argsSchema>;

const inputSchema: JsonSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_CARDS,
      description: `Maximum cards to return, newest first, 1-${MAX_CARDS}. Defaults to ${DEFAULT_CARDS}.`,
    },
    decision_limit: {
      type: "integer",
      minimum: 0,
      maximum: MAX_DECISIONS,
      description: `How many recent authorisation decisions to return across all of this business's cards, newest first, 0-${MAX_DECISIONS}. Defaults to ${DEFAULT_DECISIONS}.`,
    },
    declines_only: {
      type: "boolean",
      description:
        "Return only the decisions that declined. Default false. This is the \"why was my card declined\" question asked directly.",
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
    cards: {
      type: "array",
      items: {
        type: "object",
        properties: {
          card_id: { type: "string", description: "Our id. The provider's card token is deliberately not returned." },
          last_four: { type: ["string", "null"] },
          nickname: { type: ["string", "null"] },
          created_at: { type: "string" },
          controls: {
            description: "Null when nobody has ever set controls on this card, which is not the same as a card with no limits.",
            anyOf: [
              {
                type: "object",
                properties: {
                  version: { type: "integer", description: "Control versions are append-only; a change writes a new version and the old one stays readable." },
                  effective_from: { type: "string" },
                  note: { type: "string", description: "The reason the person who set them gave." },
                  card_state: { type: "string", enum: [...CARD_STATES], description: "frozen is checked before any limit." },
                  per_transaction_limit: { anyOf: [MONEY_SCHEMA, { type: "null" }] },
                  daily_limit: { anyOf: [MONEY_SCHEMA, { type: "null" }] },
                  monthly_limit: { anyOf: [MONEY_SCHEMA, { type: "null" }] },
                  blocked_mccs: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        mcc: { type: "string", description: "ISO 18245, four digits, as a string. '0742' is not 742." },
                        label: { type: "string" },
                      },
                      required: ["mcc", "label"],
                      additionalProperties: false,
                    },
                  },
                },
                required: [
                  "version",
                  "effective_from",
                  "note",
                  "card_state",
                  "per_transaction_limit",
                  "daily_limit",
                  "monthly_limit",
                  "blocked_mccs",
                ],
                additionalProperties: false,
              },
              { type: "null" },
            ],
          },
          spend_today: {
            allOf: [MONEY_SCHEMA],
            description:
              "Purchase authorisations THIS SYSTEM APPROVED in the current book day. Taken from our own decision log, not from the ledger, because an authorisation approved four seconds ago is not in the ledger yet and a limit that cannot see it is not a limit. Refunds and balance inquiries are excluded.",
          },
          spend_this_month: { allOf: [MONEY_SCHEMA], description: "The same figure over the book month." },
          headroom_today: {
            anyOf: [MONEY_SCHEMA, { type: "null" }],
            description: "daily limit minus spend today, or null when there is no daily limit. Can be zero; a card with a zero limit and a card with no limit are different states.",
          },
        },
        required: [
          "card_id",
          "last_four",
          "nickname",
          "created_at",
          "controls",
          "spend_today",
          "spend_this_month",
          "headroom_today",
        ],
        additionalProperties: false,
      },
    },
    recent_decisions: {
      type: "array",
      description: "Authorisation decisions across this business's cards, newest first. A declined authorisation never reaches the ledger, so this is the only place it exists.",
      items: {
        type: "object",
        properties: {
          decided_at: { type: "string" },
          card_id: { type: ["string", "null"] },
          last_four: { type: ["string", "null"] },
          nickname: { type: ["string", "null"] },
          amount: MONEY_SCHEMA,
          mcc: { type: ["string", "null"] },
          merchant_category: { type: ["string", "null"] },
          merchant: { type: ["string", "null"] },
          request_status: { type: "string", description: "The network's own request type. A BALANCE_INQUIRY or a credit is not a purchase and does not consume a limit." },
          outcome: { type: "string", enum: ["approve", "decline"] },
          result_code: { type: "string", description: "What the network was told, verbatim from the provider's enum — CARD_PAUSED, UNAUTHORIZED_MERCHANT, VELOCITY_EXCEEDED, APPROVED." },
          rule: { type: "string", enum: [...DECISION_RULES], description: "Which rule decided it. Evaluation order is fixed in code and is not the display order." },
          reason: { type: "string", description: "One sentence, safe to read to a cardholder." },
          control_version: { type: ["integer", "null"], description: "The exact control version this decision was made under." },
          decision_latency_ms: { type: "integer", description: "How long our answer took. The provider's ASA window is measured in seconds and a slow answer is a decline by default." },
          source: { type: "string", enum: ["provider", "harness"], description: "provider = the real authorisation stream. harness = a replayed payload we drove ourselves. Labelled, never merged." },
        },
        required: [
          "decided_at",
          "card_id",
          "last_four",
          "nickname",
          "amount",
          "mcc",
          "merchant_category",
          "merchant",
          "request_status",
          "outcome",
          "result_code",
          "rule",
          "reason",
          "control_version",
          "decision_latency_ms",
          "source",
        ],
        additionalProperties: false,
      },
    },
    counts: {
      type: "object",
      properties: {
        cards: { type: "integer" },
        frozen: { type: "integer" },
        without_controls: { type: "integer" },
        decisions: { type: "integer" },
        declines: { type: "integer" },
      },
      required: ["cards", "frozen", "without_controls", "decisions", "declines"],
      additionalProperties: false,
    },
    truncated: { type: "boolean" },
    note: { type: "string" },
  },
  required: [
    "business",
    "as_of_book_date",
    "cards",
    "recent_decisions",
    "counts",
    "truncated",
    "note",
  ],
  additionalProperties: false,
};

async function run(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const limit = args.limit ?? DEFAULT_CARDS;
  const decisionLimit = args.decision_limit ?? DEFAULT_DECISIONS;

  const page = await ctx.gateway.listCardControls(ctx.grant.businessId, {
    limit: limit + 1,
    decisionLimit,
    declinesOnly: args.declines_only ?? false,
  });

  const cardRows = page.cards.slice(0, limit);

  const cards = cardRows.map((card) => {
    const controls = card.controls;
    const headroom =
      controls === null || controls.dailyLimitCents === null
        ? null
        : money(controls.dailyLimitCents - card.spendDayCents);

    return {
      card_id: card.cardId,
      last_four: card.lastFour,
      nickname: card.nickname,
      created_at: card.createdAt,
      controls:
        controls === null
          ? null
          : {
              version: controls.version,
              effective_from: controls.effectiveFrom,
              note: controls.note,
              card_state: controls.cardState,
              per_transaction_limit:
                controls.perTxnLimitCents === null ? null : money(controls.perTxnLimitCents),
              daily_limit:
                controls.dailyLimitCents === null ? null : money(controls.dailyLimitCents),
              monthly_limit:
                controls.monthlyLimitCents === null ? null : money(controls.monthlyLimitCents),
              blocked_mccs: controls.blockedMccs.map((mcc) => ({
                mcc,
                label: describeMcc(mcc),
              })),
            },
      spend_today: money(card.spendDayCents),
      spend_this_month: money(card.spendMonthCents),
      headroom_today: headroom,
    };
  });

  const decisions = page.decisions.map((d) => ({
    decided_at: d.decidedAt,
    card_id: d.cardId,
    last_four: d.lastFour,
    nickname: d.nickname,
    amount: money(d.amountCents),
    mcc: d.mcc,
    merchant_category: d.mcc === null ? null : describeMcc(d.mcc),
    merchant: d.merchantDescriptor,
    request_status: d.requestStatus,
    outcome: d.outcome,
    result_code: d.resultCode,
    rule: d.rule,
    reason: d.reason,
    control_version: d.controlVersion,
    // Microseconds on the row; milliseconds is the unit a person reads a
    // latency budget in. Integer division, because a fractional millisecond is
    // not a fact anybody needs.
    decision_latency_ms: Math.round(d.decisionLatencyUs / 1000),
    source: d.source,
  }));

  const frozen = cards.filter((c) => c.controls?.card_state === "frozen").length;
  const uncontrolled = cards.filter((c) => c.controls === null).length;
  const declines = decisions.filter((d) => d.outcome === "decline").length;
  const lastDecline = decisions.find((d) => d.outcome === "decline");

  const data = {
    business: { id: ctx.grant.businessId, legal_name: ctx.grant.businessLegalName },
    as_of_book_date: ctx.bookToday,
    cards,
    recent_decisions: decisions,
    counts: {
      cards: cards.length,
      frozen,
      without_controls: uncontrolled,
      decisions: decisions.length,
      declines,
    },
    truncated: page.cards.length > cardRows.length,
    note:
      "Controls are the real-time authorisation decision made in advance: the values here are what the network is told, inside the provider's timeout, with no human on the path. That is why this surface can read them and cannot change them — an agent that can unblock a merchant category or raise a limit has arranged for the next spend to be approved, and no approval queue will ever see it. Freezing and unfreezing are refused for the same reason, with the extra one that a freeze is usually the visible end of a process this system cannot see. Spend figures come from our own decision log rather than the ledger, so a card with no controls configured shows spend and no limits: that is a card nobody has set a policy on, not a card with unlimited policy.",
  };

  const summary =
    cards.length === 0
      ? `${ctx.grant.businessLegalName} has no cards on this book.`
      : `${cards.length} card(s) for ${ctx.grant.businessLegalName}: ${frozen} frozen, ${uncontrolled} with no controls set. ` +
        cards
          .slice(0, 3)
          .map(
            (c) =>
              `••${c.last_four ?? "????"} ${c.controls === null ? "no controls" : `${c.controls.card_state}, ${c.controls.daily_limit === null ? "no daily limit" : `${c.controls.daily_limit.display}/day`}, ${c.controls.blocked_mccs.length} blocked categor${c.controls.blocked_mccs.length === 1 ? "y" : "ies"}`}, ${c.spend_today.display} approved today`,
          )
          .join("; ") +
        `. ${decisions.length} recent authorisation decision(s), ${declines} declined` +
        (lastDecline === undefined
          ? ""
          : `; the most recent decline was ${lastDecline.amount.display} at ${lastDecline.merchant ?? "an unnamed merchant"} on ${lastDecline.decided_at}, rule ${lastDecline.rule}, network result ${lastDecline.result_code} — ${lastDecline.reason}`) +
        `. Controls can be read here and not changed: that is a real-time authorisation decision and it is not on this surface.`;

  return { summary, data };
}

export const listCardControlsTool: ToolDefinition = {
  name: "list_card_controls",
  title: "List card controls and authorisation decisions",
  description:
    "Each card's current controls — frozen or active, per-transaction, daily and monthly limits, blocked merchant categories, and the approved spend so far today and this month — plus the recent real-time authorisation decisions with the rule that fired, the result code the network was given and the reason. Use this to explain why a card was declined, which nothing else can answer because a declined authorisation never reaches the ledger. Read-only and scoped to the single business this token belongs to; it cannot change a limit, block or unblock a merchant category, freeze or unfreeze a card. Provider card tokens are deliberately not returned.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "List card controls and authorisation decisions",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  readOnly: true,
  parse: (args) => parseArgs(argsSchema, args),
  run: run as ToolDefinition["run"],
};
