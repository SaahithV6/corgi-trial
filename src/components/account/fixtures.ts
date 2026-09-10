/**
 * Demo data behind the account screen's data contract.
 *
 * ============================================================================
 * TODO(ledger): this module is the swap point.
 *
 * `getAccountDataSource()` returns a fixture today. When the ledger's read
 * side is ready, the `default` branch returns the real implementation of
 * `AccountDataSource` and every other branch keeps returning a fixture,
 * because the demo states must stay reachable without writing rows to a real
 * ledger. No component changes: they depend on the interface.
 *
 *   if (state === "default") return createLedgerDataSource();
 *
 * The adapter is thin. `src/lib/ledger/balances.ts` already exposes
 * `availableBalance(businessId)` returning
 * `{ ledgerCents, holdsCents, unclearedCents, availableCents }` as `bigint`,
 * which maps field for field onto `AccountSummary`:
 *
 *   ledgerCents           <- Number(b.ledgerCents)
 *   activeHoldsCents      <- Number(b.holdsCents)
 *   unclearedCreditsCents <- Number(b.unclearedCents)
 *   availableCents        <- Number(b.availableCents)
 *   bookingWatermark      <- Number(await bookingWatermarkAt(now))
 *
 * `Number()` is exact for every cent count under 2^53 (~$90tn); see the note
 * on `Cents` in `data-contract.ts` for how to widen to `bigint` if that ever
 * stops being true. The two list methods need queries that do not exist yet —
 * holds with their `A(E)`/`C(E)` terms, and postings with a `book` column —
 * and those are the contract's ask of the ledger worker.
 * ============================================================================
 *
 * The numbers here are not decorative. The over-capture figures ($50.00
 * authorised, $73.40 cleared, $0.00 remaining) are the ones measured against
 * the Lithic sandbox in DECISIONS 006, and the partial-clearing hold that
 * still shows `providerStatus: "SETTLED"` is the exact trap recorded there: the
 * rail's status field flips to settled while $260.00 is still authorised. A
 * consumer that released on that field would free money that is still held.
 */

import { fail, ok } from "@/lib/result";

import type {
  AccountDataSource,
  AccountSummary,
  Hold,
  Posting,
} from "./data-contract";
import type { DemoState, DemoView } from "./demo-state";

/**
 * The instant every fixture is read as-of.
 *
 * Fixed rather than `Date.now()`, so ages, countdowns and running balances are
 * reproducible: the screen is a pure function of the URL, screenshots do not
 * rot, and the server render and the client hydration cannot disagree.
 */
export const DEMO_NOW = "2026-09-09T19:42:00.000Z"; // 15:42 ET

/** How long the `loading` state holds the skeleton open. Long enough to see. */
export const DEMO_LOADING_MS = 8_000;

const BUSINESS = "Blue Ridge Coffee Roasters LLC";

/* -------------------------------------------------------------------------- */
/* default — a funded account with live holds                                 */
/* -------------------------------------------------------------------------- */

const OPERATING_LEDGER_CENTS = 4_821_560; // $48,215.60

/** The $50.00 fuel-pump authorisation, before any of it has cleared. */
const FUEL_AUTH_HOLD: Hold = {
  id: "hold_01K9SHELL",
  kind: "card_auth",
  descriptor: "SHELL OIL 1247 · pump 4",
  authorisedCents: 5_000,
  clearedCents: 0,
  remainingCents: 5_000,
  closed: false,
  placedAt: "2026-09-09T19:41:30.000Z",
  expiresAt: "2026-09-16T19:41:30.000Z",
  availableAt: null,
  policyRef: null,
  providerStatus: "PENDING",
};

const FUEL_AUTH_POSTING: Posting = {
  id: "post_01K9SHELLAUTH",
  book: "memo",
  description: "Card authorisation · SHELL OIL 1247",
  counterparty: "SHELL OIL 1247",
  occurredAt: "2026-09-09T19:41:30.000Z",
  valueDate: "2026-09-09",
  ledgerDeltaCents: null,
  availableDeltaCents: -5_000,
  holdId: "hold_01K9SHELL",
  sourceRef: "lithic:evt_01K9F3Q2M7X",
};

