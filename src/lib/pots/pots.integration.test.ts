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
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

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

d("pots, against the live database", () => {
  let sql: typeof SqlHandle;
  let bal: typeof BalancesModule;
  let store: typeof StoreModule;
  let transfer: typeof TransferModule;

  let potId: string;
  let potAccountId: string;
  let mainAccountId: string;

  /** Unique per run, so the moves that must POST actually post. */
  const run = Date.now();

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    bal = await import("@/lib/ledger/balances");
    store = await import("./store");
    transfer = await import("./transfer");

    await provisionTestAccount();

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
    const opened = await transfer.openPot(
      {
        businessId: TEST_BUSINESS_ID,
        name: POT_NAME,
        purpose: "Wages set aside by the pots integration suite",
      },
      sql,
    );

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
    await expect(
      sql.unsafe(
        `UPDATE journal_line SET amount_cents = amount_cents WHERE entry_id = '${entries[0]?.id}'`,
      ),
    ).rejects.toThrow();
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
});
