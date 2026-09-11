/**
 * The two arms of `requireAcceptedQuote()` nothing had ever watched work.
 *
 * `src/lib/fx/gate.ts` is not a belt-and-braces check. Its own header says so:
 *
 *     "this gate is not an additional check — it IS the control. 'The customer
 *      agreed a price' has no second enforcement point anywhere in the system"
 *
 * So every arm of it is load-bearing, and two of them were asserted by nothing.
 *
 * ── 1. THE LAPSED COMMITMENT ────────────────────────────────────────────────
 *
 * The gate's header lists five refusals. Four are driven by
 * `fx.integration.test.ts` against the live quote book — FX_QUOTE_REQUIRED
 * (:676), FX_QUOTE_NOT_FOUND (:684), FX_QUOTE_NOT_ACCEPTED (:710, state
 * 'open'), FX_QUOTE_MISMATCH (:752, :764, :776) and FX_QUOTE_ALREADY_SETTLED
 * (:881). The fifth, `FX_QUOTE_COMMITMENT_LAPSED`, was driven by nothing: the
 * string did not occur in a single `*.test.ts` file in this repository.
 *
 * WHY IT COULD NOT BE, WHICH IS THE INTERESTING PART. `v_fx_quote` (0017 §6)
 * derives `lapsed` as "accepted, unsettled, and now() > accepted_at +
 * settlement_window_seconds". Three correct decisions put that state out of a
 * test's reach simultaneously:
 *
 *   * `settlement_window_seconds` is `CHECK (BETWEEN 60 AND 604800)`, so the
 *     shortest commitment anyone can write lasts a minute;
 *   * `fx_quote_acceptance_guard()` (0017 §4) refuses an `accepted_at` more
 *     than five seconds from `now()` — "Backdating an acceptance would defeat
 *     the line above" — so the clock cannot be brought to the window;
 *   * `now()` is the TRANSACTION timestamp, so inside the `rolledBack()`
 *     helper the rest of this directory uses it never advances. `pg_sleep()`
 *     in the same transaction changes nothing.
 *
 * Reaching `lapsed` through the live path therefore means COMMITTING an
 * acceptance and returning fifty-five seconds later: a permanent row per run
 * in a book this suite has deliberately stopped growing, and a test nearly
 * twice the configured timeout. The integrity check that makes the control
 * real is the same thing that made the control unobservable, which is why this
 * file stubs the quote book rather than asking the database for a state it
 * cannot be made to produce.
 *
 * WHAT THAT PROVES: given a quote the book reports as `lapsed`, the gate
 * refuses, refuses under its own code rather than collapsing into
 * FX_QUOTE_NOT_ACCEPTED, refuses on the clock alone while every other fact
 * about the payout is correct, and names the window and the instant it shut.
 * WHAT IT DOES NOT PROVE: that `v_fx_quote` derives `lapsed` correctly — that
 * is 0017's arithmetic. This stops at the seam, which is where the gap was.
 *
 * ── 2. THE CEILING, PROBED AT THE CEILING ───────────────────────────────────
 *
 * `fx.integration.test.ts:766-776` is the only assertion on the rule that no
 * more USDC leaves than the customer paid for. It reads:
 *
 *     // More USDC than the customer authorised: $1,000.00 is 10,000,000,000
 *     // USDC units, so one unit past that is a refusal.
 *     amountUnits: 10_000_000_001n,
 *
 * `USDC_UNITS_PER_CENT` is `10_000n`, so $1,000.00 — the quote's `sellCents`
 * of `100_000n` — is 1,000,000,000 units, not 10,000,000,000. The probe is not
 * one unit past the ceiling; it is nine billion units past it, an order of
 * magnitude out. The assertion is green and cannot distinguish the correct
 * ceiling from one ten times too generous: had the gate computed
 * `sellCents * 100_000n`, 10,000,000,001 would still be over it and the test
 * would still pass, while a $9,999 payout settled against a $1,000 commitment.
 *
 * A boundary asserted an order of magnitude away from the boundary is a count,
 * not a derivation. The two cases below sit ON the line: exactly the ceiling
 * must pass, exactly one unit more must refuse.
 */

import { describe, expect, it, vi } from "vitest";

import { USDC_UNITS_PER_CENT } from "@/lib/rails/stablecoin/types";

import type { QuoteRecord } from "./store";

const loadQuoteByRef = vi.fn<(ref: string) => Promise<QuoteRecord | null>>();

vi.mock("./store", () => ({
  loadQuoteByRef: (ref: string) => loadQuoteByRef(ref),
}));

