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

  it("posts a deposit: cash up (debit asset), customer owed more (credit liability)", async () => {
    const before = await bal.ledgerBalanceAsOf(depositAccountId, "2099-12-31");
    await postEntry({
      entityId, valueDate: "2026-09-08", book: "financial",
      description: "Test deposit", idempotencyKey: `test:${run}:deposit`,
      actorId, rail: "ach",
      lines: [
        { accountId: cashAccountId, amountCents: 250_00n },      // debit asset
        { accountId: depositAccountId, amountCents: -250_00n },  // credit liability
      ],
    });
    const after = await bal.ledgerBalanceAsOf(depositAccountId, "2099-12-31");
    // normal_side flips the sign: the customer sees +$250, not -25000.
    expect(after - before).toBe(250_00n);
  });

  it("replay is a no-op decided by Postgres, not by an if statement", async () => {
    const key = `test:${run}:replay`;
    const lines = [
      { accountId: cashAccountId, amountCents: 10_00n },
      { accountId: depositAccountId, amountCents: -10_00n },
    ];
    const first = await postEntry({
      entityId, valueDate: "2026-09-08", book: "financial",
      description: "Replay probe", idempotencyKey: key, actorId, lines,
    });
    const before = await bal.ledgerBalanceAsOf(depositAccountId, "2099-12-31");
    const second = await postEntry({
      entityId, valueDate: "2026-09-08", book: "financial",
      description: "Replay probe", idempotencyKey: key, actorId, lines,
    });
    const after = await bal.ledgerBalanceAsOf(depositAccountId, "2099-12-31");
    expect(second).toBe(first);      // same entry, not a new one
    expect(after).toBe(before);      // twice is once
  });

  it("refuses an unbalanced entry", async () => {
    await expect(postEntry({
      entityId, valueDate: "2026-09-08", book: "financial",
      description: "Unbalanced", idempotencyKey: `test:${run}:unbal`, actorId,
      lines: [
        { accountId: cashAccountId, amountCents: 100n },
        { accountId: depositAccountId, amountCents: -99n },
      ],
    })).rejects.toThrow(/sum to 1 cents/);
  });

  it("the database refuses UPDATE on a money row even when asked nicely", async () => {
    await expect(
      sql`UPDATE journal_entry SET description = 'tampered' WHERE true`,
    ).rejects.toThrow(/permission denied/);
  });

  it("a backdated correction leaves BOTH time axes independently answerable", async () => {
    // Post something wrong on Tuesday.
    const wrong = await postEntry({
      entityId, valueDate: "2026-09-08", book: "financial",
      description: "Settlement, wrong amount",
      idempotencyKey: `test:${run}:wrong`, actorId, rail: "card",
      lines: [
        { accountId: depositAccountId, amountCents: 90_00n },
        { accountId: cashAccountId, amountCents: -90_00n },
      ],
    });

    const asBelievedWednesday = await bal.ledgerBalanceAsOf(depositAccountId, "2026-09-08");
    const watermark = await bal.bookingWatermarkAt(new Date());

    // Thursday: reverse at TUESDAY'S value date and re-book the right amount.
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
    });
    expect(reversalEntryId).toBeTruthy();
    expect(rebookEntryId).toBeTruthy();

    // Tuesday, as we know it NOW: the corrected figure.
    const correctedTuesday = await bal.ledgerBalanceAsOf(depositAccountId, "2026-09-08");
    // 90.00 posted then reversed then 73.40 re-booked => net effect 73.40 debit
    expect(asBelievedWednesday - correctedTuesday).toBe(73_40n - 90_00n === -16_60n ? -16_60n : 0n);

    // Tuesday, as we BELIEVED it before the correction: still the old figure.
    const believed = await bal.balanceAsBelieved(depositAccountId, "2026-09-08", watermark);
    expect(believed).toBe(asBelievedWednesday);
    expect(believed).not.toBe(correctedTuesday);

    // Nothing was edited. The original row is still there, untouched.
    const [orig] = await sql<{ description: string }[]>`
      SELECT description FROM journal_entry WHERE id = ${wrong}::uuid`;
    expect(orig?.description).toBe("Settlement, wrong amount");
  });

  it("the financial book still nets to zero after all of that", async () => {
    expect(await bal.trialBalanceCents()).toBe(0n);
  });
});
