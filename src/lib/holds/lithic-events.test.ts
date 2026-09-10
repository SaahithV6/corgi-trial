/**
 * Lithic's vocabulary → ours.
 *
 * The fixture below is not invented. It is the shape of a real
 * `card_transaction.updated` body that Lithic POSTed to the deployed endpoint
 * on 2026-09-10 and that is still sitting in `webhook_inbox` — merchant
 * descriptor "FUEL PUMP 42", $50.00, MCC 5542 — with the tokens changed only
 * where a test needs to vary them. Every trap asserted here was measured
 * (DECISIONS 006), not read out of a doc.
 */
import { describe, expect, it } from "vitest";

import type {
  Transaction,
  TransactionEvent,
  TransactionEventType,
} from "@/lib/rails/lithic/types";

import { deriveCardEvents } from "./lithic-events";
import { holdState } from "./model";

const CARD = "56db7b80-a103-4adf-acdd-4cab460c2963";
const TXN = "69d2f4f3-8101-4a08-9524-98ae5edd96c8";

function lithicEvent(
  type: TransactionEventType,
  amount: number,
  opts: { token?: string; created?: string; polarity?: "CREDIT" | "DEBIT"; settlement?: number } = {},
): TransactionEvent {
  const event: TransactionEvent = {
    token: opts.token ?? `${type}-${amount}`,
    type,
    created: opts.created ?? "2026-09-10T16:23:11Z",
    amount,
    amounts: {
      cardholder: { amount, conversion_rate: "1.000000", currency: "USD" },
      merchant: { amount, currency: "USD" },
      settlement:
        opts.settlement === undefined ? null : { amount: opts.settlement, currency: "USD" },
    },
    ...(opts.polarity !== undefined ? { effective_polarity: opts.polarity } : {}),
  };
  return event;
}

/**
 * A transaction whose TRAP FIELDS are deliberately set to lie, exactly as the
 * live sandbox sets them: `status` SETTLED while a hold is outstanding, and
 * `amounts.hold.amount` signed negative.
 */
function txn(
  events: TransactionEvent[],
  opts: { status?: Transaction["status"]; hold?: number; settled?: number; token?: string } = {},
): Transaction {
  return {
    token: opts.token ?? TXN,
    account_token: "2742964f-478f-47ef-a4e9-852dc50d9c44",
    card_token: CARD,
    created: "2026-09-10T16:23:11Z",
    updated: "2026-09-10T16:23:11Z",
    status: opts.status ?? "PENDING",
    result: "APPROVED",
    amounts: {
      cardholder: { amount: 0, conversion_rate: "1.000000", currency: "USD" },
      // TRAP 2: signed NEGATIVE on the transaction, positive on its events.
      hold: { amount: opts.hold ?? 0, currency: "USD" },
      merchant: { amount: 0, currency: "USD" },
      settlement: { amount: opts.settled ?? 0, currency: "USD" },
    },
    events,
  };
}

const FAR = { expiresAt: new Date("2099-01-01T00:00:00Z"), now: new Date("2026-09-10T18:00:00Z") };

describe("deriveCardEvents — the real fuel-pump authorisation", () => {
  it("maps AUTHORIZATION 5000 to one canonical authorisation and nothing else", () => {
    const derived = deriveCardEvents(
      txn([lithicEvent("AUTHORIZATION", 5000, { token: "auth-1" })], { hold: -5000 }),
    );
    expect(derived.providerAuthId).toBe(TXN);
    expect(derived.providerCardToken).toBe(CARD);
    expect(derived.origin).toBe("authorization");
    expect(derived.valueDate).toBe("2026-09-10"); // 16:23Z is 12:23 in book time
    expect(derived.events).toEqual([
      {
        kind: "authorization",
        amountCents: 5000n,
        isFinal: false,
        valueDate: "2026-09-10",
        providerEventId: "auth-1",
      },
    ]);
    expect(holdState(derived.events, FAR).holdCents).toBe(5000n);
  });

  it("keeps the negative sign off our side of the boundary", () => {
    const derived = deriveCardEvents(
      txn([lithicEvent("AUTHORIZATION", 5000)], { hold: -5000 }),
    );
    // The provider's figure is carried verbatim for reconciliation, as a
    // MAGNITUDE via normalizeTransaction, and our own events are magnitudes.
    expect(derived.providerView.holdCents).toBe(5000n);
    for (const e of derived.events) expect(e.amountCents >= 0n).toBe(true);
  });
});

