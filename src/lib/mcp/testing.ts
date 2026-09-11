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
  AccrualFilter,
  AccrualPage,
  ApprovalPolicyRef,
  BalanceSnapshot,
  CardControlFilter,
  CardControlPage,
  DisputeFilter,
  DisputePage,
  DisputeRowProjection,
  Gateway,
  PayeeFilter,
  PayeeRow,
  PotsSnapshot,
  StandingOrderFilter,
  StandingOrderPage,
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
  pots: Map<string, PotsSnapshot>;
  payees: Map<string, PayeeRow[]>;
  standing: Map<string, StandingOrderPage>;
  cards: Map<string, CardControlPage>;
  disputes: Map<string, DisputeRowProjection[]>;
  accruals: Map<string, AccrualPage>;
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
    cardAuthHoldsCents: 0n,
    otherHoldsCents: 0n,
    unclearedCents: 0n,
    pendingOutboundCents: 0n,
    availableCents: 0n,
    cardHoldCount: 0,
    unclearedHoldCount: 0,
  };
}

/**
 * A balance for the tests.
 *
 * `holdsCents` is the AUTHORITATIVE hold total — card authorisations plus
 * operator holds — and `cardAuthHoldsCents` is the card share of it, exactly
 * as the live gateway now reports them. The two extra parameters exist so a
 * test can express the case that used to be invisible: an operator hold, or a
 * debit already booked to leave, either of which makes available smaller than
 * a naive ledger-minus-card-holds sum.
 */
