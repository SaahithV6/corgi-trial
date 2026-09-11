/**
 * The three fixture states behind the funding screen's data contract.
 *
 * `default` and `edge` are not here: both read Neon (see `demo-state.ts` for
 * why the edge case in particular has to be live — a fixture of "funded but not
 * yet available" would demonstrate the arithmetic while proving nothing about
 * it). These three exist so `loading`, `error` and `empty` can be shown on
 * demand, in order, in front of a panel, without slowing the real database
 * down, breaking it, or closing the only deposit accounts on the book.
 *
 * The policy rows are the SEEDED rows, verbatim — ACH really is one banking day
 * for `self` and `known` and two for `new`, wire and internal really are zero.
 * A fixture that invented a hold period would be teaching a rule this bank does
 * not have.
 */

import { fail, ok } from "@/lib/result";

import type {
  BusinessView,
  FundingDataSource,
  FundingSnapshot,
  PolicyView,
  TransactGateView,
} from "./data-contract";
import type { DemoState } from "./demo-state";

/** Fixed, so ages and screenshots are reproducible. */
export const DEMO_NOW = "2026-09-10T18:20:00.000Z"; // 14:20 ET
export const DEMO_VALUE_DATE = "2026-09-10";

/** How long `?state=loading` holds the skeleton open. Long enough to see. */
export const DEMO_LOADING_MS = 6_000;

const POLICIES: readonly PolicyView[] = [
  {
    id: "3bae7e8b-ed81-5a50-9ea7-cd22c88e0ccd",
    rail: "ach",
    counterpartyClass: "new",
    bankingDaysHold: 2,
    releaseLocalTime: "09:00:00",
    note: "A counterparty we have not seen before: settlement date plus two banking days, covering the unauthorised-return window for corporate CCD/CTX entries.",
  },
  {
    id: "8f0c3c02-27e5-5a7f-8094-fec9197c711a",
    rail: "ach",
    counterpartyClass: "known",
    bankingDaysHold: 1,
    releaseLocalTime: "09:00:00",
    note: "Counterparty seen at least 3 times over at least 60 days. Administrative-return risk (R01/R02/R03) is concentrated in the first two banking days, and a proven payer — usually payroll or a recurring customer — earns one of them back.",
  },
  {
    id: "c2ada775-2384-54a8-9f9a-5efdd64f4390",
    rail: "ach",
    counterpartyClass: "self",
    bankingDaysHold: 1,
    releaseLocalTime: "09:00:00",
    note: "An ACH pull from the customer's own verified external account. Still a hold, because a customer can overdraw their own outside bank as easily as anyone else can.",
  },
  {
    id: "1ac53394-6225-5b7b-ab56-74145d18532f",
    rail: "card",
    counterpartyClass: "n/a",
    bankingDaysHold: 0,
    releaseLocalTime: "09:00:00",
    note: "A merchant refund arriving over the card network is already funded through settlement, so it is available immediately.",
  },
  {
    id: "866159fb-82c7-5653-ba0e-c370ae568bf7",
    rail: "internal",
    counterpartyClass: "self",
    bankingDaysHold: 0,
    releaseLocalTime: "09:00:00",
    note: "A transfer between two accounts on our own book. Both legs are ours and neither can be returned, so there is nothing to hold against.",
  },
  {
    id: "42b9caa3-6b8d-5515-9a28-4c30ae2e46ec",
    rail: "usdc",
    counterpartyClass: "n/a",
    bankingDaysHold: 0,
    releaseLocalTime: "09:00:00",
    note: "Released on the Nth confirmation, not on a timer: the risk here is a chain reorg, not a counterparty. 1 confirmation on the Base Sepolia demo; 2 is the number for anything that matters.",
  },
  {
    id: "50492935-f73e-586b-a55b-00b21ec13522",
    rail: "wire",
    counterpartyClass: "n/a",
    bankingDaysHold: 0,
    releaseLocalTime: "09:00:00",
    note: "Immediate. A wire is irrevocable on receipt, so holding one is indefensible to the customer and buys us nothing.",
  },
];

/**
 * One account mid-hold, for the loading skeleton to resolve into.
 *
 * The numbers are internally consistent — $2,500.00 on the book, $2,500.00
 * uncleared, $0.00 available — because a fixture whose decomposition does not
 * add up teaches the reader that this screen's numbers do not have to.
 */
const FIXTURE_BUSINESS_ID = "e274546d-6bdd-5266-b0fb-cc839a7811f9";

const ALLOWED_GATE: TransactGateView = {
  allowed: true,
  code: null,
  message:
    "Approved, but on simulated or manual evidence: this deployment's policy allows it, and the label says exactly what it rests on.",
  status: "approved",
  evidence: "manual",
};

/**
 * A refused business, in the fixture states too.
 *
 * The refusal is half of what this screen has to get right, so a fixture that
 * only ever showed an allowed customer would leave the other half visible on
 * the live screen alone. The code is one `canTransact()` really emits.
 */
