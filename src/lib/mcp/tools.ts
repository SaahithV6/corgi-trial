/**
 * The tool registry. Eight entries, seven of which only read, and the list is
 * closed.
 *
 * Adding a ninth is a deliberate act that should be argued for in
 * docs/AGENT-LIMITS.md before it is argued for here, because the interesting
 * property of this surface is not what it can do — it is the SHAPE of the set.
 * Reads are cheap to justify: the worst case is that an agent says something
 * true that nobody asked about. Writes are not, and the count of them has gone
 * from one to one while the reads went from three to seven. That asymmetry is
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
 *
 * What did NOT get added is the other half of the argument, and it is in
 * docs/AGENT-LIMITS.md §10-§13: no mandate write, no payee write, no control
 * change, no acknowledgement.
 */

import { getBalanceTool } from "./tool-get-balance";
import { initiatePaymentTool } from "./tool-initiate-payment";
import { listCardControlsTool } from "./tool-list-card-controls";
import { listPayeesTool } from "./tool-list-payees";
import { listPotsTool } from "./tool-list-pots";
import { listReconBreaksTool } from "./tool-list-recon-breaks";
import { listStandingOrdersTool } from "./tool-list-standing-orders";
import { listTransactionsTool } from "./tool-list-transactions";
import type { ToolDefinition } from "./types";

// Ordered as a person would ask the questions: what have we got, where did it
// go, who are we paying, what is scheduled, what are the cards doing, what
// disagrees with the network — and then the one that writes.
export const TOOLS: readonly ToolDefinition[] = [
  getBalanceTool,
  listPotsTool,
  listTransactionsTool,
  listPayeesTool,
  listStandingOrdersTool,
  listCardControlsTool,
  listReconBreaksTool,
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
