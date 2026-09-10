/**
 * The four fixture states behind the console's data contract.
 *
 * `default` is not here: it is the live book. These four exist so `loading`,
 * `empty`, `error` and `edge` can be shown on demand, in order, in front of a
 * panel — without emptying a ledger, breaking a database, or overdrawing a
 * customer to make a point.
 *
 * ============================================================================
 * EVERY FIXTURE SNAPSHOT CARRIES `live: false`, AND THAT FLAG IS LOAD-BEARING.
 * It drives the FIXTURE badge, and it is passed to the decision form, which
 * will not offer to write against a row that has no database row behind it.
 * A fixture that could pass for live is the same failure as a simulated
 * integration labelled LIVE, one screen further down.
 * ============================================================================
 *
 * THE EDGE STATE IS BUILT AROUND WHOEVER IS SIGNED IN. Its pending payment is
 * initiated by the *current actor*, whichever role the switcher is on, so the
 * disabled approve button and its reason are true statements about the person
 * reading the screen rather than a mock-up of somebody else's problem.
 *
 * The policy numbers are the seeded policy's numbers: the ACH threshold really
 * is $2,500 with one approver, so a fixture row and a live row are judged by
 * the same table.
 */

import { decisionGate, releaseGate } from "@/lib/approvals/gate";
import { fail, ok } from "@/lib/result";

import { foldTotals } from "./console-derive";
import type {
  AccountPosition,
  ConsoleActor,
  ConsoleDataSource,
  ConsoleSnapshot,
  Movement,
  PendingPayment,
} from "./console-contract";
import { CONSOLE_LOADING_MS, type ConsoleState } from "./console-state";

/** Fixed, so ages and screenshots are reproducible. */
export const DEMO_NOW = "2026-09-10T18:20:00.000Z"; // 14:20 ET

const DEMO_WATERMARK = "1284";

/** The seeded ACH policy, restated so a fixture row is judged the same way. */
const ACH_THRESHOLD_CENTS = 250_000n;

/* -------------------------------------------------------------------------- */
/* Positions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * An account an over-capture has driven negative.
 *
 * $412.00 on the book, $1,050.00 held against it after a fuel pump settled
 * above the amount it authorised, so available is −$638.00. §10 is explicit
 * that this is not clamped: clamping loses money, and a customer who is
 * overdrawn is overdrawn.
 */
const OVERDRAWN: AccountPosition = {
  accountId: "b8b2b6c4-1f43-4d8a-9a1b-2c9d5f0e7a31",
  accountName: "Business current account",
  businessName: "Kettle & Crumb Bakery LLC",
  last4: "7a31",
  ledgerCents: 41_200n,
  availableCents: -63_800n,
  activeHoldsCents: 105_000n,
  unclearedCreditsCents: 0n,
};

const HEALTHY: AccountPosition = {
  accountId: "0d1f4a26-6d55-4b0e-8a52-19b7c3e4d5f6",
  accountName: "Business current account",
  businessName: "Ridgeline Robotics, Inc.",
  last4: "d5f6",
  ledgerCents: 1_935_143n,
  availableCents: 1_874_143n,
  activeHoldsCents: 31_000n,
  unclearedCreditsCents: 30_000n,
};

const EDGE_POSITIONS: readonly AccountPosition[] = [OVERDRAWN, HEALTHY];

/* -------------------------------------------------------------------------- */
/* Movement                                                                   */
/* -------------------------------------------------------------------------- */

const EDGE_MOVEMENTS: readonly Movement[] = [
  {
    entryId: "3a7e1c90-4b2d-4f18-9c33-5e6a7b8c9d01",
    bookingSeq: "1284",
    bookingTime: "2026-09-10T17:58:12.000Z",
    valueDate: "2026-09-10",
    entryType: "original",
    description: "Card clearing — fuel pump, settled above the amount authorised",
    rail: "card",
    externalRef: "txn_5Zq2Hj",
    amountCents: -105_000n,
    accountId: OVERDRAWN.accountId,
    businessName: OVERDRAWN.businessName,
  },
  {
    entryId: "9f2b8d41-77ac-4c5e-b2d1-0a3f4e5d6c72",
    bookingSeq: "1281",
    bookingTime: "2026-09-10T16:12:44.000Z",
    valueDate: "2026-09-10",
    entryType: "rebook",
    description: "Planted settlement PLANT-MTVZDGIL-2, re-booked at the correct amount",
    rail: "ach",
    externalRef: "PLANT-MTVZDGIL-2",
    amountCents: 13_456n,
    accountId: HEALTHY.accountId,
    businessName: HEALTHY.businessName,
  },
  {
    entryId: "c41d0e77-2b6f-4a89-9e10-8d7c6b5a4f39",
    bookingSeq: "1280",
    bookingTime: "2026-09-10T16:12:44.000Z",
    valueDate: "2026-09-10",
    entryType: "reversal",
    description:
      "Reversal — settled amount was taken from the wrong field on the provider payload",
    rail: "ach",
    externalRef: "PLANT-MTVZDGIL-2",
    amountCents: -12_222n,
    accountId: HEALTHY.accountId,
    businessName: HEALTHY.businessName,
  },
  {
    entryId: "5e8a2f13-9c04-4d6b-a7f2-3b1c9d8e7a45",
    bookingSeq: "1276",
    bookingTime: "2026-09-10T14:03:07.000Z",
    valueDate: "2026-09-09",
    entryType: "original",
    description: "ACH credit received — customer deposit",
    rail: "ach",
    externalRef: "ach_9KpQ2m",
    amountCents: 254_280n,
    accountId: HEALTHY.accountId,
    businessName: HEALTHY.businessName,
  },
];

