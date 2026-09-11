/**
 * Ledger integration tests. These run against the REAL Neon database.
 *
 * Gated on RUN_DB_TESTS=1 so CI (which holds no credentials, deliberately)
 * skips them rather than failing. Run locally with:
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test
 *
 * What is being proven here is not that the code compiles. It is that money
 * posts, that replaying a fact is a no-op decided by Postgres, that an
 * unbalanced entry is refused, and that a backdated correction leaves both
 * time axes independently answerable. Every one of those is a published
 * live-fire scenario.
 *
 * ===========================================================================
 * EVERY SCENARIO THAT POSTS RUNS INSIDE A TRANSACTION THAT IS ROLLED BACK
 * ===========================================================================
 *
 * This file used to leave seven journal entries and fourteen journal lines on
 * the live book per run, against the seeded demo business, indistinguishable
 * from real activity on any screen that reads it. The rows still exist while
 * the assertions are made — real Postgres, real triggers, real generated
 * columns, the real `ledger_append` — and then the transaction is thrown away.
 * Per-run cost: +7 entries / +14 lines before, ZERO after.
 *
 * The rule and the exemptions are written up in `docs/TESTING.md`. The pattern
 * is the one proved in `src/lib/fx/fx.integration.test.ts`, including the
 * `nested()` shim below, which is what lets the PRODUCTION functions be called
 * unchanged rather than hand-copied into the test.
 *
 * Three tests here are NOT wrapped, and deliberately: the UPDATE-refusal
 * probe, the view-versus-function agreement and the drift view all read (or
 * are refused by) the book as it stands. None of them writes, so none of them
 * costs a row.
 */
import { describe, expect, it, beforeAll } from "vitest";

import type * as BalancesModule from "./balances";
import type { sql as SqlHandle } from "./db";
import type { postEntry as PostEntry, reverseAndRebook as ReverseAndRebook } from "./post";

const RUN = process.env.RUN_DB_TESTS === "1";
const d = RUN ? describe : describe.skip;

