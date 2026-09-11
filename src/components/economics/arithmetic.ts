/**
 * The two pure functions `/economics` renders through, on the component side of
 * the seam.
 *
 * ============================================================================
 * WHY THEY ARE HERE AND NOT IMPORTED FROM `@/lib/interchange/screen`.
 * ============================================================================
 *
 * Every other screen in this console obeys one rule, written at the top of each
 * `data-contract.ts`: nothing under `src/components/**` opens a connection,
 * imports `postgres`, or reaches into its `src/lib/<feature>/*` for anything
 * but TYPES. `/economics` was the exception. `EconomicsView.tsx` imported
 * `portfolioTotals` and `formatBps` from `@/lib/interchange/screen` as VALUES,
 * and that module opens with
 *
 *     import { sql, type Sql } from "@/lib/ledger/db";
 *
 * which reaches `@/lib/env`, which parses `process.env` at module scope and
 * throws `EnvironmentError` when `APP_DATABASE_URL` is absent.
 *
 * The consequence was not subtle. `page.tsx` imported `EconomicsView`
 * statically, so with no database the PAGE MODULE failed to evaluate: not the
 * live state, ALL FIVE, including three fixtures that touch no database by
 * construction. A screen cannot render the words "no database configured" out
 * of a module that cannot be loaded without one — the same trap
 * `src/lib/has-database.ts` exists to keep out of the guard, one layer up.
 *
 * Two totals for one number is the defect this repository spent a migration
 * undoing, and `@/lib/interchange/screen`'s own header says so. So the second
 * copy is not left to be believed: `arithmetic.test.ts` next door runs both
 * implementations over generated rows and asserts they agree to the cent,
 * ungated. The right end state is one implementation in a module that holds no
 * SQL, and `src/lib/interchange/screen.ts` belongs to another worker for the
 * duration of this build; the drift test is what makes the interim safe rather
 * than merely tolerated.
 *
 * MONEY IS `bigint` MINOR UNITS THROUGHOUT. There is no division here except
 * the one that produces basis points, which is integer division on `bigint` and
 * is the same expression the lib uses.
 */

import type { PortfolioTotals, UnitEconomicsRow } from "@/lib/interchange/screen";

/**
 * Portfolio contribution, summed over the rows the table below it prints.
 *
 * Summed over exactly those rows, and not by a second query, so the header
 * cannot disagree with the table underneath it. `effectiveRateBps` is `null`
 * rather than zero when nothing settled: a take rate on no settlement is not
 * nought basis points, it is a rate that does not exist, and the screen renders
 * the two differently.
 */
export function portfolioTotals(rows: readonly UnitEconomicsRow[]): PortfolioTotals {
  let pricedSettlements = 0;
  let reversedSettlements = 0;
  let netSettledCents = 0n;
  let interchangeCents = 0n;
  let feeIncomeCents = 0n;
  let interestExpenseCents = 0n;
  let otherExpenseCents = 0n;
  let netContributionCents = 0n;

  for (const r of rows) {
    pricedSettlements += r.pricedSettlements;
    reversedSettlements += r.reversedSettlements;
    netSettledCents += r.netSettledCents;
    interchangeCents += r.interchangeCents;
    feeIncomeCents += r.feeIncomeCents;
    interestExpenseCents += r.interestExpenseCents;
    otherExpenseCents += r.otherExpenseCents;
    netContributionCents += r.netContributionCents;
  }

  return {
    businesses: rows.length,
    pricedSettlements,
    reversedSettlements,
    netSettledCents,
    interchangeCents,
    feeIncomeCents,
    interestExpenseCents,
    otherExpenseCents,
    netContributionCents,
    effectiveRateBps:
      netSettledCents > 0n ? (interchangeCents * 10_000n) / netSettledCents : null,
  };
}

/** Basis points as a percentage, to two places. Integer throughout; no float. */
export function formatBps(bps: number | bigint): string {
  const value = typeof bps === "bigint" ? bps : BigInt(Math.trunc(bps));
  const negative = value < 0n;
  const abs = (negative ? -value : value).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${abs.slice(0, -2)}.${abs.slice(-2)}%`;
}