export function snapshotOf(
  ledgerCents: bigint,
  holdsCents = 0n,
  unclearedCents = 0n,
  cardHoldCount = 0,
  unclearedHoldCount = 0,
  pendingOutboundCents = 0n,
  otherHoldsCents = 0n,
): BalanceSnapshot {
  return {
    ledgerCents,
    holdsCents,
    cardAuthHoldsCents: holdsCents - otherHoldsCents,
    otherHoldsCents,
    unclearedCents,
    pendingOutboundCents,
    availableCents: ledgerCents - holdsCents - unclearedCents - pendingOutboundCents,
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
    pots: new Map([[BUSINESS_A, defaultPots()], [BUSINESS_B, emptyPots()]]),
    payees: new Map([[BUSINESS_A, defaultPayees()], [BUSINESS_B, []]]),
    standing: new Map([
      [BUSINESS_A, defaultStanding()],
      [BUSINESS_B, { orders: [], occurrences: [] }],
    ]),
    cards: new Map([
      [BUSINESS_A, defaultCards()],
      [BUSINESS_B, { cards: [], decisions: [] }],
    ]),
    disputes: new Map([
      [BUSINESS_A, defaultDisputes()],
      [BUSINESS_B, []],
    ]),
    accruals: new Map([
      [BUSINESS_A, defaultAccruals()],
      [BUSINESS_B, emptyAccruals()],
    ]),
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

/* -------------------------------------------------------------------------- */
/* Fixtures for the four tools added after the first cut                      */
/* -------------------------------------------------------------------------- */

export function emptyPots(): PotsSnapshot {
  return { pots: [], mainCents: 0n, potsCents: 0n, totalCents: 0n, subtreeCents: 0n };
}

/**
 * Two pots on business A, and the identity that ties them to the deposit
 * subtree. The figures are chosen so main != total: a fixture where the pot
 * total is zero would let a bug that ignores pots pass every assertion.
 */
export function defaultPots(): PotsSnapshot {
  return {
    pots: [
      {
        potId: "9a1f5f2e-0000-4000-8000-000000000001",
        name: "Payroll — October",
        purpose: "Wages and employer taxes for the October run",
        accountCode: "2100.9a1f5f2e-0000-4000-8000-000000000001",
        openedAt: "2026-09-01T14:00:00.000Z",
        balanceCents: 12_000_00n,
      },
      {
        potId: "9a1f5f2e-0000-4000-8000-000000000002",
        name: "Sales tax",
        purpose: null,
        accountCode: "2100.9a1f5f2e-0000-4000-8000-000000000002",
        openedAt: "2026-08-20T09:30:00.000Z",
        balanceCents: 3_000_00n,
      },
    ],
    mainCents: 10_000_00n,
    potsCents: 15_000_00n,
    totalCents: 25_000_00n,
    subtreeCents: 25_000_00n,
  };
}

export function defaultPayees(): PayeeRow[] {
  return [
    {
      payeeId: "7c2f0d31-0000-4000-8000-000000000001",
      displayName: "Machining subcontractor",
      holderName: "Northwind Components LLC",
      rail: "ach",
      routingNumber: "021000021",
      accountNumberLast4: "6789",
      accountType: "checking",
      createdAt: "2026-08-14T11:00:00.000Z",
      createdByName: "Alex Whitfield",
      archived: false,
      archivedAt: null,
      checkedAt: "2026-09-09T11:00:00.000Z",
      checkedByName: "Alex Whitfield",
      outcome: "verified",
      freshness: "fresh",
      checkedDaysAgo: 1,
      checksumOk: true,
      prefixAssigned: true,
      directory: "found",
      directoryProvider: "increase",
      institutionName: "JPMORGAN CHASE BANK, NA",
      nameMatch: "match",
      nameMatchScore: 100,
      nameSource: "linked_account_holder",
      counterpartyName: "Northwind Components LLC",
      evidence: "live",
      findings: [],
      acknowledged: false,
      acknowledgedAt: null,
      acknowledgedByName: null,
      acknowledgementReason: null,
      hasConflictingTwin: false,
    },
    {
      payeeId: "7c2f0d31-0000-4000-8000-000000000002",
      displayName: "Coolant supplier",
      holderName: "Pierce Fluids Co",
      rail: "ach",
      routingNumber: "011401533",
      accountNumberLast4: "4410",
      accountType: "checking",
      createdAt: "2026-07-02T15:00:00.000Z",
      createdByName: "Alex Whitfield",
      archived: false,
      archivedAt: null,
      checkedAt: "2026-06-01T15:00:00.000Z",
      checkedByName: "Alex Whitfield",
      outcome: "warned",
      freshness: "stale",
      checkedDaysAgo: 101,
      checksumOk: true,
      prefixAssigned: true,
      directory: "not_listed",
      directoryProvider: "increase",
      institutionName: null,
      nameMatch: "close_match",
      nameMatchScore: 88,
      nameSource: "payer_asserted",
      counterpartyName: null,
      evidence: "simulated",
      findings: [
        {
          code: "NAME_CLOSE_MATCH",
          severity: "warn",
          title: "The name is close but not identical",
          detail:
            "Pierce Fluids Co against Pierce Fluid Company. A human has to say whether this is the same business.",
        },
      ],
      acknowledged: false,
      acknowledgedAt: null,
      acknowledgedByName: null,
      acknowledgementReason: null,
      hasConflictingTwin: true,
    },
    {
      payeeId: "7c2f0d31-0000-4000-8000-000000000003",
      displayName: "Retired supplier",
      holderName: "Oldcastle Bearings",
      rail: "wire",
      routingNumber: null,
      accountNumberLast4: "0013",
      accountType: null,
      createdAt: "2026-02-11T10:00:00.000Z",
      createdByName: "Alex Whitfield",
      archived: true,
      archivedAt: "2026-06-30T10:00:00.000Z",
      checkedAt: "2026-02-11T10:05:00.000Z",
      checkedByName: "Alex Whitfield",
      outcome: "verified",
      freshness: "stale",
      checkedDaysAgo: 211,
      checksumOk: true,
      prefixAssigned: true,
      directory: "found",
      directoryProvider: "increase",
      institutionName: "FIRST REPUBLIC",
      nameMatch: "match",
      nameMatchScore: 100,
      nameSource: "payer_asserted",
      counterpartyName: null,
      evidence: "simulated",
      findings: [],
      acknowledged: false,
      acknowledgedAt: null,
      acknowledgedByName: null,
      acknowledgementReason: null,
      hasConflictingTwin: false,
    },
  ];
}

export function defaultStanding(): StandingOrderPage {
  const rentId = "4d8a9b10-0000-4000-8000-000000000001";
  const cancelledId = "4d8a9b10-0000-4000-8000-000000000002";
  return {
    orders: [
      {
        id: rentId,
        reference: "Rent — Unit 4, Ridgeline Works",
        accountName: "Ridgeline Robotics, Inc. — business current account",
        rail: "ach",
        amountCents: 4_000_00n,
        currency: "USD",
        destination: {
          type: "ach",
          holderName: "Ridgeline Works Property LLC",
          routingNumber: "021000021",
          accountNumberLast4: "8812",
          accountType: "checking",
        },
        cadence: "monthly",
        dayOfMonth: 1,
        dayOfWeek: null,
        startDate: "2026-03-01",
        endDate: null,
        nextDueDate: "2026-10-01",
        cancelled: false,
        cancelledAt: null,
        cancellationReason: null,
        createdAt: "2026-02-20T16:00:00.000Z",
        createdByName: "Alex Whitfield",
      },
      {
        id: cancelledId,
        reference: "Month-end calendar probe",
        accountName: "Ridgeline Robotics, Inc. — business current account",
        rail: "internal",
        amountCents: 1_00n,
        currency: "USD",
        destination: null,
        cadence: "monthly",
        dayOfMonth: 31,
        dayOfWeek: null,
        startDate: "2026-01-31",
        endDate: null,
        nextDueDate: null,
        cancelled: true,
        cancelledAt: "2026-08-01T12:00:00.000Z",
        cancellationReason: "The probe proved the short-month rule; it is not a real payment.",
        createdAt: "2026-01-20T12:00:00.000Z",
        createdByName: "Alex Whitfield",
      },
    ],
    occurrences: [
      {
        occurrenceId: "5e0c1122-0000-4000-8000-000000000002",
        standingOrderId: rentId,
        scheduledDate: "2026-09-01",
        idempotencyKey: `standing:${rentId}:2026-09-01`,
        claimedAt: "2026-09-01T09:00:00.000Z",
        disposition: "refused",
        instructionId: null,
        refusalCode: "INSUFFICIENT_AVAILABLE_FUNDS",
        refusalReason:
          "Refused: the ledger balance covers this payment but the available balance does not.",
        observedLedgerCents: 4_500_00n,
        observedHoldsCents: 362_60n,
        observedUnclearedCents: 300_00n,
        observedAvailableCents: 3_837_40n,
        shortfallCents: 162_60n,
        decidedAt: "2026-09-01T09:00:01.000Z",
      },
      {
        occurrenceId: "5e0c1122-0000-4000-8000-000000000001",
        standingOrderId: rentId,
        scheduledDate: "2026-08-01",
        idempotencyKey: `standing:${rentId}:2026-08-01`,
        claimedAt: "2026-08-01T09:00:00.000Z",
        disposition: "raised",
        instructionId: "22222222-0000-4000-8000-000000000001",
        refusalCode: null,
        refusalReason: null,
        observedLedgerCents: 18_000_00n,
        observedHoldsCents: 0n,
        observedUnclearedCents: 0n,
        observedAvailableCents: 18_000_00n,
        shortfallCents: null,
        decidedAt: "2026-08-01T09:00:01.000Z",
      },
    ],
  };
}

export function defaultCards(): CardControlPage {
  const cardId = "6f3b7c44-0000-4000-8000-000000000001";
  return {
    cards: [
      {
        cardId,
        lastFour: "2971",
        nickname: "Workshop card — Dani",
        createdAt: "2026-05-04T13:00:00.000Z",
        controls: {
          cardId,
          controlVersionId: "8a2d5e66-0000-4000-8000-000000000003",
          version: 3,
          effectiveFrom: "2026-09-08T17:20:00.000Z",
          cardState: "active",
          perTxnLimitCents: 500_00n,
          dailyLimitCents: 1_000_00n,
          monthlyLimitCents: null,
          blockedMccs: ["5542"],
          note: "Fuel blocked after the pump over-capture; per-transaction $500.",
        },
        spendDayCents: 73_40n,
        spendMonthCents: 1_284_10n,
      },
      {
        cardId: "6f3b7c44-0000-4000-8000-000000000002",
        lastFour: "5559",
        nickname: "Ops card — unconfigured",
        createdAt: "2026-09-09T08:00:00.000Z",
        controls: null,
        spendDayCents: 0n,
        spendMonthCents: 0n,
      },
    ],
    decisions: [
      {
        decidedAt: "2026-09-10T14:02:11.000Z",
        cardId,
        lastFour: "2971",
        nickname: "Workshop card — Dani",
        amountCents: 50_00n,
        mcc: "5542",
        merchantDescriptor: "SHELL 4471 PORTLAND OR",
        requestStatus: "AUTHORIZATION",
        outcome: "decline",
        resultCode: "UNAUTHORIZED_MERCHANT",
        rule: "mcc_blocked",
        judged: true,
        reason: "This card does not allow automated fuel dispensers.",
        controlVersion: 3,
        decisionLatencyUs: 41_200,
        source: "provider",
      },
      {
        decidedAt: "2026-09-10T11:15:02.000Z",
        cardId,
        lastFour: "2971",
        nickname: "Workshop card — Dani",
        amountCents: 73_40n,
        mcc: "5251",
        merchantDescriptor: "HARBOUR HARDWARE",
        requestStatus: "AUTHORIZATION",
        outcome: "approve",
        resultCode: "APPROVED",
        rule: "within_controls",
        judged: true,
        reason: "Within this card's controls.",
        controlVersion: 3,
        decisionLatencyUs: 38_900,
        source: "provider",
      },
    ],
  };
}

/**
 * Two dispute cases, chosen to be the two an agent gets wrong.
 *
 * The first is LIVE with provisional credit granted: $73.40 advanced into the
 * customer's ledger balance and held, which is the hold `get_balance` reports
 * with no card behind it. The second is CLOSED and LOST with the advance
 * clawed back, which is the pair of postings that looks like a duplicate
 * charge in `list_transactions` and is not.
 */
export function defaultDisputes(): DisputeRowProjection[] {
  return [
    {
      disputeId: "d1111111-0000-4000-8000-000000000001",
      caseRef: "DSP-20260908-AB12CD",
      disputedEntryId: "e0000000-0000-4000-8000-000000000001",
      reason: "fraud",
      network: "visa",
      networkCode: "10.4",
      narrative: "Card not present at the pump; the driver was in the workshop all morning.",
      amountCents: 7_340n,
      status: "provisional_credit_granted",
      isClosed: false,
      raisedByName: "Dana Whitfield",
      raisedAt: "2026-09-08T15:04:00.000Z",
      valueDate: "2026-09-08",
      decidedOn: null,
      networkOutsideDate: "2026-10-28",
      daysToOutsideDate: 48,
      advancedCents: 7_340n,
      heldCents: 7_340n,
      holdReleased: false,
      needsAuthorization: false,
      authorizations: 1,
      requiredApprovals: 1,
      thresholdCents: 5_000n,
      events: [
        {
          kind: "raised",
          occurredAt: "2026-09-08T15:04:00.000Z",
          valueDate: "2026-09-08",
          actorName: "Dana Whitfield",
          actorKind: "human",
          amountCents: 7_340n,
          entryId: null,
          detail: null,
        },
        {
          kind: "provisional_credit_authorized",
          occurredAt: "2026-09-08T16:20:00.000Z",
          valueDate: "2026-09-08",
          actorName: "Priya Raman",
          actorKind: "human",
          amountCents: 7_340n,
          entryId: null,
          detail: null,
        },
        {
          kind: "provisional_credit_granted",
          occurredAt: "2026-09-08T16:21:00.000Z",
          valueDate: "2026-09-08",
          actorName: "Priya Raman",
          actorKind: "human",
          amountCents: 7_340n,
          entryId: "e0000000-0000-4000-8000-00000000000a",
          detail: null,
        },
      ],
    },
    {
      disputeId: "d1111111-0000-4000-8000-000000000002",
      caseRef: "DSP-20260901-ZZ99YY",
      disputedEntryId: "e0000000-0000-4000-8000-000000000002",
      reason: "duplicate",
      network: "visa",
      networkCode: "12.6",
      narrative: "Billed twice for one delivery.",
      amountCents: 5_00n,
      status: "closed_lost_recovered",
      isClosed: true,
      raisedByName: "Dana Whitfield",
      raisedAt: "2026-09-01T09:00:00.000Z",
      valueDate: "2026-09-01",
      decidedOn: "2026-09-06",
      networkOutsideDate: "2026-10-21",
      daysToOutsideDate: 41,
      advancedCents: 5_00n,
      heldCents: 0n,
      holdReleased: true,
      needsAuthorization: false,
      authorizations: 1,
      requiredApprovals: 1,
      thresholdCents: 5_000n,
      events: [],
    },
  ];
}

export function emptyAccruals(): AccrualPage {
  return {
    schedules: [],
    months: [],
    days: [],
    invariants: { monthDrift: 0, ledgerDrift: 0, unresolved: 0, gapDays: 0 },
    accruedToDateCents: 0n,
  };
}

/**
 * A $25.00 plan in a 30-day month: 83¢ a day with 10¢ of residual, so the
 * first ten days carry 84¢ and the rest carry 83¢. Day 10 and day 11 are both
 * present deliberately — they are the adjacent pair that differs by a penny,
 * which is the thing an agent reports as a bug.
 */
export function defaultAccruals(): AccrualPage {
  const base = {
    scheduleId: "ac111111-0000-4000-8000-000000000001",
    planName: "Business Standard",
    monthlyCents: 2_500n,
    daysInMonth: 30,
    baseShareCents: 83n,
    residualPennies: 10,
    skipReason: null,
    decidedAt: "2026-09-11T04:05:00.000Z",
  };

  return {
    schedules: [
      {
        scheduleId: base.scheduleId,
        planName: "Business Standard",
        product: "platform_fee",
        accountName: "Ridgeline Robotics, Inc. — business current account",
        monthlyCents: 2_500n,
        currency: "USD",
        startDate: "2026-09-01",
        endDate: null,
      },
    ],
    months: [
      {
        scheduleId: base.scheduleId,
        planName: "Business Standard",
        monthStart: "2026-09-01",
        daysInMonth: 30,
        monthlyCents: 2_500n,
        residualPenniesInMonth: 10,
        residualPenniesApplied: 10,
        daysClaimed: 11,
        daysDecided: 11,
        daysPosted: 11,
        daysSkipped: 0,
        accruedCents: 923n,
        remainingCents: 1_577n,
        monthComplete: false,
      },
    ],
    days: [
      {
        ...base,
        accrualDate: "2026-09-11",
        disposition: "posted",
        entryId: "e0000000-0000-4000-8000-0000000000b1",
        dayOfMonth: 11,
        residualApplied: false,
        amountCents: 83n,
        cumulativeCents: 923n,
        claimedAt: "2026-09-11T04:05:00.000Z",
      },
      {
        ...base,
        accrualDate: "2026-09-10",
        disposition: "posted",
        entryId: "e0000000-0000-4000-8000-0000000000b0",
        dayOfMonth: 10,
        residualApplied: true,
        amountCents: 84n,
        cumulativeCents: 840n,
        claimedAt: "2026-09-10T04:05:00.000Z",
      },
    ],
    invariants: { monthDrift: 0, ledgerDrift: 0, unresolved: 0, gapDays: 0 },
    accruedToDateCents: 923n,
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

    async listPots(businessId): Promise<PotsSnapshot> {
      return state.pots.get(businessId) ?? emptyPots();
    },

    async listPayees(businessId, filter: PayeeFilter): Promise<readonly PayeeRow[]> {
      const all = state.payees.get(businessId) ?? [];
      const needle = filter.holderNameContains?.toLowerCase() ?? null;
      return all
        .filter((row) => {
          if (!filter.includeArchived && row.archived) return false;
          if (filter.rail !== null && row.rail !== filter.rail) return false;
          if (filter.outcome !== null && row.outcome !== filter.outcome) return false;
          if (filter.freshness !== null && row.freshness !== filter.freshness) return false;
          if (needle !== null) {
            const haystack = `${row.holderName} ${row.displayName}`.toLowerCase();
            if (!haystack.includes(needle)) return false;
          }
          return true;
        })
        .slice(0, filter.limit);
    },

    async listStandingOrders(
      businessId,
      filter: StandingOrderFilter,
    ): Promise<StandingOrderPage> {
      const page = state.standing.get(businessId) ?? { orders: [], occurrences: [] };
      const orders = page.orders
        .filter((o) => filter.includeCancelled || !o.cancelled)
        .slice(0, filter.limit);
      const ids = new Set(orders.map((o) => o.id));
      return {
        orders,
        occurrences: page.occurrences.filter((o) => ids.has(o.standingOrderId)),
      };
    },

    async listCardControls(businessId, filter: CardControlFilter): Promise<CardControlPage> {
      const page = state.cards.get(businessId) ?? { cards: [], decisions: [] };
      const decisions = (
        filter.declinesOnly ? page.decisions.filter((d) => d.outcome === "decline") : page.decisions
      ).slice(0, filter.decisionLimit);
      return { cards: page.cards.slice(0, filter.limit), decisions };
    },

    async listDisputes(businessId, filter: DisputeFilter): Promise<DisputePage> {
      const all = state.disputes.get(businessId) ?? [];
      // Counted over every case and filtered afterwards, the same way the live
      // gateway does it — so a test asserting "no open cases, eleven closed"
      // exercises the same shape.
      const openCount = all.filter((c) => !c.isClosed).length;
      const matched = all.filter((c) => {
        if (filter.status !== null) return c.status === filter.status;
        if (filter.openOnly && c.isClosed) return false;
        return true;
      });
      return {
        cases: matched
          .slice(0, filter.limit)
          .map((c) => (filter.includeEvents ? c : { ...c, events: [] })),
        openCount,
        closedCount: all.length - openCount,
      };
    },

    async listAccruals(businessId, filter: AccrualFilter): Promise<AccrualPage> {
      const page = state.accruals.get(businessId) ?? emptyAccruals();
      const days = page.days.filter(
        (d) => filter.includeSkipped || d.disposition !== "skipped",
      );
      return {
        schedules: page.schedules.slice(0, filter.scheduleLimit),
        months: page.months.slice(0, filter.monthLimit),
        days: days.slice(0, filter.dayLimit),
        invariants: page.invariants,
        accruedToDateCents: page.accruedToDateCents,
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
