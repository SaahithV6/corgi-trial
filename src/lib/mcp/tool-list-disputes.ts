/**
 * list_disputes — card disputes, what has been advanced, and what is held.
 *
 * ===========================================================================
 * WHY THIS TOOL EXISTS, AND IT IS NOT "DISPUTES SHIPPED, SO EXPOSE DISPUTES"
 * ===========================================================================
 *
 * Every reader on this surface was added because its absence made an agent
 * CONFIDENTLY WRONG rather than merely unhelpful. Disputes produce three such
 * answers, and they are the worst three on the surface so far, because all
 * three are about money the customer can see.
 *
 * 1. **"You have an unexplained hold of $73.40."** A provisional credit is
 *    advanced INTO the customer's ledger balance and immediately held, which
 *    is precisely what makes a later clawback safe — the money was never
 *    spendable, so taking it back cannot overdraw anyone. To `get_balance`
 *    that is a hold with no card behind it, and an agent reading the balance
 *    alone will attribute it to a pending card authorisation. It will then
 *    tell a customer to wait for a merchant to clear, about money the bank
 *    advanced them and is holding on purpose.
 *
 * 2. **"You were charged twice."** A lost dispute's clawback is a NEW EVENT,
 *    not a correction: two entries, two value dates, neither one a reversal.
 *    That is deliberate — the grant really happened on its day and the
 *    clawback really happened on the decision day, and rewriting the first
 *    would be a lie about what the books believed in between. But to
 *    `list_transactions` it looks exactly like a duplicate debit, and
 *    "duplicate charge" is the single most expensive thing an agent can say
 *    wrongly, because it is itself a dispute reason.
 *
 * 3. **"Nothing is waiting on you."** A case sitting at `raised` with
 *    `needs_authorization` true is waiting on a named Corgi human, and it has
 *    a hard deadline — `network_outside_date`, after which there is no case
 *    left to make. Neither the queue nor the deadline is a journal row, so no
 *    amount of reading transactions finds them.
 *
 * ===========================================================================
 * WHAT IS PROJECTED, AND WHAT IS NOT RE-DECIDED
 * ===========================================================================
 *
 * `status` here is `v_dispute_state`'s status, which is a FOLD OVER THE EVENT
 * STREAM and not a column anybody set. `advanced` and `held` are sums over the
 * postings the case actually made. So a case that says it advanced $73.40
 * advanced $73.40 — there is no status field that could claim one thing while
 * the ledger said another, and this file does not introduce one. The status
 * meanings come from `DISPUTE_STATUS_MEANING` in `@/lib/disputes/model`, the
 * same sentences the disputes screen renders, so a person and an agent
 * describing the same case describe it identically.
 *
 * ===========================================================================
 * READ ONLY, AND THIS WAS THE CLOSEST CALL ON THE SURFACE
 * ===========================================================================
 *
 * A dispute intake moves no money and the credit that does move money needs a
 * Corgi human who is not the raiser — so on the `initiate_payment` test
 * ("would a person see this before the consequence?") a `raise_dispute` tool
 * passes. It is refused on a different test, in docs/AGENT-LIMITS.md §17: a
 * payment instruction is a REQUEST and an unapproved one simply expires, while
 * a dispute is an ASSERTION OF FACT that is durable from the moment it is
 * written — it starts the network clock, it creates work someone must do, and
 * because the event stream is append-only a withdrawal is another event rather
 * than an erasure. §18 covers the credit itself, which the schema makes
 * unrepresentable for an agent rather than merely absent.
 */

import { z } from "zod";

import { DISPUTE_STATUSES, DISPUTE_STATUS_MEANING, type DisputeStatus } from "@/lib/disputes/model";

import { MONEY_SCHEMA, money, parseArgs } from "./validate";
import type { JsonSchemaObject, ToolContext, ToolDefinition, ToolOutcome } from "./types";

const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 10;

const argsSchema = z.strictObject({
  status: z.enum(DISPUTE_STATUSES).optional(),
  open_only: z.boolean().optional(),
  include_events: z.boolean().optional(),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
});

type Args = z.infer<typeof argsSchema>;

