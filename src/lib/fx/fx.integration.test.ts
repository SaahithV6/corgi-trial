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
 * ---------------------------------------------------------------------------
 * What this suite writes: quotes, rate observations, acceptances and one
 * settlement on a seeded business, all carrying the run id. NO MONEY MOVES.
 */

const run = process.env["RUN_DB_TESTS"] === "1" ? describe : describe.skip;
const live = process.env["RUN_LIVE_TESTS"] === "1" ? it : it.skip;

/** Seeded by `scripts/seed.mjs`; stable across resets. */
const RIDGELINE = "e274546d-6bdd-5266-b0fb-cc839a7811f9";
const KETTLE = "1151e7b5-b75b-5f58-bdbf-68cd714178ce";

const RUN_ID = `it-${Date.now().toString(36)}`;

/** USD/MXN as the live source printed it on 2026-09-10. */
const MXN_MID = 1_694_350_000n;

/**
 * `@/lib/ledger/db` validates the environment at import time, so importing it
 * statically would fail this file in CI. Everything that touches the database
 * is loaded in `beforeAll`, behind the same gate as the suites — the same
 * shape `payees.integration.test.ts` uses, for the same reason.
 */
let sql: typeof SqlHandle;
let store: typeof StoreModule;
let gate: typeof GateModule;

beforeAll(async () => {
  if (process.env["RUN_DB_TESTS"] !== "1") return;
  ({ sql } = await import("@/lib/ledger/db"));
  store = await import("./store");
  gate = await import("./gate");
});

/** `JSON.stringify` cannot serialise a bigint, and every figure here is one. */
function describeResult(result: unknown): string {
  return JSON.stringify(result, (_key, value) =>
    typeof value === "bigint" ? `${value}n` : value,
  );
}

/** A live observation shape, without calling anybody. */
function observation(rateScaled: bigint, currency = "MXN") {
  return {
    source: "frankfurter.dev",
    evidence: "live" as const,
    baseCurrency: "USD",
    quoteCurrency: currency,
    rateScaled,
    rateScale: RATE_SCALE,
    literal: "16.9435",
    rateDate: "2026-09-10",
    fetchedAt: new Date().toISOString(),
    httpStatus: 200,
    fallbackReason: null,
  };
}

