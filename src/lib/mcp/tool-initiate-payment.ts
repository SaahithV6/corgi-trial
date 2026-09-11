/**
 * initiate_payment — the one write tool. It queues a request. It does not pay.
 *
 * WHAT THIS TOOL CAN DO: insert one row in `payment_instruction` and one
 * `requested` row in `payment_instruction_event`, attributed to an actor of
 * kind `agent`.
 *
 * WHAT IT CANNOT DO, and why that is structural rather than a promise:
 *
 *   - It cannot post to the journal. Money only moves through
 *     `ledger_append()`, this module never calls it, and nothing downstream of
 *     a `requested` event calls it either. The instruction is a request; the
 *     entry is a consequence of a human releasing it.
 *
 *   - It cannot approve what it queued. `actor` carries
 *     `CHECK (NOT (kind <> 'human' AND can_approve))`, so an agent that can
 *     approve is not a row Postgres will store. On top of that,
 *     `assert_maker_checker()` refuses an `approved` event whose actor is not
 *     a human with `can_approve`, refuses one whose actor is the initiator,
 *     and refuses one citing the wrong content hash. Three independent
 *     refusals, none of them in this file, none of them in TypeScript.
 *     `mcp.integration.test.ts` attempts the approval as this exact agent
 *     against the live database and asserts SQLSTATE 42501.
 *
 *   - It cannot choose the counterparty later. `content_hash` is sha256 over
 *     account, rail, amount, counterparty and value date, and an approval must
 *     cite that hash. Changing any of those five produces a different
 *     instruction rather than an amended one, so "approve $100, submit
 *     $10,000" has no representation.
 *
 * THE RESPONSE SAYS SO IN WORDS. Not because the caller is trusted to read it,
 * but because the caller is usually a language model relaying to a person, and
 * "payment initiated" is a sentence that will get repeated to a customer as
 * "your payment has been sent" unless the tool's own words make that
 * impossible. Every successful response leads with the fact that no money has
 * moved.
 */

import { z } from "zod";

import type { PaymentDestination } from "@/lib/approvals/types";

import { addDays } from "./time";
import { MONEY_SCHEMA, accountCodeString, centsString, isoDateString, money, parseArgs } from "./validate";
import { ToolError, type JsonSchemaObject, type ToolContext, type ToolDefinition, type ToolOutcome } from "./types";

const DEFAULT_ACCOUNT_CODE = "2100";

/** How far ahead an instruction may be dated. Beyond this it is a standing order, which this system does not have. */
const MAX_FORWARD_DAYS = 90;

/**
 * The destination shapes, mapped onto `@/lib/approvals`'s `PaymentDestination`.
 *
 * NOTE WHAT IS ABSENT: a full account number. The approvals module's own
 * schema stores `accountNumberLast4` and its comment says why — the approver
 * needs to RECOGNISE a beneficiary, not to be able to re-key the payment
 * somewhere else, and that row is rendered on a screen. This surface honours
 * the same rule one layer earlier: an agent never handles a full account
 * number, so an agent that is prompt-injected cannot exfiltrate one, and the
 * audit log cannot accidentally become the most sensitive store in the system.
 */
const achDestination = z.strictObject({
  type: z.literal("ach"),
  holder_name: z.string().min(1).max(140),
  routing_number: z.string().regex(/^[0-9]{9}$/, { error: "routing_number must be 9 digits" }),
  account_number_last4: z
    .string()
    .regex(/^[0-9]{4}$/, { error: "the LAST FOUR digits only; this surface never takes a full account number" }),
  account_type: z.enum(["checking", "savings"]),
});

const wireDestination = z.strictObject({
  type: z.literal("wire"),
  holder_name: z.string().min(1).max(140),
  bic: z.string().min(8).max(11),
  account_number_last4: z
    .string()
    .regex(/^[0-9]{4}$/, { error: "the LAST FOUR digits only" }),
});

const usdcDestination = z.strictObject({
  type: z.literal("usdc"),
  chain: z.enum(["ethereum", "base", "base-sepolia", "solana", "polygon"]),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, {
    error: "address must be a 0x-prefixed 20-byte hex address",
  }),
});

