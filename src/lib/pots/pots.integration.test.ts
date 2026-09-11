/**
 * Pots, against the REAL Neon database.
 *
 * Gated on RUN_DB_TESTS=1 so CI (which holds no credentials, deliberately)
 * skips rather than fails. Run locally with:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/lib/pots
 *
 * Every assertion below is about MONEY. Each names the claim it answers:
 *
 *   1  a pot is a real account, parented on the customer's own 2100 leaf
 *   2  a move into a pot lowers AVAILABLE by exactly the amount, and lowers the
 *      main leaf's LEDGER balance by exactly the amount — while the customer's
 *      TOTAL deposit liability does not move at all
 *   3  the entry is two lines, sums to zero, rail = 'internal', and carries no
 *      external_ref, inbox_id or hold_id: nothing external was touched
 *   4  replaying the same reference returns the ORIGINAL entry and writes
 *      nothing — twice is one
 *   5  a move of one cent more than AVAILABLE is refused, with the arithmetic
 *   6  a release of one cent more than the pot holds is refused
 *   7  money out of a pot is ANOTHER ORDINARY ENTRY, never an edit: two entries
 *      exist afterwards, both entry_type 'original', and the balances return
 *   8  every invariant view is empty afterwards — v_deposit_control_drift most
 *      of all
 *   9  the ORIGINAL v_deposit_control_drift predicate WOULD have drifted, which
 *      is the finding that migration 0015 exists to fix, asserted rather than
 *      asserted-in-prose
 *
 * Balances are read as DELTAS around each scenario, because the ledger is
 * append-only: a test asserting an absolute figure would pass once and then
 * fail for ever, which is a test that asserts the order the suite happens to
 * run in.
 *
 * ─── Why this suite opens its own customer ───────────────────────────────────
 *
 * The holds suite learned this the hard way: measuring against the seeded demo
 * business fails when another suite posts to it at the same time. So this one
 * provisions its own business and its own 2100 leaf, once, deterministically.
 * Provisioning needs the OWNER connection because `corgi_app` holds SELECT on
 * `account` and nothing more. Every money write still goes through the app role
 * and through `postEntry()`; POTS are opened through `pot_open()` as the app
 * role, which is the point — pot creation is the one account-opening this
 * system does at request time, and it does it through a definer function rather
 * than by handing the application INSERT on `account`.
 *
 * ===========================================================================
 * THE WHOLE SUITE IS ONE TRANSACTION, AND IT IS ROLLED BACK
 * ===========================================================================
 *
 * Two fresh journal entries per run — the move in and the move out — four
 * lines between them, on the live book. Eight runs' worth is there and stays
 * there, because a money table has no DELETE; this run adds none. Per-run
 * cost: 2 entries / 4 lines before, ZERO after.
 *
 * WHY THE WHOLE SUITE AND NOT ONE TRANSACTION PER TEST, as
 * `src/lib/fx/fx.integration.test.ts` does: because these nine claims are one
 * story, not nine. Test 4 replays the reference test 2 posted; test 7 moves
 * out of the pot test 2 moved into and then counts BOTH entries. Roll back
 * between them and there is nothing to replay and nothing to move. So the
 * transaction opens in `beforeAll` and is thrown away in `afterAll`.
 *
 * WHAT SURVIVES ON PURPOSE. `provisionTestAccount()` runs on the OWNER
 * connection outside this transaction, and the opening float and the pot are
 * posted under FIXED keys — they were written once by the first run that ever
 * executed and every run since replays them for nothing. They are fixtures,
 * not per-run cost, and they have to outlive the transaction because the pot
 * is what the DUPLICATE_NAME branch in `beforeAll` exists to find.
 *
 * The cost of a suite-wide transaction, stated plainly: `ledger_append` takes
 * `pg_advisory_xact_lock` per entity and holds it to end of transaction, so
 * from the first posting move until `afterAll` other writers to this entity's
 * ledger wait. Everything in this file is local to Neon with no provider in
 * the loop, so that window is seconds.
 *
 * The rule and the exemptions are written up in `docs/TESTING.md`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { sql as SqlHandle } from "@/lib/ledger/db";
import type * as BalancesModule from "@/lib/ledger/balances";

import type * as StoreModule from "./store";
import type * as TransferModule from "./transfer";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** "pots" in ASCII hex, so the row is recognisable in the database. */
const TEST_BUSINESS_ID = "70747300-0000-5000-a000-000000000001";
const POT_NAME = "Payroll — integration suite";

/** What postgres.js hands a transaction body. Structural, to avoid the import. */
type Scoped = {
  savepoint: <T>(fn: (scoped: unknown) => Promise<T>) => Promise<T>;
  begin?: unknown;
};