/**
 * THE HANDLE, TOO — and this one is not optional.
 *
 * `gate.ts` imports `sql` from `@/lib/ledger/db` for its `conn: Sql = sql`
 * default. That module calls `postgres(env.APP_DATABASE_URL, …)` at import
 * time, and `env` THROWS when the variable is absent. CI
 * (`.github/workflows/ci.yml`) runs a bare `pnpm test` with no secrets on
 * purpose, so importing the gate without this stub fails the whole file at
 * module load — not one red assertion, a red suite, in the one environment
 * that has no way to fix it.
 *
 * The stub is never called. Every case below omits `conn`, so the default is
 * handed straight to `loadQuoteByRef`, which is the mock above and ignores it.
 */
vi.mock("@/lib/ledger/db", () => ({
  sql: new Proxy(
    {},
    {
      get() {
        throw new Error(
          "this test must not reach the database; every case stubs loadQuoteByRef",
        );
      },
    },
  ),
}));

const { requireAcceptedQuote } = await import("./gate");

/** The off-ramp wallet the commitment names. Mixed case on purpose. */
const WALLET = "0x000000000000000000000000000000000000dEaD";
const BUSINESS = "11111111-2222-3333-4444-555555555555";

/** $1,000.00, the figure the customer committed. */
const SELL_CENTS = 100_000n;

/**
 * The ceiling, DERIVED the way the gate derives it rather than typed out as a
 * literal. A literal here would reproduce the defect this file exists to fix.
 */
const CEILING_UNITS = SELL_CENTS * USDC_UNITS_PER_CENT;

/**
 * A commitment for $1,000.00, accepted at 10:00:30 with a 900-second
 * settlement window that closed at 10:15:30. Every field is the shape
 * `toRecord()` produces; `state`, `acceptedAt` and `settleBy` carry the fact
 * under test.
 */
function quote(overrides: Partial<QuoteRecord> = {}): QuoteRecord {
  return {
    quoteId: "99999999-8888-7777-6666-555555555555",
    quoteRef: "FX-LAPSE-0001",
    entityId: "00000000-0000-0000-0000-000000000001",
    businessId: BUSINESS,
    businessName: "Ridgeline Contracting LLC",

    sellCurrency: "USD",
    sellCents: SELL_CENTS,
    feeFlatCents: 100n,
    feeBps: 25,
    feeCents: 350n,
    netCents: 99_650n,

    spreadBps: 50,
    midRateScaled: 1_694_350_000n,
    customerRateScaled: 1_685_878_250n,
    rateScale: 100_000_000n,

    buyCurrency: "MXN",
    buyExponent: 2,
    buyMinor: 168_000_320n,

    rail: "stablecoin",
    beneficiaryRef: "Invoice 4471",
    destinationAddress: WALLET,

    rateSource: "frankfurter",
    rateEvidence: "live",
    rateLiteral: "16.9435",
    rateDate: "2026-09-10",
    rateFetchedAt: "2026-09-10T10:00:00.000Z",
    rateHttpStatus: 200,

    createdAt: "2026-09-10T10:00:00.000Z",
    createdByName: "ledger-poster",
    expiresAt: "2026-09-10T10:05:00.000Z",
    expiresInSeconds: -86_400n,
    settlementWindowSeconds: 900,

    acceptedAt: "2026-09-10T10:00:30.000Z",
    acceptedByName: "Dana Okonkwo",
    acceptanceReference: "Invoice 4471",
    acceptedWithSecondsToSpare: 270n,
    settleBy: "2026-09-10T10:15:30.000Z",

    settledAt: null,
    txHash: null,
    entryId: null,
    settlementMidRateScaled: null,
    settlementCostCents: null,
    varianceCents: null,

    state: "lapsed",

    isFixture: true,
    fixtureSource: "src/lib/fx/gate.unwatched.test.ts",
    fixtureReason:
      "a lapsed commitment, which the live path cannot produce inside one transaction",
    ...overrides,
  };
}

/** A payout correct in every respect except the clock. */
const PERFECT_PAYOUT = {
  quoteRef: "FX-LAPSE-0001",
  amountUnits: CEILING_UNITS,
  toAddress: WALLET.toUpperCase(),
  businessId: BUSINESS,
} as const;

