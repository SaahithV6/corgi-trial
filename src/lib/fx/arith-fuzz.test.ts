import { beforeAll, describe, expect, it } from "vitest";

import type { sql as SqlHandle } from "@/lib/ledger/db";

import { buyMinorUnits, costCents, customerRateScaled, feeCents, pow10 } from "./quote";

/**
 * A PROPERTY-BASED differential fuzzer for the FX arithmetic — the money
 * equivalent of `src/lib/holds/fuzz.test.ts`, following docs/FUZZ.md.
 *
 * ===========================================================================
 * WHY THIS EXISTS ALONGSIDE fx.integration.test.ts
 * ===========================================================================
 *
 * `fx.integration.test.ts` already runs a corpus through both copies of the
 * four formulas and asserts they agree digit for digit. That corpus is
 * hand-picked: ten amounts, five rates, two exponents. Hand-picked corpora
 * prove the cases somebody thought of.
 *
 * This file generates instead, and — this is the part that matters — it
 * generates over the range the SCHEMA allows rather than the range the
 * application currently uses:
 *
 *   - `sell_cents` up to 100000000000, which is the CHECK's own ceiling.
 *     The hand corpus stops at 90000000000.
 *   - `buy_exponent` across 0..6, which is the CHECK's own range.
 *     The hand corpus uses only {0, 2}, because CORRIDORS only has {0, 2}.
 *     A 3-exponent currency (KWD) or a 6-exponent one is storable today by
 *     anything that writes the table without going through `requireCorridor`.
 *
 * A GENERATED column is computed by the server on whatever a writer supplies,
 * so "the application would never send that" is not a property of the column.
 *
 * ===========================================================================
 * WHAT IT ASSERTS
 * ===========================================================================
 *
 *   1. TS and SQL agree digit for digit, or BOTH refuse. A disagreement and a
 *      one-sided refusal are equally defects: the screen prices a quote before
 *      anything is stored, so a divergence is a number shown to a customer
 *      that the database then declines to stand behind.
 *   2. The DESIGN §12 direction of every rounding is the disclosed one --
 *      fee UP, customer rate DOWN, delivery DOWN, settlement cost UP -- proved
 *      as an inequality against the exact rational, not against a second
 *      implementation of the same rounding.
 *   3. Overflow is LOUD. Where the product crosses bigint, Postgres must raise
 *      rather than wrap, and TypeScript (whose bigint is unbounded) must not
 *      silently return a value the column cannot hold.
 *
 * Reads only. Every function called here is IMMUTABLE and this file writes no
 * rows, opens no transaction and touches no seeded business.
 *
 * Gated on RUN_DB_TESTS=1, like every other suite that needs the real book:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/lib/fx/arith-fuzz
 */

const run = process.env["RUN_DB_TESTS"] === "1" ? describe : describe.skip;

let sql: typeof SqlHandle;

beforeAll(async () => {
  if (process.env["RUN_DB_TESTS"] !== "1") return;
  ({ sql } = await import("@/lib/ledger/db"));
});

/** The ceiling `fx_quote.sell_cents` actually CHECKs. */
const MAX_SELL_CENTS = 100_000_000_000n;
/** The range `fx_quote.buy_exponent` actually CHECKs. */
const MAX_BUY_EXPONENT = 6;
/** The widest value a Postgres bigint column can hold. */
const BIGINT_MAX = 9_223_372_036_854_775_807n;

/**
 * A seeded xorshift32, so a counterexample is reproducible from its seed
 * rather than lost with the process. Same bargain as the hold fuzzer.
 */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

interface Case {
  readonly sell: bigint;
  readonly flat: bigint;
  readonly bps: number;
  readonly spread: number;
  readonly mid: bigint;
  readonly scale: bigint;
  readonly exp: number;
}

/**
 * Values chosen to sit ON the boundaries rather than near them: one cent, the
 * half-cent of a 50bp fee, the CHECK ceilings, and the zero of every optional
 * charge.
 */
