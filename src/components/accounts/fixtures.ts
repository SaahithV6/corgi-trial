/**
 * The three fixture states: `empty`, `error`, `edge`.
 *
 * They read nothing and write nothing. That is the whole reason they exist:
 * an over-capture that drives an account overdrawn, and a balance query that
 * fails, are not conditions anybody should seed on a live ledger to have
 * something to show. `?state=` produces them from constants, and the URL is
 * the reproduction.
 *
 * `loading` and `default` are NOT here. Both are the live database — see
 * `isLiveConsole()` — because a skeleton is only proven by standing in front
 * of the read it stands in for.
 *
 * ── The edge case, measured ─────────────────────────────────────────────────
 *
 * DECISIONS 006, on a fleet fuel card with a small float:
 *
 *     authorize 5000            hold −5000    settled     0
 *     clearing  7340 (over-cap) hold     0    settled −7340
 *
 * $50.00 was authorised, so $50.00 was withheld. The pump captured $73.40. The
 * extra $23.40 was never held, so it was never protected, and the account is
 * now overdrawn. `H(E) = max(A − C, 0)` is 0 — not because anything failed,
 * but because that is what the formula says when a capture exceeds its
 * authorisation.
 *
 * The available balance that comes out of this is NEGATIVE and this screen
 * does not clamp it, because `availableBalance()` does not clamp it, because
 * an overdraft hidden behind a cosmetic floor is a lie an operator acts on.
 *
 * These figures are the same ones `src/components/account/fixtures.ts` uses for
 * its own `?state=edge`. Two screens telling the same story about the same
 * fuel card have to quote the same numbers or one of them is wrong.
 */

import { fail, ok, type ErrorShape, type Result } from "@/lib/result";
import { holdState, type CardEvent } from "@/lib/holds";

import type {
  ConsoleBusiness,
  ConsoleHold,
  ConsoleSnapshot,
  HoldDetail,
  HoldEventRow,
} from "./contract";
import type { ConsoleData } from "./live-source";
import { CONSOLE_LOADING_MS, type ConsoleState } from "./console-state";

/** One fixed instant, so a screenshot of a fixture never ages between takes. */
export const FIXTURE_NOW = "2026-09-09T19:24:00.000Z";

/* -------------------------------------------------------------------------- */
/* edge — the over-capture                                                    */
/* -------------------------------------------------------------------------- */

export const EDGE_HOLD_ID = "fixture-hold-shell-1247";
const EDGE_AUTH_TOKEN = "fixture-txn-shell-1247";

const EDGE_BUSINESS: ConsoleBusiness = {
  businessId: "fixture-business-blue-ridge",
  legalName: "Blue Ridge Coffee Roasters LLC",
  accountId: "fixture-account-fuel-8802",
  accountName: "Fuel card",
  currency: "USD",
  cardCount: 1,
};

/**
 * $65.00 of float, then a $73.40 capture. `−840` is the ledger, and it is
 * negative before a single hold is subtracted.
 */
const EDGE_LEDGER_CENTS = -840n;
/** The Blue Bottle authorisation, still open and still withholding $12.00. */
const EDGE_OPEN_HOLD_CENTS = 1_200n;

