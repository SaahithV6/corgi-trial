import { beforeAll, describe, expect, it } from "vitest";

import type { sql as SqlHandle } from "@/lib/ledger/db";

import {
  BPS_DENOMINATOR,
  interchangeForNet,
  priceSettlement,
  roundHalfEven,
  roundingOf,
} from "./rate-card";

/**
 * A PROPERTY-BASED differential fuzzer for the INTERCHANGE arithmetic — the
 * twin of `src/lib/fx/arith-fuzz.test.ts`, following docs/FUZZ.md.
 *
 * ===========================================================================
 * WHY THIS EXISTS ALONGSIDE rate-card.test.ts AND interchange.integration.test.ts
 * ===========================================================================
 *
 * `rate-card.test.ts` proves the pure functions against hand-picked numbers —
 * the fuel card, the CNP card, the two ties at 125 bps. `interchange.integration
 * .test.ts` books real settlements and lets `interchange_posting_arithmetic`
 * refuse anything it disagrees with. Both are corpora somebody thought of.
 *
 * This file generates, and it generates over the range the SCHEMA allows
 * rather than the range the rate card uses:
 *
 *   - `interchange_posting.settled_cents` is `bigint NOT NULL CHECK
 *     (settled_cents <> 0)`. That is the WHOLE bigint line, both signs, minus
 *     one point. It is not bounded by a ticket size, by a card limit, or by
 *     anything else. The seeded corpus stops around $100k.
 *   - `rate_bps` is `CHECK (rate_bps BETWEEN 0 AND 10000)`. The card seeds six
 *     values between 100 and 190; 0 and 10000 are both storable today.
 *   - `fixed_cents` is `CHECK (fixed_cents BETWEEN 0 AND 10000)` — up to $100
 *     per transaction, not the 5c and 10c the card happens to carry.
 *
 * `interchange_ad_valorem_cents`, `interchange_cents` and
 * `interchange_natural_cents` are IMMUTABLE functions callable by anything
 * with `EXECUTE`, and the CHECK that guards the table calls them on whatever a
 * writer supplies. "The booking path would never send that" is not a property
 * of a column, and it is not a property of a function either.
 *
 * ===========================================================================
 * WHICH DESIGN §12 CLAUSE IS BEING ASSERTED, AND WHICH IS DELIBERATELY NOT
 * ===========================================================================
 *
 * §12 is `research/ledger/DESIGN.md` §12. There is no `docs/DESIGN.md`.
 *
 *   §12.2 — single value → single cent amount, round HALF TO EVEN. This is the
 *           clause interchange is under, and every rounding assertion below is
 *           an assertion about it.
 *   §12.3 — largest-remainder for one amount split across N lines. THIS CLAUSE
 *           DOES NOT APPLY HERE and `rate-card.ts` says so at length: §12.3's
 *           precondition is a SOURCE AMOUNT being distributed across shares
 *           that must add back up to it, and interchange has no source to
 *           distribute. So this file does NOT assert that a month of
 *           per-settlement prices sums to the price of the month's total —
 *           that property is FALSE, it is *supposed* to be false, and it is
 *           asserted false below with its exact bound, so that nobody
 *           "discovers" it later and files it as a defect.
 *   §12.6 — sub-cent dust to `2900`. Also not engaged: the dropped fraction
 *           never arrived as money. Asserted below as an absence, on the real
 *           book, rather than as a claim in a comment.
 *
 * Money is integer minor units. A float anywhere is a defect, so the corpus is
 * swept for one rather than the header being trusted.
 *
 * Reads only. No row is written, no transaction is opened, nothing seeded is
 * touched. Gated on RUN_DB_TESTS=1:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/lib/interchange/arith-fuzz
 */

const run = process.env["RUN_DB_TESTS"] === "1" ? describe : describe.skip;

let sql: typeof SqlHandle;

beforeAll(async () => {
  if (process.env["RUN_DB_TESTS"] !== "1") return;
  ({ sql } = await import("@/lib/ledger/db"));
});

/** The range `interchange_posting.rate_bps` actually CHECKs. */
const MAX_RATE_BPS = 10_000;
/** The range `interchange_posting.fixed_cents` actually CHECKs. */
const MAX_FIXED_CENTS = 10_000n;
/** The widest value a Postgres bigint column can hold. */
const BIGINT_MAX = 9_223_372_036_854_775_807n;
/** And the narrowest. `abs()` of this one has no bigint answer. */
const BIGINT_MIN = -9_223_372_036_854_775_808n;

/** A seeded xorshift32, so a counterexample survives the process. */
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
  /** SIGNED, and never zero: exactly what the column admits. */
  readonly settled: bigint;
  readonly bps: number;
  readonly fixed: bigint;
}