const OPERATING_HOLDS: readonly Hold[] = [
  {
    id: "hold_01K9ACH",
    kind: "uncleared_credit",
    descriptor: "SQUARE INC · daily payout",
    authorisedCents: 1_250_000,
    clearedCents: 0,
    remainingCents: 1_250_000,
    closed: false,
    placedAt: "2026-09-09T13:05:10.000Z",
    expiresAt: null,
    availableAt: "2026-09-10T13:00:00.000Z", // 09:00 ET, next banking day
    policyRef: "fap_v3 · ACH credit, counterparty seen ≥ 3 times",
    providerStatus: null,
  },
  {
    id: "hold_01K9AMZN",
    kind: "card_auth",
    descriptor: "AMZN MKTPLACE US*2X41K",
    authorisedCents: 124_000,
    clearedCents: 0,
    remainingCents: 124_000,
    closed: false,
    placedAt: "2026-09-09T16:30:00.000Z",
    expiresAt: "2026-09-16T16:30:00.000Z",
    availableAt: null,
    policyRef: null,
    providerStatus: "PENDING",
  },
  {
    // The DECISIONS 006 trap, on screen: the rail says SETTLED, $260.00 of the
    // authorisation is still live, and the derived hold is what we withhold.
    id: "hold_01K9SYSCO",
    kind: "card_auth",
    descriptor: "SYSCO FOOD SERVICES 8823",
    authorisedCents: 90_000,
    clearedCents: 64_000,
    remainingCents: 26_000,
    closed: false,
    placedAt: "2026-09-08T15:42:00.000Z",
    expiresAt: "2026-09-15T15:42:00.000Z",
    availableAt: null,
    policyRef: null,
    providerStatus: "SETTLED",
  },
  {
    id: "hold_01K9DISPUTE",
    kind: "manual",
    descriptor: "Dispute reserve · case DSP-1188",
    authorisedCents: 50_000,
    clearedCents: 0,
    remainingCents: 50_000,
    closed: false,
    placedAt: "2026-09-05T14:10:00.000Z",
    expiresAt: null,
    availableAt: null,
    policyRef: null,
    providerStatus: null,
  },
];

const OPERATING_POSTINGS: readonly Posting[] = [
  {
    id: "post_01K9SYSCOCLR",
    book: "financial",
    description: "Card clearing · SYSCO FOOD SERVICES 8823",
    counterparty: "SYSCO FOOD SERVICES 8823",
    occurredAt: "2026-09-09T18:12:00.000Z",
    valueDate: "2026-09-09",
    ledgerDeltaCents: -64_000,
    // The hold released $640.00 as the ledger took $640.00: a partial clearing
    // against its own authorisation is available-neutral.
    availableDeltaCents: 0,
    holdId: "hold_01K9SYSCO",
    sourceRef: "lithic:evt_01K9D8ZQ4KB",
  },
  {
    id: "post_01K9AMZNAUTH",
    book: "memo",
    description: "Card authorisation · AMZN MKTPLACE US",
    counterparty: "AMZN MKTPLACE US*2X41K",
    occurredAt: "2026-09-09T16:30:00.000Z",
    valueDate: "2026-09-09",
    ledgerDeltaCents: null,
    availableDeltaCents: -124_000,
    holdId: "hold_01K9AMZN",
    sourceRef: "lithic:evt_01K9C1P7T2V",
  },
  {
    id: "post_01K9WIRE",
    book: "financial",
    description: "Outgoing wire · Cascade Green Coffee Importers",
    counterparty: "Cascade Green Coffee Importers",
    occurredAt: "2026-09-09T14:20:00.000Z",
    valueDate: "2026-09-09",
    ledgerDeltaCents: -840_000,
    availableDeltaCents: -840_000,
    holdId: null,
    sourceRef: "fed:20260909B1QGC02",
  },
  {
    id: "post_01K9ACHHOLD",
    book: "memo",
    description: "Uncleared-credit hold placed · SQUARE INC",
    counterparty: "SQUARE INC",
    occurredAt: "2026-09-09T13:05:10.000Z",
    valueDate: "2026-09-09",
    ledgerDeltaCents: null,
    availableDeltaCents: -1_250_000,
    holdId: "hold_01K9ACH",
    sourceRef: null,
  },
  {
    id: "post_01K9ACHCR",
    book: "financial",
    description: "ACH credit · SQUARE INC daily payout",
    counterparty: "SQUARE INC",
    occurredAt: "2026-09-09T13:05:00.000Z",
    valueDate: "2026-09-09",
    ledgerDeltaCents: 1_250_000,
    availableDeltaCents: 1_250_000,
    holdId: null,
    sourceRef: "ach:trace 091000015551234",
  },
  {
    id: "post_01K9SBUX",
    book: "financial",
    description: "Card clearing · STARBUCKS STORE 09114 (no matching authorisation)",
    counterparty: "STARBUCKS STORE 09114",
    occurredAt: "2026-09-08T21:05:00.000Z",
    valueDate: "2026-09-08",
    ledgerDeltaCents: -1_875,
    availableDeltaCents: -1_875,
    holdId: null,
    sourceRef: "lithic:evt_01K97YH3N8D",
  },
  {
    id: "post_01K9FEE",
    book: "financial",
    description: "Monthly account fee",
    counterparty: null,
    occurredAt: "2026-09-08T09:00:00.000Z",
    valueDate: "2026-09-01",
    ledgerDeltaCents: -3_000,
    availableDeltaCents: -3_000,
    holdId: null,
    sourceRef: null,
  },
  {
    id: "post_01K9XFER",
    book: "financial",
    description: "Internal transfer from Payroll ••1120",
    counterparty: "Blue Ridge Coffee Roasters LLC · Payroll",
    occurredAt: "2026-09-07T12:00:00.000Z",
    valueDate: "2026-09-07",
    ledgerDeltaCents: 500_000,
    availableDeltaCents: 500_000,
    holdId: null,
    sourceRef: null,
  },
];