const REFUSED_GATE: TransactGateView = {
  allowed: false,
  code: "KYB_NEEDS_REVIEW",
  message: "Verification is with a reviewer. This business can be viewed, but not transacted on.",
  status: "needs_review",
  evidence: "live",
};

const FIXTURE_BUSINESSES: readonly BusinessView[] = [
  {
    id: FIXTURE_BUSINESS_ID,
    legalName: "Ridgeline Robotics, Inc.",
    ein: "000000000",
    depositAccountId: "a0c41a37-2be1-5c30-bfe9-03455f048fac",
    gate: ALLOWED_GATE,
    gateIfLiveRequired: {
      ...REFUSED_GATE,
      code: "KYB_EVIDENCE_MANUAL",
      message:
        "Verification is approved on manual evidence, and this policy requires live third-party evidence.",
      status: "approved",
      evidence: "manual",
    },
  },
  {
    id: "3593cbbb-cd74-5078-ab3c-c4c546910f95",
    legalName: "Silverline Freight Co.",
    ein: "222221000",
    // No account has ever been opened for this business, and that is a fact the
    // screen states rather than an omission it hides.
    depositAccountId: null,
    gate: REFUSED_GATE,
    gateIfLiveRequired: REFUSED_GATE,
  },
];

const LOADING_ACCOUNTS: FundingSnapshot["accounts"] = [
  {
    id: "a0c41a37-2be1-5c30-bfe9-03455f048fac",
    businessId: FIXTURE_BUSINESS_ID,
    businessName: "Ridgeline Robotics, Inc.",
    accountName: "Ridgeline Robotics, Inc. — business current account",
    currency: "USD",
    gate: ALLOWED_GATE,
    readError: null,
    balance: {
      ledgerDisplay: "$2,500.00",
      availableDisplay: "$0.00",
      cardHoldsDisplay: "$0.00",
      unclearedDisplay: "$2,500.00",
      pendingOutboundDisplay: "$0.00",
      availableIsNegative: false,
    },
    unclearedHolds: [
      {
        holdId: "00000000-0000-4000-8000-000000000001",
        descriptor: "Uncleared credit held to 2026-09-11 09:00:00 ET (ach/self, 1 banking day)",
        externalRef: "plaid:DEMO-ITEM:DEMO-ACCOUNT:DEMO",
        itemId: "DEMO-ITEM",
        plaidAccountId: "DEMO-ACCOUNT",
        amountDisplay: "$2,500.00",
        releaseDate: "2026-09-11",
        availableAt: "2026-09-11T13:00:00.000Z",
        neverReleases: false,
        released: false,
        closedReason: null,
        placedAt: DEMO_NOW,
        policy: {
          rail: "ach",
          counterpartyClass: "self",
          bankingDaysHold: 1,
          releaseLocalTime: "09:00:00",
        },
      },
    ],
  },
];

const PREFLIGHT_FAILED = {
  code: "FUNDING_PREFLIGHT_FAILED",
  message:
    "The balances, holds and availability policy could not be read, so the screen cannot be drawn honestly and the form is not drawn at all. Nothing was funded — this is a read, and a read cannot post an entry.",
} as const;

function snapshot(
  accounts: FundingSnapshot["accounts"],
  businesses: readonly BusinessView[] = FIXTURE_BUSINESSES,
): FundingSnapshot {
  return {
    accounts,
    businesses,
    selectedBusinessId: businesses[0]?.id ?? null,
    policies: POLICIES,
    defaultValueDate: DEMO_VALUE_DATE,
    provider: {
      // A fixture must not claim the provider is configured: this state cannot
      // call Plaid and the button under it says so.
      configured: false,
      environment: "sandbox",
      webhookUrl: null,
    },
    asOf: DEMO_NOW,
  };
}

/**
 * The fixture source for one non-live demo state.
 *
 * `loading` is not a rendered mock — it genuinely does not resolve for six
 * seconds, so the Suspense fallback on the page is the real loading state and
 * not a picture of one.
 */
export function createFixtureSource(
  state: Exclude<DemoState, "default" | "edge">,
): FundingDataSource {
  return {
    // The `?business=` reference is accepted and ignored, on purpose. These
    // three states answer a question about the SCREEN — is the skeleton right,
    // does the error branch draw, what does an empty book look like — and none
    // of them is about a particular customer. Honouring the selection here
    // would mean inventing fixture balances for whatever uuid was typed.
    async getSnapshot(_businessId: string | null) {
      void _businessId;
      switch (state) {
        case "loading":
          await new Promise((resolve) => setTimeout(resolve, DEMO_LOADING_MS));
          return ok(snapshot(LOADING_ACCOUNTS));
        case "empty":
          // An empty book means no account was ever opened — so the businesses
          // carry no deposit account either. A fixture whose two halves
          // disagreed would be teaching the reader that this screen's halves
          // are allowed to.
          return ok(
            snapshot(
              [],
              FIXTURE_BUSINESSES.map((business) => ({ ...business, depositAccountId: null })),
            ),
          );
        case "error":
          return fail(PREFLIGHT_FAILED.code, PREFLIGHT_FAILED.message);
      }
    },
  };
}
