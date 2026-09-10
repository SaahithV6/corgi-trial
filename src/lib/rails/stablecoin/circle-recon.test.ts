/**
 * Reconciling 1140 against the chain. Pure arithmetic, no network, no database.
 */
import { describe, expect, it } from "vitest";

import { reconcileUsdcWallet } from "./circle-recon";

const WALLET = "0xEAA8CE10ABCBCE9D7F5257126C36A078C9951E1C";

describe("reconcileUsdcWallet", () => {
  it("reconciles when the chain and the ledger agree", () => {
    const report = reconcileUsdcWallet({
      walletAddress: WALLET,
      provider: "circle.w3s",
      chainUnits: 900_000n,
      ledgerCents: 90n,
    });
    expect(report.reconciled).toBe(true);
    expect(report.breakCents).toBe(0n);
    expect(report.chainCents).toBe(90n);
    expect(report.walletAddress).toBe(WALLET.toLowerCase());
  });

  it("reports money on chain that has no journal entry", () => {
    // The live case after the Circle payout: the wallet was funded from our
    // own treasury wallet and that move was never booked.
    const report = reconcileUsdcWallet({
      walletAddress: WALLET,
      provider: "circle.w3s",
      chainUnits: 900_000n,
      ledgerCents: 0n,
    });
    expect(report.reconciled).toBe(false);
    expect(report.breakCents).toBe(90n);
    expect(report.summary).toMatch(/90 cents on chain with no journal entry/);
  });

  it("reports the other direction differently — booked money the chain does not hold", () => {
    const report = reconcileUsdcWallet({
      walletAddress: WALLET,
      provider: "base.usdc",
      chainUnits: 0n,
      ledgerCents: 50n,
    });
    expect(report.breakCents).toBe(-50n);
    expect(report.summary).toMatch(/50 cents booked that the chain does not hold/);
  });

  it("nets out a known un-booked opening balance instead of leaving it a mystery", () => {
    const report = reconcileUsdcWallet({
      walletAddress: WALLET,
      provider: "circle.w3s",
      chainUnits: 900_000n,
      ledgerCents: 0n,
      openingUnbookedCents: 90n,
    });
    expect(report.reconciled).toBe(true);
    expect(report.summary).toMatch(/after 90 cents of un-booked opening balance/);
  });

  it("shows sub-cent dust rather than folding it into the break", () => {
    // 0.904567 USDC is 90 cents and 4,567/10,000 of a cent. The ledger cannot
    // hold the remainder, so it is REPORTED, not rounded into a discrepancy.
    const report = reconcileUsdcWallet({
      walletAddress: WALLET,
      provider: "circle.w3s",
      chainUnits: 904_567n,
      ledgerCents: 90n,
    });
    expect(report.chainCents).toBe(90n);
    expect(report.chainDustUnits).toBe(4_567n);
    expect(report.breakCents).toBe(0n);
    expect(report.reconciled).toBe(true);
    expect(report.summary).toMatch(/4567\/10000 of a cent below ledger resolution/);
  });

  it("carries the provider, so a break says which rail's wallet it is about", () => {
    expect(
      reconcileUsdcWallet({ walletAddress: WALLET, provider: "circle.w3s", chainUnits: 0n, ledgerCents: 0n }).provider,
    ).toBe("circle.w3s");
  });

  it("is exact for every remainder in a cent", () => {
    for (let dust = 0n; dust < 10_000n; dust += 331n) {
      const report = reconcileUsdcWallet({
        walletAddress: WALLET,
        provider: "circle.w3s",
        chainUnits: 1_230_000n + dust,
        ledgerCents: 123n,
      });
      expect(report.chainCents).toBe(123n);
      expect(report.chainDustUnits).toBe(dust);
      expect(report.breakCents).toBe(0n);
    }
  });
});