const EDGE_HOLDS: readonly ConsoleHold[] = [
  {
    holdId: "fixture-hold-blue-bottle",
    kind: "card_auth",
    descriptor: "BLUE BOTTLE COFFEE 41",
    externalRef: "lithic:fixture-txn-blue-bottle",
    providerAuthId: "fixture-txn-blue-bottle",
    authorisedCents: 1_200n,
    clearedCents: 0n,
    remainingCents: 1_200n,
    memoBalanceCents: 1_200n,
    closed: false,
    closedReason: null,
    closureReversed: false,
    placedAt: "2026-09-09T19:12:00.000Z",
    expiresAt: "2026-09-16T19:12:00.000Z",
    eventCount: 1,
  },
  {
    holdId: EDGE_HOLD_ID,
    kind: "card_auth",
    descriptor: "SHELL OIL 1247 · pump 4",
    externalRef: `lithic:${EDGE_AUTH_TOKEN}`,
    providerAuthId: EDGE_AUTH_TOKEN,
    authorisedCents: 5_000n,
    clearedCents: 7_340n,
    remainingCents: 0n,
    memoBalanceCents: 0n,
    // NOT closed. Nothing in the event set closes it: no final capture, no
    // close, no expiry, and A(E) is 5000 rather than <= 0. The hold is zero
    // because `max(A - C, 0)` is zero when C exceeds A — which is a different
    // fact from "released", and the screen must not conflate them. A
    // `hold_closure` row here would be a bug: `terminallyClosed` is false, and
    // the table is append-only, so it could never be taken back.
    closed: false,
    closedReason: null,
    closureReversed: false,
    placedAt: "2026-09-09T17:58:00.000Z",
    expiresAt: "2026-09-16T17:58:00.000Z",
    eventCount: 2,
  },
];

const EDGE_SNAPSHOT: ConsoleSnapshot = {
  business: EDGE_BUSINESS,
  balances: {
    ledgerCents: EDGE_LEDGER_CENTS,
    holdsCents: EDGE_OPEN_HOLD_CENTS,
    unclearedCents: 0n,
    // −840 − 1200 − 0 = −2040. Not clamped, on purpose.
    availableCents: EDGE_LEDGER_CENTS - EDGE_OPEN_HOLD_CENTS,
  },
  cards: [
    {
      cardId: "fixture-card-8802",
      providerCardToken: "fixture-card-token-8802",
      lastFour: "8802",
      nickname: "Fleet fuel · van 2",
      createdAt: "2026-09-01T14:02:00.000Z",
    },
  ],
  holds: EDGE_HOLDS,
  asOf: FIXTURE_NOW,
  bookingWatermark: 148_311n,
  foldedCardHoldsCents: EDGE_OPEN_HOLD_CENTS,
};

/**
 * The event set behind the over-capture, and the fold over it.
 *
 * The running totals are computed by calling `holdState()` on each prefix, the
 * same way the live drill-down does, so the fixture cannot show arithmetic the
 * model would not produce.
 *
 * Every limb of `closed(E)` is false here — no `is_final`, no close event, the
 * expiry is a week out, and `A(E) = 5000 > 0`. So `H` is `max(5000 - 7340, 0)`
 * = 0 by the formula alone, with no closure row anywhere. "Zero because the
 * capture exceeded the authorisation" and "zero because the hold was released"
 * are different facts, and the screen says which one this is.
 */
const EDGE_EVENTS: readonly CardEvent[] = [
  {
    kind: "authorization",
    amountCents: 5_000n,
    isFinal: false,
    valueDate: "2026-09-09",
    providerEventId: "fixture-evt-shell-auth",
  },
  {
    kind: "clearing",
    amountCents: 7_340n,
    isFinal: false,
    valueDate: "2026-09-09",
    providerEventId: "fixture-evt-shell-clearing",
  },
];

const EDGE_RECEIVED_AT = [
  "2026-09-09T17:58:00.000Z",
  "2026-09-09T19:20:00.000Z",
] as const;

function edgeEventRows(): readonly HoldEventRow[] {
  const clock = {
    expiresAt: new Date("2026-09-16T17:58:00.000Z"),
    now: new Date(FIXTURE_NOW),
  };
  return EDGE_EVENTS.map((event, index) => {
    const prefix = holdState(EDGE_EVENTS.slice(0, index + 1), clock);
    return {
      providerEventId: event.providerEventId,
      kind: event.kind,
      amountCents: event.amountCents,
      isFinal: event.isFinal,
      valueDate: event.valueDate,
      receivedAt: EDGE_RECEIVED_AT[index] ?? FIXTURE_NOW,
      runningAuthorisedCents: prefix.authorisedCents,
      runningCapturedCents: prefix.capturedCents,
      runningHoldCents: prefix.holdCents,
    };
  });
}

