/**
 * `H(E)` on its own, with no database and no clock but the one injected.
 *
 * The interesting claims about this model are all provable here, because the
 * model is a pure function of a set: every pathological arrival order in
 * DESIGN.md §8.3 is the same set in a different order, and a function of a set
 * cannot tell them apart. The integration tests then prove the same numbers
 * survive contact with Postgres; these prove the arithmetic itself.
 */
import { describe, expect, it } from "vitest";

import {
  financialPostingKey,
  holdCents,
  holdPostingKey,
  holdState,
  movesFinancialBook,
  type CardEvent,
  type CardEventKind,
} from "./model";

const FAR_FUTURE = new Date("2099-01-01T00:00:00Z");
const NOW = new Date("2026-09-10T12:00:00Z");
const OPEN = { expiresAt: FAR_FUTURE, now: NOW };

let seq = 0;
function ev(
  kind: CardEventKind,
  amountCents: bigint,
  opts: { isFinal?: boolean; id?: string } = {},
): CardEvent {
  seq += 1;
  return {
    kind,
    amountCents,
    isFinal: opts.isFinal ?? false,
    valueDate: "2026-09-10",
    providerEventId: opts.id ?? `e${seq}`,
  };
}

/** Every ordering of a set, so "order-free" is asserted rather than asserted-of. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([items[i] as T, ...tail]);
  }
  return out;
}

describe("H(E) — the measured Lithic arithmetic", () => {
  // DECISIONS 006, measured against the live sandbox. These four rows are the
  // reason there is no status column anywhere in this system.
  it("auth 1000 alone holds 1000 (Lithic: status=PENDING hold=-1000)", () => {
    const state = holdState([ev("authorization", 1000n)], OPEN);
    expect(state.holdCents).toBe(1000n);
    expect(state.closed).toBe(false);
  });

  it("auth 1000 + clearing 600 holds 400 — while Lithic already says SETTLED", () => {
    const state = holdState([ev("authorization", 1000n), ev("clearing", 600n)], OPEN);
    expect(state.authorisedCents).toBe(1000n);
    expect(state.capturedCents).toBe(600n);
    expect(state.holdCents).toBe(400n);
  });

  it("a second clearing of 300 takes it to 100 — multiple captures work", () => {
    const state = holdState(
      [ev("authorization", 1000n), ev("clearing", 600n), ev("clearing", 300n)],
      OPEN,
    );
    expect(state.capturedCents).toBe(900n);
    expect(state.holdCents).toBe(100n);
  });

  it("auth 5000 + clearing 7340 over-captures to zero and is not clamped upward", () => {
    const state = holdState([ev("authorization", 5000n), ev("clearing", 7340n)], OPEN);
    expect(state.authorisedCents).toBe(5000n);
    expect(state.capturedCents).toBe(7340n);
    // max(A − C, 0): the HOLD floors at zero. The customer's AVAILABLE balance
    // does not — the extra 2340 is a real overdraft and lives in the financial
    // book, not here.
    expect(state.holdCents).toBe(0n);
  });

  it("FINANCIAL_AUTHORIZATION-shaped force post never held anything", () => {
    const state = holdState([ev("force_post", 2500n, { isFinal: true })], OPEN);
    expect(state.holdCents).toBe(0n);
    expect(state.closed).toBe(true);
  });
});

describe("H(E) — the transition table, including every pathological ordering", () => {
  const cases: {
    row: number;
    name: string;
    events: readonly CardEvent[];
    hold: bigint;
    closed: boolean;
  }[] = [
    {
      row: 1,
      name: "happy path: auth 5000 then final clearing 5000",
      events: [ev("authorization", 5000n), ev("clearing", 5000n, { isFinal: true })],
      hold: 0n,
      closed: true,
    },
    {
      row: 2,
      name: "fuel pump over-capture: auth 5000, clearing 7340",
      events: [ev("authorization", 5000n), ev("clearing", 7340n, { isFinal: true })],
      hold: 0n,
      closed: true,
    },
    {
      row: 4,
      name: "partial then final: auth 10000, clr 4000, clr 5500 final",
      events: [
        ev("authorization", 10000n),
        ev("clearing", 4000n),
        ev("clearing", 5500n, { isFinal: true }),
      ],
      hold: 0n,
      closed: true,
    },
    {
      row: 5,
      name: "multiple captures, never flagged final: auth 10000, clr 4000, clr 6000",
      events: [ev("authorization", 10000n), ev("clearing", 4000n), ev("clearing", 6000n)],
      hold: 0n,
      // A is still 10000, so the model does NOT call this closed — and it does
      // not need to, because max(A − C, 0) is already zero. `v_card_auth_hold`
      // agrees; the ASCII diagram in DESIGN §8.2 is looser than the SQL, and
      // the SQL is what `v_hold_drift` compares against.
      closed: false,
    },
    {
      row: 6,
      name: "incremental auth: auth 5000, incr 3000, clr 8000 final",
      events: [
        ev("authorization", 5000n),
        ev("incremental_authorization", 3000n),
        ev("clearing", 8000n, { isFinal: true }),
      ],
      hold: 0n,
      closed: true,
    },
    {
      row: 7,
      name: "partial auth reversal: auth 10000, rev 4000, clr 6000 final",
      events: [
        ev("authorization", 10000n),
        ev("authorization_reversal", 4000n),
        ev("clearing", 6000n, { isFinal: true }),
      ],
      hold: 0n,
      closed: true,
    },
    {
      row: 8,
      name: "full auth reversal: auth 10000, rev 10000 — closed by A <= 0",
      events: [ev("authorization", 10000n), ev("authorization_reversal", 10000n)],
      hold: 0n,
      closed: true,
    },
    {
      row: 10,
      name: "force post, no auth ever",
      events: [ev("force_post", 7340n, { isFinal: true })],
      hold: 0n,
      closed: true,
    },
    {
      row: 11,
      name: "settlement before its authorisation: clr 7340 final, then auth 5000",
      events: [ev("clearing", 7340n, { isFinal: true }), ev("authorization", 5000n)],
      hold: 0n,
      closed: true,
    },
    {
      row: 12,
      name: "settlement before auth, clearing not final",
      events: [ev("clearing", 7340n), ev("authorization", 5000n)],
      hold: 0n,
      closed: false,
    },
    {
      row: 13,
      name: "reversal before its authorisation: rev 10000, then auth 10000",
      events: [ev("authorization_reversal", 10000n), ev("authorization", 10000n)],
      hold: 0n,
      // A nets to exactly 0, which is <= 0, which is closed. Both orderings
      // agree because both are the same set.
      closed: true,
    },
    {
      row: 14,
      name: "incremental before original auth: incr 3000, then auth 5000",
      events: [ev("incremental_authorization", 3000n), ev("authorization", 5000n)],
      hold: 8000n,
      closed: false,
    },
    {
      row: 15,
      name: "capture, then merchant reverses the residual: auth 10000, clr 4000, rev 6000",
      events: [
        ev("authorization", 10000n),
        ev("clearing", 4000n),
        ev("authorization_reversal", 6000n),
      ],
      hold: 0n,
      closed: false, // A = 4000 > 0; H = max(4000 − 4000, 0) = 0 anyway.
    },
  ];

  for (const c of cases) {
    it(`row ${c.row}: ${c.name}`, () => {
      const state = holdState(c.events, OPEN);
      expect(state.holdCents).toBe(c.hold);
      expect(state.closed).toBe(c.closed);
    });

    it(`row ${c.row}: same answer under all ${factorial(c.events.length)} arrival orders`, () => {
      const target = holdState(c.events, OPEN);
      for (const order of permutations(c.events)) {
        const state = holdState(order, OPEN);
        expect(state.holdCents).toBe(target.holdCents);
        expect(state.closed).toBe(target.closed);
        expect(state.terminallyClosed).toBe(target.terminallyClosed);
        expect(state.authorisedCents).toBe(target.authorisedCents);
        expect(state.capturedCents).toBe(target.capturedCents);
      }
    });
  }
});

function factorial(n: number): number {
  let out = 1;
  for (let i = 2; i <= n; i++) out *= i;
  return out;
}

describe("H(E) — duplicates and the empty set", () => {
  it("row 17: an exact duplicate delivery changes nothing", () => {
    const auth = ev("authorization", 5000n, { id: "dup" });
    const once = holdState([auth], OPEN);
    const twice = holdState([auth, auth, auth], OPEN);
    expect(twice).toEqual(once);
    expect(twice.eventCount).toBe(1);
  });

  it("a duplicate is decided by the id, not by the contents", () => {
    // Two events that LOOK identical but carry different provider ids are two
    // facts, not one. This is DESIGN §8.3 row 19: the ledger cannot tell a
    // genuine second capture from a network-duplicated one, so it posts both
    // and lets reconciliation surface it. Guessing here would be worse.
    const state = holdState(
      [
        ev("authorization", 5000n, { id: "a" }),
        ev("clearing", 2000n, { id: "x" }),
        ev("clearing", 2000n, { id: "y" }),
      ],
      OPEN,
    );
    expect(state.capturedCents).toBe(4000n);
    expect(state.holdCents).toBe(1000n);
  });

  it("an identity with no events yet is OPEN holding nothing, not CLOSED", () => {
    // A = 0 and A <= 0 is a closure condition, so the empty-set guard matters:
    // an authorisation we created from a clearing that arrived first must not
    // be born closed, or the late authorisation could never open its hold.
    const state = holdState([], OPEN);
    expect(state.eventCount).toBe(0);
    expect(state.closed).toBe(false);
    expect(state.holdCents).toBe(0n);
  });
});

describe("closed vs terminallyClosed — the bug the live suite found", () => {
  // A settlement that beats its authorisation creates an identity whose event
  // set is {clearing}. A = 0, which satisfies `A <= 0`, which makes `closed`
  // true. H is 0 either way so nothing visible is wrong — until you write the
  // append-only `hold_closure` row on the strength of it, at which point the
  // authorisation that arrives next opens a hold that availability will never
  // count again, and the customer spends money they no longer have.
  //
  // The first version of this code did exactly that. It passed every unit test
  // here and failed scenario 5 against the live database.
  it("a clearing-first identity is closed but NOT terminally closed", () => {
    const state = holdState([ev("clearing", 3000n)], OPEN);
    expect(state.authorisedCents).toBe(0n);
    expect(state.holdCents).toBe(0n);
    expect(state.closed).toBe(true); // matches v_card_auth_hold exactly
    expect(state.sawAuthorisation).toBe(false);
    expect(state.terminallyClosed).toBe(false); // ...and so no closure row
  });

  it("the late authorisation then opens the hold it should", () => {
    const state = holdState([ev("clearing", 3000n), ev("authorization", 5000n)], OPEN);
    expect(state.holdCents).toBe(2000n);
    expect(state.closed).toBe(false);
    expect(state.terminallyClosed).toBe(false);
  });

  it("a genuine full reversal is CLOSED, but not terminal — an incremental can still land", () => {
    // This used to assert `terminallyClosed`, and that was the bug. The fuzzer
    // shrank a counterexample to exactly this event set plus one more event:
    // a later incremental authorisation reopens the hold, and a `hold_closure`
    // written here is PERMANENT and now contradicted. Migration 0028 moved the
    // `A <= 0` arm out of `terminallyClosed` and into `closed`.
    //
    // The two assertions below `closed` are the whole point of the change: the
    // money does not move. H is already 0 either way. All that changed is
    // whether we write an irreversible row saying it can never be anything else.
    const state = holdState(
      [ev("authorization", 10000n), ev("authorization_reversal", 10000n)],
      OPEN,
    );
    expect(state.sawAuthorisation).toBe(true);
    expect(state.closed).toBe(true);
    expect(state.holdCents).toBe(0n);
    expect(state.terminallyClosed).toBe(false);
  });

  it("a reversal that beats its authorisation is not terminal either", () => {
    const early = holdState([ev("authorization_reversal", 10000n)], OPEN);
    expect(early.authorisedCents).toBe(-10000n);
    expect(early.closed).toBe(true);
    expect(early.terminallyClosed).toBe(false);
    // ...and once the authorisation lands, A nets to zero, so it is CLOSED and
    // withholds nothing — but still not terminal. Order does not rescue it:
    // `holdState` is a function of the event SET, so this is the same set as
    // the case above and must give the same answer. That equality is asserted
    // across 5.1M orderings in fuzz.test.ts.
    const settled = holdState(
      [ev("authorization_reversal", 10000n, { id: "r" }), ev("authorization", 10000n, { id: "a" })],
      OPEN,
    );
    expect(settled.closed).toBe(true);
    expect(settled.terminallyClosed).toBe(false);
    expect(settled.holdCents).toBe(0n);
  });

  it("final, close and the clock are terminal on their own", () => {
    expect(holdState([ev("force_post", 2500n, { isFinal: true })], OPEN).terminallyClosed).toBe(
      true,
    );
    expect(holdState([ev("close", 0n)], OPEN).terminallyClosed).toBe(true);
    expect(
      holdState([ev("authorization", 5000n)], {
        expiresAt: new Date("2026-09-01T00:00:00Z"),
        now: NOW,
      }).terminallyClosed,
    ).toBe(true);
  });
});

describe("H(E) — the clock", () => {
  it("row 9: an authorisation past its expiry holds nothing, with no cron", () => {
    const events = [ev("authorization", 5000n)];
    const before = holdState(events, {
      expiresAt: new Date("2026-09-17T00:00:00Z"),
      now: new Date("2026-09-16T23:59:59Z"),
    });
    const after = holdState(events, {
      expiresAt: new Date("2026-09-17T00:00:00Z"),
      now: new Date("2026-09-17T00:00:00Z"),
    });
    expect(before.holdCents).toBe(5000n);
    expect(before.closed).toBe(false);
    expect(after.holdCents).toBe(0n);
    expect(after.closed).toBe(true);
    expect(after.expired).toBe(true);
  });

  it("row 16: a clearing after expiry still captures, and H stays 0", () => {
    const state = holdState([ev("authorization", 5000n), ev("clearing", 5000n)], {
      expiresAt: new Date("2026-09-01T00:00:00Z"),
      now: NOW,
    });
    expect(state.capturedCents).toBe(5000n);
    expect(state.holdCents).toBe(0n);
  });

  it("an explicit close event closes it whatever the arithmetic says", () => {
    const state = holdState([ev("authorization", 5000n), ev("close", 0n)], OPEN);
    expect(state.authorisedCents).toBe(5000n);
    expect(state.sawClose).toBe(true);
    expect(state.holdCents).toBe(0n);
  });
});

describe("H(E) — refunds and the financial book", () => {
  it("a refund touches neither A nor C", () => {
    const state = holdState([ev("authorization", 5000n), ev("refund", 1200n)], OPEN);
    expect(state.authorisedCents).toBe(5000n);
    expect(state.capturedCents).toBe(0n);
    expect(state.holdCents).toBe(5000n);
  });

  it("only captures and refunds move real money", () => {
    expect(movesFinancialBook("clearing")).toBe(true);
    expect(movesFinancialBook("force_post")).toBe(true);
    expect(movesFinancialBook("refund")).toBe(true);
    for (const kind of [
      "authorization",
      "incremental_authorization",
      "authorization_reversal",
      "expiry",
      "close",
    ] as const) {
      expect(movesFinancialBook(kind)).toBe(false);
    }
  });
});

describe("H(E) — refusals", () => {
  it("refuses a negative magnitude rather than taking its absolute value", () => {
    // `kind` carries direction and `amount_cents` is CHECK (>= 0). Silently
    // abs()-ing this would turn a reversal into an authorisation.
    expect(() => holdState([ev("authorization_reversal", -100n)], OPEN)).toThrow(
      /negative magnitude/,
    );
  });
});

describe("idempotency keys", () => {
  it("are derived from the source fact, never generated", () => {
    expect(holdPostingKey("hold-1", "evt-9")).toBe("hold:hold-1:after:evt-9");
    expect(financialPostingKey("clearing", "evt-9")).toBe("card:clearing:evt-9");
    // Same inputs, same key, for ever — which is what makes the UNIQUE index a
    // decision rather than a coincidence.
    expect(holdPostingKey("hold-1", "evt-9")).toBe(holdPostingKey("hold-1", "evt-9"));
  });
});

describe("holdCents convenience", () => {
  it("is holdState().holdCents", () => {
    const events = [ev("authorization", 1000n), ev("clearing", 600n)];
    expect(holdCents(events, OPEN)).toBe(holdState(events, OPEN).holdCents);
  });
});
