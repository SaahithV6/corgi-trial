import { beforeAll, describe, expect, it } from "vitest";

import type { sql as SqlHandle } from "@/lib/ledger/db";

import { buyMinorUnits, costCents, customerRateScaled, feeCents, priceQuote } from "./quote";
import type * as GateModule from "./gate";
import type * as StoreModule from "./store";
import { DEFAULT_FEE_BPS, DEFAULT_FEE_FLAT_CENTS, DEFAULT_SPREAD_BPS, RATE_SCALE } from "./types";

/**
 * The FX quote against the REAL Neon database.
 *
 * Gated on RUN_DB_TESTS=1 so CI — which holds no credentials, deliberately —
 * skips rather than fails. Run locally with:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/lib/fx
 *
 * Add RUN_LIVE_TESTS=1 to also call the real rate source in the same pass.
 *
 * ===========================================================================
 * THE FIVE CLAIMS THIS FILE EXISTS TO PROVE
 * ===========================================================================
 *
 *   1. THE TWO COPIES OF THE ARITHMETIC AGREE. `src/lib/fx/quote.ts` and the
 *      IMMUTABLE functions in 0017 are the same four formulas written twice,
 *      which is normally forbidden. This runs a corpus through both and
 *      asserts they agree digit for digit. That test is the entire
 *      justification for the duplication — the same bargain `aba.ts` strikes
 *      with `aba_checksum_ok()`.
 *
 *   2. AN EXPIRED QUOTE CANNOT BE ACCEPTED, AND THE DATABASE IS WHAT REFUSES
 *      IT. The INSERT is made directly against the table, with no application
 *      code in the way, so what is proved is the trigger.
 *
 *   3. ACCEPTANCE HAPPENS ONCE. The second one is a unique violation, not an
 *      overwrite.
 *
 *   4. THE COMMITMENT IS GENERATED, NOT SUPPLIED. There is no INSERT that
 *      stores a delivery amount which does not follow from the rate, because
 *      `buy_minor` is a GENERATED column and the server computes it.
 *
 *   5. NOTHING HERE POSTS TO THE JOURNAL. A quote is an offer and an
 *      acceptance is a commitment; neither is a transaction. The last suite
 *      counts journal entries before and after and asserts the count did not
 *      move.
 *
 * ===========================================================================
 * WHAT THIS SUITE WRITES, AND THE BUG THAT MADE THAT SENTENCE MATTER
 * ===========================================================================
 *
 * It used to say: "quotes, rate observations, acceptances and one settlement
 * on a seeded business, all carrying the run id. NO MONEY MOVES."
 *
 * That was true and it was not the point. Every one of those rows COMMITTED,
 * against the live production database, on every run. Eleven runs on
 * 2026-09-11 left 63 quotes, 63 rate observations, 28 acceptances and — this
 * is the one that mattered — SEVEN rows in `fx_quote_settlement`, each
 * carrying `tx_hash = '0x' + 'a'.repeat(64)` from the line below that used to
 * read `txHash: \`0x${"a".repeat(64)}\``.
 *
 * There have been eight settlements in this system's history. ONE is real:
 * `0x0acfad50…77d79e`, Base Sepolia block 46666112, 1.979521 USDC. So a reader
 * running `SELECT count(*) FROM fx_quote_settlement` got 8, checked one hash,
 * found it confirmed on chain, and had been handed the shape of a claim
 * nobody made. Nothing about that requires anyone to have been dishonest; it
 * only requires a test that writes to the book people read.
 *
 * SO: EVERY SCENARIO BELOW RUNS INSIDE A TRANSACTION THAT IS ROLLED BACK.
 * `rolledBack()` is the helper, and it is the shape
 * `src/lib/team/team.integration.test.ts` §9 introduced after the same bug
 * left orphan holds in the memo book.
 *
 * THERE IS EXACTLY ONE EXCEPTION AND IT IS NAMED WHERE IT HAPPENS: the expiry
 * control, in "THE CONTROL: the trigger refuses an acceptance past the
 * expiry". It cannot run inside a transaction, for a reason that is a fact
 * about Postgres rather than a preference — `now()` is
 * `transaction_timestamp()`, so it does not advance inside a transaction, so a
 * quote raised at T and expiring at T+1s can never be observed expired by any
 * statement in the same transaction. Proving a wall-clock control needs the
 * wall clock. That test therefore commits ONE quote per run, and pays for it
 * by MARKING IT — `fx_quote_fixture`, in the same transaction that writes it,
 * so there is no instant at which an unlabelled fixture is visible to
 * anybody. It cannot delete it instead: `fx_quote` is append-only at two
 * layers and that is the whole design.
 *
 * The last suite asserts the book is as it found it. If a scenario ever
 * escapes its transaction again, that is where it shows up.
 */

const run = process.env["RUN_DB_TESTS"] === "1" ? describe : describe.skip;
const live = process.env["RUN_LIVE_TESTS"] === "1" ? it : it.skip;

/** Seeded by `scripts/seed.mjs`; stable across resets. */
const RIDGELINE = "e274546d-6bdd-5266-b0fb-cc839a7811f9";
const KETTLE = "1151e7b5-b75b-5f58-bdbf-68cd714178ce";

const RUN_ID = `it-${Date.now().toString(36)}`;

/** USD/MXN as the live source printed it on 2026-09-10. */
const MXN_MID = 1_694_350_000n;