function operatingSummary(accountId: string, authPending: boolean): AccountSummary {
  const activeHoldsCents = authPending ? 205_000 : 200_000;
  const unclearedCreditsCents = 1_250_000;

  return {
    accountId,
    accountName: "Operating",
    businessName: BUSINESS,
    accountNumberLast4: "4417",
    currency: "USD",
    ledgerCents: OPERATING_LEDGER_CENTS,
    availableCents:
      OPERATING_LEDGER_CENTS - activeHoldsCents - unclearedCreditsCents,
    activeHoldsCents,
    unclearedCreditsCents,
    asOf: DEMO_NOW,
    bookingWatermark: 148_302,
  };
}

/* -------------------------------------------------------------------------- */
/* edge — over-capture at a fuel pump, available negative                     */
/* -------------------------------------------------------------------------- */

/**
 * DECISIONS 006, on a fleet fuel card with a small float:
 *
 *   authorize 5000            hold −5000   settled 0
 *   clearing 7340 (over-cap)  hold 0       settled −7340
 *
 * $50.00 was authorised and therefore $50.00 was withheld. The pump captured
 * $73.40. The extra $23.40 was never held, so it was never protected, and the
 * account is now overdrawn. The hold is not "wrong" — `H(E) = max(A − C, 0)`
 * is 0 and the network is owed the money. This is a correct ledger showing an
 * uncomfortable fact, and the screen has to say so rather than clamp it.
 */
const FUEL_CARD_LEDGER_CENTS = -840; // $65.00 float, then −$73.40

const FUEL_CARD_HOLDS: readonly Hold[] = [
  {
    id: "hold_01K9SHELLEDGE",
    kind: "card_auth",
    descriptor: "SHELL OIL 1247 · pump 4",
    authorisedCents: 5_000,
    clearedCents: 7_340,
    remainingCents: 0,
    closed: true,
    placedAt: "2026-09-09T17:58:00.000Z",
    expiresAt: "2026-09-16T17:58:00.000Z",
    availableAt: null,
    policyRef: null,
    providerStatus: "SETTLED",
  },
  {
    id: "hold_01K9BLUEBOTTLE",
    kind: "card_auth",
    descriptor: "BLUE BOTTLE COFFEE 41",
    authorisedCents: 1_200,
    clearedCents: 0,
    remainingCents: 1_200,
    closed: false,
    placedAt: "2026-09-09T19:12:00.000Z",
    expiresAt: "2026-09-16T19:12:00.000Z",
    availableAt: null,
    policyRef: null,
    providerStatus: "PENDING",
  },
];

