import { describe, expect, it } from "vitest";

import {
  CARD_HOLD_PARENT_CODE,
  CHART,
  CHART_CODES,
  DEPOSIT_PARENT_CODE,
  PER_BUSINESS_PARENTS,
  QUALIFIED_CODE_SEPARATOR,
  UNCLEARED_HOLD_PARENT_CODE,
  accountsForBusiness,
  cardHoldAccountCode,
  childrenOf,
  depositAccountCode,
  findAccount,
  normalSide,
  normalSideOf,
  parseDepositAccountCode,
  parsePerBusinessCode,
  perBusinessAccountName,
  perBusinessCode,
  requireAccount,
  unclearedHoldAccountCode,
  type AccountType,
} from "@/lib/ledger/chart";

/**
 * These are consistency tests, not integration tests: they prove the chart is
 * internally coherent before it is ever written to a database. A chart that
 * fails any of these would still insert cleanly and would then produce wrong
 * numbers for ever, which is exactly the class of bug worth catching at
 * `pnpm test` speed.
 */

const BUSINESS_ID = "3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const OTHER_BUSINESS_ID = "11111111-2222-4333-8444-555555555555";

describe("chart integrity", () => {
  it("has no duplicate codes", () => {
    const seen = new Map<string, number>();
    for (const account of CHART) {
      seen.set(account.code, (seen.get(account.code) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([code]) => code);
    expect(duplicates).toEqual([]);
    expect(CHART_CODES).toHaveLength(CHART.length);
  });

  it("resolves every parent code to an account that exists", () => {
    const missing = CHART.filter(
      (account) => account.parent !== null && findAccount(account.parent) === undefined,
    ).map((account) => `${account.code} -> ${String(account.parent)}`);
    expect(missing).toEqual([]);
  });

  it("lists parents before their children, so a seeder can insert as it reads", () => {
    const seen = new Set<string>();
    for (const account of CHART) {
      if (account.parent !== null) {
        expect(seen.has(account.parent)).toBe(true);
      }
      seen.add(account.code);
    }
  });

  it("has no cycles and every account reaches a root", () => {
    for (const account of CHART) {
      const path = new Set<string>([account.code]);
      let cursor = account.parent;
      while (cursor !== null) {
        expect(path.has(cursor)).toBe(false);
        path.add(cursor);
        cursor = requireAccount(cursor).parent;
      }
      // The walk ended, so the last node had parent === null: a root.
      expect(path.size).toBeGreaterThanOrEqual(1);
    }
  });

  it("makes rollups non-postable and gives every rollup at least one child", () => {
    for (const account of CHART) {
      const children = childrenOf(account.code);
      if (children.length > 0) {
        expect(account.postable).toBe(false);
      }
      if (!account.postable && account.perBusiness !== true) {
        // A non-postable account with no children and no dynamic leaves would
        // be a node nothing can ever reach. 1190 is the deliberate exception:
        // it is a reporting-time reclass target that is never posted to.
        if (children.length === 0) {
          expect(account.code).toBe("1190");
        }
      }
    }
  });

  it("keeps every root at the top of its own numeric block", () => {
    const roots = CHART.filter((account) => account.parent === null).map((a) => a.code);
    expect(roots).toEqual(["1000", "2000", "3000", "4000", "5000", "9000"]);
  });
});

describe("normal balances", () => {
  it("maps type to normal side exactly as the generated column does", () => {
    const expected: Record<AccountType, 1 | -1> = {
      asset: 1,
      expense: 1,
      liability: -1,
      equity: -1,
      income: -1,
    };
    for (const [type, side] of Object.entries(expected) as [AccountType, 1 | -1][]) {
      expect(normalSide(type)).toBe(side);
    }
  });

  it("gives every account the type its numeric block promises", () => {
    const blockType: Record<string, AccountType> = {
      "1": "asset",
      "2": "liability",
      "3": "equity",
      "4": "income",
      "5": "expense",
    };
    for (const account of CHART) {
      if (account.book === "memo") continue; // the memo block is asserted separately
      const block = account.code.slice(0, 1);
      expect(account.type).toBe(blockType[block]);
    }
  });

  it("THE ONE THAT MATTERS: a customer deposit is a credit-normal liability", () => {
    const deposits = requireAccount(DEPOSIT_PARENT_CODE);
    expect(deposits.type).toBe("liability");
    expect(normalSideOf(DEPOSIT_PARENT_CODE)).toBe(-1);

    // Restated in the sign convention this schema uses, because this is the
    // inversion that poisons every downstream number: a DEBIT is a POSITIVE
    // amount_cents, and the customer SPENDING money is a debit to their
    // deposit account. So spending moves the raw signed sum UP toward zero
    // while the natural balance (raw * normal_side) goes DOWN.
    const openingRawCents = -10_000n; // credited $100 on deposit
    const spendRawCents = 2_500n; // a $25 card clearing: a DEBIT, hence positive
    const closingRawCents = openingRawCents + spendRawCents;

    const side = BigInt(normalSideOf(DEPOSIT_PARENT_CODE));
    expect(openingRawCents * side).toBe(10_000n);
    expect(closingRawCents * side).toBe(7_500n);
    expect(closingRawCents * side).toBeLessThan(openingRawCents * side);
  });

  it("keeps our cash and the customer's money on opposite sides", () => {
    // A $100 deposit: debit 1110 (asset, +1), credit the customer (liability,
    // -1). Same entry, opposite signs, sums to zero.
    expect(normalSideOf("1110")).toBe(1);
    expect(normalSideOf(DEPOSIT_PARENT_CODE)).toBe(-1);
    const lines = [10_000n, -10_000n];
    expect(lines.reduce((a, b) => a + b, 0n)).toBe(0n);
  });

  it("keeps income and expense on the sides that make a P&L read correctly", () => {
    expect(normalSideOf("4100")).toBe(-1); // interchange income, credit-normal
    expect(normalSideOf("4200")).toBe(-1); // fee income
    expect(normalSideOf("5100")).toBe(1); // network fees, debit-normal
    expect(normalSideOf("5300")).toBe(1); // USDC gas
  });
});

describe("the memo book", () => {
  it("contains exactly the 9xxx subtree and nothing else", () => {
    for (const account of CHART) {
      expect(account.book === "memo").toBe(account.code.startsWith("9"));
    }
  });

  it("has every memo account rooted at 9000", () => {
    for (const account of CHART) {
      if (account.book !== "memo") continue;
      if (account.parent === null) {
        expect(account.code).toBe("9000");
        continue;
      }
      expect(requireAccount(account.parent).book).toBe("memo");
    }
  });

  it("never lets a financial account descend from a memo one", () => {
    for (const account of CHART) {
      if (account.parent === null) continue;
      expect(requireAccount(account.parent).book).toBe(account.book);
    }
  });

  it("makes the hold accounts credit-normal and the contra debit-normal", () => {
    // A hold's natural balance is positive while held, so 9100/9200 must be
    // credit-normal and 9900 must take the other side; otherwise the memo
    // entry cannot sum to zero with a positive hold.
    expect(normalSideOf(CARD_HOLD_PARENT_CODE)).toBe(-1);
    expect(normalSideOf(UNCLEARED_HOLD_PARENT_CODE)).toBe(-1);
    expect(normalSideOf("9900")).toBe(1);

    // The two-line memo entry from DESIGN §7: credit 9100/<biz>, debit 9900.
    const holdLines = [-2_340n, 2_340n];
    expect(holdLines.reduce((a, b) => a + b, 0n)).toBe(0n);
    expect(holdLines[0]! * BigInt(normalSideOf(CARD_HOLD_PARENT_CODE))).toBe(2_340n);
  });

  it("puts no rail control account in the memo book", () => {
    for (const account of CHART) {
      if (account.railControl === undefined) continue;
      expect(account.book).toBe("financial");
      expect(account.postable).toBe(true);
    }
  });

  it("covers every money rail we settle on with at least one control account", () => {
    const controlled = new Set(
      CHART.flatMap((account) => (account.railControl === undefined ? [] : [account.railControl])),
    );
    expect(controlled).toContain("card");
    expect(controlled).toContain("ach");
    expect(controlled).toContain("usdc");
  });
});

describe("per-business account derivation", () => {
  it("marks exactly the deposit and the two hold rollups as per-business", () => {
    expect(PER_BUSINESS_PARENTS.map((a) => a.code)).toEqual([
      DEPOSIT_PARENT_CODE,
      CARD_HOLD_PARENT_CODE,
      UNCLEARED_HOLD_PARENT_CODE,
    ]);
    for (const parent of PER_BUSINESS_PARENTS) {
      expect(parent.postable).toBe(false);
    }
  });

  it("round-trips a deposit account code", () => {
    const code = depositAccountCode(BUSINESS_ID);
    expect(code).toBe(`${DEPOSIT_PARENT_CODE}${QUALIFIED_CODE_SEPARATOR}${BUSINESS_ID}`);
    expect(parseDepositAccountCode(code)).toBe(BUSINESS_ID);
  });

  it("round-trips every per-business rollup", () => {
    for (const parent of PER_BUSINESS_PARENTS) {
      const code = perBusinessCode(parent.code, BUSINESS_ID);
      const ref = parsePerBusinessCode(code);
      expect(ref).not.toBeNull();
      expect(ref!.code).toBe(parent.code);
      expect(ref!.businessId).toBe(BUSINESS_ID);
      expect(perBusinessCode(ref!.code, ref!.businessId)).toBe(code);
    }
  });

  it("gives different businesses different codes", () => {
    expect(depositAccountCode(BUSINESS_ID)).not.toBe(depositAccountCode(OTHER_BUSINESS_ID));
    expect(cardHoldAccountCode(BUSINESS_ID)).not.toBe(depositAccountCode(BUSINESS_ID));
    expect(unclearedHoldAccountCode(BUSINESS_ID)).not.toBe(cardHoldAccountCode(BUSINESS_ID));
  });

  it("refuses to parse anything that is not a per-business code", () => {
    expect(parseDepositAccountCode(DEPOSIT_PARENT_CODE)).toBeNull(); // the control account
    expect(parseDepositAccountCode("2100/not-a-uuid")).toBeNull();
    expect(parseDepositAccountCode(`1110/${BUSINESS_ID}`)).toBeNull(); // not per-business
    expect(parseDepositAccountCode(`9100/${BUSINESS_ID}`)).toBeNull(); // a hold, not a deposit
    expect(parsePerBusinessCode(`9999/${BUSINESS_ID}`)).toBeNull(); // not in the chart
    expect(parsePerBusinessCode("")).toBeNull();
  });

  it("refuses to derive a code from a rollup that has no per-business leaves", () => {
    expect(() => perBusinessCode("1110", BUSINESS_ID)).toThrow(/per-business/);
    expect(() => perBusinessCode(DEPOSIT_PARENT_CODE, "nope")).toThrow(/business uuid/);
  });

  it("stores the BARE code, never the qualified one", () => {
    // v_available_balance, v_overdrawn_accounts and v_deposit_control_drift
    // all select `code = '2100' AND business_id IS NOT NULL`. If the stored
    // code were ever qualified those views would silently return nothing.
    for (const ref of accountsForBusiness(BUSINESS_ID)) {
      expect(ref.code).not.toContain(QUALIFIED_CODE_SEPARATOR);
      expect(findAccount(ref.code)?.perBusiness).toBe(true);
      expect(ref.businessId).toBe(BUSINESS_ID);
      expect(ref.parentCode).toBe(ref.code);
    }
    expect(accountsForBusiness(BUSINESS_ID)).toHaveLength(PER_BUSINESS_PARENTS.length);
  });

  it("names a customer leaf after the business, not after the rollup", () => {
    expect(perBusinessAccountName(DEPOSIT_PARENT_CODE, "Ridgeline Robotics, Inc.")).toBe(
      "Ridgeline Robotics, Inc. — business current account",
    );
    expect(perBusinessAccountName(CARD_HOLD_PARENT_CODE, "Ridgeline Robotics, Inc.")).toContain(
      "card authorisation holds",
    );
  });
});

describe("explainability", () => {
  it("gives every account a one-sentence 'why'", () => {
    for (const account of CHART) {
      expect(account.why.length).toBeGreaterThan(40);
      expect(account.name.trim()).toBe(account.name);
    }
  });

  it("resolves by code and throws loudly on a code that is not charted", () => {
    expect(requireAccount("1110").name).toContain("FBO");
    expect(findAccount("0000")).toBeUndefined();
    expect(() => requireAccount("0000")).toThrow(/no account '0000'/);
  });
});