const inputSchema: JsonSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: [...DISPUTE_STATUSES],
      description:
        "Restrict to one status. Statuses are folded from the case's event stream, not stored, so they cannot disagree with the postings. Naming a status overrides open_only.",
    },
    open_only: {
      type: "boolean",
      description:
        "Only cases that are still live. Default true. Closed cases are never hidden from a person; they are excluded here so an agent's default view is the work still outstanding. The counts below always cover both.",
    },
    include_events: {
      type: "boolean",
      description:
        "Include the case timeline — every transition with who made it and what it posted. Default true: \"who authorised the credit\" is the question this answers, and the answer is always a named human, which is worth showing rather than asserting.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LIMIT,
      description: `Maximum cases to return, 1-${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}. The open and closed counts are over ALL cases, never over the page.`,
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
    cases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dispute_id: { type: "string" },
          case_ref: { type: "string", description: "The reference a customer quotes." },
          disputed_entry_id: {
            type: "string",
            description:
              "The settled card journal entry under dispute. Only a card-rail entry in the financial book can be disputed — never an authorisation, never a provisional credit.",
          },
          reason: { type: "string", description: "OUR word for the claim, not the network's code." },
          network: { type: "string" },
          network_code: { type: "string", description: "The network's own reason code." },
          narrative: { type: "string" },
          amount_claimed: MONEY_SCHEMA,
          status: { type: "string", enum: [...DISPUTE_STATUSES] },
          status_meaning: {
            type: "string",
            description: "One sentence, the same one the disputes screen shows a person.",
          },
          is_closed: { type: "boolean" },
          raised_by: { type: "string" },
          raised_at: { type: "string" },
          value_date: { type: "string" },
          decided_on: { type: ["string", "null"], description: "The day the network's verdict landed." },
          network_outside_date: {
            type: "string",
            description: "The network's deadline. After it there is no case left to make.",
          },
          days_to_outside_date: {
            type: "integer",
            description: "Negative once the deadline has passed. Worth escalating below about 10.",
          },
          advanced: {
            allOf: [MONEY_SCHEMA],
            description:
              "Provisional credit actually advanced to the customer, summed from the postings. Zero until a second human authorises and grants it.",
          },
          held: {
            allOf: [MONEY_SCHEMA],
            description:
              "How much of that advance is still encumbered. This is IN the ledger balance and NOT in available balance — that is what makes a later clawback safe, and it is why get_balance shows a hold with no card behind it.",
          },
          hold_released: { type: ["boolean", "null"] },
          awaiting: {
            type: "object",
            description: "What the case is waiting on, if anything.",
            properties: {
              needs_authorization: { type: "boolean" },
              authorizations_held: { type: "integer" },
              authorizations_required: { type: "integer" },
              authorization_threshold: MONEY_SCHEMA,
              who: {
                type: "string",
                description:
                  "Plain English. Always a named human when money is involved — the authoriser must be a Corgi approver with no business of their own who is not the raiser.",
              },
            },
            required: [
              "needs_authorization",
              "authorizations_held",
              "authorizations_required",
              "authorization_threshold",
              "who",
            ],
            additionalProperties: false,
          },
          events: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: { type: "string" },
                occurred_at: { type: "string" },
                value_date: { type: "string" },
                actor: { type: "string" },
                actor_kind: { type: "string", enum: ["human", "agent", "system"] },
                amount: { anyOf: [MONEY_SCHEMA, { type: "null" }] },
                entry_id: { type: ["string", "null"] },
                detail: { type: ["string", "null"] },
              },
              required: [
                "kind",
                "occurred_at",
                "value_date",
                "actor",
                "actor_kind",
                "amount",
                "entry_id",
                "detail",
              ],
              additionalProperties: false,
            },
          },
        },
        required: [
          "dispute_id",
          "case_ref",
          "disputed_entry_id",
          "reason",
          "network",
          "network_code",
          "narrative",
          "amount_claimed",
          "status",
          "status_meaning",
          "is_closed",
          "raised_by",
          "raised_at",
          "value_date",
          "decided_on",
          "network_outside_date",
          "days_to_outside_date",
          "advanced",
          "held",
          "hold_released",
          "awaiting",
          "events",
        ],
        additionalProperties: false,
      },
    },
    counts: {
      type: "object",
      properties: {
        open: { type: "integer", description: "Across ALL cases, not the page." },
        closed: { type: "integer" },
        returned: { type: "integer" },
        awaiting_authorization: { type: "integer", description: "On the page." },
      },
      required: ["open", "closed", "returned", "awaiting_authorization"],
      additionalProperties: false,
    },
    totals: {
      type: "object",
      properties: {
        claimed: { allOf: [MONEY_SCHEMA], description: "Σ amount claimed across the page." },
        advanced: { allOf: [MONEY_SCHEMA], description: "Σ provisional credit advanced, page." },
        held: {
          allOf: [MONEY_SCHEMA],
          description:
            "Σ still encumbered, page. Reconcile this against the hold figure in get_balance before calling any hold unexplained.",
        },
      },
      required: ["claimed", "advanced", "held"],
      additionalProperties: false,
    },
    truncated: { type: "boolean" },
    note: { type: "string" },
  },
  required: [
    "business",
    "as_of_book_date",
    "cases",
    "counts",
    "totals",
    "truncated",
    "note",
  ],
  additionalProperties: false,
};