/* ========================================================================== */
/* 1. The two copies of the arithmetic agree                                  */
/* ========================================================================== */

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
    const created = await store.createQuote({
      businessId: RIDGELINE,
      buyCurrency: "MXN",
      sellCents: 100_000n,
      beneficiaryRef: `Guadalajara supplier ${RUN_ID}`,
      observation: observation(MXN_MID),
    });
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
  });

  it("refuses to let anyone store a delivery amount of their own choosing", async () => {
    // `buy_minor` is GENERATED ALWAYS. Not "the service computes it" — the
    // column cannot be written at all, by anybody, including the owner.
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
    const created = await store.createQuote({
      businessId: RIDGELINE,
      buyCurrency: "PHP",
      sellCents: 250_000n,
      beneficiaryRef: `Manila contractor ${RUN_ID}`,
      observation: observation(6_257_600_000n, "PHP"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await store.acceptQuote({
      quoteRef: created.value.quoteRef,
      reference: `invoice-${RUN_ID}`,
    });
    expect(first.ok, describeResult(first)).toBe(true);
    if (!first.ok) return;
    expect(first.value.state).toBe("accepted");
    expect(first.value.acceptedAt).not.toBeNull();
    expect(first.value.acceptanceReference).toBe(`invoice-${RUN_ID}`);
    // The commitment did not move when it was accepted. That is the point.
    expect(first.value.buyMinor).toBe(created.value.buyMinor);
    expect(first.value.customerRateScaled).toBe(created.value.customerRateScaled);

    const second = await store.acceptQuote({ quoteRef: created.value.quoteRef });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("FX_QUOTE_ALREADY_ACCEPTED");
  });

  it("THE CONTROL: the trigger refuses an acceptance past the expiry", async () => {
    // A quote with the shortest TTL the schema allows a caller to express.
    const created = await store.createQuote({
      businessId: RIDGELINE,
      buyCurrency: "MXN",
      sellCents: 50_000n,
      beneficiaryRef: `Expiry probe ${RUN_ID}`,
      observation: observation(MXN_MID),
      ttlSeconds: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Wait it out. One second plus a margin; the trigger reads the
    // transaction clock, not ours.
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
  });

  it("refuses an UPDATE on a quote even as the owner", async () => {
    const created = await store.createQuote({
      businessId: RIDGELINE,
      buyCurrency: "INR",
      sellCents: 75_000n,
      beneficiaryRef: `Bengaluru vendor ${RUN_ID}`,
      observation: observation(9_544_000_000n, "INR"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await expect(
      sql`UPDATE fx_quote SET beneficiary_ref = 'edited' WHERE id = ${created.value.quoteId}::uuid`,
    ).rejects.toThrow(/append-only violation|permission denied/);
    await expect(
      sql`DELETE FROM fx_quote WHERE id = ${created.value.quoteId}::uuid`,
    ).rejects.toThrow(/append-only violation|permission denied/);
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
    const created = await store.createQuote({
      businessId: RIDGELINE,
      buyCurrency: "MXN",
      sellCents: 100_000n,
      beneficiaryRef: `Unaccepted ${RUN_ID}`,
      observation: observation(MXN_MID),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const refusal = await gate.requireAcceptedQuote({
      quoteRef: created.value.quoteRef,
      amountUnits: 500_000n,
    });
    expect(refusal?.code).toBe("FX_QUOTE_NOT_ACCEPTED");
  });

  it("lets an accepted, unexpired quote through", async () => {
    const created = await store.createQuote({
      businessId: RIDGELINE,
      buyCurrency: "MXN",
      sellCents: 100_000n,
      beneficiaryRef: `Accepted ${RUN_ID}`,
      observation: observation(MXN_MID),
      destinationAddress: "0x000000000000000000000000000000000000dEaD",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const accepted = await store.acceptQuote({ quoteRef: created.value.quoteRef });
    expect(accepted.ok).toBe(true);

    const ok = await gate.requireAcceptedQuote({
      quoteRef: created.value.quoteRef,
      amountUnits: 500_000n,
      toAddress: "0x000000000000000000000000000000000000DEAD",
      businessId: RIDGELINE,
    });
    expect(ok).toBeNull();

    // The same quote, the wrong recipient.
    const wrongTo = await gate.requireAcceptedQuote({
      quoteRef: created.value.quoteRef,
      amountUnits: 500_000n,
      toAddress: "0x0000000000000000000000000000000000000001",
    });
    expect(wrongTo?.code).toBe("FX_QUOTE_MISMATCH");

    // The same quote, somebody else's money.
    const wrongCustomer = await gate.requireAcceptedQuote({
      quoteRef: created.value.quoteRef,
      amountUnits: 500_000n,
      toAddress: "0x000000000000000000000000000000000000dEaD",
      businessId: KETTLE,
    });
    expect(wrongCustomer?.code).toBe("FX_QUOTE_MISMATCH");

    // More USDC than the customer authorised: $1,000.00 is 10,000,000,000
    // USDC units, so one unit past that is a refusal.
    const tooMuch = await gate.requireAcceptedQuote({
      quoteRef: created.value.quoteRef,
      amountUnits: 10_000_000_001n,
      toAddress: "0x000000000000000000000000000000000000dEaD",
    });
    expect(tooMuch?.code).toBe("FX_QUOTE_MISMATCH");
  });
});

/* ========================================================================== */
/* Settlement                                                                 */
/* ========================================================================== */

run("settlement records what the commitment cost", () => {
  it("posts nothing, refuses a settlement that does not add up, and closes the quote", async () => {
    const created = await store.createQuote({
      businessId: RIDGELINE,
      buyCurrency: "MXN",
      sellCents: 100_000n,
      beneficiaryRef: `Settled ${RUN_ID}`,
      observation: observation(MXN_MID),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const quote = created.value;
    await store.acceptQuote({ quoteRef: quote.quoteRef });

    // The peso strengthened between acceptance and settlement: honouring the
    // commitment now costs more than the spread covers, and we eat it.
    const settlementMid = 1_650_000_000n;
    const position = gate.commitmentPosition(quote, settlementMid, RATE_SCALE);
    expect(position.varianceCents).toBeLessThan(0n);

    // A figure that does not satisfy the identity is refused by the trigger.
    const bogus = await store.recordQuoteSettlement({
      quoteRef: quote.quoteRef,
      txHash: `0x${"a".repeat(64)}`,
      settlementMidRateScaled: settlementMid,
      settlementRateScale: RATE_SCALE,
      settlementCostCents: position.settlementCostCents,
      varianceCents: position.varianceCents + 1n,
    });
    expect(bogus.ok).toBe(false);
    if (!bogus.ok) expect(bogus.error.code).toBe("FX_SETTLEMENT_UNBALANCED");

    const settled = await store.recordQuoteSettlement({
      quoteRef: quote.quoteRef,
      txHash: `0x${"a".repeat(64)}`,
      settlementMidRateScaled: settlementMid,
      settlementRateScale: RATE_SCALE,
      settlementCostCents: position.settlementCostCents,
      varianceCents: position.varianceCents,
    });
    expect(settled.ok, describeResult(settled)).toBe(true);
    if (!settled.ok) return;
    expect(settled.value.state).toBe("settled");
    expect(settled.value.varianceCents).toBe(position.varianceCents);

    // And once only.
    const again = await store.recordQuoteSettlement({
      quoteRef: quote.quoteRef,
      txHash: `0x${"b".repeat(64)}`,
      settlementMidRateScaled: settlementMid,
      settlementRateScale: RATE_SCALE,
      settlementCostCents: position.settlementCostCents,
      varianceCents: position.varianceCents,
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("FX_QUOTE_ALREADY_SETTLED");

    // The gate now refuses the spent quote.
    const spent = await gate.requireAcceptedQuote({
      quoteRef: quote.quoteRef,
      amountUnits: 500_000n,
    });
    expect(spent?.code).toBe("FX_QUOTE_ALREADY_SETTLED");
  });

  it("refuses a settlement against a quote nobody accepted", async () => {
    const created = await store.createQuote({
      businessId: RIDGELINE,
      buyCurrency: "MXN",
      sellCents: 100_000n,
      beneficiaryRef: `Never accepted ${RUN_ID}`,
      observation: observation(MXN_MID),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const refused = await store.recordQuoteSettlement({
      quoteRef: created.value.quoteRef,
      txHash: `0x${"c".repeat(64)}`,
      settlementMidRateScaled: MXN_MID,
      settlementRateScale: RATE_SCALE,
      settlementCostCents: 99_000n,
      varianceCents: 100_000n - created.value.feeCents - 99_000n,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("FX_QUOTE_NOT_ACCEPTED");
  });
});

/* ========================================================================== */
/* The ledger did not move                                                    */
/* ========================================================================== */

run("a quote is not a transaction", () => {
  it("writes not one journal entry, in the whole of this feature", async () => {
    const before = await sql<{ n: bigint }[]>`SELECT count(*) AS n FROM journal_entry`;

    const created = await store.createQuote({
      businessId: RIDGELINE,
      buyCurrency: "BRL",
      sellCents: 500_000n,
      beneficiaryRef: `Sao Paulo studio ${RUN_ID}`,
      observation: observation(512_470_000n, "BRL"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await store.acceptQuote({ quoteRef: created.value.quoteRef });

    const after = await sql<{ n: bigint }[]>`SELECT count(*) AS n FROM journal_entry`;
    expect(after[0]?.n).toBe(before[0]?.n);
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
