/**
 * The interchange arithmetic, proved without a database.
 *
 * Everything here is a pure function of integers, so the properties that matter
 * — the half-even tie, the fixed component not needing a second rounding rule,
 * a fully refunded purchase netting to exactly zero — are provable by
 * enumeration rather than by argument.
 *
 * The database re-derives all of it in `interchange_posting_arithmetic`, so
 * these tests and that CHECK constraint are two implementations of DESIGN
 * §12.2 held equal by the integration suite. This file is the readable one.
 */

import { describe, expect, it } from "vitest";

import {
  BPS_DENOMINATOR,
  interchangeForNet,
  interchangeLines,
  interchangePostingKey,
  interchangeRebookKey,
  priceSettlement,
  roundHalfEven,
  roundingOf,
} from "./rate-card";
import { isPriceable, presentmentOf, readDimensions } from "./dimensions";

// The card this book actually seeds for fuel, before and after the re-rate.
const FUEL_V1 = { rateBps: 130, fixedCents: 5n };
const FUEL_V2 = { rateBps: 145, fixedCents: 5n };
const STANDARD_CNP = { rateBps: 190, fixedCents: 10n };

describe("roundHalfEven — DESIGN §12.2", () => {
  it("rounds down short of the half and up past it", () => {
    // 10/4 = 2.5 exactly -> even -> 2.  9/4 = 2.25 -> 2.  11/4 = 2.75 -> 3.
    expect(roundHalfEven(9n, 4n)).toBe(2n);
    expect(roundHalfEven(11n, 4n)).toBe(3n);
  });

  it("BREAKS THE EXACT HALF TO THE EVEN CENT, IN BOTH DIRECTIONS", () => {
    // This is the whole reason §12.2 is half-even rather than half-up, and the
    // reason it gives is literally about interchange: "half-up biases every tie
    // in one direction, and over a year of interchange that bias is a real
    // number." Half-up would answer 3 and 4 here; half-even answers 2 and 4, so
    // the ties do not all fall the same way.
    expect(roundHalfEven(5n, 2n)).toBe(2n); // 2.5 -> 2 (down, to even)
    expect(roundHalfEven(7n, 2n)).toBe(4n); // 3.5 -> 4 (up, to even)
    expect(roundingOf(5n, 2n)).toBe("tie_to_even");
    expect(roundingOf(7n, 2n)).toBe("tie_to_even");
  });

  it("is unbiased over every tie in a range, which half-up is not", () => {
    // Enumerated rather than argued. Over the odd multiples of D/2, half-even
    // rounds up exactly half the time; half-up rounds up every time.
    let evenUp = 0;
    let halfUpUp = 0;
    const D = 10n;
    for (let k = 1n; k <= 40n; k += 2n) {
      const n = k * (D / 2n); // exactly k/2 of a unit
      const q = n / D;
      if (roundHalfEven(n, D) > q) evenUp += 1;
      halfUpUp += 1; // half-up always rounds a tie up
    }
    expect(evenUp).toBe(10);
    expect(halfUpUp).toBe(20);
  });

  it("refuses a signed numerator, because the direction is not the division's job", () => {
    expect(() => roundHalfEven(-5n, 2n)).toThrow(/MAGNITUDE/);
  });

  it("refuses a non-positive denominator", () => {
    expect(() => roundHalfEven(5n, 0n)).toThrow(/positive/);
  });
});