const argsSchema = z
  .strictObject({
    // `card` and `internal` are absent on purpose; see the schema note below.
    rail: z.enum(["ach", "usdc", "wire"]),
    amount_cents: centsString,
    currency: z.literal("USD").optional(),
    destination: z.discriminatedUnion("type", [achDestination, wireDestination, usdcDestination]),
    value_date: isoDateString.optional(),
    account_code: accountCodeString.optional(),
    reason: z.string().min(8).max(500),
    idempotency_key: z.string().regex(/^[A-Za-z0-9._:-]{8,120}$/, {
      error:
        "idempotency_key must be 8-120 characters of [A-Za-z0-9._:-], derived from the fact that caused this payment (an invoice id, say) and NOT randomly generated per attempt",
    }),
  })
  .refine((v) => v.rail === v.destination.type, {
    error: "the destination type must match the rail",
    path: ["destination", "type"],
  });

type Args = z.infer<typeof argsSchema>;

const inputSchema: JsonSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    rail: {
      type: "string",
      enum: ["ach", "usdc", "wire"],
      description:
        "Payment rail. card is not an origination rail. internal book transfers are not exposed to this surface because their approval policy requires zero approvals, which would make them the one thing here that could move without a human.",
    },
    amount_cents: {
      type: "string",
      pattern: "^[1-9][0-9]{0,15}$",
      description:
        "Amount in CENTS, as a decimal string. \"125000\" is $1,250.00. Not dollars, and not a JSON number — a double cannot represent every cent value.",
    },
    currency: { type: "string", enum: ["USD"], description: "USD only. Defaults to USD." },
    destination: {
      description:
        "Who is being paid. The shape must match the rail. Note that no shape takes a full bank account number: the last four digits are what an approver checks a beneficiary against, and are all this surface will accept.",
      oneOf: [
        {
          type: "object",
          title: "ACH",
          properties: {
            type: { const: "ach" },
            holder_name: { type: "string", maxLength: 140, description: "Beneficiary legal name." },
            routing_number: { type: "string", pattern: "^[0-9]{9}$", description: "ABA routing number." },
            account_number_last4: {
              type: "string",
              pattern: "^[0-9]{4}$",
              description: "LAST FOUR DIGITS ONLY. A full account number is refused.",
            },
            account_type: { type: "string", enum: ["checking", "savings"] },
          },
          required: ["type", "holder_name", "routing_number", "account_number_last4", "account_type"],
          additionalProperties: false,
        },
        {
          type: "object",
          title: "Wire",
          properties: {
            type: { const: "wire" },
            holder_name: { type: "string", maxLength: 140, description: "Beneficiary legal name." },
            bic: { type: "string", minLength: 8, maxLength: 11, description: "SWIFT/BIC of the receiving bank." },
            account_number_last4: {
              type: "string",
              pattern: "^[0-9]{4}$",
              description: "LAST FOUR DIGITS ONLY.",
            },
          },
          required: ["type", "holder_name", "bic", "account_number_last4"],
          additionalProperties: false,
        },
        {
          type: "object",
          title: "USDC",
          properties: {
            type: { const: "usdc" },
            chain: {
              type: "string",
              enum: ["ethereum", "base", "base-sepolia", "solana", "polygon"],
              description: "This deployment settles USDC on base-sepolia.",
            },
            address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$", description: "Recipient address." },
          },
          required: ["type", "chain", "address"],
          additionalProperties: false,
        },
      ],
    },
    value_date: {
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: `The business day the payment should be dated, book time. Defaults to today. May not be in the past and may not be more than ${MAX_FORWARD_DAYS} days ahead.`,
    },
    account_code: {
      type: "string",
      pattern: "^[0-9]{4}$",
      description:
        "Which of this business's accounts to debit. Defaults to 2100, the business current account.",
    },
    reason: {
      type: "string",
      minLength: 8,
      maxLength: 500,
      description:
        "Why this payment should happen, in plain language, addressed to the human who will approve it. This is the only context the approver gets from you; \"payment\" is not a reason.",
    },
    idempotency_key: {
      type: "string",
      pattern: "^[A-Za-z0-9._:-]{8,120}$",
      description:
        "Derived from the FACT that caused this payment — an invoice number, a payroll run id — not generated fresh per attempt. Replaying a key returns the original instruction and queues nothing new, so a retry after a timeout is safe. A random key per attempt turns one retry into two payments.",
    },
  },
  required: ["rail", "amount_cents", "destination", "reason", "idempotency_key"],
  additionalProperties: false,
};

