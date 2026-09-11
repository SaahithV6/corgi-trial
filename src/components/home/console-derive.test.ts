/**
 * The console's arithmetic, pinned.
 *
 * The front door sums customer money across the whole book. If `foldTotals` is
 * ever wrong, every figure in the first screenful is wrong, and it is wrong
 * quietly — a total that is off by a hold looks exactly like a total that is
 * right. So the properties that matter are asserted directly: the sums are
 * exact `bigint` arithmetic, an overdrawn account is counted rather than
 * clamped, and an empty book folds to zero rather than to nothing.
 */
import { describe, expect, it } from "vitest";

import type { AccountPosition, Attention, Movement } from "./console-contract";
import {
  attentionItems,
  directionOf,
  foldTotals,
  lineageNote,
  newestFirst,
  outstanding,
  summariseAttention,
} from "./console-derive";

function position(over: Partial<AccountPosition> = {}): AccountPosition {
  return {
    accountId: "a",
    accountName: "Business current account",
    businessName: "Ridgeline Robotics, Inc.",
    last4: "0001",
    ledgerCents: 100_000n,
    availableCents: 90_000n,
    activeHoldsCents: 10_000n,
    unclearedCreditsCents: 0n,
    fixture: null,
    ...over,
  };
}

/** A position belonging to a test-suite business rather than a customer. */
function fixturePosition(over: Partial<AccountPosition> = {}): AccountPosition {
  return position({
    fixture: {
      source: "src/lib/holds/holds.integration.test.ts",
      reason: "Opened by a test suite, never onboarded.",
    },
    ...over,
  });
}

const ZERO = {
  ledgerCents: 0n,
  availableCents: 0n,
  withheldCents: 0n,
  accounts: 0,
  businesses: 0,
  negativeAvailable: 0,
};