d("ledger, against the live database", () => {
  // Imported dynamically inside beforeAll so that a missing DATABASE_URL does
  // not blow up at module load when these tests are skipped in CI.
  let sql: typeof SqlHandle;
  let postEntry: typeof PostEntry;
  let reverseAndRebook: typeof ReverseAndRebook;
  let bal: typeof BalancesModule;
  let entityId: string;
  let actorId: string;
  let depositAccountId: string;
  let cashAccountId: string;

  beforeAll(async () => {
    ({ sql } = await import("./db"));
    ({ postEntry, reverseAndRebook } = await import("./post"));
    bal = await import("./balances");

    const [e] = await sql<{ id: string }[]>`SELECT id FROM book_entity LIMIT 1`;
    const [a] = await sql<{ id: string }[]>`
      SELECT id FROM actor WHERE kind = 'human' AND can_approve = true LIMIT 1`;
    const [b] = await sql<{ id: string; account_id: string }[]>`
      SELECT b.id, acc.id AS account_id
        FROM business b JOIN account acc
          ON acc.business_id = b.id AND acc.code = '2100'
       LIMIT 1`;
    const [c] = await sql<{ id: string }[]>`
      SELECT id FROM account WHERE code = '1110' AND business_id IS NULL LIMIT 1`;
    if (!e || !a || !b || !c) throw new Error("seed first: node scripts/seed.mjs");
    entityId = e.id;
    actorId = a.id;
    depositAccountId = b.account_id;
    cashAccountId = c.id;
  });

  const run = Date.now();

  /* ------------------------------------------------------------------------ */
  /* The transaction machinery. See fx.integration.test.ts for the long form.  */
  /* ------------------------------------------------------------------------ */

  /** What postgres.js hands a transaction body. Structural, to avoid the import. */
  type Scoped = {
    savepoint: <T>(fn: (scoped: unknown) => Promise<T>) => Promise<T>;
    begin?: unknown;
  };

  /**
   * Give a transaction handle the `.begin()` that `reverseAndRebook` calls.
   *
   * postgres.js puts `begin` on the POOL only; a transaction scope gets
   * `savepoint`, and the two are the same function internally (`scope(c, fn,
   * name)`) differing only in whether a savepoint name is issued. Without this
   * shim `reverseAndRebook(args, tx)` throws `tx.begin is not a function`, and
   * the only way to run the correction scenario inside a transaction would be
   * to stop calling the production function — which would mean this file no
   * longer tests the code that runs.
   *
   * `Sql(handler)` builds a fresh object per scope, so this adds the property
   * to this transaction's handle and to nothing else.
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

  const ROLLBACK = "ledger-integration-rollback";

  /**
   * Run a scenario against the live database and then throw it away.
   *
   * Anything that is not the sentinel is a real failure — a broken assertion
   * or a statement Postgres refused — and is rethrown so the run goes red. It
   * rolled back either way.
   */
  async function rolledBack(body: (tx: typeof SqlHandle) => Promise<void>): Promise<void> {
    let failure: unknown = null;
    try {
      await sql.begin(async (tx) => {
        await body(nested(tx));
        throw new Error(ROLLBACK);
      });
    } catch (thrown) {
      if (!(thrown instanceof Error) || thrown.message !== ROLLBACK) failure = thrown;
    }
    if (failure !== null) throw failure;
  }

  it("posts a deposit: cash up (debit asset), customer owed more (credit liability)", async () => {
    await rolledBack(async (tx) => {
      const before = await bal.ledgerBalanceAsOf(depositAccountId, "2099-12-31", tx);
      await postEntry({
        entityId, valueDate: "2026-09-08", book: "financial",
        description: "Test deposit", idempotencyKey: `test:${run}:deposit`,
        actorId, rail: "ach",
        lines: [
          { accountId: cashAccountId, amountCents: 250_00n },      // debit asset
          { accountId: depositAccountId, amountCents: -250_00n },  // credit liability
        ],
      }, tx);
      const after = await bal.ledgerBalanceAsOf(depositAccountId, "2099-12-31", tx);
      // normal_side flips the sign: the customer sees +$250, not -25000.
      expect(after - before).toBe(250_00n);
    });
  });

  it("replay is a no-op decided by Postgres, not by an if statement", async () => {
    await rolledBack(async (tx) => {
      const key = `test:${run}:replay`;
      const lines = [
        { accountId: cashAccountId, amountCents: 10_00n },
        { accountId: depositAccountId, amountCents: -10_00n },
      ];
      const first = await postEntry({
        entityId, valueDate: "2026-09-08", book: "financial",
        description: "Replay probe", idempotencyKey: key, actorId, lines,
      }, tx);
      const before = await bal.ledgerBalanceAsOf(depositAccountId, "2099-12-31", tx);
      const second = await postEntry({
        entityId, valueDate: "2026-09-08", book: "financial",
        description: "Replay probe", idempotencyKey: key, actorId, lines,
      }, tx);
      const after = await bal.ledgerBalanceAsOf(depositAccountId, "2099-12-31", tx);
      expect(second).toBe(first);      // same entry, not a new one
      expect(after).toBe(before);      // twice is once
    });
  });

  it("refuses an unbalanced entry", async () => {
    // Costs nothing either way — the guard in postEntry fires before the round
    // trip — but it runs inside the rollback so that the day someone deletes
    // that guard and leaves the database to refuse it, the refused INSERT is
    // still inside a transaction nobody keeps.
    await rolledBack(async (tx) => {
      await expect(postEntry({
        entityId, valueDate: "2026-09-08", book: "financial",
        description: "Unbalanced", idempotencyKey: `test:${run}:unbal`, actorId,
        lines: [
          { accountId: cashAccountId, amountCents: 100n },
          { accountId: depositAccountId, amountCents: -99n },
        ],
      }, tx)).rejects.toThrow(/sum to 1 cents/);
    });
  });

  it("the database refuses UPDATE on a money row even when asked nicely", async () => {
    // NOT wrapped, and it does not need to be: the grant refuses the statement
    // outright, so there is nothing to roll back. Running it on the pool also
    // keeps it honest — a rollback could otherwise be mistaken for the reason
    // the book was unchanged.
    await expect(
      sql`UPDATE journal_entry SET description = 'tampered' WHERE true`,
    ).rejects.toThrow(/permission denied/);
  });

  it("a backdated correction leaves BOTH time axes independently answerable", async () => {
    await rolledBack(async (tx) => {
      // Post something wrong on Tuesday.
      const wrong = await postEntry({
        entityId, valueDate: "2026-09-08", book: "financial",
        description: "Settlement, wrong amount",
        idempotencyKey: `test:${run}:wrong`, actorId, rail: "card",
        lines: [
          { accountId: depositAccountId, amountCents: 90_00n },
          { accountId: cashAccountId, amountCents: -90_00n },
        ],
      }, tx);

      const asBelievedWednesday = await bal.ledgerBalanceAsOf(depositAccountId, "2026-09-08", tx);
      const watermark = await bal.bookingWatermarkAt(new Date(), tx);

      // Thursday: reverse at TUESDAY'S value date and re-book the right amount.
      // `reverseAndRebook` opens its own `conn.begin` — that is the call the
      // `nested()` shim above exists for, and it becomes a savepoint here.
      const { reversalEntryId, rebookEntryId } = await reverseAndRebook({
        originalEntryId: wrong,
        reason: "merchant reversed the settlement",
        actorId,
        rebook: {
          valueDate: "2026-09-08", book: "financial",
          description: "Settlement, corrected",
          idempotencyKey: `test:${run}:rebook`,
          rail: "card",
          lines: [
            { accountId: depositAccountId, amountCents: 73_40n },
            { accountId: cashAccountId, amountCents: -73_40n },
          ],
        },
      }, tx);
      expect(reversalEntryId).toBeTruthy();
      expect(rebookEntryId).toBeTruthy();

      // Tuesday, as we know it NOW: the corrected figure.
      const correctedTuesday = await bal.ledgerBalanceAsOf(depositAccountId, "2026-09-08", tx);
      // 90.00 posted then reversed then 73.40 re-booked => net effect 73.40 debit
      expect(asBelievedWednesday - correctedTuesday).toBe(73_40n - 90_00n === -16_60n ? -16_60n : 0n);

      // Tuesday, as we BELIEVED it before the correction: still the old figure.
      const believed = await bal.balanceAsBelieved(depositAccountId, "2026-09-08", watermark, tx);
      expect(believed).toBe(asBelievedWednesday);
      expect(believed).not.toBe(correctedTuesday);

      // Nothing was edited. The original row is still there, untouched.
      const [orig] = await tx<{ description: string }[]>`
        SELECT description FROM journal_entry WHERE id = ${wrong}::uuid`;
      expect(orig?.description).toBe("Settlement, wrong amount");

      // And the book nets to zero WITH the reversal and the re-book in it.
      // This assertion used to live in its own test that ran after this one
      // and read the committed book; the rollback means "after all of that"
      // now has to be asked here, while "all of that" still exists.
      expect(await bal.trialBalanceCents(tx)).toBe(0n);
    });
  });

  it("the financial book nets to zero", async () => {
    // The standing invariant, read off the committed book. Not wrapped: it
    // writes nothing, and a rollback would only hide what it is asking about.
    expect(await bal.trialBalanceCents()).toBe(0n);
  });

  /* ------------------------------------------------------------------------ */
  /* The one definition, held to itself                                       */
  /* ------------------------------------------------------------------------ */

  it("the SQL view and the TypeScript function give the SAME four numbers", async () => {
    // They cannot drift, because neither of them contains a definition: both
    // are calls to ledger_availability() (migration 0022). This asserts the
    // bargain rather than assuming it — if someone re-inlines the arithmetic
    // into either one, this is what goes red.
    const rows = await sql<
      {
        account_id: string;
        ledger_balance_cents: string;
        card_hold_cents: string;
        uncleared_credit_cents: string;
        pending_outbound_cents: string;
        available_cents: string;
      }[]
    >`SELECT account_id,
             ledger_balance_cents::text, card_hold_cents::text,
             uncleared_credit_cents::text, pending_outbound_cents::text,
             available_cents::text
        FROM v_available_balance`;

    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const fromFunction = await bal.availableBalanceForAccount(row.account_id);

      // The view is read at its own instant and the function at its own, so a
      // hold releasing between the two reads is a real (and correct)
      // difference. Everything that is not clock-driven must agree exactly.
      expect(fromFunction.ledgerCents).toBe(BigInt(row.ledger_balance_cents));
      expect(fromFunction.pendingOutboundCents).toBe(
        BigInt(row.pending_outbound_cents),
      );

      // And the identity closes on the function's own four terms.
      expect(
        fromFunction.ledgerCents -
          fromFunction.holdsCents -
          fromFunction.unclearedCents -
          fromFunction.pendingOutboundCents,
      ).toBe(fromFunction.availableCents);
    }
  });

  it("v_balance_definition_drift is empty: the hold model and availability agree", async () => {
    // The counterpart to v_hold_drift, one level up. ledger_availability()
    // re-derives v_hold_state's release predicate at a PARAMETERISED instant
    // rather than at now(), so these are genuinely two bodies and an edit to
    // either that changes what "released" means shows up here.
    //
    // Nothing repairs what this reports. A row is a bug to fix, never a number
    // to overwrite.
    expect(await bal.balanceDefinitionDrift(sql)).toEqual([]);
  });

  it("a future-dated credit is a fact we know and not money the customer has", async () => {
    await rolledBack(async (tx) => {
      // Post a credit value-dated a year out, inside this test's own run.
      const before = await bal.availableBalanceForAccount(depositAccountId, tx);

      await postEntry({
        entityId, valueDate: "2027-09-08", book: "financial",
        description: "Standing-order settlement, next year",
        idempotencyKey: `test:${run}:future-credit`, actorId, rail: "ach",
        lines: [
          { accountId: depositAccountId, amountCents: -500_00n },
          { accountId: cashAccountId, amountCents: 500_00n },
        ],
      }, tx);

      const after = await bal.availableBalanceForAccount(depositAccountId, tx);

      // Neither the settled ledger nor available moved. A customer cannot spend
      // 2027's money in 2026, and availableBalance() used to let them.
      expect(after.ledgerCents).toBe(before.ledgerCents);
      expect(after.availableCents).toBe(before.availableCents);
      expect(after.pendingOutboundCents).toBe(before.pendingOutboundCents);
    });
  });

  it("a future-dated DEBIT comes off available immediately, and not off the ledger", async () => {
    await rolledBack(async (tx) => {
      const before = await bal.availableBalanceForAccount(depositAccountId, tx);

      await postEntry({
        entityId, valueDate: "2027-09-09", book: "financial",
        description: "Outbound ACH, settles next year",
        idempotencyKey: `test:${run}:future-debit`, actorId, rail: "ach",
        lines: [
          { accountId: depositAccountId, amountCents: 250_00n },
          { accountId: cashAccountId, amountCents: -250_00n },
        ],
      }, tx);

      const after = await bal.availableBalanceForAccount(depositAccountId, tx);

      // THE ASYMMETRY, asserted. Money booked to leave is committed: the
      // customer must not be able to spend it again in the window before it
      // settles. The ledger is untouched, because it has not settled yet.
      expect(after.ledgerCents).toBe(before.ledgerCents);
      expect(after.pendingOutboundCents).toBe(before.pendingOutboundCents + 250_00n);
      expect(after.availableCents).toBe(before.availableCents - 250_00n);
    });
  });
});
