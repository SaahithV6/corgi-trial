/**
 * The tiles are a function of the query result, and only of the query result.
 *
 * The bug this page exists to fix was a hardcoded claim about system state. So
 * the property worth testing is not "the tile says 467" — it is "the tile says
 * whatever the read said, and nothing appears that the read did not produce."
 */
import { describe, expect, it } from "vitest";

import type { SystemState } from "@/lib/home/summary";

import { buildTiles } from "./SystemStatePanel";

function stateOf(over: Partial<SystemState> = {}): SystemState {
  return {
    readAt: new Date("2026-09-10T17:41:30.000Z"),
    journalEntries: 467,
    financialEntries: 328,
    memoEntries: 139,
    journalLines: 934,
    bookingWatermark: 479n,
    lastPostedAt: new Date("2026-09-10T17:33:33.099Z"),
    cardAuthorisations: 84,
    cardAuthEvents: 171,
    activeHolds: 20,
    activeHoldCents: 74_200n,
    webhooks: {
      total: 64,
      done: 53,
      pending: 0,
      parked: 11,
      dead: 0,
      lastDeliveryAt: new Date("2026-09-10T17:33:31.582Z"),
    },
    trialBalance: {
      debitCents: 421_543_593n,
      creditCents: 421_543_593n,
      differenceCents: 0n,
      accounts: 6,
    },
    depositAccounts: 2,
    ...over,
  };
}

describe("buildTiles", () => {
  it("takes every headline figure from the state", () => {
    const tiles = buildTiles(stateOf());
    const by = new Map(tiles.map((t) => [t.key, t]));

    expect(by.get("entries")?.count).toBe(467);
    expect(by.get("card-auths")?.count).toBe(84);
    expect(by.get("holds")?.count).toBe(20);
    expect(by.get("webhooks")?.count).toBe(53);
    expect(by.get("deposit-accounts")?.count).toBe(2);
  });

  it("moves with the state — nothing is a literal", () => {
    const tiles = buildTiles(
      stateOf({
        journalEntries: 1,
        financialEntries: 1,
        memoEntries: 0,
        journalLines: 2,
        cardAuthorisations: 0,
        cardAuthEvents: 0,
        activeHolds: 0,
        activeHoldCents: 0n,
        depositAccounts: 0,
        webhooks: {
          total: 0,
          done: 0,
          pending: 0,
          parked: 0,
          dead: 0,
          lastDeliveryAt: null,
        },
      }),
    );

    expect(tiles.map((t) => t.count)).toEqual([1, 0, 0, 0, 0]);
    // An empty system says so plainly rather than borrowing yesterday's figures.
    expect(tiles.find((t) => t.key === "holds")?.detail).toContain("$0.00");
  });

  it("renders every money figure through the money formatter", () => {
    const detail = buildTiles(stateOf()).find((t) => t.key === "holds")?.detail ?? "";
    // formatUsd: grouped thousands, always two fraction digits, symbol outside.
    expect(detail).toContain("$742.00");
    // Never a float, and never a raw cent count presented as dollars.
    expect(detail).not.toContain("74200");
    expect(detail).not.toContain("742.0000");
  });

  it("keeps counts and money apart, so a count cannot be dressed as money", () => {
    for (const tile of buildTiles(stateOf())) {
      expect(tile.count === null).not.toBe(tile.cents === null);
      if (tile.cents !== null) expect(typeof tile.cents).toBe("bigint");
    }
  });

  it("mentions the parked and dead inbox rows only when there are some", () => {
    const clean = buildTiles(
      stateOf({
        webhooks: {
          total: 53,
          done: 53,
          pending: 0,
          parked: 0,
          dead: 0,
          lastDeliveryAt: null,
        },
      }),
    ).find((t) => t.key === "webhooks");
    expect(clean?.detail).toBe("of 53 verified and stored");

    const messy = buildTiles(
      stateOf({
        webhooks: {
          total: 70,
          done: 53,
          pending: 4,
          parked: 11,
          dead: 2,
          lastDeliveryAt: null,
        },
      }),
    ).find((t) => t.key === "webhooks");
    expect(messy?.detail).toContain("11 parked");
    expect(messy?.detail).toContain("4 queued");
    expect(messy?.detail).toContain("2 dead-lettered");
  });

  it("gives every tile a stable key and a provenance line", () => {
    const tiles = buildTiles(stateOf());
    expect(new Set(tiles.map((t) => t.key)).size).toBe(tiles.length);
    for (const tile of tiles) {
      expect(tile.label.length).toBeGreaterThan(0);
      expect(tile.detail.length).toBeGreaterThan(0);
    }
  });
});
