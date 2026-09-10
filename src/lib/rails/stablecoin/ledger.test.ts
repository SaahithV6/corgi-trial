/**
 * The posting: unit arithmetic here, and a real journal entry behind
 * RUN_DB_TESTS=1.
 *
 * The unit half is the part that must never be wrong and never needs a
 * database: USDC has six decimals, the ledger carries 1140 in cents, and the
 * four digits in between have to go somewhere visible. A truncation here is
 * invisible in every report and only shows up as a slowly drifting wallet
 * reconciliation months later.
 *
 * The database half follows the pattern in ../../ledger/ledger.integration.test.ts:
 * gated on RUN_DB_TESTS=1, dynamically imported so a missing DATABASE_URL does
 * not blow up at module load in CI, and everything it writes is rolled back.
 */
import { describe, expect, it, beforeAll } from "vitest";

import type { sql as SqlHandle } from "@/lib/ledger/db";
import { blockValueDate, payoutAllocation } from "./allocation";
import type { postUsdcPayout as PostUsdcPayout } from "./ledger";
import { formatUsdc, payoutIdempotencyKey, splitUsdcUnits, USDC_UNITS_PER_CENT } from "./types";

describe("USDC minor units", () => {
  it("splits a whole number of cents with no dust", () => {
    expect(splitUsdcUnits(500_000n)).toEqual({ cents: 50n, dustUnits: 0n });
    expect(USDC_UNITS_PER_CENT).toBe(10_000n);
  });

  it("keeps the sub-cent remainder instead of truncating it", () => {
    // The example chart.ts itself gives: 1.234567 USDC is 123.4567 cents.
    expect(splitUsdcUnits(1_234_567n)).toEqual({ cents: 123n, dustUnits: 4_567n });
  });

  it("formats without ever touching a float", () => {
    expect(formatUsdc(500_000n)).toBe("0.500000 USDC");
    expect(formatUsdc(20_000_000n)).toBe("20.000000 USDC");
    expect(formatUsdc(1n)).toBe("0.000001 USDC");
    // 2^53 minor units is past Number.MAX_SAFE_INTEGER and still exact here.
    expect(formatUsdc(9_007_199_254_740_993n)).toBe("9007199254.740993 USDC");
  });

  it("refuses a negative amount rather than inventing a direction", () => {
    expect(() => splitUsdcUnits(-1n)).toThrow(/positive/);
  });
});

describe("payoutAllocation", () => {
  it("produces two balanced lines when the amount is whole cents", () => {
    const a = payoutAllocation(500_000n);
    expect(a).toEqual({
      depositDebitCents: 50n,
      walletCreditCents: 50n,
      residualCreditCents: 0n,
      dustUnits: 0n,
    });
    expect(a.depositDebitCents - a.walletCreditCents - a.residualCreditCents).toBe(0n);
  });

  it("routes the sub-cent remainder to the residual account and still balances", () => {
    const a = payoutAllocation(1_234_567n);
    expect(a.depositDebitCents).toBe(124n); // rounded UP: the customer parts with 124c
    expect(a.walletCreditCents).toBe(123n); // the wallet's whole cents
    expect(a.residualCreditCents).toBe(1n); // 2900 carries the difference
    expect(a.dustUnits).toBe(4_567n);
    expect(a.depositDebitCents - a.walletCreditCents - a.residualCreditCents).toBe(0n);
  });

  it("balances for every remainder in a cent", () => {
    for (let dust = 0n; dust < 10_000n; dust += 137n) {
      const a = payoutAllocation(500_000n + dust);
      expect(a.depositDebitCents - a.walletCreditCents - a.residualCreditCents).toBe(0n);
    }
  });
});

describe("the value date comes from the block, not from the clock", () => {
  it("dates a payout in book time (America/New_York)", () => {
    // 2026-09-10T20:04:50Z — the block that carried this repo's payout.
    expect(blockValueDate(0x6aa30d62n)).toBe("2026-09-10");
  });

  it("puts a late-evening UTC block on the previous New York business day", () => {
    // 2026-09-11T02:00:00Z is 22:00 on the 10th in New York. A UTC-derived
    // value date would move the money to the wrong business day every night.
    expect(blockValueDate(BigInt(Date.parse("2026-09-11T02:00:00Z") / 1000))).toBe("2026-09-10");
  });
});