const SELL_POOL: readonly bigint[] = [
  1n, 2n, 3n, 50n, 99n, 100n, 101n, 150n, 199n, 200n, 201n, 250n, 999n, 1_000n,
  12_345n, 99_999_999n, 1_000_000_000n, MAX_SELL_CENTS - 1n, MAX_SELL_CENTS,
];
const FLAT_POOL: readonly bigint[] = [0n, 1n, 25n, 999n, 1_000_000n];
const FEE_BPS_POOL: readonly number[] = [0, 1, 25, 50, 137, 1_000];
const SPREAD_POOL: readonly number[] = [0, 1, 50, 137, 1_000];
const SCALE_POOL: readonly bigint[] = [100n, 10_000n, 100_000_000n];
const MID_POOL: readonly bigint[] = [
  1n, 99n, 512_470_000n, 1_694_350_000n, 15_418_000_000n, 9_999_999_999n,
];

function generate(count: number, seed: number): Case[] {
  const r = prng(seed);
  const pick = <T,>(pool: readonly T[]): T => pool[Math.floor(r() * pool.length)]!;
  const cases: Case[] = [];
  for (let i = 0; i < count; i += 1) {
    cases.push({
      sell: pick(SELL_POOL),
      flat: pick(FLAT_POOL),
      bps: pick(FEE_BPS_POOL),
      spread: pick(SPREAD_POOL),
      mid: pick(MID_POOL),
      scale: pick(SCALE_POOL),
      exp: Math.floor(r() * (MAX_BUY_EXPONENT + 1)),
    });
  }
  return cases;
}

/** Every (sell, feeBps) pair over the small amounts, so no tie is left to chance. */
function exhaustiveFeeBoundary(): Case[] {
  const cases: Case[] = [];
  for (const sell of SELL_POOL) {
    for (const bps of FEE_BPS_POOL) {
      for (const flat of FLAT_POOL) {
        cases.push({
          sell, flat, bps, spread: 0, mid: 1_694_350_000n, scale: 100_000_000n, exp: 2,
        });
      }
    }
  }
  return cases;
}

/** `null` when the implementation refused; the digits otherwise. */
type Outcome = { readonly ok: string } | { readonly refused: string };