describe("foldTotals", () => {
  it("folds an empty book to zero, not to nothing", () => {
    expect(foldTotals([])).toEqual({
      ...ZERO,
      live: ZERO,
      fixture: ZERO,
    });
  });

  it("sums in bigint cents with no narrowing", () => {
    const totals = foldTotals([
      position({ accountId: "a", ledgerCents: 8_493_918n, availableCents: 8_362_618n }),
      position({
        accountId: "b",
        businessName: "Kettle & Crumb Bakery LLC",
        ledgerCents: 1_935_143n,
        availableCents: 1_904_143n,
      }),
    ]);

    expect(totals.ledgerCents).toBe(10_429_061n);
    expect(totals.availableCents).toBe(10_266_761n);
    expect(totals.withheldCents).toBe(162_300n);
    expect(totals.accounts).toBe(2);
    expect(totals.businesses).toBe(2);
  });

  it("stays exact past the safe-integer range", () => {
    // 2^53 cents is about $90tn. A JS number cannot hold this pair without
    // losing a cent, which is the whole reason the front door carries bigint.
    const huge = 9_007_199_254_740_993n;
    const totals = foldTotals([
      position({ ledgerCents: huge, availableCents: huge }),
      position({ accountId: "b", ledgerCents: 1n, availableCents: 1n }),
    ]);
    expect(totals.ledgerCents).toBe(9_007_199_254_740_994n);
  });

  it("counts a negative available balance rather than clamping it", () => {
    const totals = foldTotals([
      position({ ledgerCents: 41_200n, availableCents: -63_800n }),
    ]);
    expect(totals.availableCents).toBe(-63_800n);
    expect(totals.negativeAvailable).toBe(1);
    expect(totals.withheldCents).toBe(105_000n);
  });

  it("counts distinct businesses, not accounts", () => {
    const totals = foldTotals([
      position({ accountId: "a", businessName: "One" }),
      position({ accountId: "b", businessName: "One" }),
      position({ accountId: "c", businessName: "Two" }),
    ]);
    expect(totals.accounts).toBe(3);
    expect(totals.businesses).toBe(2);
  });

  /* ------------------------------------------------------------------------ */
  /* The fixture split                                                        */
  /* ------------------------------------------------------------------------ */

  /**
   * The measured case this split exists for.
   *
   * `Holds Integration Fixture Co.` really does sit at -$858,941.45, because
   * its integration suite force-posted $500,000.00 twice without reaching the
   * refund. Folded in unlabelled, the front door reported that the bank held
   * NEGATIVE customer money. The rows are legitimate history and stay; the
   * headline stops claiming they are a customer's.
   */
  it("keeps a test fixture's half-million-dollar overdraft out of customer money", () => {
    const totals = foldTotals([
      position({ accountId: "a", ledgerCents: 6_069_951n, availableCents: 3_558_833n }),
      position({
        accountId: "b",
        businessName: "Kettle & Crumb Bakery LLC",
        ledgerCents: 4_490_116n,
        availableCents: -1_116_884n,
      }),
      fixturePosition({
        accountId: "c",
        businessName: "Holds Integration Fixture Co.",
        ledgerCents: -85_894_145n,
        availableCents: -86_322_445n,
      }),
    ]);

    // The headline: customers, and only customers.
    expect(totals.live.ledgerCents).toBe(10_560_067n);
    expect(totals.live.availableCents).toBe(2_441_949n);
    expect(totals.live.accounts).toBe(2);
    expect(totals.live.businesses).toBe(2);
    expect(totals.live.negativeAvailable).toBe(1);

    // Printed beside it, not dropped.
    expect(totals.fixture.ledgerCents).toBe(-85_894_145n);
    expect(totals.fixture.availableCents).toBe(-86_322_445n);
    expect(totals.fixture.accounts).toBe(1);

    // And the whole book is still published, and still reconciles. A split
    // that did not add back up would be a second, quieter lie.
    expect(totals.ledgerCents).toBe(-75_334_078n);
    expect(totals.accounts).toBe(3);
  });

  it("reconciles the two halves to the whole book, always", () => {
    const positions = [
      position({ accountId: "a", ledgerCents: 41_200n, availableCents: -63_800n }),
      fixturePosition({ accountId: "b", businessName: "Fixture Co.", ledgerCents: -7n }),
      position({ accountId: "c", businessName: "Two", ledgerCents: 900n }),
      fixturePosition({ accountId: "d", businessName: "Other Fixture Co." }),
    ];
    const t = foldTotals(positions);

    expect(t.live.ledgerCents + t.fixture.ledgerCents).toBe(t.ledgerCents);
    expect(t.live.availableCents + t.fixture.availableCents).toBe(t.availableCents);
    expect(t.live.withheldCents + t.fixture.withheldCents).toBe(t.withheldCents);
    expect(t.live.accounts + t.fixture.accounts).toBe(t.accounts);
    expect(t.live.negativeAvailable + t.fixture.negativeAvailable).toBe(
      t.negativeAvailable,
    );
  });

  it("treats a book with no fixtures as entirely customer money", () => {
    const totals = foldTotals([position({ ledgerCents: 100n, availableCents: 100n })]);
    expect(totals.fixture).toEqual(ZERO);
    expect(totals.live.ledgerCents).toBe(totals.ledgerCents);
  });
});

/* -------------------------------------------------------------------------- */

function attention(over: Partial<Attention> = {}): Attention {
  return {
    pendingPayments: 0,
    pendingCapped: false,
    oldestPendingAt: null,
    overdrawnAccounts: 0,
    parkedWebhooks: 0,
    deadLetteredWebhooks: 0,
    businessesNotApproved: 0,
    ...over,
  };
}

