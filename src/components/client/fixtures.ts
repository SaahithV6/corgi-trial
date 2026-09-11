/**
 * The three states you cannot arrange on a live ledger while somebody watches.
 *
 * `empty` needs a customer nobody has paid, `error` needs the database to be
 * down, and `loading` needs a slow read. None of those is a thing to arrange
 * mid-demo, so all three are constructed here — and every one of them prints
 * FIXTURE on its own face, because a screen that cannot be told apart from the
 * live one is the fastest way to fail this trial.
 *
 * `default` and `edge` are NOT here. Both read the real database:
 *
 *   default   this customer's real balance, real holds, real transactions.
 *   edge      a REAL business on this book whose available balance is NEGATIVE
 *             while its ledger balance is positive. Kettle & Crumb Bakery LLC,
 *             measured on this database: ledger $45,301.36, card holds $520.00,
 *             uncleared credits $55,500.00, available −$10,718.64. That is not
 *             a bug and it is not clamped — an ACH credit that has landed and
 *             not cleared is withheld, and the customer really is in that
 *             position. A fixture could assert it; only a live read proves it.
 *
 * The fixture business is named so plainly that nobody could mistake it for a
 * customer: there is no "Acme Corp" here, because a plausible fake name on a
 * bank screen is indistinguishable from a real customer at a glance.
 */

import type {
  ActivityScreen,
  ApproveScreen,
  BalanceScreen,
  CardsScreen,
  ClientHeader,
  Loaded,
  PayScreen,
} from "./contract";

/** How long `?state=loading` holds a read open. Long enough to photograph. */
export const CLIENT_LOADING_MS = 6_000;

export const FIXTURE_CODE = "FIXTURE_READ_FAILED";

const FIXTURE_HEADER: ClientHeader = {
  businessId: "00000000-0000-0000-0000-000000000000",
  legalName: "FIXTURE — not a customer on this book",
  accountId: null,
  accountName: "FIXTURE — business current account",
  currency: "USD",
  asOf: "1970-01-01T00:00:00.000Z",
  valueDate: "1970-01-01",
  bookingWatermark: "0",
  live: false,
  businesses: [],
};

/**
 * A header for a fixture state that still has to offer the switcher.
 *
 * The live business list is threaded in where it is available, so switching
 * customer from an `empty` or `error` screen lands somewhere real instead of
 * dead-ending. The FIGURES stay fixture; only the names are live, and the
 * header still reports `live: false`.
 */
export function fixtureHeader(
  businesses: ClientHeader["businesses"] = [],
): ClientHeader {
  return { ...FIXTURE_HEADER, businesses };
}

/* -------------------------------------------------------------------------- */
/* Empty                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A brand-new account: opened, funded by nobody, nothing held.
 *
 * The identity still holds — `0 − 0 − 0 − 0 = 0` — which is the point of
 * showing it. An empty screen that omits the arithmetic teaches a customer that
 * the arithmetic only appears when it is interesting, and then they do not look
 * for it when it matters.
 */
export function emptyBalance(businesses: ClientHeader["businesses"] = []): BalanceScreen {
  return {
    header: fixtureHeader(businesses),
    terms: {
      ledgerCents: 0n,
      holdsCents: 0n,
      unclearedCents: 0n,
      pendingOutboundCents: 0n,
      availableCents: 0n,
    },
    holds: [],
  };
}

export function emptyActivity(businesses: ClientHeader["businesses"] = []): ActivityScreen {
  return { header: fixtureHeader(businesses), rows: [], cardStories: [] };
}

export function emptyCards(businesses: ClientHeader["businesses"] = []): CardsScreen {
  return { header: fixtureHeader(businesses), cards: [], decisions: [] };
}

export function emptyPay(businesses: ClientHeader["businesses"] = []): PayScreen {
  return {
    header: fixtureHeader(businesses),
    gate: {
      allowed: false,
      code: "KYB_NOT_STARTED",
      message:
        "FIXTURE. This business has not passed its checks, so it cannot send money yet. The check runs again inside the payment itself, so this is what you would be told either way.",
    },
    policies: [],
    payees: [],
    today: "1970-01-01",
    availableCents: 0n,
  };
}

export function emptyApprove(businesses: ClientHeader["businesses"] = []): ApproveScreen {
  return {
    header: fixtureHeader(businesses),
    actorName: null,
    actorCanApprove: false,
    policies: [],
    payment: null,
    lookupMessage: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Error                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The read failed.
 *
 * The message is written for the person whose money it is, and the load-bearing
 * half of it is the second sentence: nothing moved. Every read on this surface
 * is a `SELECT`; the application role holds no `UPDATE` or `DELETE` on a money
 * table at all. A customer seeing an error beside their balance needs to be
 * told that before they need to be told anything else.
 */
export function errorState<T>(): Loaded<T> {
  return {
    ok: false,
    code: FIXTURE_CODE,
    message:
      "FIXTURE. We could not read your account just now. Nothing has moved and nothing has changed — this screen only reads, and the balance you saw a moment ago is still the balance. Try again.",
  };
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

/** Hold the read open, so the skeleton is the component's own and not a mock. */
export async function holdOpen<T>(value: T): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, CLIENT_LOADING_MS));
  return value;
}
