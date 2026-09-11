/**
 * The component-side arithmetic agrees with the ledger-side arithmetic, to the
 * cent, on every row shape either of them can be handed.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS. `./arithmetic.ts` is a second implementation of
 * `portfolioTotals` and `formatBps`, and a second definition of a total is the
 * defect this repository spent migration 0022 undoing —
 * `@/lib/interchange/screen`'s own header says so in as many words. The copy
 * was made because importing the lib's version dragged `@/lib/ledger/db` into
 * the page module and took all five of this screen's states down on a machine
 * with no database; that is measured in `./no-database.test.ts`.
 *
 * A duplicate that nobody checks is a drift waiting to happen, so this checks
 * it. Both implementations are run over the same generated rows and asserted
 * equal field by field. If someone changes one, this goes red naming the field.
 * ============================================================================
 *
 * IT IS NOT GATED ON `RUN_DB_TESTS`, AND IT STILL IMPORTS THE LIB. That module
 * throws at load without `APP_DATABASE_URL`, so this file sets a syntactically
 * valid placeholder before importing it and restores the real value
 * afterwards. Nothing here opens a connection: `parseEnv` validates the SHAPE
 * of the URL and `portfolioTotals` is a loop over an array. A URL that parses
 * is all the lib module needs in order to be loaded, which is exactly the
 * property that made the old guard unreachable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PortfolioTotals, UnitEconomicsRow } from "@/lib/interchange/screen";

import { formatBps, portfolioTotals } from "./arithmetic";

const SAVED = process.env["APP_DATABASE_URL"];
const PLACEHOLDER = "postgresql://corgi_app:x@localhost:5432/corgi?sslmode=require";

/** The lib's implementations, loaded once the environment will let them load. */
let libTotals: (rows: readonly UnitEconomicsRow[]) => PortfolioTotals;
let libFormatBps: (bps: number | bigint) => string;

beforeAll(async () => {
  if (SAVED === undefined || SAVED === "") process.env["APP_DATABASE_URL"] = PLACEHOLDER;
  const lib = await import("@/lib/interchange/screen");
  libTotals = lib.portfolioTotals;
  libFormatBps = lib.formatBps;
});

afterAll(() => {
  if (SAVED === undefined) delete process.env["APP_DATABASE_URL"];
  else process.env["APP_DATABASE_URL"] = SAVED;
});

/**
 * One row, from a seed.
 *
 * Deliberately includes negative contribution and zero settlement: the
 * `effectiveRateBps` branch turns on `netSettledCents > 0n`, and a portfolio
 * that settled nothing is the case where the two implementations could differ
 * by returning `null` against `0n` and nobody would notice on a screen that
 * renders a dash for both.
 */
function row(seed: number): UnitEconomicsRow {
  const n = BigInt(seed);
  return {
    businessId: `business-${seed}`,
    legalName: `Business ${seed}`,
    pricedSettlements: seed % 7,
    reversedSettlements: seed % 3,
    netSettledCents: seed % 5 === 0 ? 0n : n * 1_234n,
    interchangeCents: n * 17n,
    feeIncomeCents: n * 11n,
    interestExpenseCents: -(n * 3n),
    otherExpenseCents: seed % 4 === 0 ? -(n * 29n) : 0n,
    netContributionCents: n * 17n + n * 11n - n * 3n,
  } as UnitEconomicsRow;
}

describe("portfolioTotals is the same total on both sides of the seam", () => {
  for (const size of [0, 1, 2, 5, 13, 40]) {
    it(`agrees field by field over ${size} row(s)`, () => {
      const rows = Array.from({ length: size }, (_, i) => row(i + 1));
      // `toEqual` compares bigints by value and `null` distinctly from `0n`,
      // which is the difference that matters on `effectiveRateBps`.
      expect(portfolioTotals(rows)).toEqual(libTotals(rows));
    });
  }

  it("returns a rate of null, not nought, when nothing settled", () => {
    const nothing = [{ ...row(5), netSettledCents: 0n }];
    expect(portfolioTotals(nothing).effectiveRateBps).toBeNull();
    expect(portfolioTotals(nothing)).toEqual(libTotals(nothing));
  });
});

describe("formatBps is the same string on both sides of the seam", () => {
  const CASES: readonly (number | bigint)[] = [
    0, 1, 5, 12, 99, 100, 155, 170, 1_000, 10_000, -1, -5, -155, -10_000, 0n, 155n, -155n,
  ];

  for (const bps of CASES) {
    it(`agrees on ${String(bps)}`, () => {
      expect(formatBps(bps)).toBe(libFormatBps(bps));
    });
  }
});