describe("deriveCardEvents — the status field lies and we never read it", () => {
  it("auth 1000 + clearing 600: hold is 400 while Lithic says SETTLED", () => {
    const derived = deriveCardEvents(
      txn(
        [
          lithicEvent("AUTHORIZATION", 1000, { token: "a" }),
          lithicEvent("CLEARING", 600, { token: "c1", settlement: 600 }),
        ],
        // [MEASURED] this is exactly what the sandbox returns here.
        { status: "SETTLED", hold: -400, settled: -600 },
      ),
    );
    expect(derived.providerView.providerSaysSettled).toBe(true);
    // ...and the hold is still 400. A release keyed off `status` would have
    // freed money that is still authorised.
    expect(holdState(derived.events, FAR).holdCents).toBe(400n);
  });

  it("a second clearing takes it to 100, still SETTLED, still held", () => {
    const derived = deriveCardEvents(
      txn(
        [
          lithicEvent("AUTHORIZATION", 1000, { token: "a" }),
          lithicEvent("CLEARING", 600, { token: "c1", settlement: 600 }),
          lithicEvent("CLEARING", 300, { token: "c2", settlement: 300 }),
        ],
        { status: "SETTLED", hold: -100, settled: -900 },
      ),
    );
    expect(holdState(derived.events, FAR).holdCents).toBe(100n);
  });

  it("over-capture 5000/7340 releases to zero", () => {
    const derived = deriveCardEvents(
      txn(
        [
          lithicEvent("AUTHORIZATION", 5000, { token: "a" }),
          lithicEvent("CLEARING", 7340, { token: "c", settlement: 7340 }),
        ],
        { status: "SETTLED", hold: 0, settled: -7340 },
      ),
    );
    const state = holdState(derived.events, FAR);
    expect(state.capturedCents).toBe(7340n);
    expect(state.holdCents).toBe(0n);
  });
});

describe("deriveCardEvents — the single-message path", () => {
  it("FINANCIAL_AUTHORIZATION becomes a final force post that never held", () => {
    const derived = deriveCardEvents(
      txn([lithicEvent("FINANCIAL_AUTHORIZATION", 2500, { token: "f" })], {
        status: "SETTLED",
        hold: 0,
        settled: -2500,
      }),
    );
    expect(derived.origin).toBe("force_post");
    expect(derived.events[0]?.kind).toBe("force_post");
    expect(derived.events[0]?.isFinal).toBe(true);
    expect(holdState(derived.events, FAR).holdCents).toBe(0n);
  });

  it("a clearing with CREDIT polarity is a refund, not a capture", () => {
    // Booking this as a capture would debit a customer who is owed money.
    const derived = deriveCardEvents(
      txn([lithicEvent("CLEARING", 1200, { token: "r", polarity: "CREDIT", settlement: 1200 })]),
    );
    expect(derived.events[0]?.kind).toBe("refund");
    expect(holdState(derived.events, FAR).capturedCents).toBe(0n);
  });

  it("RETURN is a refund and RETURN_REVERSAL takes it back", () => {
    expect(deriveCardEvents(txn([lithicEvent("RETURN", 900)])).events[0]?.kind).toBe("refund");
    expect(deriveCardEvents(txn([lithicEvent("RETURN_REVERSAL", 900)])).events[0]?.kind).toBe(
      "force_post",
    );
  });
});

