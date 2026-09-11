/**
 * `businessAvailability()` on a business that has no `2100` leaf.
 *
 * ===========================================================================
 * THE ZERO THAT NOBODY COMPUTED
 * ===========================================================================
 *
 * `businessAvailability()` used to answer a business with no deposit account
 * with five hardcoded `0n`. Silverline Freight Co. is such a business on the
 * live book right now, and the client surface read those five zeros and drew a
 * green LIVE badge over
 *
 *   "Ledger $0.00 - card holds $0.00 - uncleared $0.00 - committed $0.00"
 *
 * Not one of those four figures came from `ledger_availability()`. There was
 * no account to read, so there was no ledger term, no hold term, no uncleared
 * term and no committed term - and the caller could not tell that reading from
 * a business whose deposit account really does sum to zero, because the two
 * returned byte-identical values.
 *
 * These two tests are the pair. Either one alone is passable by a wrong fix:
 * refusing everything passes the first, fabricating everything passes the
 * second. A genuine $0.00 account must stay reachable AND stay zero.
 *
 * Gated on RUN_DB_TESTS=1, like every other integration test here:
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm exec vitest run \
 *     src/lib/ledger/business-availability.integration.test.ts
 *
 * BOTH tests are READ-ONLY. Nothing here writes, so nothing here needs a
 * transaction to throw away: the no-account case reads a business that is
 * already in that state, and the real-zero case reads a real `2100` leaf at a
 * snapshot pinned before its first entry, which is a genuine
 * `ledger_availability()` call returning five genuine zeros. Per-run cost:
 * zero rows.
 */
import { describe, expect, it, beforeAll } from "vitest";

import type * as Defs from "./balance-definitions";
import type { sql as SqlHandle } from "./db";

const RUN = process.env.RUN_DB_TESTS === "1";
const d = RUN ? describe : describe.skip;

/** Silverline Freight Co. - on the live book, and holds no `2100` leaf. */
const NO_DEPOSIT_BUSINESS = "3593cbbb-cd74-5078-ab3c-c4c546910f95";

/** Pots Integration Fixture Co. - a real `2100` leaf with real entries on it. */
const REAL_DEPOSIT_BUSINESS = "70747300-0000-5000-a000-000000000001";

d("businessAvailability, against the live database", () => {
  let sql: typeof SqlHandle;
  let defs: typeof Defs;

  beforeAll(async () => {
    ({ sql } = await import("./db"));
    defs = await import("./balance-definitions");
  });

  it("no 2100 leaf: a named state, not five zeros", async () => {
    expect(await defs.mainDepositAccountId(NO_DEPOSIT_BUSINESS, sql)).toBeNull();

    const snapshot = await defs.readSnapshot(sql);
    const result = await defs.businessAvailability(NO_DEPOSIT_BUSINESS, snapshot, sql);

    // eslint-disable-next-line no-console
    console.log("NO 2100 ACCOUNT ->", JSON.stringify(result, (_k, v) =>
      typeof v === "bigint" ? `${v}n` : v,
    ));

    expect(defs.isLedgerRead(result)).toBe(false);
    expect(defs.noDepositAccountRefusal(result)?.code).toBe("LEDGER_NO_DEPOSIT_ACCOUNT");
    // The fabricated terms are GONE, not zeroed.
    expect(result).not.toHaveProperty("availableCents");
    expect(result).not.toHaveProperty("ledgerCents");
  });

  it("a real 2100 leaf that sums to zero: still reachable, still zero", async () => {
    expect(await defs.mainDepositAccountId(REAL_DEPOSIT_BUSINESS, sql)).not.toBeNull();

    // A real account, read before its first entry: every term is genuinely
    // nought because `ledger_availability()` says so, not because this
    // function typed five literals.
    const live = await defs.readSnapshot(sql);
    const pinned = defs.historicSnapshot("2020-01-01", 0n, live.asOf);
    const result = await defs.businessAvailability(REAL_DEPOSIT_BUSINESS, pinned, sql);

    // eslint-disable-next-line no-console
    console.log("REAL 2100, PINNED BEFORE ITS FIRST ENTRY ->", JSON.stringify(result, (_k, v) =>
      typeof v === "bigint" ? `${v}n` : v,
    ));

    expect(defs.isLedgerRead(result)).toBe(true);
    if (!defs.isLedgerRead(result)) throw new Error("unreachable");
    expect(result.ledgerCents).toBe(0n);
    expect(result.holdsCents).toBe(0n);
    expect(result.unclearedCents).toBe(0n);
    expect(result.pendingOutboundCents).toBe(0n);
    expect(result.availableCents).toBe(0n);

    // And the same account at the live snapshot is NOT zero - proof that the
    // zeros above are a read of this account and not a read of nothing.
    const now = await defs.businessAvailability(REAL_DEPOSIT_BUSINESS, live, sql);
    expect(defs.isLedgerRead(now)).toBe(true);
    if (!defs.isLedgerRead(now)) throw new Error("unreachable");
    expect(now.ledgerCents).not.toBe(0n);
  });
});