const outputSchema: JsonSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["queued_for_human_approval"],
      description: "The only status this tool can produce. There is no code path here that pays.",
    },
    money_moved: { type: "boolean", description: "Always false." },
    instruction_id: { type: "string" },
    replayed: {
      type: "boolean",
      description: "True when this idempotency key was already queued; nothing new was written.",
    },
    content_hash: {
      type: "string",
      description:
        "Lowercase hex sha256 over account, rail, amount, destination and value date, computed by @/lib/approvals. An approval must cite this exact hash, so the approved payment and the released payment cannot differ.",
    },
    requested_at: { type: "string" },
    requested_by: {
      type: "object",
      properties: {
        actor_id: { type: "string" },
        kind: { type: "string", enum: ["agent"] },
        can_approve: { type: "boolean", enum: [false] },
      },
      required: ["actor_id", "kind", "can_approve"],
      additionalProperties: false,
    },
    business: {
      type: "object",
      properties: { id: { type: "string" }, legal_name: { type: "string" } },
      required: ["id", "legal_name"],
      additionalProperties: false,
    },
    debit_account: {
      type: "object",
      properties: { code: { type: "string" }, name: { type: "string" } },
      required: ["code", "name"],
      additionalProperties: false,
    },
    amount: MONEY_SCHEMA,
    rail: { type: "string" },
    value_date: { type: "string" },
    approval: {
      type: "object",
      properties: {
        policy_id: { type: "string" },
        effective_from: { type: "string" },
        threshold: MONEY_SCHEMA,
        above_threshold: { type: "boolean" },
        required_human_approvals: { type: "integer" },
        policy_note: { type: "string" },
        self_approval_possible: { type: "boolean", enum: [false] },
        enforced_by: { type: "array", items: { type: "string" } },
      },
      required: [
        "policy_id",
        "effective_from",
        "threshold",
        "above_threshold",
        "required_human_approvals",
        "policy_note",
        "self_approval_possible",
        "enforced_by",
      ],
      additionalProperties: false,
    },
    funds_check: {
      type: "object",
      properties: {
        available_before: MONEY_SCHEMA,
        binding: { type: "boolean", enum: [false] },
        note: { type: "string" },
      },
      required: ["available_before", "binding", "note"],
      additionalProperties: false,
    },
    what_happens_next: { type: "string" },
  },
  required: [
    "status",
    "money_moved",
    "instruction_id",
    "replayed",
    "content_hash",
    "requested_at",
    "requested_by",
    "business",
    "debit_account",
    "amount",
    "rail",
    "value_date",
    "approval",
    "funds_check",
    "what_happens_next",
  ],
  additionalProperties: false,
};

