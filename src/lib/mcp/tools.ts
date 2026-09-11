/**
 * The tool registry. Eleven entries, ten of which only read, and the list is
 * closed.
 *
 * Adding a twelfth is a deliberate act that should be argued for in
 * docs/AGENT-LIMITS.md before it is argued for here, because the interesting
 * property of this surface is not what it can do — it is the SHAPE of the set.
 * Reads are cheap to justify: the worst case is that an agent says something
 * true that nobody asked about. Writes are not, and the count of them has gone
 * from one to one while the reads went from three to ten. That asymmetry is
 * the design, not an accident of what was ready.
 *
 * Every read here answers a question the surface could not answer before, and
 * each one was added because its absence made an agent CONFIDENTLY WRONG
 * rather than merely unhelpful:
 *
 *   list_pots             get_balance reads the main leaf, so money in a pot
 *                         was invisible and "you have $X" was understated.
 *   list_payees           a destination composed from an invoice had nothing
 *                         to be checked against.
 *   list_standing_orders  a payment that never fired is not a journal row, so
 *                         no amount of reading transactions finds it.
 *   list_card_controls    a declined authorisation never reaches the ledger,
 *                         so "the bank declined it" was the best answer
 *                         available.
 *   list_disputes         provisional credit sits in the ledger balance and is
 *                         held, so get_balance showed a hold with no card
 *                         behind it; and a clawback is a new entry, not a
 *                         reversal, so list_transactions showed what looked
 *                         exactly like a duplicate charge.
 *   list_accruals         a daily fee posting is 83¢ one day and 84¢ the next,
 *                         by design, and nothing on the surface could explain
 *                         the penny — so the honest answer was a rounding bug
 *                         that does not exist.
 *   list_agent_limits     the one question the surface could not answer at all
 *                         was "what am I not allowed to do here". The answer
 *                         used to be `unknown tool "approve_payment"`, which
 *                         is indistinguishable from a typo and invites a
 *                         model to keep guessing. See below.
 *
 * What did NOT get added is the other half of the argument, and it is in
 * docs/AGENT-LIMITS.md §10-§20: no mandate write, no payee write, no control
 * change, no acknowledgement, no dispute intake, no provisional credit, no
 * accrual schedule and no accrual tick.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REFUSAL LIST IS ITSELF A TOOL
 *
 * `list_agent_limits` is the odd one out: it reads no customer data, it
 * touches no table, and it is the only tool here whose subject is this surface
 * rather than the bank. It exists because a written policy that the agent
 * cannot read is a policy that is enforced only by refusals the agent cannot
 * interpret. Served through the protocol and generated from `limits.ts`, the
 * document becomes executable — and `limits.test.ts` fails the build if any
 * tool it claims is absent ever appears in this array.
 * ---------------------------------------------------------------------------
 */

import { getBalanceTool } from "./tool-get-balance";
import { initiatePaymentTool } from "./tool-initiate-payment";
import { listAccrualsTool } from "./tool-list-accruals";
import { listAgentLimitsTool } from "./tool-list-agent-limits";
import { listCardControlsTool } from "./tool-list-card-controls";
import { listDisputesTool } from "./tool-list-disputes";
import { listPayeesTool } from "./tool-list-payees";
import { listPotsTool } from "./tool-list-pots";
import { listReconBreaksTool } from "./tool-list-recon-breaks";
import { listStandingOrdersTool } from "./tool-list-standing-orders";
import { listTransactionsTool } from "./tool-list-transactions";
import type { ToolDefinition } from "./types";

// Ordered as a person would ask the questions: what have we got, where did it
// go, who are we paying, what is scheduled, what are the cards doing, what is
// being charged, what is being contested, what disagrees with the network —
// then what this surface refuses, and then the one that writes.
export const TOOLS: readonly ToolDefinition[] = [
  getBalanceTool,
  listPotsTool,
  listTransactionsTool,
  listPayeesTool,
  listStandingOrdersTool,
  listCardControlsTool,
  listAccrualsTool,
  listDisputesTool,
  listReconBreaksTool,
  listAgentLimitsTool,
  initiatePaymentTool,
];

export const READ_TOOLS: readonly ToolDefinition[] = TOOLS.filter((t) => t.readOnly);
export const WRITE_TOOLS: readonly ToolDefinition[] = TOOLS.filter((t) => !t.readOnly);

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/**
 * Parameter names no tool may ever declare.
 *
 * This is the tenant boundary written as data. A tool that accepted any of
 * these would be taking its scope from the caller instead of from the token,
 * and the reviewer who added it would have had no reason to think twice.
 * `tools.test.ts` asserts it over every registered schema, so the guard fails
 * at `pnpm test` rather than in production.
 */
export const FORBIDDEN_PARAMETER_NAMES: readonly string[] = [
  "business_id",
  "businessId",
  "entity_id",
  "entityId",
  "account_id",
  "accountId",
  "actor_id",
  "actorId",
  "requested_by",
  "approver_id",
  "customer_id",
  "tenant_id",
];