describe("priceSettlement — percent plus fixed, in integers", () => {
  it("prices the brief's own fuel capture: $73.40 at 1.45% + $0.05", () => {
    const a = priceSettlement(7340n, FUEL_V2);
    // 7340 * 145 = 1,064,300.  1,064,300 / 10,000 = 106 remainder 4,300.
    // 2 * 4300 = 8,600 < 10,000, so short of the half: round DOWN to 106.
    // 106 + 5 = 111 cents.
    expect(a.numerator).toBe(1_064_300n);
    expect(a.denominator).toBe(BPS_DENOMINATOR);
    expect(a.wholeCents).toBe(106n);
    expect(a.remainderUnits).toBe(4_300n);
    expect(a.rounding).toBe("down");
    expect(a.adValoremCents).toBe(106n);
    expect(a.fixedCents).toBe(5n);
    expect(a.interchangeCents).toBe(111n);
  });

  it("prices the same capture on the OLD card differently, which is the point of §5", () => {
    const a = priceSettlement(7340n, FUEL_V1);
    // 7340 * 130 = 954,200 -> 95 remainder 4,200 -> down -> 95 + 5 = 100.
    expect(a.interchangeCents).toBe(100n);
  });

  it("THE FIXED COMPONENT IS ADDED AFTER ROUNDING, so it introduces no fraction", () => {
    // A settlement whose ad-valorem half lands on an exact half cent. At 190
    // bps, 5000 cents gives 950,000 / 10,000 = 95 exactly — so take one that
    // does not divide: 5263 * 190 = 999,970 -> 99 remainder 9,970 -> up -> 100.
    const a = priceSettlement(5263n, STANDARD_CNP);
    expect(a.wholeCents).toBe(99n);
    expect(a.remainderUnits).toBe(9_970n);
    expect(a.rounding).toBe("up");
    expect(a.adValoremCents).toBe(100n);
    // And the total is that integer plus another integer. No second rounding
    // decision exists to be made, which is why this ledger still has exactly
    // two rounding rules.
    expect(a.interchangeCents).toBe(a.adValoremCents + a.fixedCents);
    expect(a.interchangeCents).toBe(110n);
  });

  it("finds a real half-cent tie and breaks it to the even cent", () => {
    // At 125 bps, an amount of 4000 cents gives 500,000 / 10,000 = 50 exactly.
    // A tie needs remainder = 5000: amount * bps ≡ 5000 (mod 10000).
    // 200 * 125 = 25,000 -> 2 remainder 5,000: EXACTLY half a cent, q = 2 is
    // even, so it stays at 2 rather than going to 3.
    const tie = priceSettlement(200n, { rateBps: 125, fixedCents: 0n });
    expect(tie.remainderUnits).toBe(5_000n);
    expect(tie.rounding).toBe("tie_to_even");
    expect(tie.wholeCents).toBe(2n);
    expect(tie.adValoremCents).toBe(2n);

    // 600 * 125 = 75,000 -> 7 remainder 5,000: also exactly half, q = 7 is ODD,
    // so it goes UP to 8. The two ties fall opposite ways, which is the whole
    // property.
    const otherTie = priceSettlement(600n, { rateBps: 125, fixedCents: 0n });
    expect(otherTie.remainderUnits).toBe(5_000n);
    expect(otherTie.rounding).toBe("tie_to_even");
    expect(otherTie.wholeCents).toBe(7n);
    expect(otherTie.adValoremCents).toBe(8n);
  });

  it("never produces a float, at any settled amount", () => {
    for (const cents of [1n, 7n, 99n, 100n, 7340n, 1_234_567n, 9_999_999_999n]) {
      const a = priceSettlement(cents, STANDARD_CNP);
      for (const v of [
        a.numerator,
        a.denominator,
        a.wholeCents,
        a.remainderUnits,
        a.adValoremCents,
        a.fixedCents,
        a.interchangeCents,
      ]) {
        expect(typeof v).toBe("bigint");
      }
    }
  });

  it("refuses a zero or negative settled magnitude", () => {
    expect(() => priceSettlement(0n, FUEL_V1)).toThrow(/greater than zero/);
    expect(() => priceSettlement(-1n, FUEL_V1)).toThrow(/greater than zero/);
  });

  it("refuses a rate that is not an integer in [0, 10000]", () => {
    expect(() => priceSettlement(100n, { rateBps: 1.5, fixedCents: 0n })).toThrow(/bps/);
    expect(() => priceSettlement(100n, { rateBps: 10_001, fixedCents: 0n })).toThrow(/bps/);
  });
});

describe("interchangeForNet — the reversal trap, as arithmetic", () => {
  it("a purchase earns interchange", () => {
    const r = interchangeForNet(7340n, FUEL_V2);
    expect(r.direction).toBe("earned");
    expect(r.naturalCents).toBe(111n);
  });

  it("a refund hands it back, at the same magnitude", () => {
    const r = interchangeForNet(-7340n, FUEL_V2);
    expect(r.direction).toBe("returned");
    expect(r.naturalCents).toBe(-111n);
  });

  it("A SETTLEMENT REVERSED IN FULL IS WORTH ZERO INTERCHANGE", () => {
    // THIS IS THE TRAP. The settlement's correction group nets to zero, so the
    // revenue is zero — not "the original figure, less something", but zero.
    // There is no arm for it: it falls out of the sign test.
    const r = interchangeForNet(0n, FUEL_V2);
    expect(r.direction).toBe(null);
    expect(r.naturalCents).toBe(0n);
  });

  it("a purchase and its full refund net to EXACTLY zero, fixed component included", () => {
    // Both halves cancel: the ad-valorem because it is the same magnitude at
    // the same rate, the fixed because it is the same integer. No special case.
    const purchase = interchangeForNet(7340n, FUEL_V2);
    const refund = interchangeForNet(-7340n, FUEL_V2);
    expect(purchase.naturalCents + refund.naturalCents).toBe(0n);
  });

  it("a partial correction re-prices on the NET, not on the difference", () => {
    // $73.40 corrected to $50.00 is worth what $50.00 is worth, which is not
    // what $73.40 was worth minus what $23.40 would have been worth: the fixed
    // component is charged once per transaction, not once per correction.
    const corrected = interchangeForNet(5000n, FUEL_V2);
    // 5000 * 145 = 725,000 -> 72 remainder 5,000 -> TIE, q = 72 is even -> 72.
    expect(corrected.naturalCents).toBe(72n + 5n);

    const naive =
      interchangeForNet(7340n, FUEL_V2).naturalCents -
      interchangeForNet(2340n, FUEL_V2).naturalCents;
    expect(naive).not.toBe(corrected.naturalCents);
  });
});

