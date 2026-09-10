/**
 * Standing orders against the REAL Neon database.
 *
 * Gated on RUN_DB_TESTS=1 so CI (which holds no credentials, deliberately)
 * skips rather than fails. Run locally with:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/lib/standing
 *
 * ============================================================================
 * THE TWO CLAIMS THIS FILE EXISTS TO PROVE
 * ============================================================================
 *
 *   1. AN OCCURRENCE FIRES ONCE AND ONLY ONCE. Two full runs of the firing
 *      routine, started concurrently against the same live database, raise ONE
 *      payment instruction between them. Not "the scheduler is careful" — one
 *      instruction, counted in Postgres, with the second run reporting that it
 *      found the first one's work already done.
 *
 *   2. A REFUSAL IS A ROW. An occurrence whose amount the LEDGER balance covers
 *      and the AVAILABLE balance does not is closed as attempted-and-refused,
 *      with its code, its sentence, and the four figures observed at the moment
 *      of the decision.
 *
 * ─── What this suite writes to the live database ────────────────────────────
 *
 * Two mandates on the seeded Ridgeline account, and the occurrences and
 * payment instructions they produce. NO MONEY MOVES: a firing standing order
 * raises an instruction into the approvals queue, and money leaves only when a
 * second human releases it. Every row written here is append-only audit, and
 * both mandates carry `start_date = end_date = today`, so each schedule
 * generates exactly one date, ever. A suite that left a live mandate firing
 * every month for the life of the database would be a worse bug than anything
 * it tests.
 *
 * ─── Why the refused mandate's amount is computed rather than written down ──
 *
 * The edge being demonstrated is a RELATIONSHIP between two balances, not an
 * amount: available < amount <= ledger. Ridgeline's book moves — other suites
 * post to it — so an amount hard-coded today would stop demonstrating anything
 * tomorrow. The mandate is created with `available + $100`, read from
 * `availableBalance()` at creation time, which sits in the gap exactly when
 * there are more than $100 of holds and uncleared credits against that account.
 * The test asserts that precondition and says so rather than skipping quietly.
 *
 * Once the refusal is written it is permanent evidence: the four figures are
 * stored AS OBSERVED, so the row keeps meaning what it meant even after the
 * balances move.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { sql as SqlHandle } from "@/lib/ledger/db";
import type * as BalancesModule from "@/lib/ledger/balances";

import type * as FireModule from "./fire";
import type * as StoreModule from "./store";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

// Neon is a network hop away and the concurrency scenario deliberately holds
// row locks across round trips. Vitest's default is a timeout on the WAN, not
// on the code.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/**
 * The one row a query was supposed to return.
 *
 * `noUncheckedIndexedAccess` is on, and a `?.` on a row this test has just
 * asserted the existence of would turn a missing row into a silently skipped
 * assertion — a green test that checked nothing.
 */
function only<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected exactly one row, got none");
  return row;
}

/** The seeded, KYB-approved business. The gate in requestPayment() is real. */
const BUSINESS_ID = "e274546d-6bdd-5266-b0fb-cc839a7811f9";
/** Priya Raman — the payments initiator persona. can_approve = false. */
const INITIATOR = "b3c4f786-5d1b-5194-9aae-6342ba0ef606";