/**
 * Magnitudes chosen to sit ON the boundaries rather than near them: the ties
 * at 125 bps, the one-cent floor, the amounts either side of a rounding
 * decision, and the CHECK's own ceiling — which for this column is the bigint
 * line itself.
 */
const MAGNITUDE_POOL: readonly bigint[] = [
  1n, 2n, 3n, 4n, 5n, 7n, 39n, 40n, 49n, 50n, 51n, 99n, 100n, 101n,
  120n, 200n, 201n, 400n, 600n, 601n, 999n, 1_000n, 4_000n, 7_340n,
  12_345n, 99_999n, 1_234_567n, 99_999_999n, 1_000_000_000n,
  9_999_999_999n, 999_999_999_999n,
  // The schema's own ceiling, and its neighbourhood. Nothing in the book is
  // this big; nothing in the column forbids it.
  BIGINT_MAX / 10_001n, BIGINT_MAX / 10_000n, BIGINT_MAX / 10_000n + 1n,
  BIGINT_MAX - 1n, BIGINT_MAX,
];
const BPS_POOL: readonly number[] = [
  0, 1, 5, 100, 125, 130, 145, 165, 190, 250, 1_000, 5_000, 9_999, MAX_RATE_BPS,
];
const FIXED_POOL: readonly bigint[] = [0n, 1n, 5n, 10n, 25n, 9_999n, MAX_FIXED_CENTS];

function generate(count: number, seed: number): Case[] {
  const r = prng(seed);
  const pick = <T,>(pool: readonly T[]): T => pool[Math.floor(r() * pool.length)]!;
  const cases: Case[] = [];
  for (let i = 0; i < count; i += 1) {
    const magnitude = pick(MAGNITUDE_POOL);
    cases.push({
      // BOTH SIGNS. A refund is a settlement too, and the sign is the one
      // thing the price is NOT allowed to be a function of.
      settled: r() < 0.5 ? magnitude : -magnitude,
      bps: pick(BPS_POOL),
      fixed: pick(FIXED_POOL),
    });
  }
  return cases;
}

/**
 * Every (magnitude, bps) pair, both signs, at a zero fixed fee — so no tie in
 * the ad-valorem half is left to the generator's luck. The fixed component is
 * held at zero here on purpose: it is an integer added AFTER the rounding, so
 * it cannot move a tie, and holding it at zero is what makes that claim
 * falsifiable rather than decorative.
 */
function exhaustiveRoundingBoundary(): Case[] {
  const cases: Case[] = [];
  for (const magnitude of MAGNITUDE_POOL) {
    for (const bps of BPS_POOL) {
      cases.push({ settled: magnitude, bps, fixed: 0n });
      cases.push({ settled: -magnitude, bps, fixed: 0n });
    }
  }
  return cases;
}

/** `null` when the implementation refused; the digits otherwise. */
type Outcome = { readonly ok: string } | { readonly refused: string };