describe("interchangeLines", () => {
  const accounts = { networkPayableId: "2200-id", interchangeIncomeId: "4100-id" };

  it("debits 2200 and credits 4100 when we earn it", () => {
    const lines = interchangeLines(accounts, 111n);
    expect(lines.map((l) => [l.accountId, l.amountCents])).toEqual([
      ["2200-id", 111n],
      ["4100-id", -111n],
    ]);
  });

  it("swaps the signs when we hand it back", () => {
    const lines = interchangeLines(accounts, -111n);
    expect(lines.map((l) => [l.accountId, l.amountCents])).toEqual([
      ["2200-id", -111n],
      ["4100-id", 111n],
    ]);
  });

  it("always balances", () => {
    for (const n of [1n, -1n, 111n, -99_999n]) {
      expect(interchangeLines(accounts, n).reduce((s, l) => s + l.amountCents, 0n)).toBe(0n);
    }
  });

  it("refuses to build an entry for zero", () => {
    expect(() => interchangeLines(accounts, 0n)).toThrow(/zero/);
  });
});

describe("idempotency keys", () => {
  it("are derived from the provider's own event token", () => {
    expect(interchangePostingKey("evt-1")).toBe("interchange:evt-1");
    expect(interchangeRebookKey("evt-1")).toBe("interchange:corrected:evt-1");
  });

  it("the re-book key never collides with the original's", () => {
    expect(interchangePostingKey("evt-1")).not.toBe(interchangeRebookKey("evt-1"));
  });
});

describe("dimensions — read off the provider payload and nothing else", () => {
  /** The shape this sandbox actually sends, trimmed. */
  const REAL = {
    token: "da5889ae-7732-4b61-a272-a0e42d439179",
    network: "VISA",
    merchant: { mcc: "5542", descriptor: "CORGI FUEL CL-MTWHH5", country: "USA" },
    pos: {
      entry_mode: { pan: "MANUAL", card: "UNKNOWN", pin_entered: false },
      terminal: { type: "PHONE", attended: false },
    },
  };

  it("reads the measured Lithic shape", () => {
    const d = readDimensions(REAL);
    expect(d.mcc).toBe("5542");
    expect(d.entryMode).toBe("MANUAL");
    expect(d.terminalType).toBe("PHONE");
    expect(d.network).toBe("VISA");
    expect(d.descriptor).toBe("CORGI FUEL CL-MTWHH5");
    // MANUAL is a hand-keyed PAN, which is card-NOT-present for interchange
    // even at a physical terminal: the card was never read.
    expect(d.presentment).toBe("card_not_present");
  });

  it("maps the card-present entry modes", () => {
    for (const mode of ["CONTACTLESS", "ICC", "MAGNETIC_STRIPE", "BAR_CODE"]) {
      expect(presentmentOf(mode)).toBe("card_present");
    }
  });

  it("maps the card-not-present entry modes", () => {
    for (const mode of ["MANUAL", "KEY_ENTERED", "ECOMMERCE", "CREDENTIAL_ON_FILE"]) {
      expect(presentmentOf(mode)).toBe("card_not_present");
    }
  });

  it("AN UNRECOGNISED MODE IS 'unknown', NOT card-not-present", () => {
    // Defaulting a new provider enum value into the HIGHER card-not-present
    // rate would mean a provider shipping a field value silently increased our
    // reported revenue. Wrong direction for a surprise.
    expect(presentmentOf("SOMETHING_LITHIC_ADDS_IN_2027")).toBe("unknown");
    expect(presentmentOf("UNKNOWN")).toBe("unknown");
    expect(presentmentOf(null)).toBe("unknown");
  });

  it("rejects an MCC that is not four digits rather than joining on it", () => {
    expect(readDimensions({ merchant: { mcc: "55" } }).mcc).toBe(null);
    expect(readDimensions({ merchant: { mcc: "" } }).mcc).toBe(null);
    expect(readDimensions({ merchant: {} }).mcc).toBe(null);
  });

  it("never throws on a payload that is missing everything", () => {
    for (const payload of [null, undefined, 42, "x", [], {}]) {
      const d = readDimensions(payload);
      expect(d.mcc).toBe(null);
      expect(d.presentment).toBe("unknown");
    }
  });

  it("isPriceable separates a real provider record from a synthetic one", () => {
    expect(isPriceable(REAL)).toBe(true);
    expect(isPriceable({ merchant: { mcc: "5542" } })).toBe(true);
    expect(isPriceable({ pos: { entry_mode: { pan: "MANUAL" } } })).toBe(true);
    // What an integration test's hand-built Transaction looks like: a token,
    // an amount, events, and no merchant anywhere. Not priced, and listed in
    // v_interchange_unpriced with the reason rather than silently skipped.
    expect(isPriceable({ token: "auth-1789059056109-2", amount: 5000, events: [] })).toBe(false);
    expect(isPriceable(null)).toBe(false);
  });
});
