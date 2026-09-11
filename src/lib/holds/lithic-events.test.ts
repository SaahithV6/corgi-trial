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
  TransactionResult,
} from "@/lib/rails/lithic/types";

import { APPROVED_RESULT, deriveCardEvents, isRefused } from "./lithic-events";
import { holdState, movesFinancialBook } from "./model";

const CARD = "56db7b80-a103-4adf-acdd-4cab460c2963";
const TXN = "69d2f4f3-8101-4a08-9524-98ae5edd96c8";

function lithicEvent(
  type: TransactionEventType,
  amount: number,
  opts: {
    token?: string;
    created?: string;
    polarity?: "CREDIT" | "DEBIT";
    settlement?: number;
    /** The network's verdict. OMITTED means the payload carried none. */
    result?: TransactionResult;
  } = {},
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
    ...(opts.result !== undefined ? { result: opts.result } : {}),
  };
  return event;
}

/** Seven days, matching `CARD_AUTH_EXPIRY_DAYS`, from the fixture's `created`. */
const CLOCK = {
  expiresAt: new Date("2026-09-17T16:23:11Z"),
  now: new Date("2026-09-10T18:00:00Z"),
};

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

describe("deriveCardEvents — transaction 5892c550: the advice converted against a negative base", () => {
  /**
   * The live payload, verbatim, from `webhook_inbox
   * 3520124c-2d1a-4c28-be52-432590c6f519` — Lithic transaction
   * `5892c550-b966-4afb-b681-a6456e1cf3c4`, delivered as ONE body of six
   * events at 2026-09-11T09:02:58Z. Signature verified, `state = 'done'`.
   *
   * The network reversed $123.40 against a $50.00 authorisation, then sent an
   * advice saying THE AUTHORISED AMOUNT IS NOW ZERO. Before migration 0043 the
   * conversion measured that advice against a running total of -7340 and stored
   * `incremental_authorization 7340` — an increment the network never sent, in
   * an append-only table. That row is still on the live book and
   * `v_advice_delta_unsound` reports it; this is the pin that stops the code
   * producing another one.
   *
   * Lithic's own reversal amounts are NEGATIVE in the payload. `eventMagnitude`
   * takes the absolute value, because direction lives in the canonical kind —
   * so the signs below are the ones Lithic actually sent, not tidied.
   */
  const LIVE = [
    lithicEvent("AUTHORIZATION", 5000, {
      token: "2c652ccd-cd4e-4d56-8783-7da7ac378272",
      created: "2026-09-10T22:35:26Z",
      result: "APPROVED",
    }),
    lithicEvent("CLEARING", 7340, {
      token: "45701807-d8c8-44d5-a1a7-b2e1171a10f1",
      created: "2026-09-10T22:35:27Z",
      settlement: 7340,
      result: "APPROVED",
    }),
    lithicEvent("AUTHORIZATION_REVERSAL", -7340, {
      token: "0503a161-bc33-4c9c-b4d5-6a1215447eb4",
      created: "2026-09-10T22:35:31Z",
      result: "APPROVED",
    }),
    lithicEvent("AUTHORIZATION_REVERSAL", -5000, {
      token: "ee76e133-5528-41ab-b9fd-fc8f3afb5d01",
      created: "2026-09-10T22:35:32Z",
      result: "APPROVED",
    }),
    lithicEvent("AUTHORIZATION_ADVICE", 0, {
      token: "535f87ec-7e6a-4599-8b8f-db3c8e0c5957",
      created: "2026-09-10T22:35:35Z",
      result: "APPROVED",
    }),
    lithicEvent("CLEARING", 7340, {
      token: "60e8438f-8ab2-4aa5-bbea-b6c193dfe0ba",
      created: "2026-09-10T22:35:37Z",
      settlement: 7340,
      result: "APPROVED",
    }),
  ];

  it("an advice of NOTHING produces no event, instead of an increment of 7340", () => {
    const derived = deriveCardEvents(txn(LIVE));
    const advice = derived.events.find(
      (e) => e.providerEventId === "535f87ec-7e6a-4599-8b8f-db3c8e0c5957",
    );
    expect(advice).toBeUndefined();
    // Five facts, not six: the advice asserted nothing had changed from an
    // authorised position that was already at or below nothing.
    expect(derived.events).toHaveLength(5);
    expect(derived.events.map((e) => e.kind)).toEqual([
      "authorization",
      "clearing",
      "authorization_reversal",
      "authorization_reversal",
      "clearing",
    ]);
  });

  it("keeps the over-reversal on the books rather than cancelling it out", () => {
    const derived = deriveCardEvents(txn(LIVE));
    const state = holdState(derived.events, FAR);

    // A is the honest sum of what the network said: 5000 authorised, 12340
    // reversed. NOT floored — see model.ts and migration 0043.
    expect(state.authorisedCents).toBe(-7340n);
    expect(state.capturedCents).toBe(14680n);

    // And the over-reversal is reported as a payload-level fact, because a
    // complete snapshot cannot be explained by arrival order.
    expect(derived.overReversedCents).toBe(7340n);
  });

  it("holds nothing, by BOTH defences, and never did", () => {
    const state = holdState(deriveCardEvents(txn(LIVE)).events, FAR);
    // Defence one: `A <= 0` closes the authorisation, so H is 0 before the
    // clamp is consulted.
    expect(state.closed).toBe(true);
    // Defence two: A - C is strictly negative, so `max(A - C, 0)` is 0 even
    // with the closure arm deleted. The incident report said the clamp was the
    // only thing standing between this and a wrong hold. It is not.
    expect(state.authorisedCents - state.capturedCents).toBeLessThan(0n);
    expect(state.holdCents).toBe(0n);
    // Reversible: `A <= 0` is not a terminal condition, so no permanent
    // closure row is licensed here either (migration 0028).
    expect(state.terminallyClosed).toBe(false);
  });

  it("an advice of a REAL figure still lands on that figure when the base is sound", () => {
    // The clamp must not change the ordinary case. Same payload minus the two
    // reversals: the advice of 0 now stands on a base of 5000 and correctly
    // becomes a reversal of 5000.
    const derived = deriveCardEvents(
      txn(LIVE.filter((e) => e.type !== "AUTHORIZATION_REVERSAL")),
    );
    expect(
      derived.events.find((e) => e.providerEventId === "535f87ec-7e6a-4599-8b8f-db3c8e0c5957"),
    ).toMatchObject({ kind: "authorization_reversal", amountCents: 5000n });
    expect(holdState(derived.events, FAR).authorisedCents).toBe(0n);
    expect(derived.overReversedCents).toBe(0n);
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

/* ==========================================================================
 * THE VERDICT — `event.result`, which this module used to throw away.
 *
 * Until migration 0026 `lithic-events.ts` contained zero occurrences of
 * `result`, `APPROVED` or `DECLINED`, and `card_auth_event` had no column to
 * put the answer in, so an authorisation the network REFUSED entered `E` as an
 * ordinary `authorization` and withheld the customer's money until the
 * seven-day expiry sweeper reached it. Measured in the live book: 60
 * authorisations, $1,151.00 still withheld across three businesses.
 *
 * The fixtures below are the shapes that were actually sitting in
 * `webhook_inbox` when that was found — including Lithic transaction
 * 041d610c-a71a-432e-ad62-ca16b6d882b0, which is live-fire attack 2's own
 * authorisation and reads `AUTHORIZATION 5000 result DECLINED
 * detailed_results ["ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED"]`.
 * ========================================================================== */

describe("isRefused — silence is not a refusal", () => {
  it("APPROVED is not a refusal", () => {
    expect(isRefused(APPROVED_RESULT)).toBe(false);
  });

  it("every non-APPROVED result Lithic has actually sent us is a refusal", () => {
    // All four are present in this database's retained payloads.
    for (const result of [
      "DECLINED",
      "UNAUTHORIZED_MERCHANT",
      "UNKNOWN_HOST_TIMEOUT",
      "USER_TRANSACTION_LIMIT",
    ]) {
      expect(isRefused(result)).toBe(true);
    }
  });

  it("an ABSENT verdict is not a refusal — being untold is not being told no", () => {
    // `result` is optional on Lithic's `TransactionEvent`. If a payload shape
    // ever stops carrying it, the system must keep placing holds rather than
    // silently stop, so the default has to be "we were not told".
    expect(isRefused(undefined)).toBe(false);
    expect(isRefused(null)).toBe(false);
    expect(isRefused("")).toBe(false);
  });
});

describe("deriveCardEvents — a refused authorisation feeds no term of the model", () => {
  it("AUTHORIZATION 5000 result DECLINED is recorded, and raises A by nothing", () => {
    const derived = deriveCardEvents(
      txn([lithicEvent("AUTHORIZATION", 5000, { result: "DECLINED" })], { hold: 0 }),
    );

    // THE FACT SURVIVES. Real amount, real value date, real provider token, so
    // a redelivery still deduplicates and a customer looking at a declined
    // transaction still sees that it happened.
    expect(derived.events).toHaveLength(1);
    const event = derived.events[0];
    if (event === undefined) throw new Error("unreachable");
    expect(event.kind).toBe("declined");
    expect(event.amountCents).toBe(5000n);
    expect(event.valueDate).toBe("2026-09-10");
    expect(event.providerEventId).toBe("AUTHORIZATION-5000");

    // A refusal is NOT the network saying "no further capture is coming". If
    // it were flagged final it would close the hold, and transaction
    // 041d610c shows a declined authorisation can still take a clearing.
    expect(event.isFinal).toBe(false);

    // THE MONEY DOES NOT.
    const state = holdState(derived.events, CLOCK);
    expect(state.authorisedCents).toBe(0n);
    expect(state.capturedCents).toBe(0n);
    expect(state.holdCents).toBe(0n);
    // It is a member of E, so `count > 0`, so the `A <= 0` arm makes it
    // `closed` — matching `v_card_auth_state`, whose `count(ev.id)` counts it
    // too. But `sawAuthorisation` stays false, so nothing terminal is claimed
    // and no `hold_closure` row will be written on it.
    expect(state.eventCount).toBe(1);
    expect(state.sawAuthorisation).toBe(false);
    expect(state.closed).toBe(true);
    expect(state.terminallyClosed).toBe(false);

    // And it moves no financial book either. This is the same membership test
    // the two folds use, so the kind is neutral everywhere at once.
    expect(movesFinancialBook(event.kind)).toBe(false);
  });

  it("carries the verdict verbatim, and names what was refused", () => {
    const derived = deriveCardEvents(
      txn([lithicEvent("AUTHORIZATION", 5000, { result: "UNAUTHORIZED_MERCHANT" })]),
    );
    // Verbatim: Lithic's vocabulary is Lithic's, and translating it into a
    // boolean would lose the only field that says WHY.
    expect(derived.results.get("AUTHORIZATION-5000")).toBe("UNAUTHORIZED_MERCHANT");
    expect(derived.refused).toEqual(["AUTHORIZATION-5000"]);
    expect(derived.stepTypes.get("AUTHORIZATION-5000")).toBe("AUTHORIZATION");
  });

  it("a payload that carries no verdict at all is stored with none, not with APPROVED", () => {
    const derived = deriveCardEvents(txn([lithicEvent("AUTHORIZATION", 5000)]));
    expect(derived.events[0]?.kind).toBe("authorization");
    expect(derived.results.has("AUTHORIZATION-5000")).toBe(false);
    expect(derived.refused).toEqual([]);
  });

  it("result APPROVED behaves exactly as an absent result did", () => {
    const withVerdict = deriveCardEvents(
      txn([lithicEvent("AUTHORIZATION", 5000, { result: "APPROVED" })]),
    );
    const without = deriveCardEvents(txn([lithicEvent("AUTHORIZATION", 5000)]));
    expect(withVerdict.events).toEqual(without.events);
    expect(holdState(withVerdict.events, CLOCK).holdCents).toBe(5000n);
  });

  it("origin is still `authorization` — the transaction opened with one, refused or not", () => {
    const derived = deriveCardEvents(
      txn([lithicEvent("AUTHORIZATION", 5000, { result: "DECLINED" })]),
    );
    // `card_authorization.origin` is CHECK-constrained to three values and
    // answers "how did we first hear of this", which is a question about the
    // message. Calling it `clearing_first` would be a different lie from the
    // one just fixed.
    expect(derived.origin).toBe("authorization");
  });
});

describe("deriveCardEvents — transaction 041d610c: declined, then cleared anyway", () => {
  /**
   * The real sequence out of `webhook_inbox`, and the reason a refusal must
   * not be flagged final: Lithic's sandbox accepted a CLEARING against an
   * authorisation it had itself DECLINED, and drove the transaction to
   * SETTLED. A system that closed the hold on the decline would then have no
   * hold to reconcile the capture against.
   */
  const SEQUENCE = [
    lithicEvent("AUTHORIZATION", 5000, { result: "DECLINED", token: "auth-declined" }),
    lithicEvent("CLEARING", 7340, {
      result: "APPROVED",
      token: "clearing-approved",
      settlement: 7340,
    }),
  ];

  it("the capture posts in full and the hold never opens", () => {
    const derived = deriveCardEvents(txn(SEQUENCE, { status: "SETTLED", settled: -7340 }));

    expect(derived.events.map((e) => e.kind)).toEqual(["declined", "clearing"]);

    const state = holdState(derived.events, CLOCK);
    expect(state.authorisedCents).toBe(0n); // the refusal raised nothing
    expect(state.capturedCents).toBe(7340n); // the approved capture is real
    expect(state.holdCents).toBe(0n);
    expect(state.terminallyClosed).toBe(false);

    // The money that really moved still moves: `clearing` is untouched by any
    // of this, so the financial posting happens exactly as before.
    expect(movesFinancialBook("clearing")).toBe(true);
  });

  it("is order-free, like everything else in the model", () => {
    const inOrder = holdState(deriveCardEvents(txn(SEQUENCE)).events, CLOCK);
    const reversed = holdState(deriveCardEvents(txn([...SEQUENCE].reverse())).events, CLOCK);
    expect(reversed.authorisedCents).toBe(inOrder.authorisedCents);
    expect(reversed.capturedCents).toBe(inOrder.capturedCents);
    expect(reversed.holdCents).toBe(inOrder.holdCents);
  });
});

describe("deriveCardEvents — a refused ADVICE must not sneak in through the delta", () => {
  it("auth 1000 APPROVED, advice 1500 DECLINED: A stays 1000", () => {
    // The refusal branch runs BEFORE the absolute-to-delta conversion. If it
    // did not, the advice would be turned into `incremental_authorization 500`
    // and the refused amount would re-enter A(E) through the side door.
    const derived = deriveCardEvents(
      txn([
        lithicEvent("AUTHORIZATION", 1000, { result: "APPROVED", token: "a" }),
        lithicEvent("AUTHORIZATION_ADVICE", 1500, { result: "DECLINED", token: "b" }),
      ]),
    );

    expect(derived.events.map((e) => e.kind)).toEqual(["authorization", "declined"]);
    // The refused advice keeps its own ABSOLUTE figure, because there is no
    // delta to compute for something that did not happen.
    expect(derived.events[1]?.amountCents).toBe(1500n);

    const state = holdState(derived.events, CLOCK);
    expect(state.authorisedCents).toBe(1000n);
    expect(state.holdCents).toBe(1000n);
  });

  it("an APPROVED advice after a refused one still measures from the approved total", () => {
    const derived = deriveCardEvents(
      txn([
        lithicEvent("AUTHORIZATION", 1000, { result: "APPROVED", token: "a" }),
        lithicEvent("AUTHORIZATION_ADVICE", 9000, { result: "DECLINED", token: "b" }),
        lithicEvent("AUTHORIZATION_ADVICE", 1500, { result: "APPROVED", token: "c" }),
      ]),
    );
    // 1500 absolute against a running total of 1000 — the refused 9000 never
    // entered it — so the delta is 500.
    expect(derived.events.map((e) => e.kind)).toEqual([
      "authorization",
      "declined",
      "incremental_authorization",
    ]);
    expect(derived.events[2]?.amountCents).toBe(500n);
    expect(holdState(derived.events, CLOCK).authorisedCents).toBe(1500n);
  });
});

describe("deriveCardEvents — the rule is uniform, not authorisation-only", () => {
  it("a refused CLEARING captures nothing and posts nothing", () => {
    // No non-APPROVED capture has been observed in this sandbox, so this arm
    // is asserted against a synthetic payload rather than a measured one — and
    // it is asserted, rather than left to chance, because the alternative
    // failure is posting money for a capture the network refused.
    const derived = deriveCardEvents(
      txn([
        lithicEvent("AUTHORIZATION", 5000, { result: "APPROVED", token: "a" }),
        lithicEvent("CLEARING", 5000, { result: "DECLINED", token: "b", settlement: 5000 }),
      ]),
    );

    expect(derived.events.map((e) => e.kind)).toEqual(["authorization", "declined"]);
    const state = holdState(derived.events, CLOCK);
    expect(state.capturedCents).toBe(0n);
    // The hold stays exactly where it was: nothing was captured, so nothing
    // is released.
    expect(state.holdCents).toBe(5000n);
  });

  it("a refused RETURN pays the customer nothing", () => {
    const derived = deriveCardEvents(
      txn([lithicEvent("RETURN", 2500, { result: "DECLINED", token: "r" })]),
    );
    expect(derived.events[0]?.kind).toBe("declined");
    expect(movesFinancialBook(derived.events[0]?.kind ?? "refund")).toBe(false);
  });

  it("a refused step still deduplicates on its own provider token", () => {
    const one = lithicEvent("AUTHORIZATION", 5000, { result: "DECLINED", token: "same" });
    const derived = deriveCardEvents(txn([one, { ...one }]));
    expect(derived.events).toHaveLength(1);
    expect(derived.refused).toEqual(["same"]);
  });
});
