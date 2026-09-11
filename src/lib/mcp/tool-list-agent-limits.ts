/**
 * list_agent_limits — the operations this surface refuses, and why.
 *
 * ===========================================================================
 * THE PROBLEM THIS SOLVES IS NOT DOCUMENTATION
 * ===========================================================================
 *
 * Every other tool here answers a question about money. This one answers the
 * question a model asks first and that nothing on the surface could previously
 * answer: **what am I allowed to do, and what happens if I try the rest?**
 *
 * Before this tool, the answer to the second half was
 * `INVALID_PARAMS: unknown tool "approve_payment"`. That is the worst
 * available answer, because "unknown" is indistinguishable from a typo, a
 * version skew, or a capability that exists under another name — so a model
 * retries with `approve_instruction`, then `sign_off`, then invents a
 * workaround, then tells the customer the bank's software is broken. None of
 * those behaviours is a security failure and every one of them is a support
 * ticket, and the last one is a lie told confidently on our behalf.
 *
 * `docs/AGENT-LIMITS.md` had the answer the whole time. The agent could not
 * read it. This tool is that document served through the protocol, generated
 * from `limits.ts` rather than transcribed — so the policy and the executable
 * cannot drift, and `limits.test.ts` fails the build if a refused tool name
 * ever appears in the registry.
 *
 * ===========================================================================
 * WHY IT RETURNS THE ARGUMENT AND NOT THE RULE
 * ===========================================================================
 *
 * "You may not change card controls" is a sentence a model will try to route
 * around, because it reads as a permissions problem and models are helpful.
 * "A control change IS a real-time authorisation decision made in advance, and
 * no approval queue will ever see it" is a sentence about what KIND OF THING
 * the operation is, and it generalises: a model holding that sentence will also
 * decline to suggest raising the limit instead, which is the same act in a
 * quieter register.
 *
 * Each refusal therefore carries four things: the argument, whether the
 * database refuses it or we merely do not offer it, the constraint or guard
 * test that enforces it, and where the operation actually lives. That last
 * field is the one that stops the tool being a wall — a refusal with no
 * forward path is how an agent ends up inventing one.
 *
 * ===========================================================================
 * SCOPING
 * ===========================================================================
 *
 * This tool reads no customer data at all — it touches no table, and the
 * gateway is not consulted. It is still behind the same bearer token, the same
 * per-token rate limit and the same audit record as everything else, and it
 * echoes the granted business so a caller can see which tenant it is speaking
 * for. The strongest scoping statement available about it is that there is
 * nothing here to scope: the same answer is correct for every business,
 * because the refusals are properties of the surface and not of a customer.
 */

import { z } from "zod";

import {
  DEBATABLE,
  PRINCIPLE,
  REFUSALS,
  findRefusals,
  type Refusal,
} from "./limits";
import { parseArgs } from "./validate";
import type { JsonSchemaObject, ToolContext, ToolDefinition, ToolOutcome } from "./types";

/**
 * The registry, fetched at call time rather than imported at module scope.
 *
 * This is the one genuine import cycle on the surface and it is inherent to
 * what this tool is: `tools.ts` must import this module to register the tool,
 * and this module wants the registry so that the "what you CAN do" half of its
 * answer is the real list rather than a second copy that drifts. A static
 * import in both directions means `tools.ts` evaluates its `TOOLS` array while
 * this module's export is still uninitialised, and the array gets an
 * `undefined` in it — which is not a subtle failure, but it is one that
 * depends on which file the test runner loads first.
 *
 * A dynamic import breaks the cycle at the only point where breaking it costs
 * nothing: `run` is already async, and by the time any tool runs the whole
 * graph has been evaluated. The alternative — typing the list out again here —
 * would make this tool's most important claim ("these are the tools that
 * exist") the one thing about it that could be wrong.
 */
async function registry(): Promise<{
  readonly READ_TOOLS: readonly ToolDefinition[];
  readonly WRITE_TOOLS: readonly ToolDefinition[];
}> {
  return import("./tools");
}

