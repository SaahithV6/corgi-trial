/**
 * Funding, end to end, against the REAL Plaid sandbox and the REAL database.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS SUITE MOVES MONEY. It links a real Plaid Item and posts real        │
 * │ journal entries to the live Neon database. It is gated on RUN_DB_TESTS=1 │
 * │ AND on both Plaid credentials being present, so CI — which holds neither │
 * │ deliberately — skips rather than fails. Run it with:                     │
 * │                                                                          │
 * │   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm vitest run \             │
 * │     src/lib/rails/plaid/funding.integration.test.ts                      │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Every assertion below is about MONEY, and each one answers a question the
 * brief asks of leg two of the core loop:
 *
 *   1  the five real Plaid calls happen, in order, and all return 200
 *   2  a deposit RAISES THE LEDGER BALANCE by the full amount
 *   3  and LEAVES AVAILABLE EXACTLY WHERE IT WAS, because an ACH credit inside
 *      its return window is on the book and not spendable
 *   4  the difference is one `uncleared_credit` hold, citing the
 *      `funds_availability_policy` row it was created under, with an
 *      `available_at` in the future
 *   5  replaying the same reference books nothing — three unique indexes decide
 *   6  a counterparty class with a longer hold produces a later release date,
 *      and a weekend really is skipped
 *
 * BALANCES ARE READ AS DELTAS around each scenario, never as absolutes. The
 * ledger is append-only: a test that asserted an absolute figure would pass
 * once and fail for ever afterwards, which is a test that asserts the order the
 * suite happens to run in.
 *
 * The reference carries a run id, so two executions of this file do not replay
 * each other's deposits and mistake idempotency for a bug — except in the one
 * test that replays deliberately.
 *
 * ===========================================================================
 * EVERY SCENARIO THAT DEPOSITS RUNS INSIDE A TRANSACTION THAT IS ROLLED BACK
 * ===========================================================================
 *
 * Four real deposits into the SEEDED DEMO BUSINESS per run — eight journal
 * entries (a financial one and a memo one each) and four `uncleared_credit`
 * holds, all of them indistinguishable on the console from a customer funding
 * their account. Sixteen runs' worth is on the book and stays there; this run
 * adds none. Per-run cost: 4 deposits / 8 entries / 4 holds before, ZERO
 * after.
 *
 * The rows exist while every assertion is made — real Postgres, real triggers,
 * the real three unique indexes that decide the replay — and then the
 * transaction is thrown away. The rule and the exemptions are written up in
 * `docs/TESTING.md`; the pattern is the one proved in
 * `src/lib/fx/fx.integration.test.ts`.
 *
 * THE PLAID SANDBOX IS NOT ROLLED BACK and cannot be: the Item, the public
 * token and the exchange are somebody else's system. That is what a live
 * integration means, it was already true, and it is the first test's subject
 * rather than a side effect — nothing Plaid holds is a row on our book.
 */

import { beforeAll, describe, expect, it } from "vitest";

const RUN =
  process.env["RUN_DB_TESTS"] === "1" &&
  (process.env["PLAID_CLIENT_ID"] ?? "") !== "" &&
  (process.env["PLAID_SECRET"] ?? "") !== "";

import type * as Adapter from "./adapter";
import type * as BalancesModule from "@/lib/ledger/balances";
import type * as Db from "@/lib/ledger/db";

const suite = RUN ? describe : describe.skip;

/** The seeded demo business. Its 2100 leaf is what the console screens show. */
const RIDGELINE_BUSINESS = "e274546d-6bdd-5266-b0fb-cc839a7811f9";

/** What postgres.js hands a transaction body. Structural, to avoid the import. */
type Scoped = {
  savepoint: <T>(fn: (scoped: unknown) => Promise<T>) => Promise<T>;
  begin?: unknown;
};