/* -------------------------------------------------------------------------- */
/* The pending payment, built around whoever is signed in                     */
/* -------------------------------------------------------------------------- */

const EDGE_PAYMENT_ID = "7c2a5b91-3e4d-4f60-8a91-6b5c4d3e2f10";
const EDGE_CONTENT_HASH =
  "4f2c8d1b6a3e5079c4b8d2f1a6e93058c7d4b1a2e6f3095c8b7d2a1e6f403958";

/**
 * The oldest payment awaiting approval, raised by the current actor.
 *
 * `initiatorActorId` is the signed-in actor's own id, so `decisionGate`
 * returns `self_initiated` and the approve button is disabled with the reason
 * beside it. Flip the role switcher and it stays disabled, because the reason
 * is who raised it, not which role you hold.
 */
function edgePayment(actor: ConsoleActor | null): PendingPayment {
  const gateInput = {
    state: "requested" as const,
    initiatorActorId: actor?.id ?? "00000000-0000-0000-0000-000000000000",
    initiatorName: actor?.displayName ?? "an actor this session cannot resolve",
    actor,
  };

  return {
    id: EDGE_PAYMENT_ID,
    amountCents: 420_000n,
    currency: "USD",
    rail: "ach",
    state: "requested",
    destination: "ACH ••4417 · Sysco Northeast",
    accountName: "Business current account",
    businessName: OVERDRAWN.businessName,
    initiatorName: gateInput.initiatorName,
    initiatorKind: actor?.kind ?? "human",
    requestedAt: "2026-09-10T15:41:09.000Z",
    valueDate: "2026-09-11",
    policyVersion: "ach@2026-01-01",
    thresholdCents: ACH_THRESHOLD_CENTS,
    aboveThreshold: true,
    approvalsHeld: 0,
    approvalsRequired: 1,
    contentHash: EDGE_CONTENT_HASH,
    gate: decisionGate(gateInput),
    releaseGate: releaseGate({
      ...gateInput,
      approvalsHeld: 0,
      approvalsRequired: 1,
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* The snapshots                                                              */
/* -------------------------------------------------------------------------- */

function edgeSnapshot(actor: ConsoleActor | null): ConsoleSnapshot {
  return {
    readAt: DEMO_NOW,
    bookingWatermark: DEMO_WATERMARK,
    actor,
    positions: EDGE_POSITIONS,
    totals: foldTotals(EDGE_POSITIONS),
    movements: EDGE_MOVEMENTS,
    attention: {
      pendingPayments: 3,
      pendingCapped: false,
      oldestPendingAt: "2026-09-10T15:41:09.000Z",
      overdrawnAccounts: 0,
      parkedWebhooks: 2,
      deadLetteredWebhooks: 1,
      businessesNotApproved: 1,
    },
    oldestPending: edgePayment(actor),
    live: false,
  };
}

/**
 * A deployment with nothing on the book.
 *
 * Not an error and not a bug: it is what this console looks like on the day it
 * is stood up, before the first business is verified. A front door that could
 * only render a populated book would be a front door nobody could trust on
 * day one.
 */
function emptySnapshot(actor: ConsoleActor | null): ConsoleSnapshot {
  return {
    readAt: DEMO_NOW,
    bookingWatermark: "0",
    actor,
    positions: [],
    totals: foldTotals([]),
    movements: [],
    attention: {
      pendingPayments: 0,
      pendingCapped: false,
      oldestPendingAt: null,
      overdrawnAccounts: 0,
      parkedWebhooks: 0,
      deadLetteredWebhooks: 0,
      businessesNotApproved: 0,
    },
    oldestPending: null,
    live: false,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The fixture source for one non-default state.
 *
 * `loading` is a genuinely slow read rather than a rendered skeleton: the
 * source waits, the page's Suspense boundary shows the real fallback, and what
 * you see is the component that would appear during a slow query — not a
 * picture of one.
 */
export function createFixtureConsoleSource(state: ConsoleState): ConsoleDataSource {
  return {
    async read(actor) {
      if (state === "error") {
        return fail(
          "CONSOLE_ECONNREFUSED",
          "the operator console could not be read: connect ECONNREFUSED — the ledger is unreachable from this instance",
          { retryable: true, source: "home.console.fixture", operation: "read" },
        );
      }

      if (state === "loading") {
        await sleep(CONSOLE_LOADING_MS);
        return ok(edgeSnapshot(actor));
      }

      if (state === "empty") return ok(emptySnapshot(actor));

      return ok(edgeSnapshot(actor));
    },
  };
}