const argsSchema = z.strictObject({
  operation: z.string().min(1).max(200).optional(),
  include_debatable: z.boolean().optional(),
});

type Args = z.infer<typeof argsSchema>;

const inputSchema: JsonSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    operation: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "What you were about to try, in your own words, or the name of a tool you guessed at — \"approve_payment\", \"unblock the fuel category on the ops card\", \"move money out of the payroll pot\". Matches generously: it is better to be shown three sections than none. Omit to get the whole list.",
    },
    include_debatable: {
      type: "boolean",
      description:
        "Include the refusals we consider genuinely arguable, with the case against our own position. Default true. Useful when relaying to a person, because \"this is deliberate and here is the argument against it\" is a better answer than \"no\".",
    },
  },
  required: [],
  additionalProperties: false,
};

const refusalSchema = {
  type: "object",
  properties: {
    section: {
      type: "integer",
      description: "Section number in docs/AGENT-LIMITS.md, where the long-form argument lives.",
    },
    operation: { type: "string", description: "The operation, named the way a person would ask." },
    absent_tools: {
      type: "array",
      items: { type: "string" },
      description:
        "Tool names that do not exist on this server, including the plausible misspellings. Calling one returns an unknown-tool error; this list is why.",
    },
    why: {
      type: "string",
      description:
        "The argument, not the rule. Says what kind of thing the operation is, so the reasoning generalises to operations not on this list.",
    },
    guarantee: {
      type: "string",
      enum: ["unrepresentable", "capability-absent"],
      description:
        "unrepresentable = the database refuses the row from any connection, ours included. capability-absent = the code that performs it is not in this process, and a guard test fails the build if anyone imports it. These are different promises and are not flattened into one.",
    },
    enforced_by: {
      type: "array",
      items: { type: "string" },
      description:
        "The specific constraint, trigger, revoked grant or guard test. A refusal that cannot be pointed at is a promise.",
    },
    instead: {
      type: "string",
      description:
        "The read tool that answers the underlying question, or the human who holds the pen. Relay this rather than the refusal alone.",
    },
  },
  required: ["section", "operation", "absent_tools", "why", "guarantee", "enforced_by", "instead"],
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
    query: {
      type: ["string", "null"],
      description: "The operation you asked about, echoed. Null when the whole list was returned.",
    },
    matched: { type: "integer", description: "How many refusals matched." },
    total_refusals: { type: "integer", description: "How many exist in total." },
    refusals: { type: "array", items: refusalSchema },
    what_you_can_do: {
      type: "object",
      description: "The other side of the same list: the tools that DO exist.",
      properties: {
        read_tools: { type: "array", items: { type: "string" } },
        write_tools: { type: "array", items: { type: "string" } },
        write_tools_note: { type: "string" },
      },
      required: ["read_tools", "write_tools", "write_tools_note"],
      additionalProperties: false,
    },
    principle: {
      type: "array",
      items: { type: "string" },
      description:
        "The rule every refusal is an instance of. Carries the test for operations nobody has written a section about yet.",
    },
    debatable: {
      type: "array",
      description:
        "Refusals we consider genuinely arguable, each with the case against our own position.",
      items: {
        type: "object",
        properties: {
          topic: { type: "string" },
          position: { type: "string" },
          case_against: { type: "string" },
        },
        required: ["topic", "position", "case_against"],
        additionalProperties: false,
      },
    },
    note: { type: "string" },
  },
  required: [
    "business",
    "query",
    "matched",
    "total_refusals",
    "refusals",
    "what_you_can_do",
    "principle",
    "debatable",
    "note",
  ],
  additionalProperties: false,
};

function render(refusal: Refusal): Record<string, unknown> {
  return {
    section: refusal.section,
    operation: refusal.operation,
    absent_tools: [...refusal.absentTools],
    why: refusal.why,
    guarantee: refusal.guarantee,
    enforced_by: [...refusal.enforcedBy],
    instead: refusal.instead,
  };
}

