/**
 * The shapes the MCP surface is built out of.
 *
 * The one idea worth reading this file for: **a tool never receives a business
 * id, an account uuid, or an actor id from its caller.** Those three live on
 * the `Grant`, which is derived from the bearer token and verified against the
 * `actor` table before any tool runs. A tool that wanted to read another
 * business's money would have to be handed a different token — there is no
 * argument it could be passed that would get it there.
 *
 * `mcp/tools.test.ts` asserts this mechanically over every registered schema,
 * so a future tool cannot quietly add an `account_id` parameter.
 */

import type { PaymentDestination, PayoutRail } from "@/lib/approvals/types";
import type { Logger } from "@/lib/log";
import type { AgeBucket, BreakKind, ReasonCode, Severity } from "@/lib/recon/types";

/**
 * A resolved, verified credential.
 *
 * `actorId` always points at a row with `kind = 'agent'` and
 * `can_approve = false`. Both are re-checked against the database on every
 * cache miss rather than trusted from configuration, because configuration is
 * edited by people in a hurry and the `actor` table is the thing the ledger's
 * maker-checker trigger consults.
 */
export interface Grant {
  /** Stable, non-secret label for logs and audit. Never the token itself. */
  readonly label: string;
  /** First 8 chars of the token's sha256. Enough to tell two tokens apart. */
  readonly tokenFingerprint: string;
  readonly actorId: string;
  readonly businessId: string;
  readonly businessLegalName: string;
  readonly rateLimitPerMinute: number;
  /**
   * Ceiling on a single queued instruction, in cents. Authentication says who
   * you are; this says how big a thing you may ask a human to look at. A token
   * that can queue an unbounded payment is a token that can consume an
   * approver's whole afternoon.
   */
  readonly maxInstructionCents: bigint | null;
}

/** Everything a tool handler is allowed to touch. */
export interface ToolContext {
  readonly grant: Grant;
  readonly gateway: Gateway;
  readonly log: Logger;
  /** Injected so tests are not a function of the wall clock. */
  readonly now: Date;
  /** Book-time today (America/New_York) as YYYY-MM-DD. */
  readonly bookToday: string;
}

/**
 * A tool's own refusal. Distinct from `JsonRpcError`: a protocol error means
 * the call never happened, while this means the call happened, was audited,
 * and the answer is no. MCP wants the second returned as a normal result with
 * `isError: true` so the model can read the reason and correct itself.
 */
export class ToolError extends Error {
  override readonly name = "ToolError";
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------

/** JSON Schema (draft 2020-12) as it goes on the wire. Kept as plain data. */
export interface JsonSchemaObject {
  readonly type: "object";
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
  readonly $schema?: string;
}

/**
 * MCP tool annotations. These are hints, not enforcement — the enforcement is
 * `readOnly` below plus the database privileges — but they are how a client
 * decides whether to auto-run a tool or ask its human first, so they must be
 * honest. `initiate_payment` is `readOnlyHint: false`, `destructiveHint: false`
 * because it writes a row that no money depends on.
 */
export interface ToolAnnotations {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly outputSchema?: JsonSchemaObject;
  readonly annotations: ToolAnnotations;
  /**
   * Enforced by the dispatcher, not decoration: a `readOnly` tool is refused
   * the payment queue entirely, and the write budget only applies to tools
   * where this is false.
   */
  readonly readOnly: boolean;
  /** Parse and narrow raw arguments. Throws `ToolError` on bad input. */
  parse(args: Record<string, unknown>): unknown;
  /** Run. `args` is whatever `parse` returned. */
  run(args: never, ctx: ToolContext): Promise<ToolOutcome>;
}

/**
 * What a handler returns: a one-paragraph summary a model can read aloud, and
 * the structured object a program should branch on. Both, always. A tool that
 * returns only prose forces the model to parse money out of a sentence.
 */
export interface ToolOutcome {
  readonly summary: string;
  readonly data: Record<string, unknown>;
}

// ---------------------------------------------------------------------
// The database port
// ---------------------------------------------------------------------

/**
 * Every method takes `businessId` first. Not for style: it means the scoping
 * predicate is in the signature of every query this surface can make, so a
 * reviewer can check the whole boundary by reading one interface.
 */
export interface Gateway {
  /** Verify a configured grant against the live `actor` and `business` rows. */
  resolveActor(actorId: string, businessId: string): Promise<ResolvedActor | null>;

  /** The business's postable account for a chart code, or null. */
  findAccount(businessId: string, code: string): Promise<AccountRef | null>;

  /** Ledger + available, evaluated now, delegating to `ledger/balances.ts`. */
  balanceNow(businessId: string, accountId: string): Promise<BalanceSnapshot>;

  /** Ledger + available, evaluated at a value date and a booking watermark. */
  balanceAsOf(
    businessId: string,
    accountId: string,
    asOfValueDate: string,
    asOfBookingSeq: bigint | null,
  ): Promise<BalanceSnapshot>;

  /** Highest booking_seq recorded at or before an instant. */
  bookingWatermarkAt(at: Date): Promise<bigint>;

  listTransactions(businessId: string, filter: TransactionFilter): Promise<TransactionPage>;

  listReconBreaks(businessId: string, filter: ReconFilter): Promise<ReconBreakPage>;