/** What the case is waiting on, as a sentence a person can act on. */
function awaitingSentence(args: {
  readonly status: string;
  readonly isClosed: boolean;
  readonly needsAuthorization: boolean;
  readonly authorizations: number;
  readonly requiredApprovals: number;
}): string {
  if (args.isClosed) return "Nothing — the case is closed.";
  if (args.needsAuthorization) {
    const outstanding = Math.max(0, args.requiredApprovals - args.authorizations);
    return (
      `A second human. ${args.authorizations} of ${args.requiredApprovals} authorisation(s) held; ` +
      `${outstanding} still needed before provisional credit can be advanced. The authoriser must be a Corgi ` +
      `approver with no business of their own, and it can never be whoever raised the case — the database ` +
      `refuses the row otherwise. No agent can hold one of these.`
    );
  }
  if (args.status === "evidence_submitted") return "The network. Evidence is filed and a verdict is pending.";
  if (args.status === "won_pending_finalization") {
    return "An operator, to finalise the credit and release the hold.";
  }
  if (args.status === "lost_pending_recovery") {
    return "An operator, to claw the advance back or write it off.";
  }
  if (args.status === "provisional_credit_granted") {
    return "The network's verdict. The money is with the customer and held until it lands.";
  }
  return "An operator, to work the case.";
}