describe("requireAcceptedQuote — a commitment whose settlement window closed", () => {
  it("refuses on the clock alone, with everything else about the payout correct", async () => {
    // The address matches (case-insensitively), the customer matches, and the
    // amount is exactly the ceiling rather than under it — so nothing
    // downstream of the state switch can be what produces the refusal. If the
    // gate let `lapsed` fall through to `case "accepted"` this returns null.
    loadQuoteByRef.mockResolvedValue(quote());

    const refusal = await requireAcceptedQuote(PERFECT_PAYOUT);

    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe("FX_QUOTE_COMMITMENT_LAPSED");
  });

  it("does not collapse into the never-accepted answer, which is a different fact", async () => {
    // The gate's header: "A different fact from (2) with a different
    // explanation owed to the customer, which is why it is a different code."
    // A commitment that ran out is not an offer nobody took, and a customer
    // told the second is told we never agreed a price with them at all.
    loadQuoteByRef.mockResolvedValue(quote());
    const lapsed = await requireAcceptedQuote(PERFECT_PAYOUT);

    loadQuoteByRef.mockResolvedValue(
      quote({ state: "expired", acceptedAt: null, settleBy: null, acceptedByName: null }),
    );
    const neverAccepted = await requireAcceptedQuote(PERFECT_PAYOUT);

    expect(lapsed?.code).toBe("FX_QUOTE_COMMITMENT_LAPSED");
    expect(neverAccepted?.code).toBe("FX_QUOTE_NOT_ACCEPTED");
  });

  it("names the window and the instant it shut, not just that it did", async () => {
    // A refusal an operator cannot act on is a 500 with better manners. The
    // reference, the window the offer named and the instant it closed are the
    // three things a support call asks for, and all three are in the quote the
    // gate has just read.
    loadQuoteByRef.mockResolvedValue(quote());

    const refusal = await requireAcceptedQuote(PERFECT_PAYOUT);

    expect(refusal?.message).toContain("FX-LAPSE-0001");
    expect(refusal?.message).toContain("900-second");
    expect(refusal?.message).toContain("2026-09-10T10:15:30.000Z");
    expect(refusal?.message).toContain("2026-09-10T10:00:30.000Z");
  });

  it("refuses before it reaches the recipient and amount checks", async () => {
    // Ordering decides what the customer is told to fix. A lapsed commitment
    // sent to the wrong wallet for too much money is still, first, a lapsed
    // commitment; naming the address would send them to correct the wrong
    // thing and re-submit into the same refusal.
    loadQuoteByRef.mockResolvedValue(quote());

    const refusal = await requireAcceptedQuote({
      quoteRef: "FX-LAPSE-0001",
      amountUnits: CEILING_UNITS * 99n,
      toAddress: "0x0000000000000000000000000000000000000001",
      businessId: "99999999-9999-9999-9999-999999999999",
    });

    expect(refusal?.code).toBe("FX_QUOTE_COMMITMENT_LAPSED");
  });
});

describe("requireAcceptedQuote — the amount ceiling, probed at the ceiling", () => {
  const accepted = () => quote({ state: "accepted" });

  it("lets exactly the committed amount through", async () => {
    // $1,000.00 at 10,000 units per cent is 1,000,000,000 units. The customer
    // paid for this much; the gate has no business refusing it.
    loadQuoteByRef.mockResolvedValue(accepted());

    expect(await requireAcceptedQuote({ ...PERFECT_PAYOUT, amountUnits: CEILING_UNITS })).toBeNull();
  });

  it("refuses one single unit more", async () => {
    // One unit is $0.000001. The rule is "no more USDC leaves than the
    // customer paid us", and a rule with a tolerance is a different rule.
    loadQuoteByRef.mockResolvedValue(accepted());

    const refusal = await requireAcceptedQuote({
      ...PERFECT_PAYOUT,
      amountUnits: CEILING_UNITS + 1n,
    });

    expect(refusal?.code).toBe("FX_QUOTE_MISMATCH");
  });

  it("is the ceiling the gate derives, not a literal anybody typed twice", async () => {
    // The existing probe in fx.integration.test.ts is 10x the real ceiling
    // because the figure was written out by hand. This asserts the derivation
    // instead: a $1,000.00 commitment is a billion USDC units, and if
    // USDC_UNITS_PER_CENT ever moves, this moves with it.
    expect(CEILING_UNITS).toBe(1_000_000_000n);
    loadQuoteByRef.mockResolvedValue(accepted());

    // Ten times the ceiling — the amount the existing test probes — must be
    // refused, and so must the unit above the real line. A gate that only
    // catches the first is a gate with a 900% tolerance.
    expect((await requireAcceptedQuote({ ...PERFECT_PAYOUT, amountUnits: 10_000_000_001n }))?.code)
      .toBe("FX_QUOTE_MISMATCH");
    expect((await requireAcceptedQuote({ ...PERFECT_PAYOUT, amountUnits: CEILING_UNITS + 1n }))?.code)
      .toBe("FX_QUOTE_MISMATCH");
  });

  it("refuses a payout of nothing, which settles nothing", async () => {
    loadQuoteByRef.mockResolvedValue(accepted());

    expect((await requireAcceptedQuote({ ...PERFECT_PAYOUT, amountUnits: 0n }))?.code).toBe(
      "FX_QUOTE_MISMATCH",
    );
  });
});
