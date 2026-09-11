import { beforeAll, describe, expect, it } from "vitest";

import type { sql as SqlHandle } from "@/lib/ledger/db";
import type * as BalanceModule from "@/lib/ledger/balance-definitions";
import type * as QueriesModule from "@/lib/ledger/queries";

import type * as HoldModule from "./hold";
import type * as StoreModule from "./store";
import { RATE_SCALE } from "./types";

/**
 * THE HOLD AN ACCEPTED QUOTE PLACES, against the REAL Neon database.
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/lib/fx
 *
 * ===========================================================================
 * THE BUG THIS FILE IS THE REGRESSION TEST FOR
 * ===========================================================================
 *
 * Accepting a quote wrote one row in `fx_quote_acceptance` and reserved
 * NOTHING. Measured against this book before the fix:
 *
 *   AVAILABLE $35,514.93 → accept $21,308.95 → accept $21,308.95
 *   AFTER     available $35,514.93                            ← UNMOVED
 *   GATE 1    CLEARS          GATE 2    CLEARS
 *   TOTAL     $42,617.90 cleared against $35,514.93 available
 *
 * Every scenario below runs inside a transaction that is ROLLED BACK, for the
 * reason `fx.integration.test.ts` gives at length: this suite used to commit
 * against the live book and seven of the eight rows in `fx_quote_settlement`
 * are what it left behind. A hold is a money row; an orphan one moves a
 * customer's available balance.
 *
 * ===========================================================================
 * THE FIVE CLAIMS
 * ===========================================================================
 *
 *   1. AN ACCEPTANCE MOVES AVAILABILITY BY EXACTLY THE COMMITTED PRICE, and
 *      it does so through `ledger_availability()` — the ONE definition — not
 *      through a number this feature computes for itself.
 *
 *   2. TWO COMMITMENTS CANNOT BOTH STAND AGAINST ONE BALANCE. The second is
 *      refused by name, and NOTHING IS WRITTEN: no acceptance, no hold, no
 *      rate locked.
 *
 *   3. SETTLEMENT RELEASES IT TERMINALLY — a `hold_closure` row declaring
 *      `source = 'fx_settlement'`, and a memo book put back to flat in the
 *      same transaction as the settlement row.
 *
 *   4. A LAPSE RELEASES IT ON THE CLOCK AND WRITES NO ROW. This is the
 *      closed-vs-terminallyClosed distinction, and it is the one a wrong
 *      answer to moves money: a permanent row saying "released because the
 *      window closed" can be overtaken by a settlement that was in flight.
 *
 *   5. THE INVARIANT CAN FAIL. `v_fx_commitment_unheld` returns a row for an
 *      acceptance that placed no hold — asserted here as well as by
 *      `dbcheck --prove`, because a guard nobody has seen fail is a claim.
 */

const run = process.env["RUN_DB_TESTS"] === "1" ? describe : describe.skip;

/** Seeded by `scripts/seed.mjs`; stable across resets. */
const RIDGELINE = "e274546d-6bdd-5266-b0fb-cc839a7811f9";

/** USD/MXN as the live source printed it on 2026-09-10. */
const MXN_MID = 1_694_350_000n;

const RUN_ID = `hold-it-${Date.now().toString(36)}`;

/**
 * `JSON.stringify` throws on a bigint, and every money figure in this file is
 * one. Used only to put a refusal's own words into an assertion message.
 */
function show(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
}

/**
 * A transaction hash that is not a placeholder.
 *
 * `fx_quote_settlement_tx_hash_not_placeholder` (migration 0041) refuses
 * `0x` + 64 repeats of one character, because no keccak-256 digest looks like
 * that — the constraint exists because this suite's ancestor wrote seven such
 * rows to the live book and a reader counted them as settlements. So the
 * fixtures below are random, which is also what a real hash is.
 */