d("standing orders, against the live database", () => {
  let sql: typeof SqlHandle;
  let store: typeof StoreModule;
  let fire: typeof FireModule;
  let balances: typeof BalancesModule;

  let accountId: string;
  let bookDate: string;

  /** Scopes this run's mandates. Derived from the run, never a bare uuid. */
  const runStamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);

  let fundedOrderId: string;
  let fundedKey: string;
  let refusedOrderId: string;
  let refusedKey: string;
  let refusedAmount: bigint;
  let ledgerAtCreation: bigint;

  beforeAll(async () => {
    // Imported dynamically so a missing APP_DATABASE_URL does not blow up at
    // module load in an environment that is only going to skip.
    ({ sql } = await import("@/lib/ledger/db"));
    store = await import("./store");
    fire = await import("./fire");
    balances = await import("@/lib/ledger/balances");

    bookDate = await store.bookToday();

    const [account] = await sql<{ id: string }[]>`
      SELECT id FROM account WHERE code = '2100' AND business_id = ${BUSINESS_ID}::uuid`;
    if (account === undefined) throw new Error("the seeded Ridgeline deposit account is missing");
    accountId = account.id;

    const before = await balances.availableBalance(BUSINESS_ID);
    ledgerAtCreation = before.ledgerCents;

    // ---- the mandate that will be funded -------------------------------
    const funded = await store.createStandingOrder({
      accountId,
      reference: "Rent — Unit 4, Ridgeline Works",
      rail: "ach",
      amountCents: 400_000n,
      destination: {
        type: "ach",
        holderName: "Cascade Property Partners LLC",
        routingNumber: "021000021",
        accountNumberLast4: "4417",
        accountType: "checking",
      },
      cadence: "monthly",
      dayOfMonth: Number(bookDate.slice(8, 10)),
      startDate: bookDate,
      // Exactly one date, ever. A test must not leave a mandate firing every
      // month for the life of the database.
      endDate: bookDate,
      createdByActorId: INITIATOR,
      mandateKey: `test:standing:${runStamp}:rent`,
    });
    fundedOrderId = funded.id;
    fundedKey = `standing:${fundedOrderId}:${bookDate}`;

    // ---- the mandate that will be refused for AVAILABLE -----------------
    //
    // available + $100. Sits strictly between available and ledger exactly
    // when this account carries more than $100 of holds plus uncleared
    // credits, which the test asserts below rather than assuming.
    refusedAmount = before.availableCents + 10_000n;

    const refused = await store.createStandingOrder({
      accountId,
      reference: "Quarterly equipment settlement — Northgate Finance",
      rail: "ach",
      amountCents: refusedAmount,
      destination: {
        type: "ach",
        holderName: "Northgate Equipment Finance",
        routingNumber: "011401533",
        accountNumberLast4: "9012",
        accountType: "checking",
      },
      cadence: "daily",
      startDate: bookDate,
      // Exactly one date, ever. A test must not leave a mandate firing.
      endDate: bookDate,
      createdByActorId: INITIATOR,
      mandateKey: `test:standing:${runStamp}:northgate`,
    });
    refusedOrderId = refused.id;
    refusedKey = `standing:${refusedOrderId}:${bookDate}`;
  });

  /* ---------------------------------------------------------------------- */
  /* 1. exactly once, under a concurrent double fire                        */
  /* ---------------------------------------------------------------------- */

  it("raises ONE instruction when two runs fire concurrently", async () => {
    // The published attack, run literally: two ticks of the firing routine
    // started at the same instant against the same database. Not two calls in
    // sequence, which any `if` would survive.
    const [a, b] = await Promise.all([
      fire.runStandingOrders({ runId: `test-${runStamp}-A` }),
      fire.runStandingOrders({ runId: `test-${runStamp}-B` }),
    ]);

    const reports = [...a.occurrences, ...b.occurrences].filter(
      (o) => o.standingOrderId === fundedOrderId,
    );
    // Both runs considered the same occurrence; that is the point.
    expect(reports.length).toBe(2);

    // Postgres is the witness, not the reports.
    const instructions = await sql<{ id: string }[]>`
      SELECT id FROM payment_instruction WHERE idempotency_key = ${fundedKey}`;
    expect(instructions.length).toBe(1);

    const occurrences = await sql<{ id: string }[]>`
      SELECT id FROM standing_order_occurrence
       WHERE standing_order_id = ${fundedOrderId}::uuid AND scheduled_date = ${bookDate}::date`;
    expect(occurrences.length).toBe(1);

    const occurrenceId = only(occurrences).id;
    const instructionId = only(instructions).id;

    const outcomes = await sql<{ disposition: string; instruction_id: string }[]>`
      SELECT disposition::text AS disposition, instruction_id
        FROM standing_order_outcome WHERE occurrence_id = ${occurrenceId}::uuid`;
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]?.disposition).toBe("raised");
    expect(outcomes[0]?.instruction_id).toBe(instructionId);

    // Exactly one of the two runs did the work; the other found it done.
    const raisedFresh = reports.filter((r) => r.action === "raised" && !r.replayed);
    const replayed = reports.filter((r) => r.replayed);
    expect(raisedFresh.length).toBe(1);
    expect(replayed.length).toBe(1);

    // Both runs agree on the key, and it is the derived one — not a uuid.
    for (const report of reports) {
      expect(report.idempotencyKey).toBe(fundedKey);
    }

    // And the instruction the queue holds cites that same key, so "this
    // occurrence fired" and "that instruction exists" cannot come apart.
    const [instruction] = await sql<
      { idempotency_key: string; value_date: string; amount_cents: bigint; requested_by: string }[]
    >`
      SELECT idempotency_key, value_date::text AS value_date, amount_cents, requested_by
        FROM payment_instruction WHERE id = ${instructionId}::uuid`;
    expect(instruction?.idempotency_key).toBe(fundedKey);
    expect(instruction?.value_date).toBe(bookDate);
    expect(instruction?.amount_cents).toBe(400_000n);
    // The mandate's author is the instruction's initiator, which is what makes
    // maker-checker apply to a scheduled payment with no new code.
    expect(instruction?.requested_by).toBe(INITIATOR);
  });

  it("raises nothing at all on a third, sequential run", async () => {
    const before = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payment_instruction WHERE idempotency_key = ${fundedKey}`;

    const third = await fire.runStandingOrders({ runId: `test-${runStamp}-C` });
    const report = third.occurrences.find((o) => o.standingOrderId === fundedOrderId);

    // The occurrence is decided, so it is not even in the queue any more:
    // listDue() returns dates with no occurrence row and occurrences with no
    // outcome, and this is neither.
    expect(report).toBeUndefined();

    const after = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payment_instruction WHERE idempotency_key = ${fundedKey}`;
    expect(after[0]?.n).toBe(before[0]?.n);
    expect(after[0]?.n).toBe(1);
  });

  it("keeps the double-fire invariant empty", async () => {
    // The standing-order equivalent of v_hold_drift. It cannot be non-empty
    // while payment_instruction.idempotency_key is UNIQUE — which is the point
    // of asking: emptiness is a consequence of a constraint.
    expect(await store.countDoubleFires()).toBe(0);
  });

  it("refuses a second occurrence for the same date at the row, not in code", async () => {
    // Belt and braces, straight at the constraint. Even a caller that bypassed
    // claimOccurrence() cannot put two occurrences on one date.
    await expect(
      sql`INSERT INTO standing_order_occurrence (standing_order_id, scheduled_date, claimed_by)
          VALUES (${fundedOrderId}::uuid, ${bookDate}::date, 'hand-written')`,
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it("refuses an occurrence for a date the schedule does not generate", async () => {
    // The trigger calls standing_order_due_dates() — the same function the
    // firing routine and the next-occurrence view call. There is no second
    // calendar in TypeScript for this to disagree with.
    const notDue = "2026-02-14";
    await expect(
      sql`INSERT INTO standing_order_occurrence (standing_order_id, scheduled_date, claimed_by)
          VALUES (${fundedOrderId}::uuid, ${notDue}::date, 'hand-written')`,
    ).rejects.toThrow(/not due on/i);
  });

  /* ---------------------------------------------------------------------- */
  /* 2. the refusal that is the point of the track                           */
  /* ---------------------------------------------------------------------- */

  it("records the refusal when the LEDGER covered it and AVAILABLE did not", async () => {
    // The precondition, asserted rather than assumed: this account must be
    // carrying more than $100 of holds plus uncleared credits for the amount
    // chosen at creation to sit in the gap.
    expect(ledgerAtCreation).toBeGreaterThanOrEqual(refusedAmount);

    const [row] = await sql<
      {
        occurrence_id: string;
        disposition: string;
        refusal_code: string;
        refusal_reason: string;
        observed_ledger_cents: bigint;
        observed_holds_cents: bigint;
        observed_uncleared_cents: bigint;
        observed_available_cents: bigint;
        shortfall_cents: bigint;
        instruction_id: string | null;
      }[]
    >`
      SELECT occurrence_id, disposition::text AS disposition, refusal_code, refusal_reason,
             observed_ledger_cents, observed_holds_cents, observed_uncleared_cents,
             observed_available_cents, shortfall_cents, instruction_id
        FROM v_standing_order_history
       WHERE standing_order_id = ${refusedOrderId}::uuid AND scheduled_date = ${bookDate}::date`;

    expect(row?.disposition).toBe("refused");
    expect(row?.refusal_code).toBe("INSUFFICIENT_AVAILABLE_FUNDS");

    // The four figures, as observed, and the arithmetic between them.
    const ledger = row?.observed_ledger_cents ?? 0n;
    const holds = row?.observed_holds_cents ?? 0n;
    const uncleared = row?.observed_uncleared_cents ?? 0n;
    const available = row?.observed_available_cents ?? 0n;
    expect(available).toBe(ledger - holds - uncleared);

    // THE CLAIM. The ledger balance covered this payment. The available
    // balance did not. Both are true at once, and that is why the ledger
    // balance is the wrong number to check a standing order against.
    expect(ledger).toBeGreaterThanOrEqual(refusedAmount);
    expect(available).toBeLessThan(refusedAmount);
    expect(row?.shortfall_cents).toBe(refusedAmount - available);

    // And the reason says so, in a sentence somebody can read to a customer.
    expect(row?.refusal_reason).toContain("ledger balance covers this payment");

    // Nothing was raised. A refused occurrence has no instruction, and the
    // outcome table's CHECK constraint makes the other combination
    // unrepresentable.
    expect(row?.instruction_id).toBeNull();
    const raisedForKey = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payment_instruction WHERE idempotency_key = ${refusedKey}`;
    expect(raisedForKey[0]?.n).toBe(0);
  });

  it("does not carry the refused occurrence forward", async () => {
    // The policy: refuse and close, never queue. A later run must not pick the
    // same date up again and pay it on a day nobody chose.
    const again = await fire.runStandingOrders({ runId: `test-${runStamp}-D` });
    expect(
      again.occurrences.some((o) => o.standingOrderId === refusedOrderId),
    ).toBe(false);

    const occurrences = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM standing_order_occurrence
       WHERE standing_order_id = ${refusedOrderId}::uuid`;
    expect(occurrences[0]?.n).toBe(1);
  });

  it("leaves nothing claimed and undecided", async () => {
    // Non-zero would be safe — no money moved — but it must never be
    // invisible, and after a clean run it must be zero.
    const stranded = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM v_standing_order_unresolved u
        JOIN standing_order_occurrence o ON o.id = u.occurrence_id
       WHERE o.standing_order_id IN (${fundedOrderId}::uuid, ${refusedOrderId}::uuid)`;
    expect(stranded[0]?.n).toBe(0);
  });

  it("refuses to rewrite an occurrence or its outcome", async () => {
    // These are the audit of money movement. corgi_app holds no UPDATE and
    // 0001's immutability trigger binds the owner too.
    await expect(
      sql`UPDATE standing_order_occurrence SET claimed_by = 'rewritten'
           WHERE standing_order_id = ${fundedOrderId}::uuid`,
    ).rejects.toThrow(/permission denied|immutable|append/i);

    await expect(
      sql`DELETE FROM standing_order_outcome
           WHERE occurrence_id IN (SELECT id FROM standing_order_occurrence
                                    WHERE standing_order_id = ${fundedOrderId}::uuid)`,
    ).rejects.toThrow(/permission denied|immutable|append/i);
  });

  /* ---------------------------------------------------------------------- */
  /* 3. the calendar has one definition                                      */
  /* ---------------------------------------------------------------------- */

  it("clamps a month-end mandate rather than skipping the month", async () => {
    // A mandate for the 31st is due on 30 April and on 28 February. The rule
    // is LEAST(day_of_month, days-in-that-month), it lives in
    // standing_order_due_dates(), and it is asked here rather than reimplemented.
    const order = await store.createStandingOrder({
      accountId,
      reference: "Month-end calendar probe",
      rail: "internal",
      amountCents: 100n,
      destination: {
        type: "internal",
        accountId,
        holderName: "Ridgeline Robotics, Inc.",
      },
      cadence: "monthly",
      dayOfMonth: 31,
      startDate: "2027-01-01",
      endDate: "2027-04-30",
      createdByActorId: INITIATOR,
      mandateKey: `test:standing:${runStamp}:month-end`,
    });

    const dates = await sql<{ d: string }[]>`
      SELECT d::text AS d
        FROM standing_order_due_dates(${order.id}::uuid, '2027-01-01'::date, '2027-04-30'::date) AS d`;

    expect(dates.map((r) => r.d)).toEqual([
      "2027-01-31",
      "2027-02-28",
      "2027-03-31",
      "2027-04-30",
    ]);

    // Entirely in the future and outside the catch-up window's reach today, so
    // it fires nothing now. Asserted, because a calendar probe that quietly
    // started paying $1.00 a month would be a bad way to learn that.
    const due = await store.listDue(bookDate, 500);
    expect(due.some((item) => item.standingOrderId === order.id)).toBe(false);

    // Then stopped, so it never fires when 2027 arrives. Cancellation is an
    // INSERT whose PRIMARY KEY is the order id: it happens once, it cannot be
    // written twice, and there is no UPDATE to undo it with.
    expect(
      await store.cancelStandingOrder({
        standingOrderId: order.id,
        actorId: INITIATOR,
        reason: "Calendar probe from the standing-orders integration suite. Never intended to pay.",
      }),
    ).toBe(true);

    const [next] = await sql<{ next_due_date: string | null }[]>`
      SELECT next_due_date::text AS next_due_date FROM v_standing_order_next
       WHERE standing_order_id = ${order.id}::uuid`;
    // Cancelled mandates leave the next-occurrence view entirely.
    expect(next).toBeUndefined();
  });
});
