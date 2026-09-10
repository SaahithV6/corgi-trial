/**
 * The wire boundary: decimal strings in, bigints out, and the state machine.
 *
 * Every response shape asserted here was RECORDED from the live sandbox at
 * https://api.circle.com with a `TEST_API_KEY` credential, not written from
 * the documentation. Where the two disagreed the recording won.
 */
import { describe, expect, it } from "vitest";

import {
  CIRCLE_INITIATED_STATE,
  CIRCLE_TERMINAL_STATES,
  circleAmountToUnits,
  circleData,
  isTerminal,
  parseTokenBalance,
  parseTransaction,
  parseWallet,
  parseWalletSet,
  unitsToCircleAmount,
} from "./circle-types";

describe("amounts", () => {
  it("renders minor units as a six-decimal string", () => {
    expect(unitsToCircleAmount(100_000n)).toBe("0.100000");
    expect(unitsToCircleAmount(1_000_000n)).toBe("1.000000");
    expect(unitsToCircleAmount(1_234_567n)).toBe("1.234567");
    expect(unitsToCircleAmount(1n)).toBe("0.000001");
    expect(unitsToCircleAmount(0n)).toBe("0.000000");
  });

  it("refuses a negative amount rather than encoding one", () => {
    expect(() => unitsToCircleAmount(-1n)).toThrow(/positive/);
  });

  it("parses Circle's decimal strings exactly, at every shape they arrive in", () => {
    expect(circleAmountToUnits("0.1")).toBe(100_000n);
    expect(circleAmountToUnits("0.100000")).toBe(100_000n);
    expect(circleAmountToUnits("1")).toBe(1_000_000n);
    expect(circleAmountToUnits("1.234567")).toBe(1_234_567n);
    expect(circleAmountToUnits(" 0.05 ")).toBe(50_000n);
  });

  it("does not go through a float", () => {
    // parseFloat("0.1") * 1e6 is 100000.00000000001. This is the assertion
    // that says the implementation cannot be doing that.
    expect(circleAmountToUnits("0.1")).toBe(100_000n);
    expect(circleAmountToUnits("0.07")).toBe(70_000n);
    expect(circleAmountToUnits("1234567.654321")).toBe(1_234_567_654_321n);
  });

  it("round-trips", () => {
    for (const units of [0n, 1n, 9_999n, 100_000n, 1_234_567n, 20_000_000n]) {
      expect(circleAmountToUnits(unitsToCircleAmount(units))).toBe(units);
    }
  });

  it("rejects a figure USDC cannot represent instead of rounding it away", () => {
    expect(() => circleAmountToUnits("0.1234567")).toThrow(/decimal places/);
    expect(() => circleAmountToUnits("abc")).toThrow(/decimal amount/);
    expect(() => circleAmountToUnits("-1.0")).toThrow(/decimal amount/);
    expect(() => circleAmountToUnits("")).toThrow(/decimal amount/);
  });
});

describe("the state machine", () => {
  it("does not call INITIATED terminal", () => {
    expect(isTerminal(CIRCLE_INITIATED_STATE)).toBe(false);
  });

  it("does not call anything in flight terminal", () => {
    for (const state of ["INITIATED", "PENDING_RISK_SCREENING", "QUEUED", "SENT", "ACCELERATED", "CONFIRMED"]) {
      expect(isTerminal(state)).toBe(false);
    }
  });

  it("calls exactly the four endings terminal", () => {
    expect([...CIRCLE_TERMINAL_STATES]).toEqual(["COMPLETE", "FAILED", "CANCELLED", "DENIED"]);
    for (const state of CIRCLE_TERMINAL_STATES) expect(isTerminal(state)).toBe(true);
  });

  it("treats a state nobody has seen before as not terminal", () => {
    // The safe direction: an unknown state keeps us waiting and reading the
    // chain, rather than concluding anything about money.
    expect(isTerminal("SOMETHING_NEW")).toBe(false);
  });
});