function fixtureTxHash(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

let sql: typeof SqlHandle;
let store: typeof StoreModule;
let hold: typeof HoldModule;
let accountAvailability: typeof BalanceModule.accountAvailability;
let readSnapshot: typeof BalanceModule.readSnapshot;
let houseAccountId: typeof BalanceModule.houseAccountId;
let listPostingRows: typeof QueriesModule.listPostingRows;

beforeAll(async () => {
  if (process.env["RUN_DB_TESTS"] !== "1") return;
  ({ sql } = await import("@/lib/ledger/db"));
  store = await import("./store");
  hold = await import("./hold");
  ({ accountAvailability, readSnapshot, houseAccountId } = await import(
    "@/lib/ledger/balance-definitions"
  ));
  ({ listPostingRows } = await import("@/lib/ledger/queries"));
});

/* ========================================================================== */
/* The transaction machinery                                                  */
/* ========================================================================== */

type Scoped = {
  savepoint: <T>(fn: (scoped: unknown) => Promise<T>) => Promise<T>;
  begin?: unknown;
};

/**
 * Give a transaction handle the `.begin()` that `./store.ts` calls. Verbatim
 * the shim `fx.integration.test.ts` documents: postgres.js puts `begin` on the
 * POOL object only, and a transaction scope gets `savepoint`, which is the
 * same function with a savepoint name.
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

const ROLLBACK = "fx-hold-integration-rollback";

/**
 * `isolation` is passed through for the scenarios that COUNT rows.
 *
 * Under READ COMMITTED each statement takes a fresh snapshot, so an entry
 * committed by anything else — another agent on this shared book, a cron, the
 * demo script — lands between two counts and fails a test about THIS code.
 * Under REPEATABLE READ the snapshot is fixed at the first statement and the
 * only writes the second count can see are this transaction's own, so "the
 * count did not move" means "we wrote nothing" rather than "the database was
 * quiet". Measured: the financial-entry count below went red on a run where
 * this file was the only thing in the suite that had not written one.
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
    if (!(thrown instanceof Error) || thrown.message !== ROLLBACK) failure = thrown;
  }
  if (failure !== null) throw failure;
}

/* ========================================================================== */
/* Fixtures                                                                   */
/* ========================================================================== */

function observation(rateScaled: bigint) {
  const whole = rateScaled / RATE_SCALE;
  const fraction = (rateScaled % RATE_SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return {
    source: "frankfurter.dev",
    evidence: "live" as const,
    baseCurrency: "USD",
    quoteCurrency: "MXN",
    rateScaled,
    rateScale: RATE_SCALE,
    literal: fraction === "" ? `${whole}` : `${whole}.${fraction}`,
    rateDate: "2026-09-10",
    fetchedAt: new Date().toISOString(),
    httpStatus: 200,
    fallbackReason: null,
  };
}

/**
 * The customer's deposit leaf and the availability the fix is measured in.
 *
 * THROUGH THE LEDGER'S OWN READERS — `resolveCommitmentAccounts()` for the
 * account and `accountAvailability()` over `readSnapshot()` for the figures.
 * A test that reaches into `journal_line` to work out a balance is a test
 * asserting its OWN definition of the balance, which is precisely the failure
 * `src/lib/ledger/boundary.test.ts` exists to stop spreading — and in this
 * file it would be worse than elsewhere, because the claim under test is that
 * the hold shows up in the one definition. Computing the expected number a
 * second way would let both be wrong together.
 */
async function subject(tx: typeof SqlHandle): Promise<{
  accountId: string;
  entityId: string;
  memoAccountId: string;
  availableCents: bigint;
  holdCents: bigint;
  ledgerCents: bigint;
}> {
  const entities = await tx<{ entity_id: string }[]>`
    SELECT entity_id FROM business WHERE id = ${RIDGELINE}::uuid`;
  const entityId = entities[0]?.entity_id;
  if (entityId === undefined) throw new Error("no Ridgeline business; run scripts/seed.mjs");

  const accounts = await hold.resolveCommitmentAccounts(
    { businessId: RIDGELINE, entityId },
    tx,
  );
  if (accounts === null) {
    throw new Error("Ridgeline has no 2100 leaf, or the chart has no 9300; run scripts/seed.mjs");
  }

  const snapshot = await readSnapshot(tx);
  const availability = await accountAvailability(accounts.depositAccountId, snapshot, tx);
  return {
    accountId: accounts.depositAccountId,
    entityId,
    memoAccountId: accounts.memoAccountId,
    availableCents: availability.availableCents,
    holdCents: availability.holdsCents,
    ledgerCents: availability.ledgerCents,
  };
}

async function quoteFor(
  tx: typeof SqlHandle,
  sellCents: bigint,
  label: string,
): Promise<StoreModule.QuoteRecord> {
  const created = await store.createQuote(
    {
      businessId: RIDGELINE,
      buyCurrency: "MXN",
      sellCents,
      beneficiaryRef: `${label} ${RUN_ID}`,
      observation: observation(MXN_MID),
    },
    tx,
  );
  if (!created.ok) throw new Error(`quote ${label} was not created: ${created.error.code}`);
  return created.value;
}

/* ========================================================================== */
/* 1. An acceptance withholds the committed price                             */
/* ========================================================================== */

run("an acceptance places a hold", () => {
  it("moves available balance by exactly sell_cents, through ledger_availability()", async () => {
    await rolledBack(async (tx) => {
      const before = await subject(tx);
      // A tenth of what is available, so the scenario says nothing about
      // whether the account happens to be rich today.
      const commitment = before.availableCents / 10n;
      expect(commitment).toBeGreaterThan(0n);

      const quote = await quoteFor(tx, commitment, "commitment");
      const accepted = await store.acceptQuote({ quoteRef: quote.quoteRef }, tx);
      expect(accepted.ok, show(accepted)).toBe(true);

      const after = await subject(tx);
      // EXACTLY. Not "less than", not "approximately" — the hold is the
      // committed price and availability is the one definition minus it.
      expect(after.availableCents).toBe(before.availableCents - commitment);
      expect(after.holdCents).toBe(before.holdCents + commitment);
    });
  });

  it("binds the hold to the quote, on the customer's own account, with the window as its clock", async () => {
    await rolledBack(async (tx) => {
      const before = await subject(tx);
      const commitment = before.availableCents / 10n;
      const quote = await quoteFor(tx, commitment, "binding");
      const accepted = await store.acceptQuote({ quoteRef: quote.quoteRef }, tx);
      expect(accepted.ok).toBe(true);

      const rows = await tx<
        {
          kind: string;
          external_ref: string;
          account_id: string;
          memo_account_id: string;
          sell_cents: bigint;
          memo_balance_cents: bigint;
          is_released: boolean;
          clock_matches_window: boolean;
          closures: number;
        }[]
      >`
        SELECT h.kind::text                AS kind,
               h.external_ref,
               h.account_id,
               h.memo_account_id,
               ch.sell_cents,
               hs.memo_balance_cents::bigint AS memo_balance_cents,
               hs.is_released,
               (h.available_at
                  = a.accepted_at + q.settlement_window_seconds * interval '1 second')
                                           AS clock_matches_window,
               (SELECT count(*)::int FROM hold_closure hc WHERE hc.hold_id = h.id) AS closures
          FROM fx_commitment_hold ch
          JOIN hold                h    ON h.id = ch.hold_id
          JOIN v_hold_state        hs   ON hs.hold_id = h.id
          JOIN fx_quote            q    ON q.id = ch.quote_id
          JOIN fx_quote_acceptance a    ON a.quote_id = q.id
         WHERE q.quote_ref = ${quote.quoteRef}`;
      const row = rows[0];
      expect(row, "the acceptance placed no commitment hold").toBeDefined();
      if (row === undefined) return;

      expect(row.kind).toBe("manual");
      expect(row.external_ref).toBe(hold.commitmentExternalRef(quote.quoteRef));
      expect(row.account_id).toBe(before.accountId);
      expect(row.memo_account_id).toBe(before.memoAccountId);
      expect(row.sell_cents).toBe(commitment);
      // The memo book agrees with the hold: this is `v_hold_drift`'s bargain
      // asked of one row rather than of the whole book.
      expect(row.memo_balance_cents).toBe(commitment);
      expect(row.is_released).toBe(false);
      // `available_at` IS the settlement window. That single column is the
      // whole of the lapse story — see the fourth suite.
      expect(row.clock_matches_window).toBe(true);
      // NOTHING permanent was written at acceptance.
      expect(row.closures).toBe(0);
    });
  });

  it("leaves the financial ledger untouched — an acceptance is not a transaction", async () => {
    await rolledBack(async (tx) => {
      // The claim is about the CUSTOMER'S MONEY, so it is asked of the
      // customer's settled ledger balance rather than of a global entry count.
      // A hold is a memo posting; the financial book does not move, and
      // `ledger_availability()`'s first term is what says so.
      const before = await subject(tx);
      const quote = await quoteFor(tx, before.availableCents / 10n, "no-financial");
      const accepted = await store.acceptQuote({ quoteRef: quote.quoteRef }, tx);
      expect(accepted.ok).toBe(true);

      const after = await subject(tx);
      expect(after.ledgerCents).toBe(before.ledgerCents);
      // …and it is not that nothing happened: availability DID move.
      expect(after.availableCents).toBe(before.availableCents - quote.sellCents);
    }, "isolation level repeatable read");
  });
});

/* ========================================================================== */
/* 2. THE MONEY BUG                                                           */
/* ========================================================================== */

run("THE MONEY BUG: two commitments against one balance", () => {
  it("refuses the second by name and writes nothing at all", async () => {
    await rolledBack(async (tx) => {
      const before = await subject(tx);
      expect(before.availableCents).toBeGreaterThan(0n);

      // The first commitment takes the whole available balance. The second is
      // a single cent — the smallest possible overdraft, so the assertion is
      // about the control and not about the size of the number.
      const first = await quoteFor(tx, before.availableCents, "all-of-it");
      const second = await quoteFor(tx, 1n, "one-cent-more");

      const acceptedFirst = await store.acceptQuote({ quoteRef: first.quoteRef }, tx);
      expect(acceptedFirst.ok, show(acceptedFirst)).toBe(true);

      const mid = await subject(tx);
      expect(mid.availableCents).toBe(0n);

      const acceptedSecond = await store.acceptQuote({ quoteRef: second.quoteRef }, tx);
      expect(acceptedSecond.ok).toBe(false);
      if (acceptedSecond.ok) return;
      expect(acceptedSecond.error.code).toBe("FX_COMMITMENT_EXCEEDS_AVAILABLE");
      // The refusal names its own fix, which is the house rule for one.
      expect(acceptedSecond.error.message).toMatch(/\/payouts/);

      // AND NOTHING WAS WRITTEN. This is the half that a refusal implemented
      // as "insert, then undo" would get wrong: `fx_quote_acceptance` is
      // append-only with the quote id as its PRIMARY KEY, so an acceptance
      // written and rolled back inside a savepoint would still be visible to
      // anything reading the same transaction, and a later legitimate
      // acceptance of that quote would be refused as a duplicate.
      const written = await tx<{ acceptances: number; holds: number }[]>`
        SELECT (SELECT count(*)::int FROM fx_quote_acceptance a
                  JOIN fx_quote q ON q.id = a.quote_id
                 WHERE q.quote_ref = ${second.quoteRef}) AS acceptances,
               (SELECT count(*)::int FROM hold
                 WHERE kind = 'manual'
                   AND external_ref = ${hold.commitmentExternalRef(second.quoteRef)}) AS holds`;
      expect(written[0]?.acceptances).toBe(0);
      expect(written[0]?.holds).toBe(0);

      // The first commitment is untouched by the second's refusal.
      const after = await subject(tx);
      expect(after.availableCents).toBe(0n);
      expect(after.holdCents).toBe(before.holdCents + before.availableCents);
    });
  });

  it("lets the same money be committed again once the first commitment is gone", async () => {
    await rolledBack(async (tx) => {
      const before = await subject(tx);
      const commitment = before.availableCents / 4n;

      const first = await quoteFor(tx, commitment, "first");
      expect((await store.acceptQuote({ quoteRef: first.quoteRef }, tx)).ok).toBe(true);

      // Settle it: the terminal release gives the memo book back and the
      // closure row says why.
      const settled = await store.recordQuoteSettlement(
        {
          quoteRef: first.quoteRef,
          txHash: fixtureTxHash(),
          settlementMidRateScaled: MXN_MID,
          settlementRateScale: RATE_SCALE,
          settlementCostCents: commitment - first.feeCents,
          varianceCents: 0n,
        },
        tx,
      );
      expect(settled.ok, show(settled)).toBe(true);

      // The money is available again, to the cent, and a second commitment of
      // the same size is accepted.
      const afterSettlement = await subject(tx);
      expect(afterSettlement.holdCents).toBe(before.holdCents);

      const second = await quoteFor(tx, commitment, "second");
      expect((await store.acceptQuote({ quoteRef: second.quoteRef }, tx)).ok).toBe(true);
    });
  });
});

/* ========================================================================== */
/* 3. Settlement: the TERMINAL release                                        */
/* ========================================================================== */

run("settlement releases the commitment terminally", () => {
  it("writes one hold_closure declaring fx_settlement and flattens the memo book", async () => {
    await rolledBack(async (tx) => {
      const before = await subject(tx);
      const commitment = before.availableCents / 8n;
      const quote = await quoteFor(tx, commitment, "settles");
      expect((await store.acceptQuote({ quoteRef: quote.quoteRef }, tx)).ok).toBe(true);

      const txHash = fixtureTxHash();
      const settled = await store.recordQuoteSettlement(
        {
          quoteRef: quote.quoteRef,
          txHash,
          settlementMidRateScaled: MXN_MID,
          settlementRateScale: RATE_SCALE,
          settlementCostCents: commitment - quote.feeCents,
          varianceCents: 0n,
        },
        tx,
      );
      expect(settled.ok, show(settled)).toBe(true);

      const rows = await tx<
        {
          source: string | null;
          reason: string;
          memo_balance_cents: bigint;
          is_released: boolean;
          reversals: number;
        }[]
      >`
        SELECT hc.source, hc.reason, hs.memo_balance_cents::bigint AS memo_balance_cents, hs.is_released,
               (SELECT count(*)::int FROM hold_closure_reversal r
                 WHERE r.hold_id = hc.hold_id) AS reversals
          FROM fx_commitment_hold ch
          JOIN fx_quote     q  ON q.id = ch.quote_id
          JOIN hold_closure hc ON hc.hold_id = ch.hold_id
          JOIN v_hold_state hs ON hs.hold_id = ch.hold_id
         WHERE q.quote_ref = ${quote.quoteRef}`;
      const row = rows[0];
      expect(row, "settlement wrote no closure row").toBeDefined();
      if (row === undefined) return;

      // The DISCRIMINATOR is the source, not the prose. Migration 0040 is
      // fifty lines about the difference.
      expect(row.source).toBe("fx_settlement");
      expect(row.reason).toContain(txHash);
      expect(row.reversals).toBe(0);
      // A released hold must be FLAT — `v_hold_release_drift`'s claim, asked
      // of this one hold before the whole-book guard is asked of it.
      expect(row.is_released).toBe(true);
      expect(row.memo_balance_cents).toBe(0n);

      const after = await subject(tx);
      expect(after.holdCents).toBe(before.holdCents);
    });
  });

  it("is idempotent: releasing a second time appends nothing", async () => {
    await rolledBack(async (tx) => {
      const before = await subject(tx);
      const commitment = before.availableCents / 8n;
      const quote = await quoteFor(tx, commitment, "idempotent");
      expect((await store.acceptQuote({ quoteRef: quote.quoteRef }, tx)).ok).toBe(true);

      const ids = await tx<{ quote_id: string }[]>`
        SELECT id AS quote_id FROM fx_quote WHERE quote_ref = ${quote.quoteRef}`;
      const quoteId = ids[0]?.quote_id;
      expect(quoteId).toBeDefined();
      if (quoteId === undefined) return;

      const actors = await tx<{ id: string }[]>`
        SELECT id FROM actor WHERE kind = 'system' AND display_name = 'ledger-poster' LIMIT 1`;
      const actorId = actors[0]?.id;
      if (actorId === undefined) throw new Error("no ledger-poster actor");

      const replayHash = fixtureTxHash();
      const first = await hold.releaseSettledCommitment(
        { quoteId, quoteRef: quote.quoteRef, txHash: replayHash, actorId },
        tx,
      );
      expect(first.closurePosted).toBe(true);
      expect(first.releasedCents).toBe(commitment);

      // Compare-and-append: the second call reads a zero memo balance and a
      // closure that already exists, so the right amount of bookkeeping is
      // none. Not "it would have been refused" — it computes nothing to do.
      const second = await hold.releaseSettledCommitment(
        { quoteId, quoteRef: quote.quoteRef, txHash: replayHash, actorId },
        tx,
      );
      expect(second.closurePosted).toBe(false);
      expect(second.releasedCents).toBe(0n);
      expect(second.entryId).toBeNull();
    });
  });
});

/* ========================================================================== */
/* 4. Lapse: the DERIVED release, and the row that is NOT written             */
/* ========================================================================== */

/**
 * The fixture cannot come through `acceptQuote()`, and the reason is a fact
 * about Postgres rather than a shortcut: `now()` is `transaction_timestamp()`
 * and does not advance inside a transaction, while `settlement_window_seconds`
 * has a floor of 60 (0017 §3). A commitment accepted and lapsed inside one
 * transaction is not a thing that can exist.
 *
 * So the hold is built with its clock already past — which is exactly the
 * state the sweep will find in production — and what is asserted is the
 * RELEASE PREDICATE and the bookkeeping, which is what this suite is about.
 */
run("a lapsed commitment releases on the clock and writes no row", () => {
  /**
   * A commitment whose settlement window has already closed.
   *
   * IT CANNOT COME THROUGH `acceptQuote()` UNCHANGED, and the reason is a fact
   * about Postgres rather than a shortcut: `now()` is
   * `transaction_timestamp()` and does not advance inside a transaction, while
   * `settlement_window_seconds` has a floor of 60 (0017 §3). A commitment
   * accepted and lapsed inside one transaction is not a thing that can exist,
   * and a test that slept 24 hours would not be a test.
   *
   * So the hold is built with its clock ALREADY PAST — the `available_at` a
   * real commitment carries one settlement window later — and everything else
   * is the production shape: a real quote, a real acceptance, a real
   * `fx_commitment_hold` binding, and the memo posting `placeCommitmentHold()`
   * writes. What is under test is the release predicate and the sweep, and
   * both see exactly what they would see in production.
   */
  async function lapsedCommitment(tx: typeof SqlHandle): Promise<{
    quoteRef: string;
    quoteId: string;
    holdId: string;
    commitment: bigint;
    actorId: string;
    accountId: string;
  }> {
    const s = await subject(tx);
    const commitment = s.availableCents / 8n;
    const quote = await quoteFor(tx, commitment, "lapsed");

    const actors = await tx<{ id: string }[]>`
      SELECT id FROM actor WHERE kind = 'system' AND display_name = 'ledger-poster' LIMIT 1`;
    const actorId = actors[0]?.id;
    if (actorId === undefined) throw new Error("no ledger-poster actor");

    // The acceptance goes in directly so the hold beside it can carry a past
    // clock. `fx_commitment_hold_preconditions` still has to be satisfied —
    // it refuses a hold for a quote nobody accepted — so the order here is the
    // production order even though the instant is not.
    await tx`
      INSERT INTO fx_quote_acceptance (quote_id, accepted_by)
      VALUES (${quote.quoteId}::uuid, ${actorId}::uuid)`;

    const holds = await tx<{ id: string }[]>`
      INSERT INTO hold (account_id, memo_account_id, kind, external_ref, value_date, available_at)
      VALUES (${s.accountId}::uuid, ${s.memoAccountId}::uuid, 'manual',
              ${hold.commitmentExternalRef(quote.quoteRef)},
              book_date(clock_timestamp())::date,
              now() - interval '1 hour')
      RETURNING id`;
    const holdId = holds[0]?.id;
    if (holdId === undefined) throw new Error("the fixture hold was not created");

    await tx`
      INSERT INTO fx_commitment_hold (quote_id, hold_id, sell_cents, placed_by)
      VALUES (${quote.quoteId}::uuid, ${holdId}::uuid, ${commitment}, ${actorId}::uuid)`;

    const contraId = await houseAccountId("9900", tx);
    if (contraId === null) throw new Error("the chart has no 9900 memo contra");
    const { postEntry } = await import("@/lib/ledger/post");
    await postEntry(
      {
        entityId: s.entityId,
        valueDate: new Date().toISOString().slice(0, 10),
        book: "memo",
        description: `lapsed commitment fixture ${quote.quoteRef}`,
        idempotencyKey: hold.commitmentOpenKey(quote.quoteId),
        actorId,
        holdId,
        lines: [
          { accountId: s.memoAccountId, amountCents: -commitment },
          { accountId: contraId, amountCents: commitment },
        ],
      },
      tx,
    );

    return {
      quoteRef: quote.quoteRef,
      quoteId: quote.quoteId,
      holdId,
      commitment,
      actorId,
      accountId: s.accountId,
    };
  }

  it("frees the money on the clock, with no hold_closure row and nothing running", async () => {
    await rolledBack(async (tx) => {
      const before = await subject(tx);
      const fixture = await lapsedCommitment(tx);

      const state = await tx<
        { is_released: boolean; memo_balance_cents: bigint; closures: number }[]
      >`
        SELECT hs.is_released, hs.memo_balance_cents::bigint AS memo_balance_cents,
               (SELECT count(*)::int FROM hold_closure hc WHERE hc.hold_id = hs.hold_id) AS closures
          FROM v_hold_state hs WHERE hs.hold_id = ${fixture.holdId}::uuid`;
      // THE CLOCK RELEASED IT. Derived, at the parameterised instant, by
      // `hold.available_at` — with nothing running and, crucially, NO
      // permanent row asserting why. See `src/lib/fx/hold.ts` on closed vs
      // terminallyClosed: a row saying "released because the window closed"
      // can be overtaken by a settlement already in flight.
      expect(state[0]?.is_released).toBe(true);
      expect(state[0]?.closures).toBe(0);
      // …and the memo book has NOT caught up, which is the transient
      // `v_hold_release_drift` exists to report and the sweep answers.
      expect(state[0]?.memo_balance_cents).toBe(fixture.commitment);

      // The customer is ALREADY RIGHT: availability withholds nothing for it.
      // Not "will be right after the sweep" — right now, from the clock.
      const after = await subject(tx);
      expect(after.holdCents).toBe(before.holdCents);
      expect(after.availableCents).toBe(before.availableCents);
    });
  });

  it("the sweep flattens the memo book, books it on the day the window closed, and STILL writes no closure", async () => {
    await rolledBack(async (tx) => {
      const fixture = await lapsedCommitment(tx);

      const due = await hold.findLapsedCommitments({ conn: tx });
      const row = due.find((d) => d.quoteRef === fixture.quoteRef);
      expect(row, "the sweep did not see a lapsed commitment carrying a balance").toBeDefined();
      if (row === undefined) return;
      expect(row.memoBalanceCents).toBe(fixture.commitment);

      const released = await hold.releaseLapsedCommitment(row, {
        actorId: fixture.actorId,
        conn: tx,
      });
      expect(released.releasedCents).toBe(fixture.commitment);
      expect(released.entryId).not.toBeNull();
      // THE ROW THAT IS NOT WRITTEN. This is the assertion the whole
      // closed-vs-terminallyClosed argument comes down to.
      expect(released.closurePosted).toBe(false);

      const state = await tx<{ memo_balance_cents: bigint; closures: number }[]>`
        SELECT hs.memo_balance_cents::bigint AS memo_balance_cents,
               (SELECT count(*)::int FROM hold_closure hc WHERE hc.hold_id = hs.hold_id) AS closures
          FROM v_hold_state hs WHERE hs.hold_id = ${fixture.holdId}::uuid`;
      expect(state[0]?.memo_balance_cents).toBe(0n);
      expect(state[0]?.closures).toBe(0);

      // Booked on the day the WINDOW closed, not the day the sweep ran, so a
      // re-run next week produces the identical entry. Read through
      // `listPostingRows()` — the ledger's own reader for what landed on an
      // account — rather than by querying `journal_entry` here, which is the
      // boundary `src/lib/ledger/boundary.test.ts` holds test suites to as
      // well as modules.
      const snapshot = await readSnapshot(tx);
      const postings = await listPostingRows(fixture.accountId, snapshot, 200, tx);
      const posted = postings.find((p) => p.entryId === released.entryId);
      expect(posted, "the release entry is not on the customer's account").toBeDefined();
      expect(posted?.valueDate).toBe(row.releaseValueDate);

      // Idempotent: a second pass finds nothing to do.
      const again = await hold.findLapsedCommitments({ conn: tx });
      expect(again.some((d) => d.quoteRef === fixture.quoteRef)).toBe(false);
    });
  });

  it("does not sweep a commitment still inside its window", async () => {
    await rolledBack(async (tx) => {
      const s = await subject(tx);
      const quote = await quoteFor(tx, s.availableCents / 8n, "in-window");
      expect((await store.acceptQuote({ quoteRef: quote.quoteRef }, tx)).ok).toBe(true);

      const due = await hold.findLapsedCommitments({ conn: tx });
      expect(due.some((row) => row.quoteRef === quote.quoteRef)).toBe(false);
    });
  });
});

/* ========================================================================== */
/* 5. The invariant can fail                                                  */
/* ========================================================================== */

run("v_fx_commitment_unheld", () => {
  it("is empty on this book", async () => {
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM v_fx_commitment_unheld`;
    expect(rows[0]?.n).toBe(0);
  });

  it("RETURNS A ROW for an acceptance that placed no hold", async () => {
    await rolledBack(async (tx) => {
      const s = await subject(tx);
      const quote = await quoteFor(tx, s.availableCents / 16n, "unheld");

      // The acceptance, written directly — no `acceptQuote()`, therefore no
      // hold. This is precisely the state the guard exists to catch: a
      // commitment standing against a balance it does not reserve.
      const actors = await tx<{ id: string }[]>`
        SELECT id FROM actor WHERE kind = 'system' AND display_name = 'ledger-poster' LIMIT 1`;
      const actorId = actors[0]?.id;
      if (actorId === undefined) throw new Error("no ledger-poster actor");

      await tx`
        INSERT INTO fx_quote_acceptance (quote_id, accepted_by)
        SELECT id, ${actorId}::uuid FROM fx_quote WHERE quote_ref = ${quote.quoteRef}`;

      const rows = await tx<
        { quote_ref: string; finding: string; committed_cents: bigint; withheld_cents: bigint }[]
      >`
        SELECT quote_ref, finding, committed_cents, withheld_cents
          FROM v_fx_commitment_unheld WHERE quote_ref = ${quote.quoteRef}`;
      const row = rows[0];
      expect(row, "the guard did not see an unheld commitment").toBeDefined();
      if (row === undefined) return;
      expect(row.finding).toBe("no_hold_placed");
      expect(row.withheld_cents).toBe(0n);
      expect(row.committed_cents).toBe(quote.sellCents);
    });
  });

  it("REFUSES a commitment hold for a quote nobody accepted", async () => {
    await rolledBack(async (tx) => {
      const s = await subject(tx);
      const quote = await quoteFor(tx, s.availableCents / 16n, "unaccepted");

      let message: string | null = null;
      try {
        await (tx as unknown as Scoped).savepoint(async (scoped) => {
          const sp = scoped as typeof SqlHandle;
          const holds = await sp<{ id: string }[]>`
            INSERT INTO hold (account_id, memo_account_id, kind, external_ref, value_date)
            VALUES (${s.accountId}::uuid, ${s.memoAccountId}::uuid, 'manual',
                    ${`fx_quote:UNACCEPTED-${RUN_ID}`}, book_date(clock_timestamp())::date)
            RETURNING id`;
          const actors = await sp<{ id: string }[]>`
            SELECT id FROM actor WHERE kind = 'system' AND display_name = 'ledger-poster' LIMIT 1`;
          await sp`
            INSERT INTO fx_commitment_hold (quote_id, hold_id, sell_cents, placed_by)
            SELECT q.id, ${holds[0]?.id ?? null}::uuid, q.sell_cents, ${actors[0]?.id ?? null}::uuid
              FROM fx_quote q WHERE q.quote_ref = ${quote.quoteRef}`;
        });
      } catch (thrown) {
        message = thrown instanceof Error ? thrown.message : String(thrown);
      }
      expect(message, "the database ALLOWED a hold for an unaccepted quote").not.toBeNull();
      expect(message ?? "").toMatch(/has not been accepted/);
    });
  });
});
