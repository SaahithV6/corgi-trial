import { describe, expect, it } from "vitest";

import {
  CONTENT_HASH_VERSION,
  approvalApplies,
  canonicalJson,
  contentHash,
  contentPreimage,
  isContentHash,
  requireContentHash,
} from "./hash";
import type { PaymentContent } from "./hash";

const BASE: PaymentContent = {
  accountId: "a0c41a37-2be1-5c30-bfe9-03455f048fac",
  rail: "ach",
  amountCents: 420_000n,
  currency: "USD",
  valueDate: "2026-09-11",
  destination: {
    type: "ach",
    holderName: "Fairbanks Machining LLC",
    routingNumber: "021000021",
    accountNumberLast4: "4417",
    accountType: "checking",
  },
};

describe("canonicalJson", () => {
  it("sorts keys at every depth, so assignment order cannot change a hash", () => {
    const a = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } };
    const b = { a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });

  it("keeps array order, because array order is meaning", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("refuses a bigint rather than guessing at a rendering", () => {
    expect(() => canonicalJson({ amount: 1n })).toThrow(/no canonical JSON form/);
  });
});

describe("contentPreimage", () => {
  it("names every field that is part of the payment, and the version", () => {
    const preimage = contentPreimage(BASE);
    expect(preimage.startsWith(CONTENT_HASH_VERSION)).toBe(true);
    expect(preimage).toContain("account=a0c41a37-2be1-5c30-bfe9-03455f048fac");
    expect(preimage).toContain("rail=ach");
    expect(preimage).toContain("amount=420000");
    expect(preimage).toContain("currency=USD");
    expect(preimage).toContain("value_date=2026-09-11");
    expect(preimage).toContain('"routingNumber":"021000021"');
  });

  it("hashes the amount as an exact integer string, never a float", () => {
    const huge: PaymentContent = { ...BASE, amountCents: 9_007_199_254_740_993n };
    expect(contentPreimage(huge)).toContain("amount=9007199254740993");
  });
});

describe("contentHash", () => {
  it("is 32 bytes of lowercase hex — what the bytea CHECK wants", () => {
    const hash = contentHash(BASE);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(isContentHash(hash)).toBe(true);
  });

  it("is stable across runs and across key order in the destination", () => {
    const reordered: PaymentContent = {
      valueDate: BASE.valueDate,
      currency: BASE.currency,
      amountCents: BASE.amountCents,
      rail: BASE.rail,
      accountId: BASE.accountId,
      destination: {
        accountType: "checking",
        accountNumberLast4: "4417",
        routingNumber: "021000021",
        holderName: "Fairbanks Machining LLC",
        type: "ach",
      },
    };
    expect(contentHash(reordered)).toBe(contentHash(BASE));
  });

  /**
   * The four mutations that must each produce a different payment. This is the
   * property the whole control rests on: an approval cites a hash, so any of
   * these makes the approval stop applying.
   */
  it.each([
    ["amount", { ...BASE, amountCents: 420_001n }],
    ["rail", { ...BASE, rail: "wire" as const }],
    ["account", { ...BASE, accountId: "00000000-0000-0000-0000-000000000001" }],
    ["value date", { ...BASE, valueDate: "2026-09-12" }],
    [
      "destination",
      {
        ...BASE,
        destination: {
          type: "ach" as const,
          holderName: "Fairbanks Machining LLC",
          routingNumber: "021000021",
          accountNumberLast4: "9999",
          accountType: "checking" as const,
        },
      },
    ],
  ])("changing the %s changes the hash", (_label, mutated) => {
    expect(contentHash(mutated)).not.toBe(contentHash(BASE));
  });

  it("a one-cent change changes the hash — the $100 vs $10,000 case", () => {
    const approved = contentHash({ ...BASE, amountCents: 10_000n });
    const submitted = contentHash({ ...BASE, amountCents: 1_000_000n });
    expect(approved).not.toBe(submitted);
    // And that is exactly what makes the stale approval void: the approval
    // carries `approved`, the row carries `submitted`, and the trigger compares
    // them. No application code is involved in the decision.
    expect(approvalApplies(submitted, approved)).toBe(false);
    expect(approvalApplies(submitted, submitted)).toBe(true);
  });
});

describe("requireContentHash", () => {
  it("normalises the forms a hash arrives in", () => {
    const hash = contentHash(BASE);
    expect(requireContentHash(hash.toUpperCase())).toBe(hash);
    expect(requireContentHash(`\\x${hash}`)).toBe(hash);
    expect(requireContentHash(`  ${hash}  `)).toBe(hash);
  });

  it("refuses anything that is not 32 bytes of hex", () => {
    expect(() => requireContentHash("deadbeef")).toThrow(/64 hex characters/);
    expect(() => requireContentHash(null)).toThrow(/64 hex characters/);
    expect(() => requireContentHash(`${"z".repeat(64)}`)).toThrow(/64 hex characters/);
  });
});

describe("approvalApplies", () => {
  it("treats a missing hash as not applying", () => {
    expect(approvalApplies(contentHash(BASE), null)).toBe(false);
  });
});
