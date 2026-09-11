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
import type { CardControls, DecisionOutcome, DecisionSource } from "@/lib/cards/types";
import type {
  CheckEvidence,
  DirectoryOutcome,
  Freshness,
  NameMatchOutcome,
  NameSource,
  PayeeOutcome,
  PayeeRail,
} from "@/lib/payees/types";
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

  /** Pots and the main/pots/subtree identity. See `tool-list-pots.ts`. */
  listPots(businessId: string): Promise<PotsSnapshot>;

  listPayees(businessId: string, filter: PayeeFilter): Promise<readonly PayeeRow[]>;

  listStandingOrders(
    businessId: string,
    filter: StandingOrderFilter,
  ): Promise<StandingOrderPage>;

  listCardControls(
    businessId: string,
    filter: CardControlFilter,
  ): Promise<CardControlPage>;

  listDisputes(businessId: string, filter: DisputeFilter): Promise<DisputePage>;

  listAccruals(businessId: string, filter: AccrualFilter): Promise<AccrualPage>;

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

/**
 * Ledger balance, available balance, and every term in between.
 *
 * EVERY MONEY FIELD HERE COMES FROM `ledger_availability()` — the one
 * definition of available balance in this system, the same one
 * `v_available_balance` and `v_balance_definition_drift` are built on, and the
 * same one the customer's own screen shows. This surface used to compute its
 * own, which was larger than the customer's by exactly the manual holds and
 * the future-dated debits; `gateway.ts` has the full entry on why that was the
 * worst possible direction for the error and what changed.
 *
 *     available = ledger − holds − uncleared − pendingOutbound
 *
 * and `holds = cardAuthHolds + otherHolds`, where the split is description
 * from the hold itemisation and the total is the authority's.
 */