  /**
   * See `approvals-port.ts`. Delegates to `@/lib/approvals`'s `requestPayment`,
   * which lands a row in the same queue a person's request lands in and moves
   * no money.
   */
  queuePayment(input: QueuePaymentInput): Promise<QueuedPayment>;
}

export interface ResolvedActor {
  readonly actorId: string;
  readonly kind: "human" | "agent" | "system";
  readonly displayName: string;
  readonly canApprove: boolean;
  /** Null for a Corgi-staff actor not pinned to one tenant. */
  readonly actorBusinessId: string | null;
  readonly businessLegalName: string;
}

export interface AccountRef {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly currency: string;
  readonly book: "financial" | "memo";
  readonly isPostable: boolean;
}

export interface BalanceSnapshot {
  readonly ledgerCents: bigint;
  readonly holdsCents: bigint;
  readonly unclearedCents: bigint;
  readonly availableCents: bigint;
  readonly cardHoldCount: number;
  readonly unclearedHoldCount: number;
}

export interface TransactionFilter {
  readonly accountCode: string | null;
  readonly valueDateFrom: string | null;
  readonly valueDateTo: string | null;
  readonly bookingDateFrom: string | null;
  readonly bookingDateTo: string | null;
  readonly rail: string | null;
  readonly book: "financial" | "memo" | null;
  readonly limit: number;
  /** Opaque to the caller; internally the exclusive booking_seq lower bound. */
  readonly cursorBookingSeqBelow: bigint | null;
}

export interface TransactionRow {
  readonly entryId: string;
  readonly accountCode: string;
  readonly accountName: string;
  /** WHEN IT HAPPENED. */
  readonly valueDate: string;
  /** WHEN WE LEARNED IT — the date half of booking_time. */
  readonly bookingDate: string;
  readonly bookingTime: string;
  readonly bookingSeq: bigint;
  readonly entryType: "original" | "reversal" | "rebook";
  readonly book: "financial" | "memo";
  readonly description: string;
  readonly rail: string | null;
  readonly externalRef: string | null;
  /** Signed, from this account's own point of view (normal_side applied). */
  readonly amountCents: bigint;
  readonly currency: string;
  readonly memo: string | null;
  readonly reversesEntryId: string | null;
  readonly correctionGroupId: string | null;
}

export interface TransactionPage {
  readonly rows: readonly TransactionRow[];
  readonly nextCursor: string | null;
}

export interface ReconFilter {
  readonly minAgeDays: number | null;
  readonly category: BreakKind | null;
  readonly limit: number;
  /** Explained breaks are still real; the default is to show only open ones. */
  readonly includeExplained: boolean;
}

/**
 * One break, as this surface returns it.
 *
 * Deliberately a projection of `@/lib/recon`'s own `ReconBreak` rather than a
 * second computation. The categories, the reason codes, the age buckets and
 * the severity ladder all come from `v_recon_break` and `recon/aging.ts`; if
 * this file re-derived any of them the breaks screen and the agent would
 * eventually disagree about the same row, and the agent would be the one
 * talking to the customer.
 */
export interface ReconBreakRow {
  readonly category: BreakKind;
  readonly reasonCode: ReasonCode;
  readonly breakKey: string;
  readonly externalRef: string;
  readonly valueDate: string;
  readonly ageDays: number;
  readonly ageBucket: AgeBucket;
  readonly severity: Severity;
  readonly rail: string;
  readonly provider: string;
  readonly entryId: string | null;
  readonly fileAmountCents: bigint | null;
  readonly ledgerAmountCents: bigint | null;
  /** Signed on the file's axis: how much the file is out by. */
  readonly breakAmountCents: bigint;
  readonly description: string | null;
  readonly explainedBy: string | null;
}

export interface ReconBreakPage {
  readonly rows: readonly ReconBreakRow[];
  /**
   * Breaks that exist but cannot be attributed to any business — a scheme-file
   * row we never matched has no journal entry and therefore no owner. Counted
   * so the caller is not told "zero breaks" when the answer is "none of
   * yours", but never enumerated to a tenant-scoped token.
   */
  readonly unattributableOpenBreaks: number;
}

export interface ApprovalPolicyRef {
  readonly policyId: string;
  /** `ach@2026-01-01` — the (rail, effective_from) key, printable. */
  readonly version: string;
  readonly rail: string;
  readonly effectiveFrom: string;
  readonly thresholdCents: bigint;
  readonly requiredApprovals: number;
  readonly note: string;
}

// ---------------------------------------------------------------------
// The write port (see approvals-port.ts)
// ---------------------------------------------------------------------

/**
 * What the write tool hands the approval queue.
 *
 * Note what is NOT here: a content hash, a policy id, or anything about
 * approval. `@/lib/approvals` computes the hash over its own canonical
 * preimage and picks the policy version in force on the value date, because a
 * second implementation of either would be a second opinion, and the whole
 * value of approve-the-hash is that there is only one.
 */
export interface QueuePaymentInput {
  readonly accountId: string;
  /** Narrower than the queue accepts. See the tool for why `internal` is out. */
  readonly rail: Extract<PayoutRail, "ach" | "usdc" | "wire">;
  readonly amountCents: bigint;
  readonly currency: "USD";
  readonly destination: PaymentDestination;
  readonly valueDate: string;
  /** The agent actor. Never a human, never a system principal. */
  readonly requestedByActorId: string;
  readonly idempotencyKey: string;
}

export interface QueuedPayment {
  readonly instructionId: string;
  /** Lowercase hex, 64 characters. The thing an approval must cite. */
  readonly contentHash: string;
  /** True when this key had already been queued and nothing new was written. */
  readonly replayed: boolean;
  readonly requestedAt: string;
  /** Folded from the event stream by `approvals/state.ts`, not a column. */
  readonly state: string;
  readonly approvalsHeld: number;
  readonly approvalsRequired: number;
  readonly aboveThreshold: boolean;
  readonly policy: ApprovalPolicyRef;
}
