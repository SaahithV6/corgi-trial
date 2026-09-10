/**
 * An in-memory `Gateway` for the tests.
 *
 * The point of the gateway interface is that the whole agent surface —
 * protocol, auth, scoping, rate limiting, audit, and all four tools — is
 * exercisable without Postgres. The live SQL is proved separately, once,
 * against the real Neon branch in `mcp.integration.test.ts`.
 *
 * This fake enforces the tenant boundary the same way the real one does: it
 * keys everything by business id and simply has nothing to return when asked
 * about a business the caller was not granted. If a scoping bug ever let a
 * business id come from an argument instead of the grant, the test asserting
 * on business B's data would start passing under business A's token, and the
 * cross-tenant test in `server.test.ts` would catch it.
 *
 * Not shipped anywhere: nothing under `src/app` imports it.
 */

import { contentHash } from "@/lib/approvals/hash";
import { logger } from "@/lib/log";

import { ToolError } from "./types";
import type {
  AccountRef,
  ApprovalPolicyRef,
  BalanceSnapshot,
  Gateway,
  QueuePaymentInput,
  QueuedPayment,
  ReconBreakPage,
  ReconBreakRow,
  ReconFilter,
  ResolvedActor,
  ToolContext,
  TransactionFilter,
  TransactionPage,
  TransactionRow,
} from "./types";

export const BUSINESS_A = "e274546d-6bdd-5266-b0fb-cc839a7811f9";
export const BUSINESS_B = "1151e7b5-b75b-5f58-bdbf-68cd714178ce";
export const AGENT_ACTOR = "3743dc53-4e1c-577e-9a0f-e4469ffc1761";
export const HUMAN_APPROVER = "3b805475-b3a6-5717-bd98-aef8826ce05a";
export const SYSTEM_ACTOR = "c448e10a-28f6-573e-97b8-2c953f3ad7d9";

export interface FakeState {
  actors: Map<string, ResolvedActor>;
  businessNames: Map<string, string>;
  /** `${businessId}:${code}` -> account */
  accounts: Map<string, AccountRef>;
  /** `${businessId}:${accountId}` -> snapshot */
  balances: Map<string, BalanceSnapshot>;
  transactions: Map<string, TransactionRow[]>;
  breaks: Map<string, ReconBreakRow[]>;
  policies: ApprovalPolicyRef[];
  queued: QueuePaymentInput[];
  /** Keyed by idempotency key, so a replay returns the original. */
  instructions: Map<string, QueuedPayment>;
  watermark: bigint;
  unattributableBreaks: number;
}

export function emptySnapshot(): BalanceSnapshot {
  return {
    ledgerCents: 0n,
    holdsCents: 0n,
    unclearedCents: 0n,
    availableCents: 0n,
    cardHoldCount: 0,
    unclearedHoldCount: 0,
  };
}

export function snapshotOf(
  ledgerCents: bigint,
  holdsCents = 0n,
  unclearedCents = 0n,
  cardHoldCount = 0,
  unclearedHoldCount = 0,
): BalanceSnapshot {
  return {
    ledgerCents,
    holdsCents,
    unclearedCents,
    availableCents: ledgerCents - holdsCents - unclearedCents,
    cardHoldCount,
    unclearedHoldCount,
  };
}