async function run(args: Args, ctx: ToolContext): Promise<ToolOutcome> {
  const includeDebatable = args.include_debatable ?? true;
  const query = args.operation ?? null;
  const matched = query === null ? REFUSALS : findRefusals(query);
  const { READ_TOOLS, WRITE_TOOLS } = await registry();

  const unrepresentable = matched.filter((r) => r.guarantee === "unrepresentable");

  const data = {
    business: { id: ctx.grant.businessId, legal_name: ctx.grant.businessLegalName },
    query,
    matched: matched.length,
    total_refusals: REFUSALS.length,
    refusals: matched.map(render),
    what_you_can_do: {
      read_tools: READ_TOOLS.map((t) => t.name),
      write_tools: WRITE_TOOLS.map((t) => t.name),
      write_tools_note:
        "initiate_payment is the only tool on this surface that writes anything, and what it writes is a request in the same approval queue a person's request lands in. When it succeeds, NOTHING HAS BEEN PAID. It cannot approve, release, submit or cancel what it wrote, and neither can any other agent.",
    },
    principle: [...PRINCIPLE],
    debatable: includeDebatable
      ? DEBATABLE.map((d) => ({
          topic: d.topic,
          position: d.position,
          case_against: d.caseAgainst,
        }))
      : [],
    note:
      "This list is generated from the same module the guard tests read, so it cannot drift from the surface it describes: if a tool named in absent_tools ever appeared in the registry, the build would fail before it shipped. Relay the `instead` field, not the refusal alone — every one of these operations exists in the product and is done by a person, and an agent that says only \"I cannot\" is why someone invents a workaround.",
  };

  const headline =
    query === null
      ? `${REFUSALS.length} operations are deliberately not available to an agent on this surface`
      : matched.length === 0
        ? `Nothing on the refusal list matches "${query}". That is not permission: this surface has exactly ${
            READ_TOOLS.length
          } read tools and ${
            WRITE_TOOLS.length
          } write tool, and anything not in tools/list simply does not exist here`
        : `${matched.length} of ${REFUSALS.length} refusals match "${query}"`;

  const lead = matched[0];
  const detail =
    lead === undefined
      ? ""
      : ` The closest is §${lead.section}, ${lead.operation.toLowerCase()} — ${
          lead.guarantee === "unrepresentable"
            ? "which the database refuses outright, from any connection"
            : "which is not code this process holds at all"
        }. ${lead.instead}`;

  const strength =
    unrepresentable.length === 0
      ? "None of the matches is enforced by the schema; every one is enforced by the capability not being in this process, which is a real guarantee and a weaker one."
      : `${unrepresentable.length} of the matches ${
          unrepresentable.length === 1 ? "is" : "are"
        } enforced by the schema rather than by this tool list, meaning no connection can write the row — ours included.`;

  const summary =
    `${headline}. ` +
    `${strength} ` +
    detail +
    ` The rule underneath all of them: an agent may state an intention, it may not make a fact final, and it may not change the rules that decide what is final.`;

  return { summary, data };
}

export const listAgentLimitsTool: ToolDefinition = {
  name: "list_agent_limits",
  title: "What this agent surface refuses, and why",
  description:
    "The operations this bank deliberately does not hand an autonomous agent, each with the argument for refusing it, whether the database makes it impossible or the capability is merely absent, the constraint or guard test that enforces it, and where the operation actually lives instead. Call this BEFORE telling anyone an operation is unsupported, and call it when a tool you expected is missing from tools/list — \"unknown tool\" means the name was refused on purpose, and this says why. Pass `operation` with the thing you were about to try, in your own words. Read-only, scoped to the single business this token belongs to, and it reads no customer data at all: the same answer is correct for every business, because these are properties of the surface and not of an account.",
  inputSchema,
  outputSchema,
  annotations: {
    title: "What this agent surface refuses, and why",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  readOnly: true,
  parse: (args) => parseArgs(argsSchema, args),
  run: run as ToolDefinition["run"],
};