describe("the idempotency key is the transaction hash", () => {
  it("is derived from the hash and nothing else", () => {
    expect(payoutIdempotencyKey("0xb47c5a36")).toBe("usdc:payout:0xb47c5a36");
  });
});

const RUN = process.env.RUN_DB_TESTS === "1";
const d = RUN ? describe : describe.skip;

d("posting a confirmed payout to the live database", () => {
  let sql: typeof SqlHandle;
  let postUsdcPayout: typeof PostUsdcPayout;
  let entityId: string;
  let businessId: string;
  let actorId: string;

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    ({ postUsdcPayout } = await import("./ledger"));
    const [entity] = await sql<{ id: string }[]>`SELECT id FROM book_entity LIMIT 1`;
    const [business] = await sql<{ id: string }[]>`
      SELECT b.id FROM business b
       JOIN account a ON a.business_id = b.id AND a.code = '2100' AND a.is_postable
       LIMIT 1`;
    const [actor] = await sql<{ id: string }[]>`SELECT id FROM actor WHERE display_name = 'ledger-poster'`;
    if (!entity || !business || !actor) throw new Error("seed the database first");
    entityId = entity.id;
    businessId = business.id;
    actorId = actor.id;
  });

  const outcomeFor = (txHash: string, units: bigint) =>
    ({
      provider: "base.usdc" as const,
      evidence: "live" as const,
      kind: "confirmed" as const,
      amount: { amount: units, currency: "USDC" as const },
      from: "0xd3629d7399945a1ff2c5a1c5b0f7c9d32d3c2918",
      to: "0x000000000000000000000000000000000000dead",
      txHash,
      nonce: 0n,
      recovered: false,
      gas: { gasLimit: 56_528n, maxFeePerGas: 16_000_000n, maxPriorityFeePerGas: 1_000_000n, maxCostWei: 0n },
      receipt: {
        blockNumber: 46_651_201n,
        blockHash: `0x${"11".repeat(32)}`,
        blockTimestamp: 0x6aa30d62n,
        gasUsed: 44_843n,
        effectiveGasPriceWei: 6_000_000n,
        gasCostWei: 269_058_000_000n,
      },
    });

  it("posts a balanced entry and replays it as a no-op", async () => {
    const txHash = `0x${"e".repeat(63)}1`;
    await sql.begin(async (tx) => {
      const first = await postUsdcPayout(
        { outcome: outcomeFor(txHash, 500_000n), entityId, businessId, actorId, reference: "test" },
        tx as never,
      );
      const second = await postUsdcPayout(
        { outcome: outcomeFor(txHash, 500_000n), entityId, businessId, actorId, reference: "test" },
        tx as never,
      );
      // Same fact, same entry. Decided by the UNIQUE constraint, not by us.
      expect(second.entryId).toBe(first.entryId);
      expect(first.valueDate).toBe("2026-09-10");

      const lines = await tx<{ amount_cents: bigint; currency: string }[]>`
        SELECT amount_cents, currency FROM journal_line WHERE entry_id = ${first.entryId}::uuid`;
      expect(lines).toHaveLength(2);
      expect(lines.reduce((sum, l) => sum + l.amount_cents, 0n)).toBe(0n);

      const [entries] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM journal_entry WHERE idempotency_key = ${first.idempotencyKey}`;
      expect(entries?.n).toBe(1);
      throw new Error("rollback");
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== "rollback") throw error;
    });
  });

  it("posts the sub-cent residual as its own line", async () => {
    const txHash = `0x${"f".repeat(63)}2`;
    await sql.begin(async (tx) => {
      const posted = await postUsdcPayout(
        { outcome: outcomeFor(txHash, 1_234_567n), entityId, businessId, actorId },
        tx as never,
      );
      const lines = await tx<{ amount_cents: bigint }[]>`
        SELECT amount_cents FROM journal_line WHERE entry_id = ${posted.entryId}::uuid ORDER BY ordinal`;
      expect(lines.map((l) => l.amount_cents)).toEqual([124n, -123n, -1n]);
      throw new Error("rollback");
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || error.message !== "rollback") throw error;
    });
  });
});