export function defaultState(): FakeState {
  const accountA: AccountRef = {
    accountId: "a0c41a37-2be1-5c30-bfe9-03455f048fac",
    code: "2100",
    name: "Ridgeline Robotics, Inc. — business current account",
    currency: "USD",
    book: "financial",
    isPostable: true,
  };
  const accountB: AccountRef = {
    accountId: "bbbbbbbb-0000-4000-8000-000000000001",
    code: "2100",
    name: "Kettle & Crumb Bakery LLC — business current account",
    currency: "USD",
    book: "financial",
    isPostable: true,
  };

  return {
    actors: new Map<string, ResolvedActor>([
      [
        AGENT_ACTOR,
        {
          actorId: AGENT_ACTOR,
          kind: "agent",
          displayName: "Corgi payments agent",
          canApprove: false,
          actorBusinessId: null,
          businessLegalName: "",
        },
      ],
      [
        HUMAN_APPROVER,
        {
          actorId: HUMAN_APPROVER,
          kind: "human",
          displayName: "Alex Whitfield",
          canApprove: true,
          actorBusinessId: BUSINESS_A,
          businessLegalName: "",
        },
      ],
      [
        SYSTEM_ACTOR,
        {
          actorId: SYSTEM_ACTOR,
          kind: "system",
          displayName: "ledger-poster",
          canApprove: false,
          actorBusinessId: null,
          businessLegalName: "",
        },
      ],
    ]),
    businessNames: new Map([
      [BUSINESS_A, "Ridgeline Robotics, Inc."],
      [BUSINESS_B, "Kettle & Crumb Bakery LLC"],
    ]),
    accounts: new Map([
      [`${BUSINESS_A}:2100`, accountA],
      [`${BUSINESS_B}:2100`, accountB],
    ]),
    balances: new Map([
      [`${BUSINESS_A}:${accountA.accountId}`, snapshotOf(10_000_00n, 362_60n, 50_00n, 2, 1)],
      [`${BUSINESS_B}:${accountB.accountId}`, snapshotOf(7_500_00n)],
    ]),
    transactions: new Map(),
    breaks: new Map(),
    policies: [
      {
        policyId: "9315dd14-5e7f-5703-b37a-236a2531b968",
        version: "ach@2026-01-01",
        rail: "ach",
        effectiveFrom: "2026-01-01",
        thresholdCents: 250_000n,
        requiredApprovals: 1,
        note: "ACH debits of $2,500 or more need one approver who is not the initiator.",
      },
      {
        policyId: "d0aaa278-d28b-502c-9e4f-4eddda0af506",
        version: "wire@2026-01-01",
        rail: "wire",
        effectiveFrom: "2026-01-01",
        thresholdCents: 0n,
        requiredApprovals: 2,
        note: "Every wire, at any amount, needs two distinct human approvers.",
      },
      {
        policyId: "787eb2f6-e05b-5dbf-bb5a-56cc6242b105",
        version: "usdc@2026-01-01",
        rail: "usdc",
        effectiveFrom: "2026-01-01",
        thresholdCents: 100_000n,
        requiredApprovals: 1,
        note: "USDC from $1,000 up needs an approver; on-chain transfers are irreversible.",
      },
    ],
    queued: [],
    instructions: new Map(),
    watermark: 5n,
    unattributableBreaks: 0,
  };
}