describe("parsing the recorded shapes", () => {
  it("unwraps the data envelope, and says so when it is missing", () => {
    expect(circleData({ data: { a: 1 } }, "x")).toEqual({ a: 1 });
    expect(() => circleData({ a: 1 }, "x")).toThrow(/no "data" envelope/);
    expect(() => circleData(null, "x")).toThrow(/expected an object/);
  });

  it("parses a wallet set as POST /v1/w3s/developer/walletSets returned it", () => {
    const set = parseWalletSet({
      walletSet: {
        id: "9882bf06-4831-5bad-a1d4-606b80f944e0",
        custodyType: "DEVELOPER",
        name: "corgi-trial payouts",
        updateDate: "2026-09-10T23:44:20Z",
        createDate: "2026-09-10T23:44:20Z",
      },
    });
    expect(set.id).toBe("9882bf06-4831-5bad-a1d4-606b80f944e0");
    expect(set.name).toBe("corgi-trial payouts");
  });

  it("parses a wallet as POST /v1/w3s/developer/wallets returned it", () => {
    const wallet = parseWallet({
      id: "9a3524c0-728c-554f-8d26-a19c6ee66a4a",
      state: "LIVE",
      walletSetId: "9882bf06-4831-5bad-a1d4-606b80f944e0",
      custodyType: "DEVELOPER",
      address: "0xeaa8ce10abcbce9d7f5257126c36a078c9951e1c",
      blockchain: "BASE-SEPOLIA",
      accountType: "EOA",
      updateDate: "2026-09-10T23:44:24Z",
      createDate: "2026-09-10T23:44:24Z",
    });
    expect(wallet.address).toBe("0xeaa8ce10abcbce9d7f5257126c36a078c9951e1c");
    expect(wallet.blockchain).toBe("BASE-SEPOLIA");
    expect(wallet.accountType).toBe("EOA");
  });

  it("takes a token's contract address off a balance, and tolerates a native coin having none", () => {
    const usdc = parseTokenBalance({
      token: {
        id: "5797fbd6-3795-519d-84ca-ec4c5f80c3b1",
        blockchain: "BASE-SEPOLIA",
        tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        standard: "ERC20",
        name: "USDC",
        symbol: "USDC",
        decimals: 6,
        isNative: false,
      },
      amount: "1.0",
      updateDate: "2026-09-10T23:52:00Z",
    });
    expect(usdc.tokenId).toBe("5797fbd6-3795-519d-84ca-ec4c5f80c3b1");
    expect(usdc.tokenAddress).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(circleAmountToUnits(usdc.amount)).toBe(1_000_000n);

    const native = parseTokenBalance({
      token: { id: "native-id", blockchain: "BASE-SEPOLIA", name: "ETH", symbol: "ETH", decimals: 18, isNative: true },
      amount: "0.00003",
    });
    expect(native.tokenAddress).toBeNull();
  });

  it("parses the transfer POST response — an id, a state, and NO hash", () => {
    // This is the shape that makes Circle dangerous, recorded verbatim.
    const tx = parseTransaction({ id: "a384de2e-ff91-5bc8-8c05-7f13112ba22b", state: "INITIATED" });
    expect(tx.state).toBe(CIRCLE_INITIATED_STATE);
    expect(tx.txHash).toBeNull();
    expect(isTerminal(tx.state)).toBe(false);
  });

  it("parses the later GET, where the hash has appeared", () => {
    const tx = parseTransaction({
      transaction: {
        id: "a384de2e-ff91-5bc8-8c05-7f13112ba22b",
        blockchain: "BASE-SEPOLIA",
        tokenId: "5797fbd6-3795-519d-84ca-ec4c5f80c3b1",
        walletId: "9a3524c0-728c-554f-8d26-a19c6ee66a4a",
        sourceAddress: "0xeaa8ce10abcbce9d7f5257126c36a078c9951e1c",
        destinationAddress: "0x000000000000000000000000000000000000dead",
        transactionType: "OUTBOUND",
        state: "CONFIRMED",
        amounts: ["0.1"],
        txHash: "0x251858a3d3daf45aa2a8e2bc970351580b33bfe97a7f18e951b207fb91d476fa",
        blockHeight: 46657187,
        operation: "TRANSFER",
        feeLevel: "MEDIUM",
      },
    });
    expect(tx.txHash).toBe("0x251858a3d3daf45aa2a8e2bc970351580b33bfe97a7f18e951b207fb91d476fa");
    expect(circleAmountToUnits(tx.amounts[0] ?? "0")).toBe(100_000n);
    // Recorded fact, and the reason the poll does not wait for COMPLETE: the
    // money had already moved on chain while Circle still said CONFIRMED.
    expect(isTerminal(tx.state)).toBe(false);
  });

  it("keeps a failure's reason instead of flattening it to a boolean", () => {
    const tx = parseTransaction({
      transaction: {
        id: "t",
        state: "FAILED",
        amounts: ["0.1"],
        errorReason: "INSUFFICIENT_FUNDS",
        errorDetails: "wallet cannot cover the transfer",
      },
    });
    expect(tx.state).toBe("FAILED");
    expect(tx.txHash).toBeNull();
    expect(tx.errorReason).toBe("INSUFFICIENT_FUNDS");
    expect(isTerminal(tx.state)).toBe(true);
  });

  it("refuses a response with no id rather than inventing one", () => {
    expect(() => parseTransaction({ transaction: { state: "INITIATED" } })).toThrow(/transaction.id/);
  });
});