async function run(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const limit = args.limit ?? DEFAULT_LIMIT;
  const includeEvents = args.include_events ?? true;

  const page = await ctx.gateway.listDisputes(ctx.grant.businessId, {
    status: args.status ?? null,
    openOnly: args.open_only ?? true,
    includeEvents,
    limit,
  });

  const cases = page.cases.map((row) => ({
    dispute_id: row.disputeId,
    case_ref: row.caseRef,
    disputed_entry_id: row.disputedEntryId,
    reason: row.reason,
    network: row.network,
    network_code: row.networkCode,
    narrative: row.narrative,
    amount_claimed: money(row.amountCents),
    status: row.status,
    status_meaning: DISPUTE_STATUS_MEANING[row.status as DisputeStatus] ?? "",
    is_closed: row.isClosed,
    raised_by: row.raisedByName,
    raised_at: row.raisedAt,
    value_date: row.valueDate,
    decided_on: row.decidedOn,
    network_outside_date: row.networkOutsideDate,
    days_to_outside_date: row.daysToOutsideDate,
    advanced: money(row.advancedCents),
    held: money(row.heldCents),
    hold_released: row.holdReleased,
    awaiting: {
      needs_authorization: row.needsAuthorization,
      authorizations_held: row.authorizations,
      authorizations_required: row.requiredApprovals,
      authorization_threshold: money(row.thresholdCents),
      who: awaitingSentence({
        status: row.status,
        isClosed: row.isClosed,
        needsAuthorization: row.needsAuthorization,
        authorizations: row.authorizations,
        requiredApprovals: row.requiredApprovals,
      }),
    },
    events: row.events.map((event) => ({
      kind: event.kind,
      occurred_at: event.occurredAt,
      value_date: event.valueDate,
      actor: event.actorName,
      actor_kind: event.actorKind,
      amount: event.amountCents === null ? null : money(event.amountCents),
      entry_id: event.entryId,
      detail: event.detail,
    })),
  }));

  // bigint throughout. `BigInt(x.cents)` and not `Number(...)`: the display
  // string is for people and the cents string is the number.
  const claimed = cases.reduce((acc, c) => acc + BigInt(c.amount_claimed.cents), 0n);
  const advanced = cases.reduce((acc, c) => acc + BigInt(c.advanced.cents), 0n);
  const held = cases.reduce((acc, c) => acc + BigInt(c.held.cents), 0n);
  // `needs_authorization` is a property of the CLAIM — the amount is at or
  // above the policy threshold — and it stays true on a case that has since
  // closed. Counting it without the `is_closed` guard produced a summary
  // reading "2 case(s) are waiting on a second human" about two cases that
  // were decided and settled weeks ago, which is exactly the confidently wrong
  // sentence this tool exists to prevent. Caught against live rows.
  const awaitingCount = cases.filter(
    (c) => !c.is_closed && c.awaiting.needs_authorization,
  ).length;
  const urgent = cases.filter((c) => !c.is_closed && c.days_to_outside_date <= 10);

  const data = {
    business: { id: ctx.grant.businessId, legal_name: ctx.grant.businessLegalName },
    as_of_book_date: ctx.bookToday,
    cases,
    counts: {
      open: page.openCount,
      closed: page.closedCount,
      returned: cases.length,
      awaiting_authorization: awaitingCount,
    },
    totals: { claimed: money(claimed), advanced: money(advanced), held: money(held) },
    truncated: cases.length === limit,
    note:
      "Two things here are easy to report wrongly. (1) Provisional credit is advanced INTO the ledger balance and held, so it shows up in get_balance as a hold with no card behind it — check `held` above before describing any hold as a pending card authorisation. (2) A clawback on a lost case is a NEW entry and not a reversal, so list_transactions shows the grant and the clawback as two separate postings on two value dates; that is the corrected history, not a duplicate charge. This tool reads only: an agent cannot raise, withdraw or progress a case, and it can never authorise or grant provisional credit — the database refuses an authorisation by any non-human, by the raiser, or by anyone belonging to the disputing business.",
  };

  const summary =
    cases.length === 0
      ? `No ${args.status ?? (args.open_only === false ? "" : "open ")}dispute cases for ${ctx.grant.businessLegalName}. ` +
        `${page.openCount} open and ${page.closedCount} closed case(s) exist in total.`
      : `${cases.length} dispute case(s) for ${ctx.grant.businessLegalName} (${page.openCount} open, ${page.closedCount} closed in total), ` +
        `${money(claimed).display} claimed, ${money(advanced).display} advanced as provisional credit, of which ${money(held).display} is still held and therefore NOT spendable. ` +
        (awaitingCount === 0
          ? "Nothing is waiting on an authorisation. "
          : `${awaitingCount} case(s) are waiting on a second human to authorise the advance; no agent can be that human. `) +
        (urgent.length === 0
          ? ""
          : `${urgent.length} case(s) are within 10 days of the network's outside date — ${urgent
              .map((c) => `${c.case_ref} (${c.days_to_outside_date}d)`)
              .join(", ")}. `) +
        `Status is folded from each case's event stream, so it cannot disagree with what was posted.`;

  return { summary, data };
}

export const listDisputesTool: ToolDefinition = {
  name: "list_disputes",
  title: "List card disputes and provisional credit",
  description:
    "Card disputes for this business: the claim, the settled card entry it is against, the status folded from the case's own event stream, how much provisional credit has been advanced, how much of it is still held, what the case is waiting on, the network's outside date, and the full timeline with who made each transition. Call this before describing an unexplained hold — a provisional credit sits in the ledger balance and is held, so get_balance shows it as a hold with no card behind it — and before calling a clawback a duplicate charge, because a clawback is a new entry rather than a reversal and appears beside the original in list_transactions. Read-only and scoped to the single business this token belongs to; it cannot raise, withdraw or progress a case, and it cannot authorise or grant provisional credit.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "List card disputes and provisional credit",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  readOnly: true,
  parse: (args) => parseArgs(argsSchema, args),
  run: run as ToolDefinition["run"],
};