async function run(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const amountCents = BigInt(args.amount_cents);

  if (ctx.grant.maxInstructionCents !== null && amountCents > ctx.grant.maxInstructionCents) {
    // A per-token ceiling. Authentication says who you are; this says how big
    // a thing you may put in front of a person.
    throw new ToolError(
      "ABOVE_TOKEN_CEILING",
      `this token may queue at most ${money(ctx.grant.maxInstructionCents).display} per instruction; ${money(amountCents).display} was requested`,
      {
        requested: money(amountCents),
        ceiling: money(ctx.grant.maxInstructionCents),
      },
    );
  }

  const valueDate = args.value_date ?? ctx.bookToday;
  if (valueDate < ctx.bookToday) {
    // Backdating money OUT is not a correction, it is a claim that a payment
    // already happened. Corrections go through reversal-and-rebook, by a human.
    throw new ToolError(
      "VALUE_DATE_IN_THE_PAST",
      `value_date ${valueDate} is before today (${ctx.bookToday}); an outbound payment cannot be backdated through this surface`,
    );
  }
  const latest = addDays(ctx.bookToday, MAX_FORWARD_DAYS);
  if (valueDate > latest) {
    throw new ToolError(
      "VALUE_DATE_TOO_FAR_AHEAD",
      `value_date ${valueDate} is more than ${MAX_FORWARD_DAYS} days ahead (latest is ${latest}); this system has no standing orders`,
    );
  }

  const code = args.account_code ?? DEFAULT_ACCOUNT_CODE;
  const account = await ctx.gateway.findAccount(ctx.grant.businessId, code);
  if (account === null) {
    throw new ToolError(
      "ACCOUNT_NOT_FOUND",
      `${ctx.grant.businessLegalName} has no open account with code ${code}`,
      { account_code: code },
    );
  }
  if (!account.isPostable || account.book !== "financial") {
    throw new ToolError(
      "ACCOUNT_NOT_PAYABLE",
      `account ${code} (${account.name}) is a ${account.book}-book or non-postable account and cannot fund a payment`,
    );
  }

  // Pre-flight only. The binding check is at release, against the balance at
  // that moment — an available balance from thirty seconds ago is a fact about
  // the past, and a card authorisation can land in between.
  const snapshot = await ctx.gateway.balanceNow(ctx.grant.businessId, account.accountId);
  if (amountCents > snapshot.availableCents) {
    throw new ToolError(
      "INSUFFICIENT_AVAILABLE_FUNDS",
      `${money(amountCents).display} exceeds the available balance of ${money(snapshot.availableCents).display} on account ${code}. Nothing was queued: putting a payment that cannot fund in front of an approver wastes the scarcest resource in this design.`,
      {
        requested: money(amountCents),
        available: money(snapshot.availableCents),
        ledger: money(snapshot.ledgerCents),
        held: money(
          snapshot.holdsCents + snapshot.unclearedCents + snapshot.pendingOutboundCents,
        ),
      },
    );
  }

  const destination = toDestination(args);

  // Namespaced by tenant and by the agent actor, so one token's key can never
  // collide with — or be used to probe for — another's instruction.
  const idempotencyKey = `mcp:${ctx.grant.businessId}:${ctx.grant.actorId}:${args.idempotency_key}`;

  // Everything from here is the approvals module's: it picks the policy
  // version in force on the value date, computes the content hash over its own
  // canonical preimage, writes the instruction and its `requested` event in
  // one transaction, and folds the state back out of the event stream. There
  // is no second implementation of any of it on this surface.
  const queued = await ctx.gateway.queuePayment({
    accountId: account.accountId,
    rail: args.rail,
    amountCents,
    currency: args.currency ?? "USD",
    destination,
    valueDate,
    requestedByActorId: ctx.grant.actorId,
    idempotencyKey,
  });

  const policy = queued.policy;
  const requiredApprovals = queued.approvalsRequired;

  const data = {
    status: "queued_for_human_approval" as const,
    money_moved: false,
    instruction_id: queued.instructionId,
    replayed: queued.replayed,
    state: queued.state,
    content_hash: queued.contentHash,
    requested_at: queued.requestedAt,
    requested_by: {
      actor_id: ctx.grant.actorId,
      kind: "agent" as const,
      can_approve: false,
    },
    business: { id: ctx.grant.businessId, legal_name: ctx.grant.businessLegalName },
    debit_account: { code: account.code, name: account.name },
    amount: money(amountCents),
    rail: args.rail,
    value_date: valueDate,
    approval: {
      policy_id: policy.policyId,
      policy_version: policy.version,
      effective_from: policy.effectiveFrom,
      threshold: money(policy.thresholdCents),
      above_threshold: queued.aboveThreshold,
      required_human_approvals: requiredApprovals,
      approvals_held: queued.approvalsHeld,
      policy_note: policy.note,
      self_approval_possible: false as const,
      enforced_by: [
        "actor.actor_only_humans_approve — CHECK (NOT (kind <> 'human' AND can_approve)): an agent that can approve is not a storable row",
        "assert_maker_checker() — refuses an 'approved' event whose actor is not a human approver",
        "assert_maker_checker() — refuses an 'approved' event whose actor is the initiator",
        "assert_maker_checker() — refuses an 'approved' event citing a different content_hash",
        "payment_instruction_event.pie_one_decision_per_actor — one actor cannot approve twice to satisfy a two-approver rule",
      ],
    },
    funds_check: {
      available_before: money(snapshot.availableCents),
      binding: false as const,
      note: "Checked when this instruction was queued, not when it will be released. The balance at release is what actually governs.",
    },
    what_happens_next:
      requiredApprovals === 0
        ? `This instruction is below the ${money(policy.thresholdCents).display} threshold for ${policy.rail} under policy ${policy.version}, so policy requires no second human. It is still queued and unreleased: this surface has no operation that approves, submits or releases a payment, and nothing leaves the account until a person releases it in the approval queue.`
        : `A human approver who is not the initiator must approve this instruction ${requiredApprovals === 1 ? "once" : `${requiredApprovals} times, by ${requiredApprovals} distinct people`} before it can be released. The agent that requested it cannot be one of them.`,
  };

  const summary =
    `NO MONEY HAS MOVED. ${
      queued.replayed
        ? "This idempotency key was already queued, so nothing new was written; a"
        : "A"
    }` +
    ` payment instruction for ${money(amountCents).display} by ${args.rail} to ${describeDestination(destination)} ` +
    `dated ${valueDate} is sitting in the approval queue as instruction ${queued.instructionId}, state "${queued.state}". ` +
    `It debits ${account.name} only if and when a human releases it. ` +
    (requiredApprovals === 0
      ? `Policy ${policy.version} requires no second approver below ${money(policy.thresholdCents).display}, but this surface still cannot release it.`
      : `It needs ${requiredApprovals} human approval(s) from someone other than the requester; it holds ${queued.approvalsHeld}.`) +
    ` This agent cannot approve it: the actor table forbids a non-human approver and the maker-checker trigger refuses the initiator.`;

  return { summary, data };
}