const FUEL_CARD_POSTINGS: readonly Posting[] = [
  {
    id: "post_01K9SHELLREL",
    book: "memo",
    description: "Hold released · SHELL OIL 1247 (final clearing, over-capture)",
    counterparty: "SHELL OIL 1247",
    occurredAt: "2026-09-09T19:20:05.000Z",
    valueDate: "2026-09-09",
    ledgerDeltaCents: null,
    availableDeltaCents: 5_000,
    holdId: "hold_01K9SHELLEDGE",
    sourceRef: "lithic:evt_01K9E7R4W9P",
  },
  {
    id: "post_01K9SHELLCLR",
    book: "financial",
    description: "Card clearing · SHELL OIL 1247 · pump 4",
    counterparty: "SHELL OIL 1247",
    occurredAt: "2026-09-09T19:20:00.000Z",
    valueDate: "2026-09-09",
    ledgerDeltaCents: -7_340,
    availableDeltaCents: -7_340,
    holdId: "hold_01K9SHELLEDGE",
    sourceRef: "lithic:evt_01K9E7R4W9P",
  },
  {
    id: "post_01K9BBAUTH",
    book: "memo",
    description: "Card authorisation · BLUE BOTTLE COFFEE 41",
    counterparty: "BLUE BOTTLE COFFEE 41",
    occurredAt: "2026-09-09T19:12:00.000Z",
    valueDate: "2026-09-09",
    ledgerDeltaCents: null,
    availableDeltaCents: -1_200,
    holdId: "hold_01K9BLUEBOTTLE",
    sourceRef: "lithic:evt_01K9E5J1C4M",
  },
  {
    id: "post_01K9SHELLAUTH2",
    book: "memo",
    description: "Card authorisation · SHELL OIL 1247 · pump 4",
    counterparty: "SHELL OIL 1247",
    occurredAt: "2026-09-09T17:58:00.000Z",
    valueDate: "2026-09-09",
    ledgerDeltaCents: null,
    availableDeltaCents: -5_000,
    holdId: "hold_01K9SHELLEDGE",
    sourceRef: "lithic:evt_01K9DZ2B6TQ",
  },
  {
    id: "post_01K9WFM",
    book: "financial",
    description: "Card clearing · WHOLE FOODS MKT 10412",
    counterparty: "WHOLE FOODS MKT 10412",
    occurredAt: "2026-09-09T15:02:00.000Z",
    valueDate: "2026-09-09",
    ledgerDeltaCents: -4_218,
    availableDeltaCents: -4_218,
    holdId: null,
    sourceRef: "lithic:evt_01K9DB8K5RS",
  },
  {
    id: "post_01K9FUELTOP",
    book: "financial",
    description: "Internal transfer from Operating ••4417",
    counterparty: "Blue Ridge Coffee Roasters LLC · Operating",
    occurredAt: "2026-09-08T11:00:00.000Z",
    valueDate: "2026-09-08",
    ledgerDeltaCents: 10_000,
    availableDeltaCents: 10_000,
    holdId: null,
    sourceRef: null,
  },
];

function fuelCardSummary(accountId: string): AccountSummary {
  const activeHoldsCents = 1_200;
  return {
    accountId,
    accountName: "Fuel card",
    businessName: BUSINESS,
    accountNumberLast4: "8802",
    currency: "USD",
    ledgerCents: FUEL_CARD_LEDGER_CENTS,
    availableCents: FUEL_CARD_LEDGER_CENTS - activeHoldsCents,
    activeHoldsCents,
    unclearedCreditsCents: 0,
    asOf: DEMO_NOW,
    bookingWatermark: 148_311,
  };
}

/* -------------------------------------------------------------------------- */
/* empty — opened, never used                                                 */
/* -------------------------------------------------------------------------- */

