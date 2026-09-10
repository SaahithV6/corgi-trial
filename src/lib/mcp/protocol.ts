/**
 * The MCP layer: version negotiation, the `initialize` handshake, and the
 * result envelopes for `tools/list` and `tools/call`.
 *
 * Kept apart from `server.ts` so that the protocol can be tested without a
 * request, a token or a database, and apart from `jsonrpc.ts` because JSON-RPC
 * has no opinion about any of this.
 */

import { TOOLS } from "./tools";
import type { ToolOutcome } from "./types";

/** Newest revision this server speaks. */
export const LATEST_PROTOCOL_VERSION = "2025-06-18";

/**
 * Older revisions still accepted, newest first. Clients in the wild lag the
 * spec by months, and the wire shape of `initialize`/`tools/list`/`tools/call`
 * is unchanged across these three — what changed is batching (removed) and the
 * `MCP-Protocol-Version` header (added), both handled explicitly.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION,
  "2025-03-26",
  "2024-11-05",
] as const;

export const SERVER_INFO = {
  name: "corgi-neobank",
  title: "Corgi Neobank",
  version: "0.1.0",
} as const;

/**
 * Shown to the model on connect. Worth as much as the tool descriptions: a
 * model that has read this will not tell a customer their payment was sent.
 */
export const SERVER_INSTRUCTIONS = `Corgi neobank, agent surface.

Your token is scoped to exactly one business. Every tool answers only about
that business's money; there is no parameter that widens the scope, and no
account belonging to anyone else is addressable.

Three tools read: get_balance, list_transactions, list_recon_breaks.

One tool writes, and it does not move money: initiate_payment queues a request
in a human approval queue. When it succeeds, NOTHING HAS BEEN PAID. Say so
plainly to whoever you are relaying to — "queued for approval", never "sent",
"paid" or "initiated". You cannot approve, release, submit or cancel a payment
through this surface; those operations are not exposed to any agent. See
docs/AGENT-LIMITS.md for the full list and the reasoning.

Two dates, always. value_date is when money moved in business terms;
booking_date is when this system learned of it. They differ on every correction
and every late settlement, and answering with the wrong one is the most common
way to be confidently wrong about a customer's account.

Ledger balance is not available balance. Available subtracts open card
authorisation holds and uncleared credits. Quote available when the question is
"can I spend it" and ledger when the question is "what do the books say".

All amounts are integer CENTS as decimal strings, in and out.`;

export interface InitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: Record<string, unknown>;
  readonly serverInfo: typeof SERVER_INFO;
  readonly instructions: string;
}

/**
 * Echo the client's version when we speak it; otherwise answer with ours and
 * let the client decide whether it can proceed. That is what the spec asks
 * for, and it is also the only behaviour that does not break on the next
 * revision: refusing an unknown version would make this server fail against
 * clients newer than itself.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === "string") {
    for (const supported of SUPPORTED_PROTOCOL_VERSIONS) {
      if (supported === requested) return supported;
    }
  }
  return LATEST_PROTOCOL_VERSION;
}

export function isSupportedProtocolVersion(version: string): boolean {
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

export function initializeResult(protocolVersion: string): InitializeResult {
  return {
    protocolVersion,
    capabilities: {
      // `listChanged: false` is honest: the tool set is compiled in, so there
      // is nothing to notify about. Declaring a capability we do not implement
      // makes a client wait for a notification that never comes.
      tools: { listChanged: false },
    },
    serverInfo: SERVER_INFO,
    instructions: SERVER_INSTRUCTIONS,
  };
}

export function toolsListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      annotations: tool.annotations,
    })),
  };
}

/**
 * A successful tool result.
 *
 * Both halves, always: `content` is what a model reads, `structuredContent` is
 * what a program branches on. Clients that predate `structuredContent` still
 * get a usable answer from the text; clients that have it never have to parse
 * money out of a sentence.
 */
export function toolCallResult(outcome: ToolOutcome): Record<string, unknown> {
  return {
    content: [{ type: "text", text: outcome.summary }],
    structuredContent: outcome.data,
    isError: false,
  };
}

/**
 * A tool that ran, was scoped and audited, and said no.
 *
 * Returned as a normal result with `isError: true` rather than as a JSON-RPC
 * error, which is what the spec asks for and is also what makes an agent
 * recoverable: a model that receives a protocol error usually gives up, while
 * one that receives "INSUFFICIENT_AVAILABLE_FUNDS: $500.00 exceeds available
 * $412.60" can go and ask a better question.
 */
export function toolCallError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: {
      error: code,
      message,
      ...(details === undefined ? {} : { details }),
    },
    isError: true,
  };
}