export interface BalanceSnapshot {
  readonly ledgerCents: bigint;
  /** Every active hold: card authorisations AND operator (`manual`) holds. */
  readonly holdsCents: bigint;
  /** The card-authorisation share of `holdsCents`. Itemisation, not authority. */
  readonly cardAuthHoldsCents: bigint;
  /**
   * The rest of `holdsCents` — operator holds. Named because it was the term
   * this surface used to drop silently, handing an agent money an operator had
   * deliberately withheld.
   */
  readonly otherHoldsCents: bigint;
  readonly unclearedCents: bigint;
  /**
   * Debits already booked with a future value date: money committed to leave.
   * A customer who can spend it again before it settles is a customer we have
   * overdrawn on their behalf. Also previously missing from this surface.
   */
  readonly pendingOutboundCents: bigint;
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

/* ---------------------------------------------------------------------
 * Pots
 * ------------------------------------------------------------------ */

export interface PotBalanceRow {
  readonly potId: string;
  readonly name: string;
  readonly purpose: string | null;
  /** `2100.<pot id>` — the pot's position in this business's own chart. */
  readonly accountCode: string;
  readonly openedAt: string;
  readonly balanceCents: bigint;
}

/**
 * The pots, plus the identity that proves the set is complete.
 *
 * `mainCents + potsCents = totalCents` comes from `v_pot_identity`, which sums
 * the pot table's accounts. `subtreeCents` comes from `v_pot_subtree`, which
 * walks `account.parent_id` from the deposit leaf and never reads the pot
 * table at all. Two routes to one number, carried separately so the tool can
 * SHOW that they agree rather than assert it.
 */
export interface PotsSnapshot {
  readonly pots: readonly PotBalanceRow[];
  readonly mainCents: bigint;
  readonly potsCents: bigint;
  readonly totalCents: bigint;
  readonly subtreeCents: bigint;
}

/* ---------------------------------------------------------------------
 * Payees
 * ------------------------------------------------------------------ */

export interface PayeeFilter {
  readonly rail: PayeeRail | null;
  readonly outcome: PayeeOutcome | null;
  readonly freshness: Freshness | null;
  readonly holderNameContains: string | null;
  readonly includeArchived: boolean;
  readonly limit: number;
}

/** One finding, as the verification service recorded it. Rendered, never re-decided. */
export interface PayeeFindingRow {
  readonly code: string;
  readonly severity: "block" | "warn" | "note";
  readonly title: string;
  readonly detail: string;
}

/**
 * A payee as this surface returns it.
 *
 * A projection of `v_payee_book`, not a second computation: the outcome, the
 * freshness label, the name-match band and the twin flag are all decided by
 * the payees module and migration 0016. If this file re-derived any of them,
 * the screen and the agent would eventually disagree about whether a
 * destination is safe, and the agent is the one talking to the customer.
 *
 * NOTE WHAT IS ABSENT: a full account number. The payee module never receives
 * one, so there is none to project.
 */
export interface PayeeRow {
  readonly payeeId: string;
  readonly displayName: string;
  readonly holderName: string;
  readonly rail: PayeeRail;
  readonly routingNumber: string | null;
  readonly accountNumberLast4: string | null;
  readonly accountType: string | null;
  readonly createdAt: string;
  readonly createdByName: string;
  readonly archived: boolean;
  readonly archivedAt: string | null;
  readonly checkedAt: string | null;
  readonly checkedByName: string | null;
  readonly outcome: PayeeOutcome | null;
  readonly freshness: Freshness;
  readonly checkedDaysAgo: number | null;
  readonly checksumOk: boolean | null;
  readonly prefixAssigned: boolean | null;
  readonly directory: DirectoryOutcome | null;
  readonly directoryProvider: string | null;
  readonly institutionName: string | null;
  readonly nameMatch: NameMatchOutcome | null;
  readonly nameMatchScore: number | null;
  readonly nameSource: NameSource | null;
  readonly counterpartyName: string | null;
  readonly evidence: CheckEvidence | null;
  readonly findings: readonly PayeeFindingRow[];
  readonly acknowledged: boolean;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedByName: string | null;
  readonly acknowledgementReason: string | null;
  readonly hasConflictingTwin: boolean;
}

/* ---------------------------------------------------------------------
 * Standing orders
 * ------------------------------------------------------------------ */

export interface StandingOrderFilter {
  readonly includeCancelled: boolean;
  readonly limit: number;
}

export interface StandingOrderRow {
  readonly id: string;
  readonly reference: string;
  readonly accountName: string;
  readonly rail: PayoutRail;
  readonly amountCents: bigint;
  readonly currency: string;
  readonly destination: PaymentDestination | null;
  readonly cadence: string;
  readonly dayOfMonth: number | null;
  readonly dayOfWeek: number | null;
  readonly startDate: string;
  readonly endDate: string | null;
  /** From `v_standing_order_next` — the database's own calendar walk. */
  readonly nextDueDate: string | null;
  readonly cancelled: boolean;
  readonly cancelledAt: string | null;
  readonly cancellationReason: string | null;
  readonly createdAt: string;
  readonly createdByName: string;
}

/**
 * One occurrence.
 *
 * The four `observed*` figures are the balance as it stood when the funding
 * decision was made, stored on the row. They are the reason a refusal can be
 * explained months later without re-deriving a balance that has since moved.
 */
export interface StandingOccurrenceRow {
  readonly occurrenceId: string;
  readonly standingOrderId: string;
  readonly scheduledDate: string;
  readonly idempotencyKey: string;
  readonly claimedAt: string;
  readonly disposition: "raised" | "refused" | null;
  readonly instructionId: string | null;
  readonly refusalCode: string | null;
  readonly refusalReason: string | null;
  readonly observedLedgerCents: bigint | null;
  readonly observedHoldsCents: bigint | null;
  readonly observedUnclearedCents: bigint | null;
  readonly observedAvailableCents: bigint | null;
  readonly shortfallCents: bigint | null;
  readonly decidedAt: string | null;
}

export interface StandingOrderPage {
  readonly orders: readonly StandingOrderRow[];
  /** Across every mandate on the page; the tool groups them. */
  readonly occurrences: readonly StandingOccurrenceRow[];
}

/* ---------------------------------------------------------------------
 * Cards
 * ------------------------------------------------------------------ */

export interface CardControlFilter {
  readonly limit: number;
  readonly decisionLimit: number;
  readonly declinesOnly: boolean;
}

export interface CardControlRow {
  readonly cardId: string;
  readonly lastFour: string | null;
  readonly nickname: string | null;
  readonly createdAt: string;
  /** Null when nobody has ever set controls. Not the same as "no limits". */
  readonly controls: CardControls | null;
  /** Approved purchase authorisations in the current book day and month. */
  readonly spendDayCents: bigint;
  readonly spendMonthCents: bigint;
}

/**
 * One real-time authorisation decision.
 *
 * `providerCardToken` and `providerAuthToken` exist on the row this is
 * projected from and are deliberately dropped here: they are how a card is
 * addressed at Lithic, and an agent that never holds one cannot be talked into
 * using it.
 */
export interface CardDecisionRow {
  readonly decidedAt: string;
  readonly cardId: string | null;
  readonly lastFour: string | null;
  readonly nickname: string | null;
  readonly amountCents: bigint;
  readonly mcc: string | null;
  readonly merchantDescriptor: string | null;
  readonly requestStatus: string;
  readonly outcome: DecisionOutcome;
  readonly resultCode: string;
  readonly rule: string;
  readonly reason: string;
  readonly controlVersion: number | null;
  readonly decisionLatencyUs: number;
  readonly source: DecisionSource;
}

export interface CardControlPage {
  readonly cards: readonly CardControlRow[];
  readonly decisions: readonly CardDecisionRow[];
}

/* ---------------------------------------------------------------------
 * Disputes
 * ------------------------------------------------------------------ */

export interface DisputeFilter {
  readonly status: string | null;
  /** Exclude cases in a closed status. The default view is live work. */
  readonly openOnly: boolean;
  readonly includeEvents: boolean;
  readonly limit: number;
}

/**
 * One transition on a case.
 *
 * `actorKind` is carried deliberately. A case timeline that reads
 * "provisional credit authorised" without saying WHO is exactly the kind of
 * sentence an agent repeats to a customer as if the bank had decided it; the
 * whole point of `assert_dispute_lifecycle()` is that the authoriser is a
 * named Corgi human who is not the raiser, and the timeline should show that
 * rather than assert it.
 */
export interface DisputeEventProjection {
  readonly kind: string;
  readonly occurredAt: string;
  readonly valueDate: string;
  readonly actorName: string;
  readonly actorKind: string;
  readonly amountCents: bigint | null;
  readonly entryId: string | null;
  readonly detail: string | null;
}

/**
 * A dispute as this surface returns it.
 *
 * A projection of `v_dispute_state`, which is a FOLD OF THE EVENT STREAM and
 * not a status column. `advancedCents` and `heldCents` in particular are sums
 * over the postings the case actually made, so a case that says it advanced
 * $73.40 advanced $73.40 — there is no status field that could say one thing
 * while the ledger said another.
 */
export interface DisputeRowProjection {
  readonly disputeId: string;
  readonly caseRef: string;
  readonly disputedEntryId: string;
  readonly reason: string;
  readonly network: string;
  readonly networkCode: string;
  readonly narrative: string;
  readonly amountCents: bigint;
  readonly status: string;
  readonly isClosed: boolean;
  readonly raisedByName: string;
  readonly raisedAt: string;
  readonly valueDate: string;
  readonly decidedOn: string | null;
  /** The network's deadline. After it, there is no case left to make. */
  readonly networkOutsideDate: string;
  readonly daysToOutsideDate: number;
  /** What has actually been advanced to the customer, summed from postings. */
  readonly advancedCents: bigint;
  /** How much of that advance is still encumbered by the dispute hold. */
  readonly heldCents: bigint;
  readonly holdReleased: boolean | null;
  readonly needsAuthorization: boolean;
  readonly authorizations: number;
  readonly requiredApprovals: number;
  readonly thresholdCents: bigint;
  readonly events: readonly DisputeEventProjection[];
}

export interface DisputePage {
  readonly cases: readonly DisputeRowProjection[];
  /** Open and closed counts across EVERY case, not just the page. */
  readonly openCount: number;
  readonly closedCount: number;
}

/* ---------------------------------------------------------------------
 * Accrual
 * ------------------------------------------------------------------ */

export interface AccrualFilter {
  readonly scheduleLimit: number;
  readonly monthLimit: number;
  readonly dayLimit: number;
  readonly includeSkipped: boolean;
}

export interface AccrualScheduleRow {
  readonly scheduleId: string;
  readonly planName: string;
  readonly product: string;
  readonly accountName: string;
  readonly monthlyCents: bigint;
  readonly currency: string;
  readonly startDate: string;
  readonly endDate: string | null;
}

/**
 * One accrued day, WITH THE ARITHMETIC.
 *
 * Every field below is a column on `accrual_posting` that the database
 * re-derived with `accrual_daily_share()` before it would store the row — the
 * `accrual_posting_arithmetic` CHECK. So these are not a claim about the
 * rounding rule, they are the rounding rule, verified by the thing that
 * persisted them. An agent asked "why is Tuesday 84¢ and Wednesday 83¢" can
 * answer from the row instead of guessing at a float.
 */
export interface AccrualDayRow {
  readonly scheduleId: string;
  readonly planName: string;
  readonly accrualDate: string;
  readonly disposition: "posted" | "skipped" | null;
  readonly entryId: string | null;
  readonly skipReason: string | null;
  readonly monthlyCents: bigint | null;
  readonly daysInMonth: number | null;
  readonly dayOfMonth: number | null;
  readonly baseShareCents: bigint | null;
  readonly residualPennies: number | null;
  readonly residualApplied: boolean | null;
  readonly amountCents: bigint | null;
  readonly cumulativeCents: bigint | null;
  readonly claimedAt: string;
  readonly decidedAt: string | null;
}

export interface AccrualMonthRow {
  readonly scheduleId: string;
  readonly planName: string;
  readonly monthStart: string;
  readonly daysInMonth: number;
  readonly monthlyCents: bigint;
  readonly residualPenniesInMonth: number;
  readonly residualPenniesApplied: number;
  readonly daysClaimed: number;
  readonly daysDecided: number;
  readonly daysPosted: number;
  readonly daysSkipped: number;
  readonly accruedCents: bigint;
  readonly remainingCents: bigint;
  readonly monthComplete: boolean;
}

/**
 * The invariants, scoped to one business.
 *
 * `monthDrift` and `ledgerDrift` must be zero forever. `gapDays` is allowed to
 * be non-zero — a schedule enrolled today owes days nothing has claimed — and
 * persistently non-zero is the one failure a silent accrual job would hide,
 * which is why an agent is shown it rather than a tidy "all good".
 */
export interface AccrualInvariantCounts {
  readonly monthDrift: number;
  readonly ledgerDrift: number;
  readonly unresolved: number;
  readonly gapDays: number;
}

export interface AccrualPage {
  readonly schedules: readonly AccrualScheduleRow[];
  readonly months: readonly AccrualMonthRow[];
  readonly days: readonly AccrualDayRow[];
  readonly invariants: AccrualInvariantCounts;
  /** Σ of every posted day for this business, over all time. */
  readonly accruedToDateCents: bigint;
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