describe("attentionItems", () => {
  it("gives every row a count, a destination and a reason", () => {
    for (const item of attentionItems(attention())) {
      expect(item.key.length).toBeGreaterThan(0);
      expect(item.href.startsWith("/")).toBe(true);
      expect(item.detail.length).toBeGreaterThan(20);
    }
  });

  it("hides nothing but zeroes", () => {
    const items = attentionItems(attention({ pendingPayments: 3, parkedWebhooks: 2 }));
    expect(outstanding(items).map((item) => item.key)).toEqual([
      "approvals",
      "parked",
    ]);
  });

  it("agrees in number with its own count", () => {
    const one = attentionItems(
      attention({ businessesNotApproved: 1, parkedWebhooks: 1, overdrawnAccounts: 1 }),
    );
    expect(outstanding(one).map((item) => item.label)).toEqual([
      "account overdrawn",
      "business not cleared to transact",
      "webhook delivery parked",
    ]);

    const many = attentionItems(attention({ parkedWebhooks: 16 }));
    expect(outstanding(many)[0]?.label).toBe("webhook deliveries parked");
  });

  it("says 'at least' when the queue read hit its page limit", () => {
    const capped = attentionItems(
      attention({ pendingPayments: 200, pendingCapped: true }),
    );
    expect(capped[0]?.label).toContain("at least");

    const exact = attentionItems(attention({ pendingPayments: 91 }));
    expect(exact[0]?.label).not.toContain("at least");
  });
});

describe("summariseAttention", () => {
  it("says so plainly when nothing is waiting", () => {
    expect(summariseAttention(attentionItems(attention()))).toBe(
      "Nothing on this book is waiting on a person right now.",
    );
  });

  it("counts things and kinds", () => {
    const items = attentionItems(
      attention({ pendingPayments: 91, parkedWebhooks: 16, deadLetteredWebhooks: 4 }),
    );
    expect(summariseAttention(items)).toBe(
      "111 things are waiting on a person, across 3 kinds.",
    );
  });

  it("uses the singular for one kind", () => {
    const items = attentionItems(attention({ overdrawnAccounts: 1 }));
    expect(summariseAttention(items)).toBe(
      "1 thing is waiting on a person, across one kind.",
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("directionOf", () => {
  it("reads from the customer's side: positive is money in", () => {
    expect(directionOf(25_428n)).toBe("in");
    expect(directionOf(-105_000n)).toBe("out");
  });

  it("treats zero as neither an outflow nor a mistake", () => {
    // A zero line is forbidden by the schema, so this only ever comes from a
    // caller that folded something. It must not be reported as money out.
    expect(directionOf(0n)).toBe("in");
  });
});

describe("lineageNote", () => {
  it("names a correction as two more rows, never as an edit", () => {
    expect(lineageNote("reversal")).toContain("Nothing was edited");
    expect(lineageNote("rebook")).toContain("Re-book");
  });

  it("says nothing about a plain entry", () => {
    expect(lineageNote("original")).toBeNull();
  });

  it("does not invent a story for an entry type it has never seen", () => {
    expect(lineageNote("some_future_type")).toBe("Entry type some_future_type.");
  });
});

describe("newestFirst", () => {
  function movement(bookingSeq: string): Movement {
    return {
      entryId: `e-${bookingSeq}`,
      bookingSeq,
      bookingTime: "2026-09-10T17:00:00.000Z",
      valueDate: "2026-09-10",
      entryType: "original",
      description: "x",
      rail: "ach",
      externalRef: null,
      amountCents: 1n,
      accountId: "a",
      businessName: "One",
    };
  }

  it("orders by what we learned, not by string", () => {
    // "9" > "1284" as a string. booking_seq is int8 and must be compared as
    // one, or the front door puts the ninth entry ever booked at the top.
    const sorted = newestFirst([movement("9"), movement("1284"), movement("861")]);
    expect(sorted.map((m) => m.bookingSeq)).toEqual(["1284", "861", "9"]);
  });

  it("does not mutate its input", () => {
    const input = [movement("1"), movement("2")];
    newestFirst(input);
    expect(input.map((m) => m.bookingSeq)).toEqual(["1", "2"]);
  });
});