function edgeHoldDetail(): HoldDetail {
  const clock = {
    expiresAt: new Date("2026-09-16T17:58:00.000Z"),
    now: new Date(FIXTURE_NOW),
  };
  return {
    holdId: EDGE_HOLD_ID,
    kind: "card_auth",
    descriptor: "SHELL OIL 1247 · pump 4",
    externalRef: `lithic:${EDGE_AUTH_TOKEN}`,
    accountId: EDGE_BUSINESS.accountId,
    businessId: EDGE_BUSINESS.businessId,
    businessName: EDGE_BUSINESS.legalName,
    provider: "lithic",
    providerAuthId: EDGE_AUTH_TOKEN,
    origin: "authorization",
    placedAt: "2026-09-09T17:58:00.000Z",
    expiresAt: "2026-09-16T17:58:00.000Z",
    firstSeenAt: "2026-09-09T17:58:00.000Z",
    // No closure row, and that is the point. `terminallyClosed` is false for
    // this set, so the machinery never wrote one; the hold is zero by the
    // formula and stays open to any further capture the network sends.
    closureRow: null,
    events: edgeEventRows(),
    state: holdState(EDGE_EVENTS, clock),
    memoBalanceCents: 0n,
    evaluatedAt: FIXTURE_NOW,
  };
}

/* -------------------------------------------------------------------------- */
/* empty                                                                      */
/* -------------------------------------------------------------------------- */

const EMPTY_BUSINESS: ConsoleBusiness = {
  businessId: "fixture-business-northgate",
  legalName: "Northgate Fabrication Co.",
  accountName: "Business current account",
  accountId: "fixture-account-northgate",
  currency: "USD",
  cardCount: 0,
};

const EMPTY_SNAPSHOT: ConsoleSnapshot = {
  business: EMPTY_BUSINESS,
  balances: {
    ledgerCents: 0n,
    holdsCents: 0n,
    unclearedCents: 0n,
    availableCents: 0n,
  },
  cards: [],
  holds: [],
  asOf: FIXTURE_NOW,
  bookingWatermark: 148_290n,
  foldedCardHoldsCents: 0n,
};

/* -------------------------------------------------------------------------- */
/* error                                                                      */
/* -------------------------------------------------------------------------- */

const QUERY_FAILURE: ErrorShape = {
  code: "LEDGER_READ_FAILED",
  message:
    "console could not be read: connection terminated unexpectedly while folding the deposit account's journal lines",
  details: { retryable: true, source: "accounts.console.console" },
};

/* -------------------------------------------------------------------------- */
/* The swap point                                                             */
/* -------------------------------------------------------------------------- */

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The `loading` state is not a mock of a slow read — it IS a slow read. The
 * page's Suspense boundary shows the real skeleton for as long as this takes.
 */
export function holdOpenForLoadingState(state: ConsoleState): Promise<void> {
  return state === "loading" ? delay(CONSOLE_LOADING_MS) : Promise.resolve();
}

/** The fixture answer for a non-live state. `default`/`loading` never reach here. */
export function fixtureConsole(state: ConsoleState): Result<ConsoleData, ErrorShape> {
  if (state === "error") return fail(QUERY_FAILURE.code, QUERY_FAILURE.message, QUERY_FAILURE.details);
  if (state === "empty") {
    return ok({ businesses: [EMPTY_BUSINESS], snapshot: EMPTY_SNAPSHOT });
  }
  return ok({ businesses: [EDGE_BUSINESS], snapshot: EDGE_SNAPSHOT });
}

/**
 * The drill-down for a fixture hold.
 *
 * `null` for anything else, so the route falls through to the live query and a
 * real hold id is never intercepted by a fixture.
 */
export function fixtureHoldDetail(holdId: string): HoldDetail | null {
  return holdId === EDGE_HOLD_ID ? edgeHoldDetail() : null;
}