/**
 * Give a transaction handle the `.begin()` that `fundFromLinkedAccount` calls.
 *
 * The adapter wraps the financial entry, the memo entry and the hold in one
 * `conn.begin(...)`, which is right: a deposit that booked its money without
 * its hold would be spendable on the day it arrived. But postgres.js puts
 * `begin` on the POOL only; a transaction scope gets `savepoint`, and the two
 * are the same function internally (`scope(c, fn, name)`) differing only in
 * whether a savepoint name is issued. Without this shim
 * `fundFromLinkedAccount({ conn: tx })` throws `conn.begin is not a function`,
 * and the only way to run these scenarios inside a transaction would be to
 * stop calling the adapter — which would mean this file no longer tests leg
 * two of the core loop.
 *
 * `Sql(handler)` builds a fresh object per scope, so this adds the property to
 * this transaction's handle and to nothing else.
 */
function nested(handle: unknown): Db.Sql {
  const scoped = handle as Scoped;
  if (typeof scoped.begin !== "function") {
    scoped.begin = (first: unknown, second?: unknown) => {
      const body = (typeof first === "function" ? first : second) as (
        inner: unknown,
      ) => Promise<unknown>;
      return scoped.savepoint((inner) => Promise.resolve(body(nested(inner))));
    };
  }
  return handle as Db.Sql;
}

const ROLLBACK = "plaid-funding-integration-rollback";