async function fromSql(fn: string, args: readonly unknown[]): Promise<Outcome> {
  try {
    const rows = await sql.unsafe<{ v: bigint }[]>(
      `select ${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as v`,
      args as never[],
    );
    return { ok: String(rows[0]!.v) };
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The whole corpus in ONE round trip. Per-case queries are correct and far too
 * slow to be run often, and a fuzzer nobody runs is a fuzzer that finds
 * nothing. The corpus goes down as jsonb and comes back ordered, so row `i` is
 * case `i`.
 */
async function sqlBatch(
  expr: (c: string) => string,
  cases: readonly Case[],
): Promise<(string | null)[]> {
  const payload = cases.map((c) => ({
    sell: String(c.sell), flat: String(c.flat), bps: c.bps, spread: c.spread,
    mid: String(c.mid), scale: String(c.scale), exp: c.exp,
  }));
  const rows = await sql<{ i: number; v: bigint | null }[]>`
    SELECT ordinality::int - 1 AS i,
           ${sql.unsafe(expr("c"))} AS v
      FROM jsonb_array_elements(${sql.json(payload)}) WITH ORDINALITY AS t(c, ordinality)
     ORDER BY ordinality`;
  const out: (string | null)[] = new Array(cases.length).fill(null);
  for (const row of rows) out[row.i] = row.v === null ? null : String(row.v);
  return out;
}

/** Compare one batched SQL column against the TypeScript twin. */
function compare(
  cases: readonly Case[],
  theirs: readonly (string | null)[],
  ours: (c: Case) => Outcome,
): string[] {
  const disagreements: string[] = [];
  cases.forEach((c, i) => {
    const mine = ours(c);
    const yours = theirs[i];
    if ("ok" in mine) {
      if (yours === null) disagreements.push(`${describeCase(c)} :: ts=${mine.ok} pg=NULL`);
      else if (mine.ok !== yours) disagreements.push(`${describeCase(c)} :: ts=${mine.ok} pg=${yours}`);
    } else if (yours !== null) {
      disagreements.push(`${describeCase(c)} :: ts refused (${mine.refused}) pg=${yours}`);
    }
  });
  return disagreements;
}

function fromTs(compute: () => bigint): Outcome {
  try {
    return { ok: String(compute()) };
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
}

function describeCase(c: Case): string {
  return `sell=${c.sell} flat=${c.flat} feeBps=${c.bps} spread=${c.spread} mid=${c.mid} scale=${c.scale} exp=${c.exp}`;
}

run("the FX arithmetic, fuzzed against its own schema limits", () => {
  const CASES = [...generate(3_000, 0x9e37_79b9), ...exhaustiveFeeBoundary()];

  it("generates over the schema's range, not the corridor list's", () => {
    expect(CASES.length).toBeGreaterThan(3_000);
    expect(CASES.some((c) => c.sell === MAX_SELL_CENTS)).toBe(true);
    expect(CASES.some((c) => c.exp > 2)).toBe(true);
  });

  it("fx_fee_cents and feeCents agree digit for digit, or both refuse", async () => {
    const theirs = await sqlBatch(
      (c) => `fx_fee_cents((${c}->>'sell')::bigint, (${c}->>'flat')::bigint, (${c}->>'bps')::int)`,
      CASES,
    );
    const disagreements = compare(CASES, theirs, (c) =>
      fromTs(() => feeCents(c.sell, c.flat, c.bps)),
    );
    expect(disagreements.slice(0, 10)).toEqual([]);
  });

  it("fx_customer_rate and customerRateScaled agree digit for digit", async () => {
    const theirs = await sqlBatch(
      (c) => `fx_customer_rate((${c}->>'mid')::bigint, (${c}->>'spread')::int)`,
      CASES,
    );
    const disagreements = compare(CASES, theirs, (c) =>
      fromTs(() => customerRateScaled(c.mid, c.spread)),
    );
    expect(disagreements.slice(0, 10)).toEqual([]);
  });

  /**
   * Split by whether the exact product fits a bigint at all. The representable
   * ones must agree digit for digit; the rest are the overflow suite's
   * business, and are asserted there to be REFUSED rather than wrapped. A
   * single batch containing an overflowing case aborts the whole statement,
   * which is itself the loud failure we want -- but it would tell us nothing
   * about the other 3,000.
   */
  const tsBuyMinor = (c: Case): Outcome =>
    fromTs(() =>
      buyMinorUnits({
        netCents: c.sell - feeCents(c.sell, c.flat, c.bps),
        customerRateScaled: customerRateScaled(c.mid, c.spread),
        rateScale: c.scale,
        buyExponent: c.exp,
      }),
    );

  const representable = CASES.filter((c) => {
    const o = tsBuyMinor(c);
    return "ok" in o && BigInt(o.ok) >= 0n && BigInt(o.ok) <= BIGINT_MAX;
  });
  const overflowing = CASES.filter((c) => {
    const o = tsBuyMinor(c);
    return "ok" in o && BigInt(o.ok) > BIGINT_MAX;
  });

  it("the corpus straddles the bigint ceiling in both directions", () => {
    expect(representable.length).toBeGreaterThan(500);
    expect(overflowing.length).toBeGreaterThan(0);
  });

  it("fx_buy_minor and buyMinorUnits agree digit for digit where the result fits", async () => {
    const theirs = await sqlBatch(
      (c) => `fx_buy_minor((${c}->>'sell')::bigint, (${c}->>'flat')::bigint, (${c}->>'bps')::int,
                          (${c}->>'mid')::bigint, (${c}->>'spread')::int,
                          (${c}->>'scale')::bigint, (${c}->>'exp')::smallint)`,
      representable,
    );
    const disagreements = compare(representable, theirs, tsBuyMinor);
    expect(disagreements.slice(0, 10)).toEqual([]);
  });

  it("fx_cost_cents and costCents agree digit for digit", async () => {
    const subset = CASES.slice(0, 1_500).filter((c) => {
      const o = fromTs(() =>
        costCents({ buyMinor: c.sell, rateScaled: c.mid, rateScale: c.scale, buyExponent: c.exp }),
      );
      return "ok" in o && BigInt(o.ok) <= BIGINT_MAX;
    });
    const theirs = await sqlBatch(
      (c) => `fx_cost_cents((${c}->>'sell')::bigint, (${c}->>'mid')::bigint,
                           (${c}->>'scale')::bigint, (${c}->>'exp')::smallint)`,
      subset,
    );
    const disagreements = compare(subset, theirs, (c) =>
      fromTs(() =>
        costCents({ buyMinor: c.sell, rateScaled: c.mid, rateScale: c.scale, buyExponent: c.exp }),
      ),
    );
    expect(disagreements.slice(0, 10)).toEqual([]);
  });

  /**
   * The direction of each rounding, proved against the EXACT rational rather
   * than against a second implementation of the same rounding. `q` is the
   * integer answer; the assertion is that the exact value lies in the
   * half-open interval the disclosed direction claims.
   */
  it("every rounding goes the disclosed direction, against the exact rational", () => {
    for (const c of CASES) {
      // fee: flat + ceil(sell * bps / 10000)
      const feeNum = c.sell * BigInt(c.bps);
      const fee = feeCents(c.sell, c.flat, c.bps) - c.flat;
      expect(fee * 10_000n).toBeGreaterThanOrEqual(feeNum);
      expect((fee - 1n) * 10_000n).toBeLessThan(feeNum);

      // customer rate: floor(mid * (10000 - spread) / 10000)
      const rateNum = c.mid * BigInt(10_000 - c.spread);
      const rate = customerRateScaled(c.mid, c.spread);
      expect(rate * 10_000n).toBeLessThanOrEqual(rateNum);
      expect((rate + 1n) * 10_000n).toBeGreaterThan(rateNum);

      // delivery: floor(net * rate * 10^exp / (100 * scale))
      const net = c.sell - feeCents(c.sell, c.flat, c.bps);
      if (net < 0n) continue;
      const num = net * rate * pow10(c.exp);
      const den = 100n * c.scale;
      const minor = buyMinorUnits({
        netCents: net,
        customerRateScaled: rate,
        rateScale: c.scale,
        buyExponent: c.exp,
      });
      expect(minor * den).toBeLessThanOrEqual(num);
      expect((minor + 1n) * den).toBeGreaterThan(num);
    }
  });

  /**
   * The delivery amount is stored in a `bigint` column. TypeScript's bigint is
   * unbounded, so `buyMinorUnits` will happily return a number the column
   * cannot hold; the question is whether the database REFUSES it rather than
   * wrapping, and whether the pair can ever disagree about that.
   */
  it("a delivery amount past bigint is refused by Postgres, never wrapped", async () => {
    // sell at the CHECK ceiling, no fee, no spread, the widest exponent the
    // CHECK admits, and a scale of 100 -- all individually legal.
    const c: Case = {
      sell: MAX_SELL_CENTS, flat: 0n, bps: 0, spread: 0,
      mid: 9_999_999_999n, scale: 100n, exp: MAX_BUY_EXPONENT,
    };
    const ours = fromTs(() =>
      buyMinorUnits({
        netCents: c.sell,
        customerRateScaled: customerRateScaled(c.mid, c.spread),
        rateScale: c.scale,
        buyExponent: c.exp,
      }),
    );
    const theirs = await fromSql("fx_buy_minor", [
      c.sell, c.flat, c.bps, c.mid, c.spread, c.scale, c.exp,
    ]);

    // TypeScript computes it, because its bigint has no ceiling.
    expect("ok" in ours).toBe(true);
    if (!("ok" in ours)) return;
    expect(BigInt(ours.ok)).toBeGreaterThan(BIGINT_MAX);

    // Postgres must REFUSE, loudly. A wrap here would be a delivery
    // commitment of the wrong sign.
    expect("refused" in theirs).toBe(true);
    if ("refused" in theirs) {
      expect(theirs.refused).toMatch(/out of range/i);
    }
  });

  /**
   * Zero and one-minor-unit floors. A quote whose net converts to less than
   * one minor unit delivers ZERO, which is arithmetically right and
   * commercially a refusal the caller has to make -- asserted here so that if
   * the floor ever becomes a round, this fails.
   */
  it("a net that converts to under one minor unit floors to zero, both sides", async () => {
    const c: Case = {
      sell: 1n, flat: 0n, bps: 0, spread: 0,
      mid: 1n, scale: 100_000_000n, exp: 0,
    };
    const ours = buyMinorUnits({
      netCents: c.sell,
      customerRateScaled: customerRateScaled(c.mid, c.spread),
      rateScale: c.scale,
      buyExponent: c.exp,
    });
    const theirs = await fromSql("fx_buy_minor", [
      c.sell, c.flat, c.bps, c.mid, c.spread, c.scale, c.exp,
    ]);
    expect(ours).toBe(0n);
    expect(theirs).toEqual({ ok: "0" });
  });
});
