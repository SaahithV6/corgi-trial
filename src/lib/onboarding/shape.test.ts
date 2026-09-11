/**
 * THE DUPLICATION GUARD.
 *
 * `src/lib/ledger/chart.ts` is the source of truth for which rollups carry one
 * leaf per customer, and `accountsForBusiness()` is the function that names
 * them. A plpgsql function cannot import TypeScript, so
 * `db/migrations/0021_open_accounts.sql` seeds `per_business_rollup` with the
 * same three rows — and two copies of one fact is precisely the failure this
 * codebase keeps catching (0015's header is a whole essay about one).
 *
 * So the copy is checked rather than trusted. This suite reads the migration
 * off disk, parses its seed INSERT, and asserts three things against the chart:
 *
 *   1. the SAME rollup codes, no more and no fewer;
 *   2. in the SAME order the chart lists them, so a business's accounts open
 *      deposit-first;
 *   3. with leaf names that compose to exactly what `perBusinessAccountName()`
 *      produces, character for character.
 *
 * Add a fourth per-business rollup to `chart.ts` and this goes red until the
 * migration that opens it exists. No database, no network, no credentials —
 * which is what lets it run in CI, where the drift would otherwise first be
 * noticed by a customer with no memo account to hold their card's hold.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { accountsForBusiness, perBusinessAccountName } from "@/lib/ledger/chart";

import { leafNameSuffix, PER_BUSINESS_ROLLUPS } from "./types";

const MIGRATION = join(process.cwd(), "db", "migrations", "0021_open_accounts.sql");

type SeedRow = { readonly code: string; readonly leafName: string; readonly ordinal: number };

/**
 * Pull the `per_business_rollup` seed out of the migration text.
 *
 * Deliberately a narrow parse of the exact literal form the migration uses —
 * `('2100', 'business current account', '…', 1)` — rather than a general SQL
 * parser. If the migration is rewritten into a form this cannot read, the
 * expectation below that it found three rows fails, and a test that goes red
 * when it stops understanding its subject is the correct behaviour for a guard.
 * Silently parsing nothing and passing is the failure mode to avoid.
 */
function seededRollups(): readonly SeedRow[] {
  const sqlText = readFileSync(MIGRATION, "utf8");
  const start = sqlText.indexOf("INSERT INTO per_business_rollup");
  expect(start, "the migration no longer seeds per_business_rollup").toBeGreaterThan(-1);

  const statement = sqlText.slice(start, sqlText.indexOf(";", start));
  const rows: SeedRow[] = [];

  // ('<code>', '<leaf name>', '<why, which may contain '' escapes>', <ordinal>)
  const rowPattern = /\(\s*'(\d{4})'\s*,\s*'((?:[^']|'')*)'\s*,\s*'(?:[^']|'')*'\s*,\s*(\d+)\s*\)/g;
  for (const match of statement.matchAll(rowPattern)) {
    rows.push({
      code: match[1] ?? "",
      // Postgres escapes a quote by doubling it; undo that before comparing.
      leafName: (match[2] ?? "").replaceAll("''", "'"),
      ordinal: Number(match[3]),
    });
  }
  return rows;
}

describe("per_business_rollup agrees with the chart of accounts", () => {
  const seeded = seededRollups();

  it("seeds one row per chart rollup marked perBusiness, and no others", () => {
    expect(seeded.length).toBe(PER_BUSINESS_ROLLUPS.length);
    expect(seeded.map((row) => row.code)).toEqual(PER_BUSINESS_ROLLUPS.map((r) => r.code));
  });

  it("orders them the way the chart does, so the deposit leaf opens first", () => {
    // `ordinal` drives the FOR loop in business_accounts_open(). Chart order is
    // parents-first and deposit-before-memo; a business whose 9100 existed
    // before its 2100 would be a transient nobody has a use for.
    const byOrdinal = [...seeded].sort((a, b) => a.ordinal - b.ordinal);
    expect(byOrdinal.map((row) => row.code)).toEqual(PER_BUSINESS_ROLLUPS.map((r) => r.code));
    expect(byOrdinal[0]?.code).toBe("2100");
  });

  it("names each leaf exactly as perBusinessAccountName() would", () => {
    for (const row of seeded) {
      expect(row.leafName, `leaf name for rollup ${row.code}`).toBe(leafNameSuffix(row.code));
    }
  });

  it("composes the same full account name the migration builds in SQL", () => {
    // The migration writes `v_legal || ' — ' || r.leaf_name`. This is that
    // expression, in TypeScript, checked against the chart's own function for a
    // real legal name — including the one with a comma in it, because a name
    // that round-trips through string concatenation is worth proving once.
    const legalName = "Kettle & Crumb Bakery LLC";
    for (const row of seeded) {
      expect(`${legalName} — ${row.leafName}`).toBe(perBusinessAccountName(row.code, legalName));
    }
  });

  it("covers every account accountsForBusiness() says to open", () => {
    const businessId = "1151e7b5-b75b-5f58-bdbf-68cd714178ce";
    const wanted = accountsForBusiness(businessId).map((ref) => ref.code);
    expect(new Set(seeded.map((row) => row.code))).toEqual(new Set(wanted));
  });
});

describe("leafNameSuffix", () => {
  it("is the inverse of perBusinessAccountName for every per-business rollup", () => {
    for (const rollup of PER_BUSINESS_ROLLUPS) {
      const legalName = "Silverline Freight Co.";
      expect(`${legalName} — ${leafNameSuffix(rollup.code)}`).toBe(
        perBusinessAccountName(rollup.code, legalName),
      );
    }
  });

  it("throws rather than guess for a code the chart does not carry", () => {
    // `requireAccount()` refuses first, and that is the behaviour worth
    // pinning: a suffix invented for a code nobody charted would let the
    // migration and the chart name the same account two different things, and
    // the disagreement would first be visible as a customer's account having
    // the wrong label in their statement.
    expect(() => leafNameSuffix("9999")).toThrow(/no account '9999'/);
  });
});