/** MCP's snake_case arguments to the approvals module's own destination type. */
function toDestination(args: Args): PaymentDestination {
  switch (args.destination.type) {
    case "ach":
      return {
        type: "ach",
        holderName: args.destination.holder_name,
        routingNumber: args.destination.routing_number,
        accountNumberLast4: args.destination.account_number_last4,
        accountType: args.destination.account_type,
      };
    case "wire":
      return {
        type: "wire",
        holderName: args.destination.holder_name,
        bic: args.destination.bic,
        accountNumberLast4: args.destination.account_number_last4,
      };
    case "usdc":
      return {
        type: "usdc",
        chain: args.destination.chain,
        address: args.destination.address,
      };
  }
}

/** One line an approver — or a model relaying to one — can recognise. */
function describeDestination(destination: PaymentDestination): string {
  switch (destination.type) {
    case "ach":
      return `${destination.holderName} (ACH ${destination.routingNumber} ••${destination.accountNumberLast4})`;
    case "wire":
      return `${destination.holderName} (wire ${destination.bic} ••${destination.accountNumberLast4})`;
    case "usdc":
      return `${destination.address.slice(0, 6)}…${destination.address.slice(-4)} on ${destination.chain}`;
    case "internal":
      return `${destination.holderName} (internal book transfer)`;
  }
}

export const initiatePaymentTool: ToolDefinition = {
  name: "initiate_payment",
  title: "Initiate payment (queues for human approval)",
  description:
    "Queue an outbound payment for HUMAN APPROVAL. This tool does not pay anyone. It writes one payment_instruction and one 'requested' event attributed to this agent, and no journal entry exists until a person releases it. The agent cannot approve what it queued: the actor table makes an approving agent unrepresentable and the maker-checker trigger refuses the initiator. Replaying an idempotency_key returns the original instruction and queues nothing new.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "Initiate payment (queues for human approval)",
    // Writes a row, so not read-only.
    readOnlyHint: false,
    // Not destructive: it adds a request to a queue. Nothing is overwritten,
    // nothing is spent, and the row is append-only.
    destructiveHint: false,
    // Same idempotency_key, same instruction, no second row.
    idempotentHint: true,
    openWorldHint: false,
  },
  readOnly: false,
  parse: (args) => parseArgs(argsSchema, args),
  run: run as ToolDefinition["run"],
};
