/**
 * Public surface of the MCP module.
 *
 * `gateway.ts` is deliberately NOT re-exported here. It is `server-only` and
 * constructs the Postgres handle at import, so anything that touches it drags
 * a database connection into scope; the route imports it directly and nothing
 * else should.
 */

export { MemoryAuditSink, loggerAuditSink, redactArguments, teeAuditSink } from "./audit";
export type { AuditOutcome, AuditRecord, AuditSink } from "./audit";

export {
  ActorVerificationCache,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  authenticate,
  bearerToken,
  fingerprint,
  findGrant,
  parseTokenConfig,
  sha256,
  verifyActor,
} from "./auth";
export type { AuthFailure, AuthResult, ConfiguredGrant, TokenConfig } from "./auth";

export { CONTENT_HASH_VERSION, contentHash, contentPreimage } from "./approvals-port";
export type { PaymentContent, PaymentQueuePort } from "./approvals-port";

export { decodeMessage, failure, success } from "./jsonrpc";

export {
  DEBATABLE,
  PRINCIPLE,
  REFUSALS,
  findRefusals,
  refusalForTool,
  refusedToolNames,
} from "./limits";
export type { Debatable, Guarantee, Refusal } from "./limits";
export type { JsonRpcRequest, JsonRpcResponse } from "./jsonrpc";

export {
  LATEST_PROTOCOL_VERSION,
  SERVER_INFO,
  SERVER_INSTRUCTIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  initializeResult,
  negotiateProtocolVersion,
  toolsListResult,
} from "./protocol";

export {
  RateLimiter,
  UNAUTHENTICATED_LIMIT_PER_MINUTE,
  WRITE_LIMIT_PER_MINUTE,
  clientKey,
} from "./ratelimit";

export { createMcpServer, originAllowed } from "./server";
export type { McpServer, McpServerDeps } from "./server";

export { FORBIDDEN_PARAMETER_NAMES, READ_TOOLS, TOOLS, WRITE_TOOLS, findTool } from "./tools";

export { addDays, bookDate, daysBetween, isIsoDate } from "./time";

export { ToolError } from "./types";
export type {
  AccountRef,
  AccrualDayRow,
  AccrualFilter,
  AccrualInvariantCounts,
  AccrualMonthRow,
  AccrualPage,
  AccrualScheduleRow,
  ApprovalPolicyRef,
  BalanceSnapshot,
  DisputeEventProjection,
  DisputeFilter,
  DisputePage,
  DisputeRowProjection,
  Gateway,
  Grant,
  QueuePaymentInput,
  QueuedPayment,
  ReconBreakPage,
  ReconBreakRow,
  ResolvedActor,
  ToolContext,
  ToolDefinition,
  ToolOutcome,
  TransactionFilter,
  TransactionPage,
  TransactionRow,
} from "./types";