export function fakeGateway(state: FakeState = defaultState()): {
  gateway: Gateway;
  state: FakeState;
} {
  let nextInstruction = 1;

  const gateway: Gateway = {
    async resolveActor(actorId, businessId) {
      const actor = state.actors.get(actorId);
      const name = state.businessNames.get(businessId);
      if (actor === undefined || name === undefined) return null;
      return { ...actor, businessLegalName: name };
    },

    async findAccount(businessId, code) {
      return state.accounts.get(`${businessId}:${code}`) ?? null;
    },

    async balanceNow(businessId, accountId) {
      return state.balances.get(`${businessId}:${accountId}`) ?? emptySnapshot();
    },

    async balanceAsOf(businessId, accountId) {
      return state.balances.get(`${businessId}:${accountId}`) ?? emptySnapshot();
    },

    async bookingWatermarkAt() {
      return state.watermark;
    },

    async listTransactions(businessId, filter: TransactionFilter): Promise<TransactionPage> {
      const all = state.transactions.get(businessId) ?? [];
      const matched = all.filter((row) => {
        if (filter.accountCode !== null && row.accountCode !== filter.accountCode) return false;
        if (filter.valueDateFrom !== null && row.valueDate < filter.valueDateFrom) return false;
        if (filter.valueDateTo !== null && row.valueDate > filter.valueDateTo) return false;
        if (filter.bookingDateFrom !== null && row.bookingDate < filter.bookingDateFrom) return false;
        if (filter.bookingDateTo !== null && row.bookingDate > filter.bookingDateTo) return false;
        if (filter.rail !== null && row.rail !== filter.rail) return false;
        if (filter.book !== null && row.book !== filter.book) return false;
        if (filter.cursorBookingSeqBelow !== null && row.bookingSeq >= filter.cursorBookingSeqBelow) {
          return false;
        }
        return true;
      });
      const page = matched.slice(0, filter.limit);
      const last = page[page.length - 1];
      return {
        rows: page,
        nextCursor:
          matched.length > filter.limit && last !== undefined ? last.bookingSeq.toString() : null,
      };
    },

    async listReconBreaks(businessId, filter: ReconFilter): Promise<ReconBreakPage> {
      const all = state.breaks.get(businessId) ?? [];
      const matched = all
        .filter((b) => filter.category === null || b.category === filter.category)
        .filter((b) => filter.minAgeDays === null || b.ageDays >= filter.minAgeDays)
        .slice()
        .sort((a, b) => b.ageDays - a.ageDays);
      return {
        rows: matched.slice(0, filter.limit),
        unattributableOpenBreaks: state.unattributableBreaks,
      };
    },

    async queuePayment(input: QueuePaymentInput): Promise<QueuedPayment> {
      const policy =
        state.policies
          .filter((p) => p.rail === input.rail && p.effectiveFrom <= input.valueDate)
          .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0] ?? null;
      if (policy === null) {
        // Same refusal shape the real approvals module produces: a rail with
        // no policy version in force cannot be judged, so nothing is queued.
        throw new ToolError(
          "POLICY_MISSING",
          `No approval policy is in force for ${input.rail} on ${input.valueDate}. A payment cannot be raised without a policy version to cite.`,
        );
      }

      const aboveThreshold = input.amountCents >= policy.thresholdCents;
      const existing = state.instructions.get(input.idempotencyKey);
      if (existing !== undefined) return { ...existing, replayed: true };

      const queued: QueuedPayment = {
        instructionId: `11111111-0000-4000-8000-${String(nextInstruction++).padStart(12, "0")}`,
        contentHash: contentHash({
          accountId: input.accountId,
          rail: input.rail,
          amountCents: input.amountCents,
          currency: input.currency,
          destination: input.destination,
          valueDate: input.valueDate,
        }),
        replayed: false,
        requestedAt: "2026-09-10T18:00:00.000Z",
        state: "requested",
        approvalsHeld: 0,
        approvalsRequired: aboveThreshold ? policy.requiredApprovals : 0,
        aboveThreshold,
        policy,
      };
      state.queued.push(input);
      state.instructions.set(input.idempotencyKey, queued);
      return queued;
    },
  };

  return { gateway, state };
}

/** A journal posting for the list_transactions tests. */
export function txRow(overrides: Partial<TransactionRow> = {}): TransactionRow {
  return {
    entryId: "e0000000-0000-4000-8000-000000000001",
    accountCode: "2100",
    accountName: "Ridgeline Robotics, Inc. — business current account",
    valueDate: "2026-09-08",
    bookingDate: "2026-09-08",
    bookingTime: "2026-09-08T14:00:00.000Z",
    bookingSeq: 3n,
    entryType: "original",
    book: "financial",
    description: "Card clearing",
    rail: "card",
    externalRef: "txn_abc",
    amountCents: -7_340n,
    currency: "USD",
    memo: null,
    reversesEntryId: null,
    correctionGroupId: null,
    ...overrides,
  };
}

export function breakRow(overrides: Partial<ReconBreakRow> = {}): ReconBreakRow {
  return {
    category: "in_ledger_not_file",
    reasonCode: "unmatched_reference",
    breakKey: "e0000000-0000-4000-8000-000000000009",
    externalRef: "trace-77",
    valueDate: "2026-09-01",
    ageDays: 9,
    ageBucket: "8-30",
    severity: "aged",
    rail: "ach",
    provider: "increase",
    entryId: "e0000000-0000-4000-8000-000000000009",
    ledgerAmountCents: 12_500n,
    fileAmountCents: null,
    breakAmountCents: -12_500n,
    description: "ACH settlement booked, no file row",
    explainedBy: null,
    ...overrides,
  };
}

/** A `ToolContext` for calling a handler directly, without the HTTP layer. */
export function testContext(overrides: Partial<ToolContext> = {}): ToolContext {
  const { gateway } = fakeGateway();
  return {
    grant: {
      label: "ridgeline-agent",
      tokenFingerprint: "ab12cd34",
      actorId: AGENT_ACTOR,
      businessId: BUSINESS_A,
      businessLegalName: "Ridgeline Robotics, Inc.",
      rateLimitPerMinute: 60,
      maxInstructionCents: null,
    },
    gateway,
    log: logger({ level: "error", emit: () => {} }),
    now: new Date("2026-09-10T18:00:00.000Z"),
    bookToday: "2026-09-10",
    ...overrides,
  };
}