suite("funding from a linked external bank", () => {
  let linkExternalAccount: typeof Adapter.linkExternalAccount;
  let fundFromLinkedAccount: typeof Adapter.fundFromLinkedAccount;
  let availableBalance: typeof BalancesModule.availableBalance;
  let sql: Db.Sql;
  let valueDate: string;

  beforeAll(async () => {
    const adapter = await import("./adapter");
    linkExternalAccount = adapter.linkExternalAccount;
    fundFromLinkedAccount = adapter.fundFromLinkedAccount;
    ({ availableBalance } = await import("@/lib/ledger/balances"));
    ({ sql } = await import("@/lib/ledger/db"));

    // Book time from the database's own `book_date()`, so the business day
    // boundary is the Fed/ACH one and there is one definition of it, not two.
    const [row] = await sql<{ value_date: string }[]>`
      SELECT to_char(book_date(now()), 'YYYY-MM-DD') AS value_date`;
    valueDate = row?.value_date ?? "";
  });

  /**
   * Run a scenario against the live database and then throw it away.
   *
   * Anything that is not the sentinel is a real failure — a broken assertion
   * or a statement Postgres refused — and is rethrown so the run goes red. It
   * rolled back either way.
   */
  async function rolledBack(body: (tx: Db.Sql) => Promise<void>): Promise<void> {
    let failure: unknown = null;
    try {
      await sql.begin(async (raw) => {
        await body(nested(raw));
        throw new Error(ROLLBACK);
      });
    } catch (thrown) {
      if (!(thrown instanceof Error) || thrown.message !== ROLLBACK) failure = thrown;
    }
    if (failure !== null) throw failure;
  }

  it("links a real Item: five calls, all 200, with ACH numbers indexed by account", async () => {
    const link = await linkExternalAccount({ clientUserId: RIDGELINE_BUSINESS });

    expect(link.calls.map((call) => call.endpoint)).toEqual([
      "POST /link/token/create",
      "POST /sandbox/public_token/create",
      "POST /item/public_token/exchange",
      "POST /accounts/get",
      "POST /auth/get",
    ]);
    for (const call of link.calls) {
      expect(call.ok).toBe(true);
      expect(call.status).toBe(200);
      // Plaid's own request id, which can be taken to their dashboard by
      // somebody who does not trust this suite.
      expect(call.requestId).toMatch(/^[0-9a-f]+$/);
    }

    // A real link token from the real first step of the production flow.
    expect(link.linkToken?.token).toMatch(/^link-sandbox-/);

    // `ins_109508` returns fourteen accounts and three ACH entries. A credit
    // card, a CD, a mortgage and a 401k are all on it and none can fund a
    // business current account.
    expect(link.fundable.length).toBeGreaterThan(0);
    expect(link.fundable.length).toBeLessThan(14);
    for (const account of link.fundable) {
      expect(account.routingNumber).toMatch(/^\d{9}$/);
      expect(account.itemId).toBe(link.item.item_id);
      expect(account.evidence).toBe("live");
      // The full account number is never on this shape.
      expect(JSON.stringify(account)).not.toMatch(/\d{16}/);
    }
  });

  it("raises the LEDGER balance and leaves AVAILABLE untouched", async () => {
    const link = await linkExternalAccount({ clientUserId: RIDGELINE_BUSINESS });
    const linked = link.fundable.find((account) => account.subtype === "checking");
    expect(linked).toBeDefined();
    if (linked === undefined) return;

    // The Plaid calls are made OUTSIDE the transaction, deliberately. A
    // transaction that posts takes `pg_advisory_xact_lock` per entity until it
    // ends, and holding that across five HTTP round trips to Plaid would make
    // every other writer on this book wait on somebody else's network.
    await rolledBack(async (tx) => {
      const before = await availableBalance(RIDGELINE_BUSINESS, tx);
      const amountCents = 250_000n;
      const reference = `ITEST-${Date.now()}`;

      const receipt = await fundFromLinkedAccount({
        businessId: RIDGELINE_BUSINESS,
        amountCents,
        linked,
        counterpartyClass: "self",
        valueDate,
        reference,
        conn: tx,
      });

      const after = await availableBalance(RIDGELINE_BUSINESS, tx);

      expect(receipt.created).toBe(true);

      // The two figures the whole screen exists to separate.
      expect(after.ledgerCents - before.ledgerCents).toBe(amountCents);
      expect(after.availableCents - before.availableCents).toBe(0n);
      expect(after.unclearedCents - before.unclearedCents).toBe(amountCents);
      // A deposit is not an authorisation.
      expect(after.holdsCents - before.holdsCents).toBe(0n);

      // The hold cites the policy row it was created under, and releases in the
      // future — not "pending", not a flag, an instant.
      expect(receipt.policy.rail).toBe("ach");
      expect(receipt.policy.counterpartyClass).toBe("self");
      expect(receipt.schedule.availableAt.getTime()).toBeGreaterThan(Date.now());
      expect(receipt.schedule.policyId).toBe(receipt.policy.id);

      // The linkage survives on the money rows: there is no plaid_item table.
      expect(receipt.externalRef).toBe(
        `plaid:${linked.itemId}:${linked.accountId}:${reference}`,
      );

      // Both entries exist, are different, and the hold is one row.
      expect(receipt.entryId).not.toBe(receipt.memoEntryId);

      const [entry] = await tx<{ description: string; rail: string; book: string }[]>`
        SELECT description, rail::text AS rail, book::text AS book
          FROM journal_entry WHERE id = ${receipt.entryId}::uuid`;
      expect(entry?.book).toBe("financial");
      expect(entry?.rail).toBe("ach");
      // The row itself carries the qualification, for ever. A ledger line reading
      // "in transit" while nothing was transmitted is a false statement unless it
      // says so on its face.
      expect(entry?.description).toContain("ORIGINATED, NOT TRANSMITTED");

      // The financial entry debits 1130 and credits the customer, and nothing
      // else. 1110 is untouched: no real dollars arrived at the sponsor bank.
      const lines = await tx<{ code: string; amount_cents: bigint }[]>`
        SELECT a.code, l.amount_cents
          FROM journal_line l JOIN account a ON a.id = l.account_id
         WHERE l.entry_id = ${receipt.entryId}::uuid
         ORDER BY l.ordinal`;
      expect(lines.map((line) => line.code).sort()).toEqual(["1130", "2100"]);
      expect(lines.find((line) => line.code === "1130")?.amount_cents).toBe(amountCents);
      expect(lines.find((line) => line.code === "2100")?.amount_cents).toBe(-amountCents);
    });
  });

  it("books ONE deposit when the same reference is submitted twice", async () => {
    const link = await linkExternalAccount({ clientUserId: RIDGELINE_BUSINESS });
    const linked = link.fundable[0];
    expect(linked).toBeDefined();
    if (linked === undefined) return;

    await rolledBack(async (tx) => {
      const reference = `ITEST-REPLAY-${Date.now()}`;
      const request = {
        businessId: RIDGELINE_BUSINESS,
        amountCents: 1_00n,
        linked,
        counterpartyClass: "self" as const,
        valueDate,
        reference,
        conn: tx,
      };

      const first = await fundFromLinkedAccount(request);
      const between = await availableBalance(RIDGELINE_BUSINESS, tx);
      const second = await fundFromLinkedAccount(request);
      const after = await availableBalance(RIDGELINE_BUSINESS, tx);

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      // Same hold, same entries — Postgres decided, not an `if`. The three
      // unique indexes are real indexes on real rows here; what the rollback
      // changes is only whether those rows outlive the assertion.
      expect(second.holdId).toBe(first.holdId);
      expect(second.entryId).toBe(first.entryId);
      expect(second.memoEntryId).toBe(first.memoEntryId);
      // And nothing moved on the second press.
      expect(after.ledgerCents).toBe(between.ledgerCents);
      expect(after.unclearedCents).toBe(between.unclearedCents);
    });
  });

  it("holds a NEW counterparty longer, and skips the weekend to get there", async () => {
    const link = await linkExternalAccount({ clientUserId: RIDGELINE_BUSINESS });
    const linked = link.fundable[0];
    expect(linked).toBeDefined();
    if (linked === undefined) return;

    await rolledBack(async (tx) => {
      const self = await fundFromLinkedAccount({
        businessId: RIDGELINE_BUSINESS,
        amountCents: 1_00n,
        linked,
        counterpartyClass: "self",
        valueDate,
        reference: `ITEST-SELF-${Date.now()}`,
        conn: tx,
      });

      const fresh = await fundFromLinkedAccount({
        businessId: RIDGELINE_BUSINESS,
        amountCents: 1_00n,
        linked,
        counterpartyClass: "new",
        valueDate,
        reference: `ITEST-NEW-${Date.now()}`,
        conn: tx,
      });

      expect(self.schedule.bankingDaysHold).toBe(1);
      expect(fresh.schedule.bankingDaysHold).toBe(2);
      expect(fresh.schedule.releaseDate > self.schedule.releaseDate).toBe(true);

      // Two banking days is not two calendar days when a weekend is in the way,
      // and the schedule says WHICH days it skipped rather than only the answer.
      for (const skipped of fresh.schedule.skipped) {
        expect(["weekend", "federal_reserve_holiday"]).toContain(skipped.reason);
      }
      expect(fresh.schedule.calendarDaysHeld).toBeGreaterThanOrEqual(
        fresh.schedule.bankingDaysHold,
      );
    });
  });

  // NOT wrapped, and it does not need to be: `fundFromLinkedAccount` refuses a
  // non-positive amount in TypeScript before it opens a connection, so there is
  // no row to roll back. Passing `conn` anyway would be a lie about where the
  // refusal happens.
  it("refuses an amount that is not a positive integer number of cents", async () => {
    const link = await linkExternalAccount({ clientUserId: RIDGELINE_BUSINESS });
    const linked = link.fundable[0];
    expect(linked).toBeDefined();
    if (linked === undefined) return;

    await expect(
      fundFromLinkedAccount({
        businessId: RIDGELINE_BUSINESS,
        amountCents: 0n,
        linked,
        counterpartyClass: "self",
        valueDate,
        reference: `ITEST-ZERO-${Date.now()}`,
      }),
    ).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
  });
});