/** The one real settlement. docs/STABLECOIN.md, and Basescan. */
const REAL_TX_HASH = "0x0acfad50d866e99ce4db08f3c09a2c8ca1d2771fd00ebcb6b0678fb75777d79e";

/** A hash that is 64 repetitions of one hex digit is not a digest of anything. */
const PLACEHOLDER_HASH = /^0x([0-9a-f])\1{63}$/;

/**
 * `@/lib/ledger/db` validates the environment at import time, so importing it
 * statically would fail this file in CI. Everything that touches the database
 * is loaded in `beforeAll`, behind the same gate as the suites — the same
 * shape `payees.integration.test.ts` uses, for the same reason.
 */
let sql: typeof SqlHandle;
let store: typeof StoreModule;
let gate: typeof GateModule;

/** How many settlements were on file before this run. See the last suite. */
let settlementsAtStart = 0;

beforeAll(async () => {
  if (process.env["RUN_DB_TESTS"] !== "1") return;
  ({ sql } = await import("@/lib/ledger/db"));
  store = await import("./store");
  gate = await import("./gate");
  settlementsAtStart = (await store.loadSettlementBook()).length;
});

/* ========================================================================== */
/* The transaction machinery                                                  */
/* ========================================================================== */

/** What postgres.js hands a transaction body. Structural, to avoid the import. */
type Scoped = {
  savepoint: <T>(fn: (scoped: unknown) => Promise<T>) => Promise<T>;
  begin?: unknown;
};

/**
 * Give a transaction handle the `.begin()` that `src/lib/fx/store.ts` calls.
 *
 * THIS IS NOT DECORATION AND IT IS THE ONE THING IN THIS FILE WORTH READING
 * TWICE. `createQuote`, `acceptQuote` and `recordQuoteSettlement` each wrap
 * their writes in `conn.begin(...)`, which is right: a quote and the rate
 * observation it was priced from must land together or not at all. But
 * postgres.js only puts `begin` on the POOL object — look at `Object.assign`
 * in `postgres/src/index.js`, where `begin` sits alongside `listen` and `end`
 * and is not among the methods `Sql(handler)` gives a transaction scope. A
 * transaction handle gets `savepoint` instead.
 *
 * So `createQuote(input, tx)` throws `tx.begin is not a function`, and without
 * this shim the only way to run these scenarios inside a transaction would be
 * to stop calling the production functions and hand-write their INSERTs here
 * — which would mean this suite no longer tests the code that runs.
 *
 * `savepoint(fn)` and `begin(fn)` are the same function in that file
 * (`scope(c, fn, name)`), differing only in whether a savepoint name is
 * issued. A nested savepoint rolls back independently and leaves the outer
 * transaction usable, which is exactly the semantics `conn.begin` wants and is
 * verified by "refuses a settlement that does not add up" below: that INSERT
 * is refused by a trigger, and the transaction it happens inside carries on to
 * make four more assertions.
 *
 * The mutation is safe: `Sql(handler)` builds a fresh object per scope, so the
 * property is added to this transaction's handle and to nothing else.
 */
function nested(handle: unknown): typeof SqlHandle {
  const scoped = handle as Scoped;
  if (typeof scoped.begin !== "function") {
    scoped.begin = (first: unknown, second?: unknown) => {
      const body = (typeof first === "function" ? first : second) as (
        inner: unknown,
      ) => Promise<unknown>;
      return scoped.savepoint((inner) => Promise.resolve(body(nested(inner))));
    };
  }
  return handle as typeof SqlHandle;
}

const ROLLBACK = "fx-integration-rollback";

/**
 * Run a scenario against the live database and then throw it away.
 *
 * The rows exist, the triggers fire, the generated columns are computed by the
 * server and every assertion is made against real Postgres — and then the
 * transaction is rolled back and the book is exactly as it was. A fixture that
 * never exists outside this function cannot be read off a screen as a fact.
 *
 * `isolation` is passed through for the one suite that needs REPEATABLE READ;
 * see "a quote is not a transaction".
 */
async function rolledBack(
  body: (tx: typeof SqlHandle) => Promise<void>,
  isolation = "",
): Promise<void> {
  let failure: unknown = null;
  try {
    await sql.begin(isolation, async (tx) => {
      await body(nested(tx));
      throw new Error(ROLLBACK);
    });
  } catch (thrown) {
    // Anything that is not our own sentinel is a real failure — an assertion
    // that did not hold, or a statement the database refused. It rolled back
    // either way; rethrow it so the run goes red.
    if (!(thrown instanceof Error) || thrown.message !== ROLLBACK) failure = thrown;
  }
  if (failure !== null) throw failure;
}

/**
 * Assert a statement is REFUSED, inside a savepoint, so the surrounding
 * transaction survives to keep testing.
 *
 * `expect(...).rejects` on a bare `tx\`...\`` would leave the transaction in
 * the aborted state and every later statement in the scenario would fail with
 * "current transaction is aborted" — which reads like ten broken assertions
 * instead of one working control.
 */
async function expectRefusal(
  tx: typeof SqlHandle,
  statement: (scoped: typeof SqlHandle) => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let message: string | null = null;
  try {
    await (tx as unknown as Scoped).savepoint(async (scoped) => {
      await statement(scoped as typeof SqlHandle);
    });
  } catch (thrown) {
    message = thrown instanceof Error ? thrown.message : String(thrown);
  }
  expect(message, "the database ALLOWED it").not.toBeNull();
  expect(message ?? "").toMatch(pattern);
}