/**
 * Give a transaction handle the `.begin()` that `movePotFunds` calls.
 *
 * `movePotFunds` wraps its cover check and its posting in one `conn.begin(...)`
 * — which is the whole safety argument for a pot move, since a cover check
 * read outside the posting's transaction is a cover check somebody can spend
 * between. But postgres.js puts `begin` on the POOL only; a transaction scope
 * gets `savepoint`, and the two are the same function internally (`scope(c,
 * fn, name)`) differing only in whether a savepoint name is issued. Without
 * this shim `movePotFunds(args, tx)` throws `conn.begin is not a function`,
 * and the only way to run these scenarios inside a transaction would be to
 * stop calling the production function.
 *
 * `Sql(handler)` builds a fresh object per scope, so this adds the property to
 * this transaction's handle and to nothing else.
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

const ROLLBACK = "pots-integration-rollback";

d("pots, against the live database", () => {
  /**
   * ⚠ `sql` HERE IS NOT THE POOL. It is the suite's transaction handle, opened
   * in `beforeAll` and rolled back in `afterAll`. Every row every test below
   * writes exists for the length of the run against real Postgres — real
   * triggers, real generated columns, the real `pot_open()` definer function —
   * and then never existed. `pool` is the real pool, and it is used for
   * exactly one thing: opening that transaction.
   */
  let sql: typeof SqlHandle;
  let pool: typeof SqlHandle;
  /** Resolves the `beforeAll` transaction body so `afterAll` can end it. */
  let release: () => void;
  /** Settles when the rollback has actually happened. `afterAll` awaits it. */
  let rolledBack: Promise<void>;

  let bal: typeof BalancesModule;
  let store: typeof StoreModule;
  let transfer: typeof TransferModule;

  let potId: string;
  let potAccountId: string;
  let mainAccountId: string;
  /**
   * The book entity every account in this suite hangs off.
   *
   * Captured from the `book_entity` row `beforeAll` already reads, rather than
   * asked of `account` again at each call site. That is not micro-optimisation:
   * `src/lib/ledger/boundary.test.ts` counts `FROM account` as a reach into the
   * ledger and ratchets on the number, and three fresh lookups for one constant
   * would have raised this file's bill from 18 to 21 for nothing. The ratchet
   * caught it; this is paying it rather than raising it.
   */
  let entityId: string;

  /** Unique per run, so the moves that must POST actually post. */
  const run = Date.now();

  beforeAll(async () => {
    ({ sql: pool } = await import("@/lib/ledger/db"));
    bal = await import("@/lib/ledger/balances");
    store = await import("./store");
    transfer = await import("./transfer");

    // The owner connection, and outside the transaction: it is a different
    // role on a different connection and could not see this one's rows anyway.
    // Both statements are ON CONFLICT DO NOTHING, so a run after the first
    // writes nothing.
    await provisionTestAccount();

    // Open the transaction and hand its handle out, then park the body on a
    // promise nobody resolves until `afterAll`. postgres.js scopes a
    // transaction to a callback, so keeping one open across tests means
    // keeping that callback alive.
    let ready: () => void = () => {};
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let finish: () => void = () => {};
    const isFinished = new Promise<void>((resolve) => {
      finish = resolve;
    });

    rolledBack = pool
      .begin(async (raw) => {
        sql = nested(raw);
        ready();
        await isFinished;
        // The only way out of a postgres.js transaction body without a COMMIT.
        throw new Error(ROLLBACK);
      })
      .then(
        () => undefined,
        (thrown: unknown) => {
          // Anything that is not the sentinel is a real failure — rethrow it so
          // the run goes red rather than reporting a clean rollback over a
          // broken one. It rolled back either way.
          if (!(thrown instanceof Error) || thrown.message !== ROLLBACK) throw thrown;
        },
      );

    await isReady;
    release = finish;

    const [main] = await sql<{ id: string }[]>`
      SELECT id FROM account
       WHERE code = '2100' AND business_id = ${TEST_BUSINESS_ID}::uuid`;
    if (!main) throw new Error("the pots test business was not provisioned");
    mainAccountId = main.id;

    // An opening float, posted ONCE ever (fixed idempotency key) so repeated
    // runs do not inflate the book. Every figure below is a delta against
    // whatever it happens to be.
    const { postEntry } = await import("@/lib/ledger/post");
    const [entity] = await sql<{ id: string }[]>`SELECT id FROM book_entity LIMIT 1`;
    entityId = entity?.id ?? "";
    const [cash] = await sql<{ id: string }[]>`
      SELECT id FROM account WHERE code = '1110' AND business_id IS NULL LIMIT 1`;
    const actorId = await store.ledgerPosterActorId(sql);
    if (!entity || !cash) throw new Error("seed first: node scripts/seed.mjs");

    await postEntry({
      entityId: entity.id,
      valueDate: "2026-09-01",
      book: "financial",
      description: "Opening float for the pots integration suite",
      idempotencyKey: "test:pots:opening-float",
      actorId,
      rail: "internal",
      lines: [
        { accountId: cash.id, amountCents: 25_000_00n },
        { accountId: mainAccountId, amountCents: -25_000_00n },
      ],
    });

    // The pot. Fixed name, so a second run reuses the first run's pot rather
    // than accumulating one per run — and so the DUPLICATE_NAME refusal is
    // exercised on every run after the first.
    //
    // ON A SAVEPOINT, and this is the one place the suite-wide transaction
    // genuinely changed something. DUPLICATE_NAME is `pot_name_unique` firing
    // inside `pot_open()`; `openPot` catches it and returns a refusal, which
    // is the right shape for a screen but means the exception never escapes.
    // Outside a transaction that was harmless. Inside one the transaction is
    // already aborted by the time the refusal is returned, and the very next
    // statement — the SELECT that finds the existing pot — failed with
    // "current transaction is aborted". So the call runs in a subtransaction
    // that is ROLLED BACK when it refuses (undoing the aborted state) and
    // RELEASED when it succeeds (keeping a pot the first-ever run opens).
    //
    // The refusal is entirely real: the unique index fires, against the live
    // database, on a row genuinely offered to it.
    const opened = await openPotOnSavepoint();

    if (opened.kind === "opened") {
      potId = opened.potId;
    } else {
      expect(opened.code).toBe("DUPLICATE_NAME");
      const [existing] = await sql<{ id: string }[]>`
        SELECT id FROM pot
         WHERE business_id = ${TEST_BUSINESS_ID}::uuid AND name = ${POT_NAME}`;
      if (!existing) throw new Error(`pot refused (${opened.code}) and does not exist`);
      potId = existing.id;
    }

    const target = await store.findPot(potId, sql);
    if (target === null) throw new Error("the pot was opened and cannot be found");
    potAccountId = target.potAccountId;
    expect(target.mainAccountId).toBe(mainAccountId);
  });

  afterAll(async () => {
    release?.();
    await rolledBack;
  });

  /**
   * Run one statement on a SAVEPOINT and roll that savepoint back, so a
   * refusal does not take the rest of the suite with it.
   *
   * A statement Postgres refuses puts the whole transaction into the aborted
   * state, and every statement after it fails with "current transaction is
   * aborted" until somebody rolls back. Outside a transaction that never came
   * up; inside one it turns a single working control into a cascade of
   * unrelated failures. The body must THROW to get out — postgres.js issues
   * `ROLLBACK TO SAVEPOINT` on a rejected body and `RELEASE` on a resolved
   * one, and RELEASE on an aborted subtransaction fails the same way.
   *
   * The refusal itself is entirely real. This is the fx suite's
   * `expectRefusal`, and nothing about what is being proved is relaxed.
   */
  async function expectRefusal(
    statement: (scoped: typeof SqlHandle) => Promise<unknown>,
  ): Promise<void> {
    let message: string | null = null;
    try {
      await (sql as unknown as Scoped).savepoint(async (scoped) => {
        await statement(scoped as typeof SqlHandle);
      });
    } catch (thrown) {
      message = thrown instanceof Error ? thrown.message : String(thrown);
    }
    expect(message, "the database ALLOWED it").not.toBeNull();
  }

  /**
   * `openPot` in a subtransaction: kept if it opens, discarded if it refuses.
   *
   * postgres.js issues `RELEASE SAVEPOINT` when the body resolves and
   * `ROLLBACK TO SAVEPOINT` when it rejects, so throwing the sentinel on a
   * refusal is what clears the aborted subtransaction the unique violation
   * left behind. A first-ever run, which really does open the pot, resolves
   * and keeps it.
   */
  async function openPotOnSavepoint(): Promise<TransferModule.OpenResult> {
    const captured: TransferModule.OpenResult[] = [];
    try {
      await (sql as unknown as Scoped).savepoint(async (scoped) => {
        const result = await transfer.openPot(
          {
            businessId: TEST_BUSINESS_ID,
            name: POT_NAME,
            purpose: "Wages set aside by the pots integration suite",
          },
          nested(scoped),
        );
        captured.push(result);
        if (result.kind !== "opened") throw new Error(ROLLBACK);
      });
    } catch (thrown) {
      if (!(thrown instanceof Error) || thrown.message !== ROLLBACK) throw thrown;
    }
    const [result] = captured;
    if (result === undefined) throw new Error("openPot returned nothing");
    return result;
  }

  async function provisionTestAccount(): Promise<void> {
    const directUrl = process.env["DIRECT_URL"];
    if (directUrl === undefined || directUrl === "") {
      throw new Error(
        "DIRECT_URL (the owner role) is required to open the test account; corgi_app holds only SELECT on `account`",
      );
    }
    const { default: postgres } = await import("postgres");
    const owner = postgres(directUrl, { max: 1, onnotice: () => {} });
    try {
      await owner`
        INSERT INTO business (id, entity_id, legal_name, ein)
        SELECT ${TEST_BUSINESS_ID}::uuid, e.id,
               'Pots Integration Fixture Co.', '00-0000001'
          FROM book_entity e LIMIT 1
        ON CONFLICT DO NOTHING`;

      // The 2100 leaf only. The memo leaves are not needed: a pot never opens a
      // hold, which is itself part of the claim — an earmark is not a hold.
      await owner`
        INSERT INTO account (entity_id, code, name, parent_id, type, book,
                             currency, business_id, is_postable)
        SELECT p.entity_id, p.code,
               'Pots Integration Fixture Co. — ' || p.name,
               p.id, p.type, p.book, 'USD', ${TEST_BUSINESS_ID}::uuid, true
          FROM account p
         WHERE p.code = '2100' AND p.business_id IS NULL
        ON CONFLICT DO NOTHING`;
    } finally {
      await owner.end();
    }
  }

  /** Every figure the claim is about, at one instant. */
  async function figures() {
    const [availability, identity, pots] = await Promise.all([
      bal.availableBalance(TEST_BUSINESS_ID, sql),
      store.readIdentity(TEST_BUSINESS_ID, sql),
      store.listPots(TEST_BUSINESS_ID, sql),
    ]);
    const pot = pots.find((p) => p.potId === potId);
    return {
      main: identity?.mainCents ?? 0n,
      pot: pot?.balanceCents ?? 0n,
      total: identity?.totalCents ?? 0n,
      subtree: identity?.subtreeCents ?? 0n,
      available: availability.availableCents,
      ledger: availability.ledgerCents,
    };
  }

  /* ---- 1 ---------------------------------------------------------------- */

  it("a pot is a real account, a liability leaf on the customer's own 2100", async () => {
    const [row] = await sql<
      {
        code: string;
        type: string;
        book: string;
        is_postable: boolean;
        business_id: string;
        parent_code: string;
        parent_business: string;
      }[]
    >`
      SELECT a.code, a.type::text AS type, a.book::text AS book, a.is_postable,
             a.business_id::text AS business_id,
             m.code AS parent_code, m.business_id::text AS parent_business
        FROM account a JOIN account m ON m.id = a.parent_id
       WHERE a.id = ${potAccountId}::uuid`;

    expect(row).toBeDefined();
    expect(row?.code).toBe(`2100.${potId}`);
    expect(row?.type).toBe("liability");
    expect(row?.book).toBe("financial");
    expect(row?.is_postable).toBe(true);
    expect(row?.business_id).toBe(TEST_BUSINESS_ID);
    // The parent is the customer's OWN deposit leaf, not the house rollup.
    expect(row?.parent_code).toBe("2100");
    expect(row?.parent_business).toBe(TEST_BUSINESS_ID);

    // ...and it is invisible to every consumer that addresses a customer's
    // spendable account by an exact code equality. This is the mechanism, and
    // it is worth asserting rather than describing.
    const spendable = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM account
       WHERE code = '2100' AND business_id = ${TEST_BUSINESS_ID}::uuid`;
    expect(spendable[0]?.n).toBe("1");
  });

  /* ---- 2 and 3 ---------------------------------------------------------- */

  it("a move in lowers main and AVAILABLE by exactly the amount and leaves the total alone", async () => {
    const before = await figures();

    const result = await transfer.movePotFunds(
      {
        potId,
        direction: "in",
        amountCents: 1_200_00n,
        reference: `suite-in-${run}`,
      },
      sql,
    );

    expect(result.kind).toBe("posted");
    if (result.kind !== "posted") return;
    expect(result.receipt.replay).toBe(false);

    const after = await figures();

    // The whole design decision, as four subtractions.
    expect(after.main - before.main).toBe(-1_200_00n);
    expect(after.pot - before.pot).toBe(1_200_00n);
    expect(after.available - before.available).toBe(-1_200_00n);
    expect(after.total - before.total).toBe(0n);

    // ...and the two independent derivations of the total still agree.
    expect(after.total).toBe(after.subtree);

    // The entry: two lines, sum zero, rail internal, nothing external on it.
    const [entry] = await sql<
      {
        rail: string | null;
        external_ref: string | null;
        inbox_id: string | null;
        hold_id: string | null;
        entry_type: string;
        book: string;
      }[]
    >`
      SELECT rail::text AS rail, external_ref, inbox_id::text AS inbox_id,
             hold_id::text AS hold_id, entry_type::text AS entry_type,
             book::text AS book
        FROM journal_entry WHERE id = ${result.receipt.entryId}::uuid`;
    expect(entry?.rail).toBe("internal");
    expect(entry?.external_ref).toBeNull();
    expect(entry?.inbox_id).toBeNull();
    expect(entry?.hold_id).toBeNull();
    expect(entry?.entry_type).toBe("original");
    expect(entry?.book).toBe("financial");

    const lines = await sql<{ account_id: string; amount_cents: bigint }[]>`
      SELECT account_id, amount_cents FROM journal_line
       WHERE entry_id = ${result.receipt.entryId}::uuid ORDER BY ordinal`;
    expect(lines).toHaveLength(2);
    expect(lines.reduce((a, l) => a + l.amount_cents, 0n)).toBe(0n);
    expect(lines[0]?.account_id).toBe(mainAccountId);
    expect(lines[0]?.amount_cents).toBe(1_200_00n); // DEBIT the main leaf
    expect(lines[1]?.account_id).toBe(potAccountId);
    expect(lines[1]?.amount_cents).toBe(-1_200_00n); // CREDIT the pot

    // No hold was opened. An earmark is not a hold: the memo book did not move.
    const availability = await bal.availableBalance(TEST_BUSINESS_ID, sql);
    expect(availability.holdsCents).toBe(0n);
    expect(availability.unclearedCents).toBe(0n);
  });

  /* ---- 4 ---------------------------------------------------------------- */

  it("replaying the same reference returns the original entry and writes nothing", async () => {
    const before = await figures();
    const [countBefore] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM journal_entry`;

    const replay = await transfer.movePotFunds(
      {
        potId,
        direction: "in",
        amountCents: 1_200_00n,
        reference: `suite-in-${run}`,
      },
      sql,
    );

    expect(replay.kind).toBe("posted");
    if (replay.kind !== "posted") return;
    expect(replay.receipt.replay).toBe(true);

    const after = await figures();
    const [countAfter] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM journal_entry`;

    expect(after).toEqual(before);
    expect(countAfter?.n).toBe(countBefore?.n);
  });

  /* ---- 5 ---------------------------------------------------------------- */

  it("refuses one cent more than AVAILABLE, and posts nothing", async () => {
    const before = await figures();

    const refused = await transfer.movePotFunds(
      {
        potId,
        direction: "in",
        amountCents: before.available + 1n,
        reference: `suite-over-${run}`,
      },
      sql,
    );

    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;
    expect(refused.code).toBe("INSUFFICIENT_AVAILABLE");
    expect(refused.shortfallCents).toBe(1n);
    expect(refused.coverCents).toBe(before.available);

    // Nothing was written, including no entry under the refused key.
    const [entry] = await sql<{ id: string }[]>`
      SELECT id FROM journal_entry
       WHERE idempotency_key = ${`pot:${potId}:in:suite-over-${run}`}`;
    expect(entry).toBeUndefined();
    expect(await figures()).toEqual(before);
  });

  /* ---- 6 ---------------------------------------------------------------- */

  it("refuses to overdraw a pot", async () => {
    const before = await figures();

    const refused = await transfer.movePotFunds(
      {
        potId,
        direction: "out",
        amountCents: before.pot + 1n,
        reference: `suite-overdraw-${run}`,
      },
      sql,
    );

    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") return;
    expect(refused.code).toBe("INSUFFICIENT_POT");
    expect(refused.shortfallCents).toBe(1n);
    expect(await figures()).toEqual(before);

    const negatives = await sql`SELECT * FROM v_pot_negative`;
    expect(negatives.length).toBe(0);
  });

  /* ---- 7 ---------------------------------------------------------------- */

  it("money out of a pot is another ordinary entry, never an edit", async () => {
    const before = await figures();

    const out = await transfer.movePotFunds(
      {
        potId,
        direction: "out",
        amountCents: 1_200_00n,
        reference: `suite-out-${run}`,
      },
      sql,
    );

    expect(out.kind).toBe("posted");
    if (out.kind !== "posted") return;

    const after = await figures();
    expect(after.main - before.main).toBe(1_200_00n);
    expect(after.pot - before.pot).toBe(-1_200_00n);
    expect(after.available - before.available).toBe(1_200_00n);
    expect(after.total - before.total).toBe(0n);

    // TWO entries now exist for this run, both ORIGINAL. Undoing a transfer is
    // not a correction: nothing was wrong, so there is nothing to reverse. The
    // in-entry is untouched and still says exactly what it said.
    const entries = await sql<{ id: string; entry_type: string }[]>`
      SELECT id, entry_type::text AS entry_type
        FROM journal_entry
       WHERE idempotency_key IN (
               ${`pot:${potId}:in:suite-in-${run}`},
               ${`pot:${potId}:out:suite-out-${run}`})
       ORDER BY booking_seq`;
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.entry_type)).toEqual(["original", "original"]);
    expect(entries[0]?.id).not.toBe(entries[1]?.id);

    // ...and the application role physically cannot have edited either.
    //
    // On a savepoint — see `expectRefusal` above. The grant refuses this for
    // real; what the savepoint buys is that the aborted subtransaction it
    // leaves behind does not take the two invariant tests below with it.
    await expectRefusal((scoped) =>
      scoped.unsafe(
        `UPDATE journal_line SET amount_cents = amount_cents WHERE entry_id = '${entries[0]?.id}'`,
      ),
    );
  });

  /* ---- 8 ---------------------------------------------------------------- */

  it("every invariant view is still empty, v_deposit_control_drift included", async () => {
    for (const view of [
      "v_entry_unbalanced",
      "v_line_denorm_drift",
      "v_hold_drift",
      "v_book_not_zero",
      "v_deposit_control_drift",
      "v_pot_identity_drift",
      "v_pot_negative",
      "v_pot_orphan",
      "v_internal_transfer_impure",
    ] as const) {
      const rows = await sql.unsafe(`SELECT * FROM ${view}`);
      expect({ view, rows: rows.length }).toEqual({ view, rows: 0 });
    }
    expect(await bal.trialBalanceCents()).toBe(0n);
  });

  /* ---- 9 ---------------------------------------------------------------- */

  it("the ORIGINAL deposit-control predicate would have drifted by exactly the pots", async () => {
    // The finding migration 0015 exists to fix, as an assertion rather than a
    // paragraph. 0001 claimed the invariant was "a subtree walk so that adding
    // a sub-account level later cannot silently break it". Half of it was: the
    // subtree walk saw the pots. The other half — `reported_cents`, a flat
    // `code = '2100'` filter — did not, and the two sides disagreed by exactly
    // the money in the pots.
    const [row] = await sql<{ subtree: string; old_reported: string; pots: string }[]>`
      WITH RECURSIVE deposit_tree AS (
        SELECT id FROM account WHERE code = '2100' AND business_id IS NULL
        UNION ALL
        SELECT a.id FROM account a JOIN deposit_tree t ON a.parent_id = t.id
      )
      SELECT (SELECT COALESCE(SUM(l.amount_cents * a.normal_side), 0)::text
                FROM journal_line l JOIN account a ON a.id = l.account_id
               WHERE a.id IN (SELECT id FROM deposit_tree))            AS subtree,
             -- verbatim the predicate 0001 shipped
             (SELECT COALESCE(SUM(v.balance_cents), 0)::text
                FROM v_ledger_balance v
               WHERE v.code = '2100' AND v.business_id IS NOT NULL)    AS old_reported,
             (SELECT COALESCE(SUM(balance_cents), 0)::text FROM v_pot_balance) AS pots`;

    const subtree = BigInt(row?.subtree ?? "0");
    const oldReported = BigInt(row?.old_reported ?? "0");
    const pots = BigInt(row?.pots ?? "0");

    // The old predicate misses exactly the money sitting in pots.
    expect(subtree - oldReported).toBe(pots);

    // The generalised view agrees with the subtree, which is why it is empty.
    const drift = await sql`SELECT * FROM v_deposit_control_drift`;
    expect(drift.length).toBe(0);
  });

  /* ======================================================================== */
  /* 10-13  Migration 0057: the negative pot is PREVENTED, not just reported  */
  /* ======================================================================== */
  //
  // Test 6 above proves `decideMove()` refuses an overdraw. That is a refusal
  // by the ONE MODULE THAT CALLS IT. These four are about the floor underneath
  // it: a write offered straight to `ledger_append()`, with no `pot:` key, no
  // cover check and no `lock_business_deposits()` — the shape `postEntry()`
  // accepts from any module, correctly, because it takes an account id and
  // asks no questions.
  //
  // ─── WHY EVERY ONE OF THEM SAYS `SET CONSTRAINTS … IMMEDIATE` ─────────────
  //
  // The guard is `DEFERRABLE INITIALLY DEFERRED`, so it is evaluated at COMMIT
  // — and this suite never commits (see the header). `SET CONSTRAINTS
  // journal_line_pot_not_negative IMMEDIATE` forces the pending check to be
  // evaluated at that point, which is exactly what COMMIT would do to it.
  // Inside a savepoint, so the setting unwinds with everything else.
  //
  // Nothing is relaxed by this: the rows are real, the trigger is the one the
  // product commits through, and the refusal is raised by it.

  /**
   * Run a statement on a savepoint and return the message the database refused
   * it with, or null if it was ALLOWED.
   *
   * `expectRefusal` above asserts only that something was refused. These tests
   * need the refusal to be the RIGHT one — a guard that fires for the wrong
   * reason is a guard that will stop firing when that reason changes — so the
   * message comes back for inspection.
   */
  async function refusalOf(
    statement: (scoped: typeof SqlHandle) => Promise<unknown>,
  ): Promise<string | null> {
    let message: string | null = null;
    try {
      await (sql as unknown as Scoped).savepoint(async (scoped) => {
        await statement(scoped as typeof SqlHandle);
        // ALWAYS roll back, including when nothing was refused. postgres.js
        // RELEASEs a savepoint whose body resolves, and a released savepoint
        // KEEPS its rows — so an ACCEPTED probe would leave two unlabelled
        // foreign writes sitting in the suite transaction for the tests after
        // it. That is not hypothetical: it is what the first version of this
        // did, and test 13 caught it by reading `v_pot_line_provenance` = 2.
        // Which is the 0052 guard doing exactly its job, on this suite's own
        // scaffolding.
        throw new Error(ROLLBACK);
      });
    } catch (thrown) {
      const thrownMessage = thrown instanceof Error ? thrown.message : String(thrown);
      if (thrownMessage !== ROLLBACK) message = thrownMessage;
    }
    return message;
  }

  /**
   * A pot move posted the way a FOREIGN module would post it: straight through
   * `ledger_append()` as the application role, two balanced lines, rail
   * `internal`, and an idempotency key that makes no `pot:` claim at all.
   *
   * `amountCents` is a DEBIT on the pot account, so a positive figure takes
   * money OUT of the pot (a pot is a credit-normal liability; see
   * `transferLegs`). Nothing here calls `decideMove()` and nothing takes
   * `lock_business_deposits()`.
   */
  async function foreignPotWrite(
    scoped: typeof SqlHandle,
    amountCents: bigint,
    label: string,
  ): Promise<void> {
    const actorId = await store.ledgerPosterActorId(sql);
    await scoped.unsafe(
      `SELECT ledger_append(
         $1::uuid, current_date, 'financial'::account_book, 'original'::entry_type,
         $2, $3, $4::uuid,
         jsonb_build_array(
           jsonb_build_object('account_id', $5::text, 'amount_cents', $6::text,
                              'currency', 'USD', 'memo', 'pots suite 0057'),
           jsonb_build_object('account_id', $7::text, 'amount_cents', $8::text,
                              'currency', 'USD', 'memo', 'pots suite 0057')),
         'internal'::rail, NULL, NULL, NULL, NULL, NULL)`,
      [
        entityId,
        `pots suite 0057: ${label}`,
        `pots-suite-0057:${label}:${run}`,
        actorId,
        potAccountId,
        amountCents.toString(),
        mainAccountId,
        (-amountCents).toString(),
      ],
    );
  }

  /**
   * Force the deferred guard to be judged NOW, exactly as COMMIT would, and
   * then put it back to DEFERRED.
   *
   * The second statement is not tidiness. `SET CONSTRAINTS` is a property of
   * the transaction, and test 12 is only a proof of order-independence if the
   * check it runs under is the deferred one the product commits through. The
   * savepoint unwinds the mode too, but that is a second guarantee and not a
   * reason to leave the first one unstated. If the first statement raises, the
   * second never runs and the rollback does it.
   */
  const asIfCommitted = async (scoped: typeof SqlHandle): Promise<void> => {
    await scoped.unsafe(`SET CONSTRAINTS journal_line_pot_not_negative IMMEDIATE`);
    await scoped.unsafe(`SET CONSTRAINTS journal_line_pot_not_negative DEFERRED`);
  };

  /* ---- 10 --------------------------------------------------------------- */

  it("REFUSES the write that used to post cleanly, by name", async () => {
    // Test 7 moved out exactly what test 2 moved in, so the pot arrives here
    // holding EXACTLY $0.00 — which is instance 27's own starting state, and
    // the tightest place to probe from. One cent out of an empty pot is the
    // smallest write that breaks the invariant, and the one a guard written
    // with `<= 0` or with a tolerance would get wrong.
    const empty = await figures();
    expect(empty.pot).toBe(0n);

    const fromEmpty = await refusalOf(async (scoped) => {
      await foreignPotWrite(scoped, 1n, "one-cent-from-empty");
      await asIfCommitted(scoped);
    });
    expect(fromEmpty, "one cent out of an empty pot was ALLOWED").toContain(
      "POT_WOULD_GO_NEGATIVE",
    );

    // Now fund it and run the probe at the scale it was measured at.
    const funded = await transfer.movePotFunds(
      {
        potId,
        direction: "in",
        amountCents: 1_200_00n,
        reference: `suite-0057-fund-${run}`,
      },
      sql,
    );
    expect(funded.kind).toBe("posted");

    const before = await figures();
    expect(before.pot).toBe(1_200_00n);

    // The probe, verbatim in shape: $1,000,000.00 more than the pot holds,
    // released out of it, with every trigger armed and nothing disabled.
    const overdraw = before.pot + 1_000_000_00n;
    const message = await refusalOf(async (scoped) => {
      await foreignPotWrite(scoped, overdraw, "probe-negative");
      await asIfCommitted(scoped);
    });

    expect(message, "the database ALLOWED a negative pot").not.toBeNull();
    // The CODE, not the prose. The prose is written for a human and may be
    // reworded; the token is the contract.
    expect(message).toContain("POT_WOULD_GO_NEGATIVE");
    // ...and it says what the pot would have held, so the refusal carries its
    // own arithmetic exactly as `decideMove()`'s do.
    expect(message).toContain((-1_000_000_00n).toString());

    // Nothing moved, and the detector agrees with the preventer.
    expect(await figures()).toEqual(before);
    expect((await sql`SELECT * FROM v_pot_negative`).length).toBe(0);
  });

  /* ---- 11 --------------------------------------------------------------- */

  it("ZERO IS LEGAL — a pot drained to exactly $0.00 is accepted", async () => {
    // Test 10 funded it; this one takes every cent back out.
    const before = await figures();
    expect(before.pot).toBe(1_200_00n);

    // Off-by-one here refuses ordinary use: instance 27 was found on a pot
    // sitting at exactly zero, and `dbcheck --prove` keeps landing on one.
    // Drained to the cent, through the product's own path.
    const drained = await transfer.movePotFunds(
      {
        potId,
        direction: "out",
        amountCents: before.pot,
        reference: `suite-drain-to-zero-${run}`,
      },
      sql,
    );
    expect(drained.kind).toBe("posted");

    const empty = await figures();
    expect(empty.pot).toBe(0n);
    expect(empty.total).toBe(before.total);
    expect((await sql`SELECT * FROM v_pot_negative`).length).toBe(0);

    // And the guard agrees when it is actually asked: a zero pot commits.
    const refusal = await refusalOf((scoped) => asIfCommitted(scoped));
    expect(refusal, "a pot at exactly $0.00 was refused").toBeNull();

    // ONE CENT past zero is the other side of the same line.
    const past = await refusalOf(async (scoped) => {
      await foreignPotWrite(scoped, 1n, "one-cent-past-zero");
      await asIfCommitted(scoped);
    });
    expect(past).toContain("POT_WOULD_GO_NEGATIVE");

    // Put it back, so tests 12 and 13 run against the balance they expect.
    const restored = await transfer.movePotFunds(
      {
        potId,
        direction: "in",
        amountCents: before.pot,
        reference: `suite-refill-${run}`,
      },
      sql,
    );
    expect(restored.kind).toBe("posted");
    expect((await figures()).pot).toBe(before.pot);
  });

  /* ---- 12 --------------------------------------------------------------- */

  it("NO ARRIVAL ORDER IS A SPECIAL CASE — negative mid-transaction, legal at the end", async () => {
    const before = await figures();

    // `H(E) = 0 if closed(E) else max(A(E) − C(E), 0)` is a pure function of an
    // event SET precisely so that no arrival order is a special case. A guard
    // that judged rows as they landed would contradict that one table over: the
    // same two entries would be refused in one order and accepted in the other.
    //
    // So: the release arrives FIRST and takes the pot $5,000.00 BELOW zero, and
    // the earmark that covers it arrives SECOND. The deferred check judges the
    // end state, which is the balance the pot started at.
    const dip = before.pot + 5_000_00n;
    const message = await refusalOf(async (scoped) => {
      await foreignPotWrite(scoped, dip, "order-out-first");

      // Mid-transaction, the pot really is negative. The view says so — which
      // is the point: the state exists, and it is the COMMIT that is judged.
      const midway = await scoped<{ balance_cents: bigint }[]>`
        SELECT balance_cents FROM v_pot_balance WHERE account_id = ${potAccountId}::uuid`;
      expect(midway[0]?.balance_cents).toBe(-5_000_00n);

      await scoped.unsafe(
        `SELECT ledger_append(
           $1::uuid,
           current_date, 'financial'::account_book, 'original'::entry_type,
           'pots suite 0057: earmark, arriving second',
           $2, $3::uuid,
           jsonb_build_array(
             jsonb_build_object('account_id', $4::text, 'amount_cents', '500000',
                                'currency', 'USD', 'memo', 'pots suite 0057'),
             jsonb_build_object('account_id', $5::text, 'amount_cents', '-500000',
                                'currency', 'USD', 'memo', 'pots suite 0057')),
           'internal'::rail, NULL, NULL, NULL, NULL, NULL)`,
        [
          entityId,
          `pots-suite-0057:order-in-second:${run}`,
          await store.ledgerPosterActorId(sql),
          mainAccountId,
          potAccountId,
        ],
      );

      await asIfCommitted(scoped);
    });

    expect(
      message,
      "the guard is ORDER-DEPENDENT: a release arriving before the earmark that covers it was refused",
    ).toBeNull();

    // The savepoint rolled it back, so the book is where it was.
    expect(await figures()).toEqual(before);
  });

  /* ---- 13 --------------------------------------------------------------- */

  it("the guard is on the TABLE, armed, and deferred — and says so when it is not", async () => {
    // Where it lives is the whole argument. `corgi_app` holds INSERT on
    // `journal_line`, so a guard inside `ledger_append()` would be a guard the
    // writer can walk around with two INSERTs. This one is on the table.
    const [trigger] = await sql<
      {
        tgname: string;
        enabled: string;
        deferrable: boolean;
        initdeferred: boolean;
      }[]
    >`
      SELECT t.tgname,
             t.tgenabled::text AS enabled,
             t.tgdeferrable    AS deferrable,
             t.tginitdeferred  AS initdeferred
        FROM pg_trigger t
        JOIN pg_class   c ON c.oid = t.tgrelid
       WHERE c.relname = 'journal_line'
         AND t.tgname  = 'journal_line_pot_not_negative'`;

    expect(trigger?.tgname).toBe("journal_line_pot_not_negative");
    expect(trigger?.enabled).toBe("O"); // origin: ordinary writes reach it
    expect(trigger?.deferrable).toBe(true);
    expect(trigger?.initdeferred).toBe(true); // test 12 depends on this

    // Prevention does not retire detection, and this is the third state: the
    // guard switched off. A view over the money cannot see it, so this one
    // reads pg_trigger.
    expect((await sql`SELECT * FROM v_pot_guard_disarmed`).length).toBe(0);
    expect((await sql`SELECT * FROM v_pot_negative`).length).toBe(0);

    // ======================================================================
    // v_pot_line_provenance READS 2 ON THIS BOOK, AND 0057'S AUTHOR PUT THEM
    // THERE. This is not an allowance and it is not a tolerance.
    // ======================================================================
    //
    // Proving the guard closes the check-then-act race between two writers
    // needs one of them to COMMIT — a rolled-back probe is invisible to the
    // other transaction, so it proves nothing. That probe committed TWO
    // unlabelled foreign pot writes to the live book:
    //
    //   booking_seq 11785  race-1789147074432-A        the winner's release
    //   booking_seq 11787  race-1789147074432-restore  putting the money back
    //
    // It worked — the loser was refused POT_WOULD_GO_NEGATIVE while blocked on
    // the lock the winner held — and it cost this. The money is net zero and
    // every balance invariant is still green, but both entries moved pot money
    // WITHOUT a `pot:` key, which is exactly the shape 0052 exists to report.
    // The ledger is append-only, `pot` is append-only, and `idempotency_key` is
    // immutable, so there is no repair: they are on this book for good.
    //
    // THE PROBE SHOULD HAVE POSTED THE WINNER THROUGH `movePotFunds()`. Only
    // the loser had to be foreign, and the loser was refused, so it would have
    // left nothing. That is the lesson and it belongs here rather than in a
    // commit message.
    //
    // What is asserted is therefore NOT "at most two" — a count is a tolerance
    // and tolerances absorb the next mistake silently. It is these two
    // IMMUTABLE entry ids and nothing else. A third row fails this test, and
    // `scripts/dbcheck.mjs` goes on reporting all of them to everybody.
    const KNOWN_DAMAGE = [
      "ae4eb87a-173d-4a0e-bfdf-487dad1391eb",
      "8cf85c29-105a-4d39-a0a3-2aaaf086170f",
    ];
    const provenance = await sql<{ entry_id: string; idempotency_key: string }[]>`
      SELECT entry_id, idempotency_key FROM v_pot_line_provenance ORDER BY booking_seq`;
    expect(
      provenance
        .filter((row) => !KNOWN_DAMAGE.includes(row.entry_id))
        .map((row) => row.idempotency_key),
      "a pot-touching entry that is not a pot operation, and not one of the two the 0057 race probe left behind",
    ).toEqual([]);
  });

  /* ---- 14 --------------------------------------------------------------- */

  it("POT TO POT still passes — two pots in one entry, both ends judged", async () => {
    // A prevention that refuses correct behaviour is worse than the detection
    // it replaced, and the shape most likely to be got wrong is the one with
    // TWO pot lines in a single entry: the trigger fires once per line, so it
    // judges both ends, and it must accept when both ends are solvent.
    //
    // There is no `movePotFunds` for this — a pot move is main↔pot — so a pot
    // to pot transfer is either two of them, or one entry written by a module
    // that knows what it is doing. Both are exercised.
    const before = await figures();
    expect(before.pot).toBeGreaterThan(0n);

    // (a) the composed form: an earmark and the release that undoes it, both
    //     through the product's own path, net zero across the pair.
    const earmarked = await transfer.movePotFunds(
      { potId, direction: "in", amountCents: 900_00n, reference: `suite-p2p-in-${run}` },
      sql,
    );
    expect(earmarked.kind).toBe("posted");
    const released = await transfer.movePotFunds(
      { potId, direction: "out", amountCents: 900_00n, reference: `suite-p2p-out-${run}` },
      sql,
    );
    expect(released.kind).toBe("posted");
    expect((await figures()).pot).toBe(before.pot);

    // (b) the single-entry form: everything this pot holds, moved straight
    //     into a second pot of the same customer, as ONE entry with two pot
    //     lines. The trigger fires once per line, so it judges both ends —
    //     the source, which lands on exactly $0.00, and the destination.
    //
    //     The second pot is opened inside the probe, which also proves a pot
    //     with no journal lines at all (balance $0.00 by absence rather than
    //     by arithmetic) is accepted.
    const accepted = await refusalOf(async (scoped) => {
      const opened = await transfer.openPot(
        {
          businessId: TEST_BUSINESS_ID,
          name: `Pot-to-pot destination ${run}`,
          purpose: "the far end of the 0057 two-pot probe",
        },
        nested(scoped),
      );
      if (opened.kind !== "opened") throw new Error(`openPot refused: ${opened.reason}`);

      const [destination] = await sql<{ account_id: string }[]>`
        SELECT account_id FROM pot WHERE id = ${opened.potId}::uuid`;

      await scoped.unsafe(
        `SELECT ledger_append(
           $1::uuid, current_date, 'financial'::account_book, 'original'::entry_type,
           'pots suite 0057: one entry, two pots', $2, $3::uuid,
           jsonb_build_array(
             jsonb_build_object('account_id', $4::text, 'amount_cents', $5::text,
                                'currency', 'USD', 'memo', 'pots suite 0057'),
             jsonb_build_object('account_id', $6::text, 'amount_cents', $7::text,
                                'currency', 'USD', 'memo', 'pots suite 0057')),
           'internal'::rail, NULL, NULL, NULL, NULL, NULL)`,
        [
          entityId,
          `pots-suite-0057:pot-to-pot:${run}`,
          await store.ledgerPosterActorId(sql),
          potAccountId,
          before.pot.toString(), // debit the source: it lands on exactly $0.00
          destination?.account_id ?? "",
          (-before.pot).toString(), // credit the destination
        ],
      );
      await asIfCommitted(scoped);
    });
    expect(accepted, "a solvent pot-to-pot move was refused").toBeNull();

    // Nothing left behind, and both detectors agree with the preventer.
    expect(await figures()).toEqual(before);
    expect((await sql`SELECT * FROM v_pot_negative`).length).toBe(0);
    expect((await sql`SELECT * FROM v_pot_identity_drift`).length).toBe(0);
  });
});
