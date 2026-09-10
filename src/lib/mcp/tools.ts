/**
 * The tool registry. Four entries, and the list is closed.
 *
 * Adding a fifth is a deliberate act that should be argued for in
 * docs/AGENT-LIMITS.md before it is argued for here, because the interesting
 * property of this surface is not what it can do — it is the size of the set.
 */

import { getBalanceTool } from "./tool-get-balance";
import { initiatePaymentTool } from "./tool-initiate-payment";
import { listReconBreaksTool } from "./tool-list-recon-breaks";
import { listTransactionsTool } from "./tool-list-transactions";
import type { ToolDefinition } from "./types";

export const TOOLS: readonly ToolDefinition[] = [
  getBalanceTool,
  listTransactionsTool,
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