describe("deriveCardEvents — events that are recognised and skipped", () => {
  it("a balance inquiry adds no member to E", () => {
    const derived = deriveCardEvents(txn([lithicEvent("BALANCE_INQUIRY", 0)]));
    expect(derived.events).toHaveLength(0);
  });

  it("a pending CREDIT_AUTHORIZATION does not open a hold against the customer", () => {
    // Lithic calls this hold-opening. A hold on an INCOMING credit would reduce
    // the customer's available balance for money arriving, which is backwards.
    const derived = deriveCardEvents(txn([lithicEvent("CREDIT_AUTHORIZATION", 4000)]));
    expect(derived.events).toHaveLength(0);
  });
});

describe("deriveCardEvents — advice is absolute, and becomes a delta", () => {
  it("1000 then an advice of 1500 is an increment of 500, not of 1500", () => {
    const derived = deriveCardEvents(
      txn([
        lithicEvent("AUTHORIZATION", 1000, { token: "a", created: "2026-09-10T16:00:00Z" }),
        lithicEvent("AUTHORIZATION_ADVICE", 1500, { token: "adv", created: "2026-09-10T16:05:00Z" }),
      ]),
    );
    expect(derived.events[1]).toMatchObject({
      kind: "incremental_authorization",
      amountCents: 500n,
      providerEventId: "adv",
    });
    // The absolute figure the advice asserted, reconstructed by summing.
    expect(holdState(derived.events, FAR).authorisedCents).toBe(1500n);
  });

  it("an advice DOWN becomes a reversal", () => {
    const derived = deriveCardEvents(
      txn([
        lithicEvent("AUTHORIZATION", 1000, { token: "a", created: "2026-09-10T16:00:00Z" }),
        lithicEvent("AUTHORIZATION_ADVICE", 400, { token: "adv", created: "2026-09-10T16:05:00Z" }),
      ]),
    );
    expect(derived.events[1]).toMatchObject({
      kind: "authorization_reversal",
      amountCents: 600n,
    });
    expect(holdState(derived.events, FAR).authorisedCents).toBe(400n);
  });

  it("an advice that changes nothing produces no event at all", () => {
    const derived = deriveCardEvents(
      txn([
        lithicEvent("AUTHORIZATION", 1000, { token: "a", created: "2026-09-10T16:00:00Z" }),
        lithicEvent("AUTHORIZATION_ADVICE", 1000, { token: "adv", created: "2026-09-10T16:05:00Z" }),
      ]),
    );
    expect(derived.events).toHaveLength(1);
  });

  it("the conversion does not depend on the array's delivered order", () => {
    // `events[]` is append-only, so an event before the advice can never arrive
    // in a later payload than the advice; sorting by `created` makes that
    // independent of Lithic's ordering promise rather than dependent on it.
    const auth = lithicEvent("AUTHORIZATION", 1000, {
      token: "a",
      created: "2026-09-10T16:00:00Z",
    });
    const advice = lithicEvent("AUTHORIZATION_ADVICE", 1500, {
      token: "adv",
      created: "2026-09-10T16:05:00Z",
    });
    expect(deriveCardEvents(txn([advice, auth])).events).toEqual(
      deriveCardEvents(txn([auth, advice])).events,
    );
  });
});

describe("deriveCardEvents — origin, which nothing branches on", () => {
  it("a clearing with no authorisation in the payload is clearing_first", () => {
    const derived = deriveCardEvents(
      txn([lithicEvent("CLEARING", 7340, { token: "c", settlement: 7340 })]),
    );
    expect(derived.origin).toBe("clearing_first");
    // And the maths is the same as the in-order case: A = 0, C = 7340, H = 0.
    expect(holdState(derived.events, FAR).holdCents).toBe(0n);
  });

  it("a payload with no usable events is still an identity", () => {
    const derived = deriveCardEvents(txn([]));
    expect(derived.events).toHaveLength(0);
    expect(derived.origin).toBe("clearing_first");
  });
});

describe("deriveCardEvents — refusals", () => {
  it("refuses an event with no token, because it could not be deduplicated", () => {
    const bad = { ...lithicEvent("AUTHORIZATION", 5000), token: "" };
    expect(() => deriveCardEvents(txn([bad]))).toThrow(/cannot be deduplicated/);
  });
});