/** `JSON.stringify` cannot serialise a bigint, and every figure here is one. */
function describeResult(result: unknown): string {
  return JSON.stringify(result, (_key, value) =>
    typeof value === "bigint" ? `${value}n` : value,
  );
}

/**
 * A live observation shape, without calling anybody.
 *
 * The literal is DERIVED from the scaled integer rather than passed alongside
 * it. The first version took both and defaulted the literal to "16.9435" for
 * every currency, which put rows in the live database claiming the source had
 * printed a peso rate for a real — harmless to the assertions, and exactly the
 * kind of incoherent row that later gets read off a screen as a bug.
 */
function observation(rateScaled: bigint, currency = "MXN") {
  const whole = rateScaled / RATE_SCALE;
  const fraction = (rateScaled % RATE_SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return {
    source: "frankfurter.dev",
    evidence: "live" as const,
    baseCurrency: "USD",
    quoteCurrency: currency,
    rateScaled,
    rateScale: RATE_SCALE,
    literal: fraction === "" ? `${whole}` : `${whole}.${fraction}`,
    rateDate: "2026-09-10",
    fetchedAt: new Date().toISOString(),
    httpStatus: 200,
    fallbackReason: null,
  };
}

/* ========================================================================== */
/* 1. The two copies of the arithmetic agree                                  */
/* ========================================================================== */
/* Reads only: these call the IMMUTABLE functions in 0017 and write nothing.  */

run("the SQL and the TypeScript are the same four formulas", () => {
  /**
   * A corpus wide enough to catch a rounding disagreement: amounts that
   * straddle every rounding boundary, rates at both magnitudes we quote, both
   * minor-unit exponents, and fee and spread settings including the zero and
   * the ceiling.
   */
  const AMOUNTS = [1n, 99n, 100n, 101n, 999n, 1_000n, 12_345n, 100_000n, 999_999n, 90_000_000_000n];
  const RATES = [1_694_350_000n, 15_418_000_000n, 512_470_000n, 1n, 99_999_999n];
  const FEES: readonly (readonly [bigint, number])[] = [
    [0n, 0],
    [100n, 25],
    [1n, 1],
    [999n, 1000],
  ];
  const SPREADS = [0, 1, 50, 137, 1000];
  const EXPONENTS = [0, 2];

  it("fx_fee_cents agrees with feeCents, digit for digit", async () => {
    const cases = AMOUNTS.flatMap((sell) =>
      FEES.map(([flat, bps]) => ({ sell, flat, bps, ours: feeCents(sell, flat, bps) })),
    );
    const rows = await sql<{ i: number; theirs: bigint }[]>`
      SELECT ordinality::int - 1 AS i,
             fx_fee_cents((c->>'sell')::bigint, (c->>'flat')::bigint, (c->>'bps')::int) AS theirs
        FROM jsonb_array_elements(${sql.json(
          cases.map((c) => ({ sell: c.sell.toString(), flat: c.flat.toString(), bps: c.bps })),
        )}) WITH ORDINALITY AS t(c, ordinality)`;
    expect(rows).toHaveLength(cases.length);
    for (const row of rows) {
      expect(row.theirs, `case ${row.i}`).toBe(cases[row.i]?.ours);
    }
  });

  it("fx_customer_rate agrees with customerRateScaled", async () => {
    const cases = RATES.flatMap((mid) =>
      SPREADS.map((bps) => ({ mid, bps, ours: customerRateScaled(mid, bps) })),
    );
    const rows = await sql<{ i: number; theirs: bigint }[]>`
      SELECT ordinality::int - 1 AS i,
             fx_customer_rate((c->>'mid')::bigint, (c->>'bps')::int) AS theirs
        FROM jsonb_array_elements(${sql.json(
          cases.map((c) => ({ mid: c.mid.toString(), bps: c.bps })),
        )}) WITH ORDINALITY AS t(c, ordinality)`;
    for (const row of rows) {
      expect(row.theirs, `case ${row.i}`).toBe(cases[row.i]?.ours);
    }
  });

  it("fx_buy_minor agrees with buyMinorUnits across the whole corpus", async () => {
    const cases: {
      sell: bigint;
      flat: bigint;
      bps: number;
      mid: bigint;
      spread: number;
      exponent: number;
      ours: bigint;
    }[] = [];
    for (const sell of AMOUNTS) {
      for (const [flat, bps] of FEES) {
        for (const mid of RATES) {
          for (const spread of SPREADS) {
            for (const exponent of EXPONENTS) {
              const fee = feeCents(sell, flat, bps);
              // Below the fee there is nothing to convert; the schema refuses
              // such a quote for the same reason priceQuote throws.
              if (fee >= sell) continue;
              cases.push({
                sell,
                flat,
                bps,
                mid,
                spread,
                exponent,
                ours: buyMinorUnits({
                  netCents: sell - fee,
                  customerRateScaled: customerRateScaled(mid, spread),
                  rateScale: RATE_SCALE,
                  buyExponent: exponent,
                }),
              });
            }
          }
        }
      }
    }

    const rows = await sql<{ i: number; theirs: bigint }[]>`
      SELECT ordinality::int - 1 AS i,
             fx_buy_minor((c->>'sell')::bigint, (c->>'flat')::bigint, (c->>'bps')::int,
                          (c->>'mid')::bigint, (c->>'spread')::int,
                          ${RATE_SCALE}::bigint, (c->>'exponent')::smallint) AS theirs
        FROM jsonb_array_elements(${sql.json(
          cases.map((c) => ({
            sell: c.sell.toString(),
            flat: c.flat.toString(),
            bps: c.bps,
            mid: c.mid.toString(),
            spread: c.spread,
            exponent: c.exponent,
          })),
        )}) WITH ORDINALITY AS t(c, ordinality)`;

    expect(rows.length).toBeGreaterThan(500);
    for (const row of rows) {
      expect(row.theirs, `case ${row.i}: ${describeResult(cases[row.i])}`).toBe(cases[row.i]?.ours);
    }
  });

  it("fx_cost_cents agrees with costCents", async () => {
    const cases = RATES.filter((r) => r > 1_000n).flatMap((rate) =>
      [1n, 7n, 1_679_977n, 999_999_999n].flatMap((minor) =>
        EXPONENTS.map((exponent) => ({
          minor,
          rate,
          exponent,
          ours: costCents({ buyMinor: minor, rateScaled: rate, rateScale: RATE_SCALE, buyExponent: exponent }),
        })),
      ),
    );
    const rows = await sql<{ i: number; theirs: bigint }[]>`
      SELECT ordinality::int - 1 AS i,
             fx_cost_cents((c->>'minor')::bigint, (c->>'rate')::bigint,
                           ${RATE_SCALE}::bigint, (c->>'exponent')::smallint) AS theirs
        FROM jsonb_array_elements(${sql.json(
          cases.map((c) => ({ minor: c.minor.toString(), rate: c.rate.toString(), exponent: c.exponent })),
        )}) WITH ORDINALITY AS t(c, ordinality)`;
    for (const row of rows) {
      expect(row.theirs, `case ${row.i}`).toBe(cases[row.i]?.ours);
    }
  });
});

/* ========================================================================== */
/* 2, 3, 4. The controls                                                      */
/* ========================================================================== */

run("the quote, the offer and the commitment", () => {
  it("stores a commitment the database itself derived", async () => {
    await rolledBack(async (tx) => {
      const created = await store.createQuote(
        {
          businessId: RIDGELINE,
          buyCurrency: "MXN",
          sellCents: 100_000n,
          beneficiaryRef: `Guadalajara supplier ${RUN_ID}`,
          observation: observation(MXN_MID),
        },
        tx,
      );
      expect(created.ok, describeResult(created)).toBe(true);
      if (!created.ok) return;

      const quote = created.value;
      const priced = priceQuote({
        sellCents: 100_000n,
        buyCurrency: "MXN",
        midRateScaled: MXN_MID,
        feeFlatCents: DEFAULT_FEE_FLAT_CENTS,
        feeBps: DEFAULT_FEE_BPS,
        spreadBps: DEFAULT_SPREAD_BPS,
      });

      // The preview the screen showed and the row the database generated are
      // the same numbers. This is claim 1 again, end to end rather than formula
      // by formula.
      expect(quote.feeCents).toBe(priced.feeCents);
      expect(quote.customerRateScaled).toBe(priced.customerRateScaled);
      expect(quote.buyMinor).toBe(priced.buyMinor);
      expect(quote.netCents).toBe(priced.netCents);
      expect(quote.state).toBe("open");
      expect(quote.quoteRef).toMatch(/^FXQ-[0-9A-HJKMNP-TV-Z]{8}$/);

      // A quote raised by the application is not a fixture. The column exists
      // and it is false, rather than absent.
      expect(quote.isFixture).toBe(false);
      expect(quote.fixtureReason).toBeNull();
    });
  });

  it("refuses to let anyone store a delivery amount of their own choosing", async () => {
    // `buy_minor` is GENERATED ALWAYS. Not "the service computes it" — the
    // column cannot be written at all, by anybody, including the owner.
    //
    // On the pool rather than in a transaction, deliberately: the statement is
    // refused, so it writes nothing, and there is nothing to roll back.
    await expect(
      sql`
        INSERT INTO fx_quote (entity_id, business_id, quote_ref, sell_cents,
                              fee_flat_cents, fee_bps, spread_bps, observation_id,
                              mid_rate_scaled, rate_scale, buy_currency, buy_exponent,
                              beneficiary_ref, created_by, expires_at,
                              settlement_window_seconds, buy_minor)
        SELECT b.entity_id, b.id, 'FXQ-ZZZZZZZZ', 100000, 100, 25, 50, o.id,
               ${MXN_MID}, ${RATE_SCALE}, 'MXN', 2,
               'forged', a.id, now() + interval '2 minutes', 86400, 999999999
          FROM business b, fx_rate_observation o, actor a
         WHERE b.id = ${RIDGELINE}::uuid AND a.display_name = 'ledger-poster'
         LIMIT 1`,
    ).rejects.toThrow(/non-DEFAULT value into column "buy_minor"/);
  });

  it("accepts an open quote, once", async () => {
    await rolledBack(async (tx) => {
      const created = await store.createQuote(
        {
          businessId: RIDGELINE,
          buyCurrency: "PHP",
          sellCents: 250_000n,
          beneficiaryRef: `Manila contractor ${RUN_ID}`,
          observation: observation(6_257_600_000n, "PHP"),
        },
        tx,
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const first = await store.acceptQuote(
        { quoteRef: created.value.quoteRef, reference: `invoice-${RUN_ID}` },
        tx,
      );
      expect(first.ok, describeResult(first)).toBe(true);
      if (!first.ok) return;
      expect(first.value.state).toBe("accepted");
      expect(first.value.acceptedAt).not.toBeNull();
      expect(first.value.acceptanceReference).toBe(`invoice-${RUN_ID}`);
      // The commitment did not move when it was accepted. That is the point.
      expect(first.value.buyMinor).toBe(created.value.buyMinor);
      expect(first.value.customerRateScaled).toBe(created.value.customerRateScaled);

      const second = await store.acceptQuote({ quoteRef: created.value.quoteRef }, tx);
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.code).toBe("FX_QUOTE_ALREADY_ACCEPTED");
    });
  });

  /* ------------------------------------------------------------------------ */
  /* THE ONE SCENARIO THAT COMMITS                                            */
  /* ------------------------------------------------------------------------ */

  it("THE CONTROL: the trigger refuses an acceptance past the expiry", async () => {
    /**
     * THIS TEST COMMITS ONE QUOTE, ON PURPOSE, AND MARKS IT AS IT DOES.
     *
     * Everything else in this file runs inside a transaction that is thrown
     * away. This one cannot, and the reason is structural rather than a
     * preference:
     *
     *   `now()` IS `transaction_timestamp()`. It is fixed at the first
     *   statement of a transaction and does not advance. 0017 §4 relies on
     *   that and says so — "two statements in one transaction must agree on
     *   whether the offer was still open" — and it is the right clock for the
     *   trigger.
     *
     * The consequence for this test is absolute. `expires_at` is written as
     * `now() + ttl`, `fx_quote_acceptance.accepted_at` defaults to `now()`,
     * and `v_fx_quote.state` compares `now()` against `expires_at`. Inside one
     * transaction all three read the same instant, so `accepted_at` can never
     * exceed `expires_at` and the state can never become `expired`. A quote
     * that expires is a thing that happens BETWEEN transactions. Proving a
     * wall-clock control needs the wall clock.
     *
     * There is a version of this that stays inside a transaction: pass an
     * explicit `accepted_at` two seconds in the future and the trigger's first
     * branch fires. It proves the comparison and it does not prove the
     * FEATURE — not `v_fx_quote.state = 'expired'`, not the application's
     * translation to `FX_QUOTE_EXPIRED`, and not "the expired quote is still
     * on file afterwards", which is §5 of docs/FX.md in one assertion. The
     * control is worth a committed row; a weaker test is not.
     *
     * SO IT PAYS FOR THE ROW. It cannot delete it — `fx_quote` is append-only
     * at two layers and that is the design, not an obstacle — so it does the
     * append-only equivalent: `fx_quote_fixture`, written in the SAME
     * transaction as the quote, so there is no instant in which an unlabelled
     * fixture is visible on `/payouts` or in `v_fx_quote_settlement`.
     */
    const created = await sql.begin(async (raw) => {
      const tx = nested(raw);
      const quote = await store.createQuote(
        {
          businessId: RIDGELINE,
          buyCurrency: "MXN",
          sellCents: 50_000n,
          beneficiaryRef: `Expiry probe ${RUN_ID}`,
          observation: observation(MXN_MID),
          ttlSeconds: 1,
        },
        tx,
      );
      if (!quote.ok) return quote;

      const marked = await store.markQuoteAsFixture(
        {
          quoteRef: quote.value.quoteRef,
          source: "src/lib/fx/fx.integration.test.ts",
          reason:
            "The expiry control. It commits because now() does not advance inside a transaction, so a quote cannot be observed expired by any statement that raised it. No money was quoted, authorised or sent; the quote exists only to be refused.",
        },
        tx,
      );
      if (!marked.ok) return marked;
      return quote;
    });

    expect(created.ok, describeResult(created)).toBe(true);
    if (!created.ok) return;

    // Wait it out. One second plus a margin; the trigger reads the
    // transaction clock, and this is a new transaction every statement.
    await new Promise((resolve) => setTimeout(resolve, 1_600));

    const rows = await sql<{ state: string }[]>`
      SELECT state FROM v_fx_quote WHERE quote_ref = ${created.value.quoteRef}`;
    expect(rows[0]?.state).toBe("expired");

    // Straight at the table. No application code in the way, so what is being
    // proved is the trigger.
    await expect(
      sql`
        INSERT INTO fx_quote_acceptance (quote_id, accepted_by)
        SELECT ${created.value.quoteId}::uuid, a.id
          FROM actor a WHERE a.display_name = 'ledger-poster' LIMIT 1`,
    ).rejects.toThrow(/cannot be accepted at/);

    // And through the application, which translates rather than re-checks.
    const refused = await store.acceptQuote({ quoteRef: created.value.quoteRef });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("FX_QUOTE_EXPIRED");

    // The expired quote is still on file. Nothing was deleted or edited.
    const still = await store.loadQuoteByRef(created.value.quoteRef);
    expect(still?.state).toBe("expired");
    expect(still?.acceptedAt).toBeNull();

    // AND IT IS LABELLED. The row that had to survive says what it is, on the
    // row, where `/payouts` reads it — not in this comment.
    expect(still?.isFixture).toBe(true);
    expect(still?.fixtureSource).toBe("src/lib/fx/fx.integration.test.ts");
    expect(still?.fixtureReason).toMatch(/expiry control/);
  });

  it("refuses an UPDATE on a quote even as the owner", async () => {
    await rolledBack(async (tx) => {
      const created = await store.createQuote(
        {
          businessId: RIDGELINE,
          buyCurrency: "INR",
          sellCents: 75_000n,
          beneficiaryRef: `Bengaluru vendor ${RUN_ID}`,
          observation: observation(9_544_000_000n, "INR"),
        },
        tx,
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      await expectRefusal(
        tx,
        (scoped) =>
          scoped`UPDATE fx_quote SET beneficiary_ref = 'edited' WHERE id = ${created.value.quoteId}::uuid`,
        /append-only violation|permission denied/,
      );
      await expectRefusal(
        tx,
        (scoped) => scoped`DELETE FROM fx_quote WHERE id = ${created.value.quoteId}::uuid`,
        /append-only violation|permission denied/,
      );

      // And the marker is append-only for the same reason and by the same
      // mechanism: a label that can be quietly withdrawn is not a label.
      const marked = await store.markQuoteAsFixture(
        {
          quoteRef: created.value.quoteRef,
          source: "src/lib/fx/fx.integration.test.ts",
          reason: "Immutability probe; this whole scenario is rolled back.",
        },
        tx,
      );
      expect(marked.ok, describeResult(marked)).toBe(true);
      await expectRefusal(
        tx,
        (scoped) =>
          scoped`DELETE FROM fx_quote_fixture WHERE quote_id = ${created.value.quoteId}::uuid`,
        /append-only violation|permission denied/,
      );
    });
  });
});

/* ========================================================================== */
/* The gate                                                                   */
/* ========================================================================== */

run("the payout gate", () => {
  it("refuses a payout that names no quote at all", async () => {
    const refusal = await gate.requireAcceptedQuote({ quoteRef: null, amountUnits: 500_000n });
    expect(refusal?.code).toBe("FX_QUOTE_REQUIRED");
  });

  it("refuses a reference that matches nothing", async () => {
    const refusal = await gate.requireAcceptedQuote({
      quoteRef: "FXQ-00000000",
      amountUnits: 500_000n,
    });
    expect(refusal?.code).toBe("FX_QUOTE_NOT_FOUND");
  });

  it("refuses an open quote nobody has accepted — the headline code", async () => {
    await rolledBack(async (tx) => {
      const created = await store.createQuote(
        {
          businessId: RIDGELINE,
          buyCurrency: "MXN",
          sellCents: 100_000n,
          beneficiaryRef: `Unaccepted ${RUN_ID}`,
          observation: observation(MXN_MID),
        },
        tx,
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      // The gate is handed the SAME transaction. It reads through
      // `loadQuoteByRef`, so on the pool it would not see the uncommitted
      // quote and would answer FX_QUOTE_NOT_FOUND — a passing-looking test
      // that proved nothing.
      const refusal = await gate.requireAcceptedQuote(
        { quoteRef: created.value.quoteRef, amountUnits: 500_000n },
        tx,
      );
      expect(refusal?.code).toBe("FX_QUOTE_NOT_ACCEPTED");
    });
  });

  it("lets an accepted, unexpired quote through", async () => {
    await rolledBack(async (tx) => {
      const created = await store.createQuote(
        {
          businessId: RIDGELINE,
          buyCurrency: "MXN",
          sellCents: 100_000n,
          beneficiaryRef: `Accepted ${RUN_ID}`,
          observation: observation(MXN_MID),
          destinationAddress: "0x000000000000000000000000000000000000dEaD",
        },
        tx,
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const accepted = await store.acceptQuote({ quoteRef: created.value.quoteRef }, tx);
      expect(accepted.ok).toBe(true);

      const ok = await gate.requireAcceptedQuote(
        {
          quoteRef: created.value.quoteRef,
          amountUnits: 500_000n,
          toAddress: "0x000000000000000000000000000000000000DEAD",
          businessId: RIDGELINE,
        },
        tx,
      );
      expect(ok).toBeNull();

      // The same quote, the wrong recipient.
      const wrongTo = await gate.requireAcceptedQuote(
        {
          quoteRef: created.value.quoteRef,
          amountUnits: 500_000n,
          toAddress: "0x0000000000000000000000000000000000000001",
        },
        tx,
      );
      expect(wrongTo?.code).toBe("FX_QUOTE_MISMATCH");

      // The same quote, somebody else's money.
      const wrongCustomer = await gate.requireAcceptedQuote(
        {
          quoteRef: created.value.quoteRef,
          amountUnits: 500_000n,
          toAddress: "0x000000000000000000000000000000000000dEaD",
          businessId: KETTLE,
        },
        tx,
      );
      expect(wrongCustomer?.code).toBe("FX_QUOTE_MISMATCH");

      // More USDC than the customer authorised: $1,000.00 is 10,000,000,000
      // USDC units, so one unit past that is a refusal.
      const tooMuch = await gate.requireAcceptedQuote(
        {
          quoteRef: created.value.quoteRef,
          amountUnits: 10_000_000_001n,
          toAddress: "0x000000000000000000000000000000000000dEaD",
        },
        tx,
      );
      expect(tooMuch?.code).toBe("FX_QUOTE_MISMATCH");
    });
  });
});

/* ========================================================================== */
/* Settlement                                                                 */
/* ========================================================================== */
/*                                                                            */
/* THIS IS THE SUITE THAT WROTE THE SEVEN ROWS. It is unchanged in what it    */
/* asserts and completely changed in what it leaves behind: the settlements   */
/* below are written, checked and rolled back, so `fx_quote_settlement` does  */
/* not grow by one row per run any more.                                      */
/*                                                                            */
/* The placeholder hash is kept, and deliberately. It is the honest value for */
/* a settlement that never touched a chain, and since 0041 the database       */
/* REFUSES it — `fx_quote_settlement_tx_hash_not_placeholder`, because no     */
/* keccak-256 digest is 64 repetitions of one character. So the second test   */
/* below now proves the second layer as well: even if a future scenario       */
/* escapes its transaction, it cannot write this row.                         */
/* ========================================================================== */

run("settlement records what the commitment cost", () => {
  it("refuses a settlement that does not add up, and closes the quote", async () => {
    await rolledBack(async (tx) => {
      const created = await store.createQuote(
        {
          businessId: RIDGELINE,
          buyCurrency: "MXN",
          sellCents: 100_000n,
          beneficiaryRef: `Settled ${RUN_ID}`,
          observation: observation(MXN_MID),
        },
        tx,
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const quote = created.value;
      await store.acceptQuote({ quoteRef: quote.quoteRef }, tx);

      // The peso strengthened between acceptance and settlement: honouring the
      // commitment now costs more than the spread covers, and we eat it.
      const settlementMid = 1_650_000_000n;
      const position = gate.commitmentPosition(quote, settlementMid, RATE_SCALE);
      expect(position.varianceCents).toBeLessThan(0n);

      // A plausible hash, derived from the quote so two runs never collide.
      // It is not a real transaction and nothing here claims it is — but it is
      // the shape of one, and since 0041 the all-'a' placeholder this test
      // used to use is refused by a CHECK constraint.
      const txHash = `0x${quote.quoteId.replace(/-/g, "").padEnd(64, "0").slice(0, 64)}`;
      expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(txHash).not.toMatch(PLACEHOLDER_HASH);

      // A figure that does not satisfy the identity is refused by the trigger.
      const bogus = await store.recordQuoteSettlement(
        {
          quoteRef: quote.quoteRef,
          txHash,
          settlementMidRateScaled: settlementMid,
          settlementRateScale: RATE_SCALE,
          settlementCostCents: position.settlementCostCents,
          varianceCents: position.varianceCents + 1n,
        },
        tx,
      );
      expect(bogus.ok).toBe(false);
      if (!bogus.ok) expect(bogus.error.code).toBe("FX_SETTLEMENT_UNBALANCED");

      const settled = await store.recordQuoteSettlement(
        {
          quoteRef: quote.quoteRef,
          txHash,
          settlementMidRateScaled: settlementMid,
          settlementRateScale: RATE_SCALE,
          settlementCostCents: position.settlementCostCents,
          varianceCents: position.varianceCents,
        },
        tx,
      );
      expect(settled.ok, describeResult(settled)).toBe(true);
      if (!settled.ok) return;
      expect(settled.value.state).toBe("settled");
      expect(settled.value.varianceCents).toBe(position.varianceCents);

      // And once only.
      const again = await store.recordQuoteSettlement(
        {
          quoteRef: quote.quoteRef,
          txHash: `0x${"b".repeat(63)}1`,
          settlementMidRateScaled: settlementMid,
          settlementRateScale: RATE_SCALE,
          settlementCostCents: position.settlementCostCents,
          varianceCents: position.varianceCents,
        },
        tx,
      );
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.error.code).toBe("FX_QUOTE_ALREADY_SETTLED");

      // The gate now refuses the spent quote.
      const spent = await gate.requireAcceptedQuote(
        { quoteRef: quote.quoteRef, amountUnits: 500_000n },
        tx,
      );
      expect(spent?.code).toBe("FX_QUOTE_ALREADY_SETTLED");
    });
  });

  it("THE SECOND LAYER: the database refuses a placeholder transaction hash", async () => {
    /**
     * The real fix for the seven rows is the rollback above. This is the
     * belt: a transaction hash is keccak-256 of the signed transaction's own
     * bytes, and no digest of anything is 64 repetitions of one character. So
     * `0x` + 'a'×64 — the literal this file used to write — is refused by the
     * schema, regardless of what any test does with its transactions.
     *
     * 0041 adds it NOT VALID, because the seven rows that already exist fail
     * it and an append-only table cannot be repaired. NOT VALID weakens
     * nothing for new rows, which is what this asserts.
     */
    await rolledBack(async (tx) => {
      const created = await store.createQuote(
        {
          businessId: RIDGELINE,
          buyCurrency: "MXN",
          sellCents: 100_000n,
          beneficiaryRef: `Placeholder probe ${RUN_ID}`,
          observation: observation(MXN_MID),
        },
        tx,
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const quote = created.value;
      await store.acceptQuote({ quoteRef: quote.quoteRef }, tx);

      const position = gate.commitmentPosition(quote, MXN_MID, RATE_SCALE);
      const refused = await store.recordQuoteSettlement(
        {
          quoteRef: quote.quoteRef,
          txHash: `0x${"a".repeat(64)}`,
          settlementMidRateScaled: MXN_MID,
          settlementRateScale: RATE_SCALE,
          settlementCostCents: position.settlementCostCents,
          varianceCents: position.varianceCents,
        },
        tx,
      );
      expect(refused.ok, "the database ACCEPTED a placeholder hash").toBe(false);

      // Nothing landed: the quote is still accepted, not settled.
      const after = await store.loadQuoteByRef(quote.quoteRef, tx);
      expect(after?.state).toBe("accepted");
    });
  });

  it("refuses a settlement against a quote nobody accepted", async () => {
    await rolledBack(async (tx) => {
      const created = await store.createQuote(
        {
          businessId: RIDGELINE,
          buyCurrency: "MXN",
          sellCents: 100_000n,
          beneficiaryRef: `Never accepted ${RUN_ID}`,
          observation: observation(MXN_MID),
        },
        tx,
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const refused = await store.recordQuoteSettlement(
        {
          quoteRef: created.value.quoteRef,
          txHash: `0x${"c".repeat(63)}1`,
          settlementMidRateScaled: MXN_MID,
          settlementRateScale: RATE_SCALE,
          settlementCostCents: 99_000n,
          varianceCents: 100_000n - created.value.feeCents - 99_000n,
        },
        tx,
      );
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("FX_QUOTE_NOT_ACCEPTED");
    });
  });
});

/* ========================================================================== */
/* The ledger did not move                                                    */
/* ========================================================================== */

run("a quote is not a transaction", () => {
  it("writes not one journal entry, in the whole of this feature", async () => {
    /**
     * REPEATABLE READ, and it is what makes this assertion mean anything.
     *
     * Under READ COMMITTED each statement takes a fresh snapshot, so a journal
     * entry committed by anything else — another agent, a cron, the demo
     * script — lands between the two counts and fails a test about THIS code.
     * Under REPEATABLE READ the snapshot is fixed at the first statement and
     * the only writes the second count can see are this transaction's own.
     *
     * So "the count did not move" stops meaning "the database was quiet" and
     * starts meaning "we wrote nothing", which is the claim.
     */
    await rolledBack(async (tx) => {
      const before = await tx<{ n: bigint }[]>`SELECT count(*) AS n FROM journal_entry`;

      const created = await store.createQuote(
        {
          businessId: RIDGELINE,
          buyCurrency: "BRL",
          sellCents: 500_000n,
          beneficiaryRef: `Sao Paulo studio ${RUN_ID}`,
          observation: observation(512_470_000n, "BRL"),
        },
        tx,
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      await store.acceptQuote({ quoteRef: created.value.quoteRef }, tx);

      const after = await tx<{ n: bigint }[]>`SELECT count(*) AS n FROM journal_entry`;
      expect(after[0]?.n).toBe(before[0]?.n);
    }, "isolation level repeatable read");
  });

  it("holds no non-USD amount anywhere the ledger can see it", async () => {
    // The delivery amount lives on exactly one column of one table. If a
    // second currency has leaked into the journal, this finds it.
    const rows = await sql<{ currency: string }[]>`
      SELECT DISTINCT currency FROM journal_line`;
    expect(rows.map((r) => r.currency)).toEqual(["USD"]);
  });
});

/* ========================================================================== */
/* The book is as this suite found it                                         */
/* ========================================================================== */

run("this suite leaves the settlement book alone", () => {
  /**
   * The regression test for the bug this file caused.
   *
   * Everything above either rolls back or marks what it commits. If a future
   * edit breaks that — a `sql` where a `tx` was meant, a scenario that forgets
   * the wrapper — the settlement count moves and this fails with the number.
   */
  it("recorded no settlement of its own", async () => {
    const book = await store.loadSettlementBook();
    expect(
      book.length,
      `the suite added ${book.length - settlementsAtStart} settlement(s) to the live book`,
    ).toBe(settlementsAtStart);
  });

  it("every settlement on file is either real or labelled", async () => {
    const book = await store.loadSettlementBook();
    for (const settlement of book) {
      if (PLACEHOLDER_HASH.test(settlement.txHash)) {
        // An impossible hash. It must be marked, or `/payouts` is printing a
        // transaction reference that resolves nowhere with nothing to say so.
        expect(settlement.isFixture, `${settlement.quoteRef} carries a placeholder hash`).toBe(
          true,
        );
        expect(settlement.fixtureSource).not.toBeNull();
        expect(settlement.fixtureReason).not.toBeNull();
      } else if (!settlement.isFixture) {
        // Not marked, so it is claiming to be real. Then it must look real:
        // a plausible hash, and a journal entry that actually exists —
        // `hasEntry` comes from the FK into `journal_entry`, not from the
        // settlement's own claim to have posted.
        expect(settlement.txHash, `${settlement.quoteRef}`).toMatch(/^0x[0-9a-f]{64}$/);
        expect(settlement.hasEntry, `${settlement.quoteRef} claims to be real with no entry`).toBe(
          true,
        );
      }
    }
  });

  it("the one real settlement is on file, unmarked, with its entry", async () => {
    // docs/STABLECOIN.md and docs/FX.md §11 both quote this transaction. If it
    // ever stops matching, one of the three is wrong and this says which.
    const book = await store.loadSettlementBook();
    const real = book.find((s) => s.txHash === REAL_TX_HASH);
    expect(real, "the Base Sepolia payout is missing from fx_quote_settlement").toBeDefined();
    expect(real?.isFixture).toBe(false);
    expect(real?.hasEntry).toBe(true);
    expect(real?.settlementCostCents).toBe(198n);
    expect(real?.varianceCents).toBe(1n);
  });
});

/* ========================================================================== */
/* The live rate source                                                       */
/* ========================================================================== */

run("the rate source, for real", () => {
  live("answers 200 and prints a plain decimal we can scale by hand", async () => {
    const { fetchMidRate, frankfurterUrl } = await import("./rate");
    const observed = await fetchMidRate("MXN");
    expect(observed.evidence).toBe("live");
    expect(observed.httpStatus).toBe(200);
    expect(observed.rateScaled).toBeGreaterThan(0n);
    // The integer is re-derivable from the characters the source printed.
    const [whole, fraction = ""] = observed.literal.split(".");
    expect(observed.rateScaled).toBe(BigInt(`${whole}${fraction.padEnd(8, "0").slice(0, 8)}`));
    expect(frankfurterUrl(["MXN"])).toContain("frankfurter.dev");
  });
});