function emptySummary(accountId: string): AccountSummary {
  return {
    accountId,
    accountName: "Reserve",
    businessName: BUSINESS,
    accountNumberLast4: "9002",
    currency: "USD",
    ledgerCents: 0,
    availableCents: 0,
    activeHoldsCents: 0,
    unclearedCreditsCents: 0,
    asOf: DEMO_NOW,
    bookingWatermark: 148_311,
  };
}

/* -------------------------------------------------------------------------- */
/* The data source                                                            */
/* -------------------------------------------------------------------------- */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const QUERY_FAILURE = () =>
  fail(
    "LEDGER_QUERY_FAILED",
    "The balance query did not complete. No money moved; this is a read failure.",
    { retryable: true, source: "ledger.balances" },
  );

/**
 * Pick the fixture that answers the contract for a given demo state.
 *
 * TODO(ledger): `case "default"` returns the real `AccountDataSource` once
 * `src/lib/ledger/balances.ts` exists. Everything else stays a fixture.
 */
export function getAccountDataSource(view: DemoView): AccountDataSource {
  const { state, authPending } = view;

  return {
    async getAccountSummary({ accountId }) {
      await simulateLatency(state);
      if (state === "error") return QUERY_FAILURE();
      if (state === "empty") return ok(emptySummary(accountId));
      if (state === "edge") return ok(fuelCardSummary(accountId));
      return ok(operatingSummary(accountId, authPending));
    },

    async listHolds() {
      await simulateLatency(state);
      if (state === "error") return QUERY_FAILURE();
      if (state === "empty") return ok([]);
      if (state === "edge") return ok(FUEL_CARD_HOLDS);
      return ok(authPending ? [FUEL_AUTH_HOLD, ...OPERATING_HOLDS] : OPERATING_HOLDS);
    },

    async listPostings({ limit }) {
      await simulateLatency(state);
      if (state === "error") return QUERY_FAILURE();
      if (state === "empty") return ok([]);

      const rows =
        state === "edge"
          ? FUEL_CARD_POSTINGS
          : authPending
            ? [FUEL_AUTH_POSTING, ...OPERATING_POSTINGS]
            : OPERATING_POSTINGS;

      return ok(limit === undefined ? rows : rows.slice(0, limit));
    },
  };
}

/**
 * The `loading` state is not a mock of a slow query — it *is* a slow query.
 * The page's Suspense boundary shows the real skeleton for as long as this
 * takes, which is the only way to know the skeleton is correct.
 */
function simulateLatency(state: DemoState): Promise<void> {
  return state === "loading" ? delay(DEMO_LOADING_MS) : Promise.resolve();
}

/* -------------------------------------------------------------------------- */
/* Account directory (the index page)                                         */
/* -------------------------------------------------------------------------- */

export type DemoAccountRef = {
  readonly accountId: string;
  readonly accountName: string;
  readonly last4: string;
  readonly businessName: string;
  readonly ledgerCents: number;
  readonly availableCents: number;
  /** Which demo state this row opens in, so the directory's figures match the screen. */
  readonly state: DemoState;
};

/**
 * TODO(ledger): replace with a real `listAccounts` when the ledger exposes one.
 * Deliberately not part of `AccountDataSource` — the account screen does not
 * need it, and the contract stays narrow.
 */
export const DEMO_ACCOUNTS: readonly DemoAccountRef[] = [
  {
    accountId: "acct_operating_4417",
    accountName: "Operating",
    last4: "4417",
    businessName: BUSINESS,
    ledgerCents: OPERATING_LEDGER_CENTS,
    availableCents: OPERATING_LEDGER_CENTS - 200_000 - 1_250_000,
    state: "default",
  },
  {
    accountId: "acct_fuelcard_8802",
    accountName: "Fuel card",
    last4: "8802",
    businessName: BUSINESS,
    ledgerCents: FUEL_CARD_LEDGER_CENTS,
    availableCents: FUEL_CARD_LEDGER_CENTS - 1_200,
    state: "edge",
  },
  {
    accountId: "acct_reserve_9002",
    accountName: "Reserve",
    last4: "9002",
    businessName: BUSINESS,
    ledgerCents: 0,
    availableCents: 0,
    state: "empty",
  },
];