function fromTs(compute: () => bigint | string): Outcome {
  try {
    return { ok: String(compute()) };
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
}

async function fromSql(expr: string, args: readonly unknown[]): Promise<Outcome> {
  try {
    const rows = await sql.unsafe<{ v: unknown }[]>(`select (${expr}) as v`, args as never[]);
    return { ok: String(rows[0]!.v) };
  } catch (error) {
    return { refused: error instanceof Error ? error.message : String(error) };
  }
}

function describeCase(c: Case): string {
  return `settled=${c.settled} bps=${c.bps} fixed=${c.fixed}`;
}

/** The magnitude the price is taken on. Unbounded in TypeScript, on purpose. */
function magnitudeOf(c: Case): bigint {
  return c.settled > 0n ? c.settled : -c.settled;
}

/**
 * The whole corpus in ONE round trip. Per-case queries are correct and far too
 * slow to run often, and a fuzzer nobody runs is a fuzzer that finds nothing.
 * The corpus goes down as jsonb and comes back ordered, so row `i` is case `i`.
 */
async function sqlBatch(
  expr: (c: string) => string,
  cases: readonly Case[],
): Promise<(string | null)[]> {
  const payload = cases.map((c) => ({
    settled: String(c.settled),
    bps: c.bps,
    fixed: String(c.fixed),
  }));
  const rows = await sql<{ i: number; v: unknown }[]>`
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

/** `(c->>'settled')::bigint`, spelled once. */
const S = (c: string) => `(${c}->>'settled')::bigint`;
const B = (c: string) => `(${c}->>'bps')::int`;
const F = (c: string) => `(${c}->>'fixed')::bigint`;

/**
 * The `interchange_posting_arithmetic` CHECK, evaluated in Postgres against
 * the numbers TypeScript computed — every conjunct, in the order the
 * constraint states them. This is the strongest form of the differential: it
 * does not ask "do the two agree about one function", it asks "would the
 * database ACCEPT the row this module would have written". No row is
 * inserted; the predicate is evaluated on a jsonb literal.
 */
async function sqlCheckBatch(cases: readonly Case[]): Promise<(boolean | null)[]> {
  const payload = cases.map((c) => {
    const a = priceSettlement(magnitudeOf(c), { rateBps: c.bps, fixedCents: c.fixed });
    return {
      settled: String(c.settled),
      bps: c.bps,
      fixed: String(c.fixed),
      num: String(a.numerator),
      den: String(a.denominator),
      whole: String(a.wholeCents),
      rem: String(a.remainderUnits),
      rounding: a.rounding,
      adv: String(a.adValoremCents),
      ic: String(a.interchangeCents),
      dir: c.settled > 0n ? "earned" : "returned",
    };
  });
  const rows = await sql<{ i: number; v: boolean | null }[]>`
    SELECT ordinality::int - 1 AS i,
           (    (c->>'den')::bigint      = 10000
            AND (c->>'num')::bigint      = abs((c->>'settled')::bigint) * (c->>'bps')::int::bigint
            AND (c->>'whole')::bigint    = (c->>'num')::bigint / (c->>'den')::bigint
            AND (c->>'rem')::bigint      = (c->>'num')::bigint % (c->>'den')::bigint
            AND (c->>'rounding')::interest_rounding
                                         = interest_rounding_of((c->>'num')::bigint, (c->>'den')::bigint)
            AND (c->>'adv')::bigint      = interchange_ad_valorem_cents((c->>'settled')::bigint, (c->>'bps')::int)
            AND (c->>'ic')::bigint       = public.interchange_cents((c->>'settled')::bigint,
                                                                    (c->>'bps')::int,
                                                                    (c->>'fixed')::bigint)
            AND (c->>'dir')::interchange_direction
                                         = interchange_direction_of((c->>'settled')::bigint)
            AND (c->>'adv')::bigint      = (c->>'whole')::bigint + CASE
                                              WHEN 2 * (c->>'rem')::bigint > (c->>'den')::bigint THEN 1
                                              WHEN 2 * (c->>'rem')::bigint < (c->>'den')::bigint THEN 0
                                              ELSE (c->>'whole')::bigint % 2
                                            END
           ) AS v
      FROM jsonb_array_elements(${sql.json(payload)}) WITH ORDINALITY AS t(c, ordinality)
     ORDER BY ordinality`;
  const out: (boolean | null)[] = new Array(cases.length).fill(null);
  for (const row of rows) out[row.i] = row.v;
  return out;
}

/**
 * The repair decision, as a shape rather than as a story. `book.ts` computes
 * it in TypeScript; `v_interchange_drift` computes it in SQL; the header of
 * `book.ts` claims the two "cannot drift apart". That claim is testable.
 */
interface DriftCase {
  readonly booked: bigint;
  readonly net: bigint;
  readonly bps: number;
  readonly fixed: bigint;
}

function generateDrift(count: number, seed: number): DriftCase[] {
  const r = prng(seed);
  const pick = <T,>(pool: readonly T[]): T => pool[Math.floor(r() * pool.length)]!;
  const NET_POOL: readonly bigint[] = [
    0n, 1n, -1n, 5n, -5n, 99n, -99n, 7_340n, -7_340n, 1_234_567n, -1_234_567n,
    999_999_999_999n, -999_999_999_999n,
  ];
  const BOOKED_POOL: readonly bigint[] = [0n, 1n, -1n, 111n, -111n, 2_346n, -2_346n];
  const out: DriftCase[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      booked: pick(BOOKED_POOL),
      net: pick(NET_POOL),
      bps: pick(BPS_POOL),
      fixed: pick(FIXED_POOL),
    });
  }
  return out;
}

run("the interchange arithmetic, fuzzed against its own schema limits", () => {
  const CASES: readonly Case[] = [
    ...generate(3_000, 0x9e37_79b9),
    ...exhaustiveRoundingBoundary(),
  ];

  /**
   * The cases whose exact numerator fits a bigint at all. The rest are the
   * overflow suite's business, and are asserted there to be REFUSED rather
   * than wrapped. One overflowing case in a batch aborts the whole statement —
   * which is itself the loud failure we want, and would tell us nothing about
   * the other 3,900.
   */
  const representable = CASES.filter((c) => magnitudeOf(c) * BigInt(c.bps) <= BIGINT_MAX);
  const overflowing = CASES.filter((c) => magnitudeOf(c) * BigInt(c.bps) > BIGINT_MAX);

  it("generates over the SCHEMA's range, not the rate card's", () => {
    expect(CASES.length).toBeGreaterThan(3_000);
    // Both signs: a refund is a settlement, and the sign is the one thing the
    // price must not be a function of.
    expect(CASES.some((c) => c.settled > 0n)).toBe(true);
    expect(CASES.some((c) => c.settled < 0n)).toBe(true);
    expect(CASES.every((c) => c.settled !== 0n)).toBe(true);
    // The CHECK's own endpoints, not the card's.
    expect(CASES.some((c) => c.bps === 0)).toBe(true);
    expect(CASES.some((c) => c.bps === MAX_RATE_BPS)).toBe(true);
    expect(CASES.some((c) => c.fixed === MAX_FIXED_CENTS)).toBe(true);
    // And amounts the seeded book has never seen, because the column admits
    // them: `settled_cents` is bounded by bigint and by nothing else.
    expect(CASES.some((c) => magnitudeOf(c) === BIGINT_MAX)).toBe(true);
    expect(representable.length).toBeGreaterThan(1_000);
    expect(overflowing.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 1. The four IMMUTABLE functions, digit for digit
  // -------------------------------------------------------------------------

  it("interchange_ad_valorem_cents and priceSettlement agree digit for digit", async () => {
    const theirs = await sqlBatch((c) => `interchange_ad_valorem_cents(${S(c)}, ${B(c)})`, representable);
    const disagreements = compare(representable, theirs, (c) =>
      fromTs(
        () => priceSettlement(magnitudeOf(c), { rateBps: c.bps, fixedCents: 0n }).adValoremCents,
      ),
    );
    expect(disagreements.slice(0, 10)).toEqual([]);
  });

  it("interchange_cents and priceSettlement agree digit for digit", async () => {
    const theirs = await sqlBatch(
      (c) => `public.interchange_cents(${S(c)}, ${B(c)}, ${F(c)})`,
      representable,
    );
    const disagreements = compare(representable, theirs, (c) =>
      fromTs(
        () =>
          priceSettlement(magnitudeOf(c), { rateBps: c.bps, fixedCents: c.fixed })
            .interchangeCents,
      ),
    );
    expect(disagreements.slice(0, 10)).toEqual([]);
  });

  /**
   * THE ONE THAT MATTERS FOR `book.ts`. `interchangeForNet()` is the single
   * definition of "what is this settlement worth right now" on the TypeScript
   * side; `interchange_natural_cents()` is the same definition on the SQL
   * side, and `v_interchange_drift` is built out of it. If these two ever
   * disagree, the hook repairs a settlement the invariant thinks is fine, or
   * the invariant fires at something the hook will not repair.
   */
  it("interchange_natural_cents and interchangeForNet agree digit for digit, signed", async () => {
    const theirs = await sqlBatch(
      (c) => `interchange_natural_cents(${S(c)}, ${B(c)}, ${F(c)})`,
      representable,
    );
    const disagreements = compare(representable, theirs, (c) =>
      fromTs(
        () => interchangeForNet(c.settled, { rateBps: c.bps, fixedCents: c.fixed }).naturalCents,
      ),
    );
    expect(disagreements.slice(0, 10)).toEqual([]);
  });

  it("interest_rounding_of and roundingOf name the same one of the four cases", async () => {
    const theirs = await sqlBatch(
      (c) => `interest_rounding_of(abs(${S(c)}) * ${B(c)}::bigint, 10000::bigint)::text`,
      representable,
    );
    const disagreements = compare(representable, theirs, (c) =>
      fromTs(() => roundingOf(magnitudeOf(c) * BigInt(c.bps), BPS_DENOMINATOR)),
    );
    expect(disagreements.slice(0, 10)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 2. The CHECK constraint itself
  // -------------------------------------------------------------------------

  /**
   * Nine conjuncts, evaluated by Postgres on the numbers this module computes.
   * A `false` here is a row `insertPosting()` would have been refused on.
   */
  it("every conjunct of interchange_posting_arithmetic holds on what TypeScript computed", async () => {
    const verdicts = await sqlCheckBatch(representable);
    const rejected: string[] = [];
    representable.forEach((c, i) => {
      if (verdicts[i] !== true) rejected.push(`${describeCase(c)} :: check=${String(verdicts[i])}`);
    });
    expect(rejected.slice(0, 10)).toEqual([]);
  });

  /**
   * `interchange_cents > 0` is a COLUMN check, not part of the arithmetic
   * conjunction, and it is the reason `reconcileSettlement()` has a
   * `zero_value` arm at all. The arm and the constraint must agree exactly on
   * which settlements are unstorable — otherwise the hook either posts a row
   * Postgres refuses, or declines to post one it would have accepted.
   */
  it("the zero_value arm names exactly the prices the column would refuse", async () => {
    const theirs = await sqlBatch(
      (c) => `(public.interchange_cents(${S(c)}, ${B(c)}, ${F(c)}) > 0)::text`,
      representable,
    );
    const mismatches: string[] = [];
    representable.forEach((c, i) => {
      const priced = priceSettlement(magnitudeOf(c), { rateBps: c.bps, fixedCents: c.fixed });
      const tsWouldPost = priced.interchangeCents !== 0n;
      const pgWouldAccept = theirs[i] === "true";
      if (tsWouldPost !== pgWouldAccept) {
        mismatches.push(`${describeCase(c)} :: ts posts=${tsWouldPost} pg accepts=${pgWouldAccept}`);
      }
    });
    expect(mismatches.slice(0, 10)).toEqual([]);
    // And the case exists in the corpus, so this is not vacuous: 0 bps with no
    // fixed fee prices every settlement at nothing.
    expect(representable.some((c) => c.bps === 0 && c.fixed === 0n)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 3. DESIGN §12.2, against the exact rational
  // -------------------------------------------------------------------------

  /**
   * The direction of the rounding proved against the EXACT rational rather
   * than against a second implementation of the same rounding. The ad-valorem
   * cent is within half a cent of `N/D` — `|adv*D - N| <= D/2` — and on an
   * exact tie it is the EVEN cent, which is the entire content of §12.2.
   */
  it("the ad-valorem cent is the nearest cent, and every tie goes to the even one", () => {
    let ties = 0;
    let tiesUp = 0;
    for (const c of representable) {
      const magnitude = magnitudeOf(c);
      const n = magnitude * BigInt(c.bps);
      const d = BPS_DENOMINATOR;
      const adv = roundHalfEven(n, d);
      const error = adv * d - n; // signed, in ten-thousandths of a cent
      const absError = error < 0n ? -error : error;
      expect(2n * absError).toBeLessThanOrEqual(d);
      if (2n * (n % d) === d) {
        ties += 1;
        expect(adv % 2n).toBe(0n);
        if (adv * d > n) tiesUp += 1;
      }
    }
    // Not vacuous, and NOT one-directional: half-up would send every tie the
    // same way, which is the bias §12.2 exists to remove.
    expect(ties).toBeGreaterThan(0);
    expect(tiesUp).toBeGreaterThan(0);
    expect(tiesUp).toBeLessThan(ties);
  });

  /**
   * The fixed component is added AFTER the rounding and is already an integer
   * number of cents, so it cannot move a rounding decision. Proved by holding
   * the amount and rate fixed and sweeping the fee across the CHECK's range.
   */
  it("the fixed component never moves a rounding decision", () => {
    for (const c of representable.slice(0, 400)) {
      const base = priceSettlement(magnitudeOf(c), { rateBps: c.bps, fixedCents: 0n });
      for (const fixed of FIXED_POOL) {
        const withFee = priceSettlement(magnitudeOf(c), { rateBps: c.bps, fixedCents: fixed });
        expect(withFee.adValoremCents).toBe(base.adValoremCents);
        expect(withFee.rounding).toBe(base.rounding);
        expect(withFee.remainderUnits).toBe(base.remainderUnits);
        expect(withFee.interchangeCents).toBe(base.adValoremCents + fixed);
      }
    }
  });

  /**
   * The sign is carried by `direction`, never by the division. A refund is
   * priced at the same magnitude as the purchase it reverses, so the two sum
   * to exactly zero — which is what makes a fully refunded purchase cost the
   * book nothing, with no arm and no special case.
   */
  it("a purchase and its refund sum to exactly zero interchange, both sides", async () => {
    const pairs = representable.slice(0, 800);
    const theirs = await sqlBatch(
      (c) =>
        `(interchange_natural_cents(${S(c)}, ${B(c)}, ${F(c)})
          + interchange_natural_cents(-${S(c)}, ${B(c)}, ${F(c)}))`,
      pairs,
    );
    const bad: string[] = [];
    pairs.forEach((c, i) => {
      const rate = { rateBps: c.bps, fixedCents: c.fixed };
      const sum =
        interchangeForNet(c.settled, rate).naturalCents +
        interchangeForNet(-c.settled, rate).naturalCents;
      if (sum !== 0n || theirs[i] !== "0") {
        bad.push(`${describeCase(c)} :: ts=${sum} pg=${theirs[i]}`);
      }
    });
    expect(bad.slice(0, 10)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 4. DESIGN §12.3, asserted NON-APPLICABLE rather than quietly assumed
  // -------------------------------------------------------------------------

  /**
   * §12.3 is largest-remainder, and its precondition is a SOURCE AMOUNT being
   * distributed across shares that must add back up to it. Interchange has no
   * source to distribute: each settlement is priced on its own, and the month
   * is the SUM of those prices, not a division of anything.
   *
   * So the tempting invariant — "a month of interchange equals the price of
   * the month's total spend" — is FALSE, and it is supposed to be. It is
   * asserted false here, with its exact bound, so that the next person to
   * notice the gap reads this test instead of filing a defect. The bound is
   * the honest statement of the same fact: half a cent of rounding per
   * settlement, plus one fixed fee per settlement beyond the first.
   */
  it("a month of prices does NOT equal the price of the month's total — §12.3 does not apply", () => {
    const rate = { rateBps: 165, fixedCents: 10n };
    const month = representable
      .filter((c) => magnitudeOf(c) <= 1_000_000_000n)
      .slice(0, 500)
      .map(magnitudeOf);
    expect(month.length).toBeGreaterThan(100);

    const sumOfPrices = month.reduce(
      (acc, m) => acc + priceSettlement(m, rate).interchangeCents,
      0n,
    );
    const total = month.reduce((acc, m) => acc + m, 0n);
    const priceOfTotal = priceSettlement(total, rate).interchangeCents;

    // They differ, and that is CORRECT. Asserting equality here is the failure
    // a §12.3 reading would have manufactured.
    expect(sumOfPrices).not.toBe(priceOfTotal);

    // And the difference is exactly accounted for: at most half a cent of
    // rounding per settlement, plus the fixed fee each settlement carries and
    // the aggregate does not.
    const n = BigInt(month.length);
    const roundingSlack = (n + 1n) / 2n + 1n;
    const fixedSlack = (n - 1n) * rate.fixedCents;
    const delta = sumOfPrices - priceOfTotal;
    const absDelta = delta < 0n ? -delta : delta;
    expect(absDelta).toBeLessThanOrEqual(roundingSlack + fixedSlack);
  });

  /**
   * The positive half of the same statement, which IS the invariant the book
   * holds: the total is the sum of independently priced settlements, and
   * nothing redistributes a penny between them. Summation is associative over
   * integers, so this is exactly as strong as it looks — and it is what makes
   * `v_interchange_drift` able to reason one settlement at a time.
   */
  it("the aggregate is the sum of per-settlement prices, with no penny moved", async () => {
    const subset = representable.slice(0, 1_000);
    const theirs = await sqlBatch(
      (c) => `interchange_natural_cents(${S(c)}, ${B(c)}, ${F(c)})`,
      subset,
    );
    const sqlTotal = theirs.reduce<bigint>((acc, v) => acc + BigInt(v ?? "0"), 0n);
    const tsTotal = subset.reduce<bigint>(
      (acc, c) =>
        acc + interchangeForNet(c.settled, { rateBps: c.bps, fixedCents: c.fixed }).naturalCents,
      0n,
    );
    expect(tsTotal).toBe(sqlTotal);
  });

  // -------------------------------------------------------------------------
  // 5. DESIGN §12.6 — the dust that is not dust
  // -------------------------------------------------------------------------

  /**
   * §12.6 sends sub-cent dust to `2900 Rounding residual clearing`, because
   * USDC dust ARRIVED as real money with more precision than a cent and
   * truncating it would break the identity between customer balances and our
   * obligation. An interchange fraction never arrived — it is precision that
   * was never claimed — so `2900` must not be engaged, and the dropped
   * fraction is carried on the row instead of being posted anywhere.
   */
  it("the dropped fraction is bounded, recorded, and reconstructs the exact value", () => {
    for (const c of representable) {
      const a = priceSettlement(magnitudeOf(c), { rateBps: c.bps, fixedCents: c.fixed });
      expect(a.denominator).toBe(BPS_DENOMINATOR);
      expect(a.remainderUnits).toBeGreaterThanOrEqual(0n);
      expect(a.remainderUnits).toBeLessThan(a.denominator);
      // The row states its own fraction: whole cents and remainder rebuild the
      // numerator exactly, so nothing was lost, only left unrounded.
      expect(a.wholeCents * a.denominator + a.remainderUnits).toBe(a.numerator);
      // And the rounding moved the answer by at most one cent from the floor.
      expect(a.adValoremCents - a.wholeCents === 0n || a.adValoremCents - a.wholeCents === 1n).toBe(
        true,
      );
    }
  });

  it("NO interchange entry has ever touched 2900, on the real book", async () => {
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM interchange_posting ip
        JOIN journal_line l ON l.entry_id = ip.entry_id
        JOIN account a      ON a.id = l.account_id
       WHERE a.code = '2900'`;
    expect(rows[0]?.n ?? 0).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 6. No float, anywhere
  // -------------------------------------------------------------------------

  /**
   * Money is integer minor units. A `number` holding cents is a defect even
   * when the value happens to be exact today, because the defect is the type,
   * not the value — so this sweeps every field of every case rather than
   * spot-checking the seven amounts `rate-card.test.ts` checks.
   */
  it("every money field is a bigint and every SQL answer is an integer string", async () => {
    for (const c of representable) {
      const a = priceSettlement(magnitudeOf(c), { rateBps: c.bps, fixedCents: c.fixed });
      for (const [name, v] of Object.entries(a)) {
        if (name === "rounding") continue;
        expect(typeof v).toBe("bigint");
      }
      const natural = interchangeForNet(c.settled, { rateBps: c.bps, fixedCents: c.fixed });
      expect(typeof natural.naturalCents).toBe("bigint");
    }
    // And the SQL side: a `numeric` or a `double precision` creeping into any
    // of the three functions would come back with a decimal point or an
    // exponent. Every answer must be a bare integer.
    const theirs = await sqlBatch(
      (c) => `public.interchange_cents(${S(c)}, ${B(c)}, ${F(c)})`,
      representable.slice(0, 1_000),
    );
    const notIntegers = theirs.filter((v) => v === null || !/^-?\d+$/.test(v));
    expect(notIntegers.slice(0, 5)).toEqual([]);
    // Belt and braces: ask Postgres what type it actually returned.
    const typed = await sql<{ t: string }[]>`
      SELECT pg_typeof(public.interchange_cents(7340::bigint, 165, 10::bigint))::text AS t`;
    expect(typed[0]?.t).toBe("bigint");
  });

  // -------------------------------------------------------------------------
  // 7. Overflow is LOUD
  // -------------------------------------------------------------------------

  /**
   * `settled_cents` is bounded by bigint and by nothing else, and `rate_bps`
   * reaches 10000. Their product does NOT fit a bigint over most of that
   * range. TypeScript's bigint is unbounded, so `priceSettlement` will happily
   * return a number the column cannot hold; the question is whether Postgres
   * REFUSES rather than wraps, because a wrapped interchange figure is revenue
   * of the wrong sign on a balancing entry that no existing invariant inspects.
   */
  it("a numerator past bigint is refused by Postgres, never wrapped", async () => {
    const c: Case = { settled: BIGINT_MAX, bps: MAX_RATE_BPS, fixed: 0n };
    const ours = fromTs(
      () => priceSettlement(magnitudeOf(c), { rateBps: c.bps, fixedCents: c.fixed }).numerator,
    );
    expect("ok" in ours).toBe(true);
    if (!("ok" in ours)) return;
    expect(BigInt(ours.ok)).toBeGreaterThan(BIGINT_MAX);

    const theirs = await fromSql("public.interchange_cents($1::bigint, $2::int, $3::bigint)", [
      c.settled,
      c.bps,
      c.fixed,
    ]);
    expect("refused" in theirs).toBe(true);
    if ("refused" in theirs) expect(theirs.refused).toMatch(/out of range/i);
  });

  /**
   * The one value in the column's range whose MAGNITUDE has no bigint answer.
   * `abs(-9223372036854775808)` overflows, so even a zero-rate card cannot
   * price it; TypeScript computes the magnitude without complaint. Recorded
   * here as the exact boundary of the parity, not as a defect: the database
   * refuses loudly, which is the behaviour asked for.
   */
  it("bigint's own floor is priceable in TypeScript and refused by Postgres", async () => {
    const magnitude = -BIGINT_MIN;
    expect(magnitude).toBeGreaterThan(BIGINT_MAX);
    const theirs = await fromSql("interchange_ad_valorem_cents($1::bigint, $2::int)", [
      BIGINT_MIN,
      1,
    ]);
    expect("refused" in theirs).toBe(true);
    if ("refused" in theirs) expect(theirs.refused).toMatch(/out of range/i);
  });

  it("the overflow frontier is exactly where the arithmetic says it is", async () => {
    // One below and one above the last representable numerator at 10000 bps.
    const justFits: Case = { settled: BIGINT_MAX / 10_000n, bps: MAX_RATE_BPS, fixed: 0n };
    const justDoesNot: Case = { settled: BIGINT_MAX / 10_000n + 1n, bps: MAX_RATE_BPS, fixed: 0n };
    expect(magnitudeOf(justFits) * BigInt(justFits.bps)).toBeLessThanOrEqual(BIGINT_MAX);
    expect(magnitudeOf(justDoesNot) * BigInt(justDoesNot.bps)).toBeGreaterThan(BIGINT_MAX);

    const ok = await fromSql("public.interchange_cents($1::bigint, $2::int, $3::bigint)", [
      justFits.settled,
      justFits.bps,
      justFits.fixed,
    ]);
    expect("ok" in ok).toBe(true);
    if ("ok" in ok) {
      expect(ok.ok).toBe(
        String(
          priceSettlement(magnitudeOf(justFits), {
            rateBps: justFits.bps,
            fixedCents: justFits.fixed,
          }).interchangeCents,
        ),
      );
    }

    const no = await fromSql("public.interchange_cents($1::bigint, $2::int, $3::bigint)", [
      justDoesNot.settled,
      justDoesNot.bps,
      justDoesNot.fixed,
    ]);
    expect("refused" in no).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 8. `book.ts` — the repair decision, against the invariant that reports it
  // -------------------------------------------------------------------------

  /**
   * `book.ts` decides to repair when "the journal disagrees with what the
   * settlement is now worth"; `v_interchange_drift` reports a settlement when
   * `booked IS DISTINCT FROM interchange_natural_cents(net, bps, fixed)`. The
   * header claims these "cannot drift apart". Fuzzed here over booked/net
   * pairs the schema admits, including the zero net that is the whole trap.
   */
  it("book.ts's repair condition and v_interchange_drift's WHERE are the same predicate", async () => {
    const drift = generateDrift(1_500, 0x5eed_1ce5);
    const payload = drift.map((d) => ({
      booked: String(d.booked),
      net: String(d.net),
      bps: d.bps,
      fixed: String(d.fixed),
    }));
    const rows = await sql<{ i: number; v: boolean }[]>`
      SELECT ordinality::int - 1 AS i,
             ((c->>'booked')::bigint IS DISTINCT FROM
              interchange_natural_cents((c->>'net')::bigint, (c->>'bps')::int, (c->>'fixed')::bigint))
             AS v
        FROM jsonb_array_elements(${sql.json(payload)}) WITH ORDINALITY AS t(c, ordinality)
       ORDER BY ordinality`;
    const theirs: (boolean | null)[] = new Array(drift.length).fill(null);
    for (const row of rows) theirs[row.i] = row.v;

    const mismatches: string[] = [];
    drift.forEach((d, i) => {
      // The arithmetic half of `needsRepair`, verbatim from book.ts.
      const expected = interchangeForNet(d.net, { rateBps: d.bps, fixedCents: d.fixed });
      const mine = d.booked !== expected.naturalCents;
      if (mine !== theirs[i]) {
        mismatches.push(
          `booked=${d.booked} net=${d.net} bps=${d.bps} fixed=${d.fixed} :: ts=${mine} pg=${theirs[i]}`,
        );
      }
    });
    expect(mismatches.slice(0, 10)).toEqual([]);

    // Not vacuous in either direction.
    expect(theirs.some((v) => v === true)).toBe(true);
    expect(theirs.some((v) => v === false)).toBe(true);
    // And the trap is in the corpus: a settlement corrected to zero is worth
    // zero interchange, so anything booked against it is drift.
    expect(drift.some((d) => d.net === 0n && d.booked !== 0n)).toBe(true);
  });

  /**
   * `needsRepair` is deliberately a SUPERSET of the drift condition — it also
   * fires when the settlement was reversed and the `interchange_reversal`
   * audit row is missing, which is the state `v_interchange_unreversed`
   * reports and the state that was actually observed on this book. Stated as a
   * test so the superset is a decision rather than an accident.
   */
  it("needsRepair is the drift condition OR the missing-paperwork condition, never less", () => {
    const needsRepair = (
      booked: bigint,
      expected: bigint,
      settlementReversed: boolean,
      repaired: boolean,
    ): boolean => booked !== expected || (settlementReversed && !repaired);

    for (const d of generateDrift(400, 0xbeef_cafe)) {
      const expected = interchangeForNet(d.net, { rateBps: d.bps, fixedCents: d.fixed })
        .naturalCents;
      const drifted = d.booked !== expected;
      for (const settlementReversed of [false, true]) {
        for (const repaired of [false, true]) {
          const repair = needsRepair(d.booked, expected, settlementReversed, repaired);
          // Superset: every drifting case is repaired, whatever the paperwork.
          if (drifted) expect(repair).toBe(true);
          // And the extra arm fires only on the paperwork state, never at random.
          if (!drifted) expect(repair).toBe(settlementReversed && !repaired);
        }
      }
    }
  });

  /**
   * `interchange_direction_of(0)` answers `earned`; `interchangeForNet(0)`
   * answers `null`. That is a real difference in the two vocabularies and it
   * is unreachable through the column — `CHECK (settled_cents <> 0)` — but it
   * is reachable through the FUNCTION, which anything with EXECUTE may call.
   * Pinned here so a future caller reads the boundary instead of finding it.
   */
  it("the two direction vocabularies agree everywhere the column can reach", async () => {
    const theirs = await sqlBatch((c) => `interchange_direction_of(${S(c)})::text`, representable);
    const mismatches: string[] = [];
    representable.forEach((c, i) => {
      const mine = interchangeForNet(c.settled, { rateBps: c.bps, fixedCents: c.fixed }).direction;
      if (mine !== theirs[i]) mismatches.push(`${describeCase(c)} :: ts=${mine} pg=${theirs[i]}`);
    });
    expect(mismatches.slice(0, 10)).toEqual([]);

    // And the one place they do NOT agree, stated rather than hidden.
    expect(interchangeForNet(0n, { rateBps: 165, fixedCents: 10n }).direction).toBeNull();
    const atZero = await sql<{ d: string }[]>`
      SELECT interchange_direction_of(0::bigint)::text AS d`;
    expect(atZero[0]?.d).toBe("earned");
  });
});

