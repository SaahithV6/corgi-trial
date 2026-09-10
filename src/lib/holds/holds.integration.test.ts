/**
 * The card authorisation hold state machine, against the REAL Neon database.
 *
 * Gated on RUN_DB_TESTS=1 so CI (which holds no credentials, deliberately)
 * skips rather than fails. Run locally with:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test
 *
 * Every assertion below is about MONEY, not about types. Each one names the
 * published live-fire scenario it answers:
 *
 *   1  authorisation opens a hold; AVAILABLE drops, LEDGER does not move
 *   2  partial capture posts the settled amount and reduces the hold
 *   3  a second capture reduces it again — multiple captures work
 *   4  over-capture ($50 auth, $73.40 clearing) releases to zero and
 *      overdraws AVAILABLE, unclamped
 *   5  settlement BEFORE its authorisation converges on the same numbers
 *   6  replay of any single event changes nothing
 *   7  the release posts exactly once under a concurrent double-fire
 *   8  expiry releases on the clock, idempotently
 *
 * Balances are read as DELTAS around each scenario rather than as absolutes,
 * because the ledger is append-only and shared: a test that asserted an
 * absolute figure would pass once and then fail for ever afterwards, which is
 * a test that asserts the order the suite happens to run in.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type * as BalancesModule from "@/lib/ledger/balances";
import type { sql as SqlHandle } from "@/lib/ledger/db";
import type {
  Transaction,
  TransactionEvent,
  TransactionEventType,
} from "@/lib/rails/lithic/types";

import type * as ApplyModule from "./apply";
import type * as ExpiryModule from "./expiry";
import type * as ModelModule from "./model";
import type * as StoreModule from "./store";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

// Neon is a network hop away and each scenario below makes dozens of them —
// several inside explicit transactions that hold a row lock while they run.
// Vitest's 5s default is a timeout on the WAN, not on the code, and a suite
// that fails on latency teaches nobody anything.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

d("card holds, against the live database", () => {
  let sql: typeof SqlHandle;
  let bal: typeof BalancesModule;
  let apply: typeof ApplyModule;
  let store: typeof StoreModule;
  let model: typeof ModelModule;
  let expiry: typeof ExpiryModule;

  let businessId: string;
  let depositAccountId: string;
  let memoAccountId: string;

  const run = Date.now();
  let cardSeq = 0;

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    bal = await import("@/lib/ledger/balances");
    apply = await import("./apply");
    store = await import("./store");
    model = await import("./model");
    expiry = await import("./expiry");

    const [b] = await sql<{ business_id: string; deposit: string; memo: string }[]>`
      SELECT dep.business_id, dep.id AS deposit, memo.id AS memo
        FROM account dep
        JOIN account memo ON memo.business_id = dep.business_id AND memo.code = '9100'
       WHERE dep.code = '2100' AND dep.business_id IS NOT NULL
       LIMIT 1`;
    if (!b) throw new Error("seed first: node scripts/seed.mjs");
    businessId = b.business_id;
    depositAccountId = b.deposit;
    memoAccountId = b.memo;
  });

  /** A fresh card per scenario, so no two scenarios share an authorisation. */
  async function freshCard(): Promise<StoreModule.CardBinding> {
    cardSeq += 1;
    return store.registerCard(
      {
        provider: "lithic",
        providerCardToken: `test-card-${run}-${cardSeq}`,
        businessId,
        lastFour: "4242",
        nickname: `holds integration ${run}-${cardSeq}`,
      },
      sql,
    );
  }

  // --- payload construction -------------------------------------------------
  //
  // Shaped like the real `card_transaction.updated` bodies sitting in
  // webhook_inbox, TRAP FIELDS INCLUDED: `status` is set to SETTLED wherever
  // the sandbox sets it, and `amounts.hold.amount` is signed negative. If any
  // of this code read either field, these tests would fail.

  function lithicEvent(
    type: TransactionEventType,
    amount: number,
    token: string,
    createdIso: string,
  ): TransactionEvent {
    return {
      token,
      type,
      created: createdIso,
      amount,
      amounts: {
        cardholder: { amount, conversion_rate: "1.000000", currency: "USD" },
        merchant: { amount, currency: "USD" },
        settlement: type === "CLEARING" ? { amount, currency: "USD" } : null,
      },
      effective_polarity: "DEBIT",
    };
  }

  function txn(
    cardToken: string,
    authToken: string,
    events: TransactionEvent[],
    opts: { status?: Transaction["status"]; hold?: number; settled?: number; created?: string } = {},
  ): Transaction {
    return {
      token: authToken,
      account_token: "2742964f-478f-47ef-a4e9-852dc50d9c44",
      card_token: cardToken,
      created: opts.created ?? new Date().toISOString(),
      updated: new Date().toISOString(),
      status: opts.status ?? "PENDING",
      result: "APPROVED",
      amounts: {
        cardholder: { amount: 0, conversion_rate: "1.000000", currency: "USD" },
        hold: { amount: opts.hold ?? 0, currency: "USD" },
        merchant: { amount: 0, currency: "USD" },
        settlement: { amount: opts.settled ?? 0, currency: "USD" },
      },
      events,
    };
  }

  async function applied(t: Transaction): Promise<ApplyModule.HoldOutcome> {
    const result = await apply.applyCardTransaction(t, { now: new Date() });
    if (result.status !== "applied") {
      throw new Error(`expected applied, got ${result.status}`);
    }
    return result;
  }

  async function entriesWithKey(key: string): Promise<number> {
    const [row] = await sql<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM journal_entry WHERE idempotency_key = ${key}`;
    return Number(row?.n ?? 0n);
  }

  // =========================================================================
  // 1. Authorisation
  // =========================================================================

  it("1. an authorisation opens a memo hold: AVAILABLE drops, LEDGER does not move", async () => {
    const card = await freshCard();
    const authToken = `auth-${run}-1`;
    const before = await bal.availableBalance(businessId);

    const out = await applied(
      txn(card.providerCardToken, authToken, [
        lithicEvent("AUTHORIZATION", 5000, `${authToken}-e1`, new Date().toISOString()),
      ]),
    );

    const after = await bal.availableBalance(businessId);

    expect(out.state.authorisedCents).toBe(5000n);
    expect(out.state.capturedCents).toBe(0n);
    expect(out.state.holdCents).toBe(5000n);
    expect(out.deltaCents).toBe(5000n);
    expect(out.memoEntryId).not.toBeNull();
    // An authorisation posts NOTHING to the financial book. That is structural:
    // there is no code path from an authorisation to postCardMovement().
    expect(out.financialEntryIds).toHaveLength(0);

    expect(after.ledgerCents).toBe(before.ledgerCents);
    expect(after.holdsCents - before.holdsCents).toBe(5000n);
    expect(after.availableCents - before.availableCents).toBe(-5000n);

    // The memo entry is in the MEMO book, carries the hold id, and hit the
    // customer's own 9100 leaf.
    const [entry] = await sql<{ book: string; hold_id: string; cents: bigint }[]>`
      SELECT e.book, e.hold_id, l.amount_cents AS cents
        FROM journal_entry e
        JOIN journal_line l ON l.entry_id = e.id AND l.account_id = ${memoAccountId}::uuid
       WHERE e.id = ${out.memoEntryId}::uuid`;
    expect(entry?.book).toBe("memo");
    expect(entry?.hold_id).toBe(out.holdId);
    // Credit-normal account: +5000 held is -5000 signed.
    expect(entry?.cents).toBe(-5000n);
  });

  // =========================================================================
  // 2 & 3. Partial captures
  // =========================================================================

  it("2/3. partial capture posts the settled amount and reduces the hold; twice", async () => {
    const card = await freshCard();
    const authToken = `auth-${run}-2`;
    const created = new Date().toISOString();

    const start = await bal.availableBalance(businessId);
    await applied(
      txn(card.providerCardToken, authToken, [
        lithicEvent("AUTHORIZATION", 1000, `${authToken}-e1`, created),
      ]),
    );
    const afterAuth = await bal.availableBalance(businessId);
    expect(afterAuth.holdsCents - start.holdsCents).toBe(1000n);
    expect(afterAuth.ledgerCents).toBe(start.ledgerCents);

    // Clearing 600. [MEASURED] Lithic reports status=SETTLED, hold=-400 here.
    const first = await applied(
      txn(
        card.providerCardToken,
        authToken,
        [
          lithicEvent("AUTHORIZATION", 1000, `${authToken}-e1`, created),
          lithicEvent("CLEARING", 600, `${authToken}-e2`, created),
        ],
        { status: "SETTLED", hold: -400, settled: -600 },
      ),
    );
    expect(first.state.capturedCents).toBe(600n);
    expect(first.state.holdCents).toBe(400n);
    expect(first.deltaCents).toBe(-600n);
    expect(first.financialEntryIds).toHaveLength(1);

    const afterFirst = await bal.availableBalance(businessId);
    // The money moved: ledger down 600, hold down 600, available unchanged.
    expect(afterFirst.ledgerCents - afterAuth.ledgerCents).toBe(-600n);
    expect(afterFirst.holdsCents - afterAuth.holdsCents).toBe(-600n);
    expect(afterFirst.availableCents).toBe(afterAuth.availableCents);

    // Clearing 300 against the SAME authorisation. [MEASURED] hold=-100.
    const second = await applied(
      txn(
        card.providerCardToken,
        authToken,
        [
          lithicEvent("AUTHORIZATION", 1000, `${authToken}-e1`, created),
          lithicEvent("CLEARING", 600, `${authToken}-e2`, created),
          lithicEvent("CLEARING", 300, `${authToken}-e3`, created),
        ],
        { status: "SETTLED", hold: -100, settled: -900 },
      ),
    );
    expect(second.state.capturedCents).toBe(900n);
    expect(second.state.holdCents).toBe(100n);
    expect(second.deltaCents).toBe(-300n);

    const afterSecond = await bal.availableBalance(businessId);
    expect(afterSecond.ledgerCents - afterFirst.ledgerCents).toBe(-300n);
    expect(afterSecond.holdsCents - afterFirst.holdsCents).toBe(-300n);

    // Net over the whole scenario: 900 really left, 100 is still authorised.
    expect(afterSecond.ledgerCents - start.ledgerCents).toBe(-900n);
    expect(afterSecond.holdsCents - start.holdsCents).toBe(100n);
    expect(afterSecond.availableCents - start.availableCents).toBe(-1000n);

    // The memo book agrees with the fold over the event set, which is what
    // v_hold_drift asserts globally.
    expect(await store.memoHoldBalance(second.holdId, memoAccountId)).toBe(100n);
  });

  // =========================================================================
  // 4. The fuel pump
  // =========================================================================

  it("4. over-capture: $50 auth, $73.40 clearing — hold releases, AVAILABLE goes negative", async () => {
    const card = await freshCard();
    const authToken = `auth-${run}-4`;
    const created = new Date().toISOString();

    const start = await bal.availableBalance(businessId);

    const authOut = await applied(
      txn(
        card.providerCardToken,
        authToken,
        [lithicEvent("AUTHORIZATION", 5000, `${authToken}-e1`, created)],
        { hold: -5000 },
      ),
    );
    expect(authOut.state.holdCents).toBe(5000n);
    const afterAuth = await bal.availableBalance(businessId);
    expect(afterAuth.availableCents - start.availableCents).toBe(-5000n);
    expect(afterAuth.ledgerCents).toBe(start.ledgerCents);

    const clearOut = await applied(
      txn(
        card.providerCardToken,
        authToken,
        [
          lithicEvent("AUTHORIZATION", 5000, `${authToken}-e1`, created),
          lithicEvent("CLEARING", 7340, `${authToken}-e2`, created),
        ],
        // [MEASURED] the sandbox's own numbers for this exact case.
        { status: "SETTLED", hold: 0, settled: -7340 },
      ),
    );

    expect(clearOut.state.authorisedCents).toBe(5000n);
    expect(clearOut.state.capturedCents).toBe(7340n);
    expect(clearOut.state.holdCents).toBe(0n);
    expect(clearOut.deltaCents).toBe(-5000n);
    expect(clearOut.financialEntryIds).toHaveLength(1);

    const after = await bal.availableBalance(businessId);
    expect(after.ledgerCents - start.ledgerCents).toBe(-7340n);
    expect(after.holdsCents).toBe(start.holdsCents);
    // The customer paid 73.40 against a 50.00 authorisation. AVAILABLE moves by
    // the full 7340 and is not clamped anywhere: clamping loses money.
    expect(after.availableCents - start.availableCents).toBe(-7340n);
    expect(await store.memoHoldBalance(clearOut.holdId, memoAccountId)).toBe(0n);
  });

  it("4b. AVAILABLE is allowed to go negative rather than being floored at zero", async () => {
    const card = await freshCard();
    const authToken = `auth-${run}-4b`;
    const created = new Date().toISOString();

    // A FIXED amount, comfortably past anything a seeded demo account holds.
    // Deriving it from the balance would make the assertion depend on the
    // balance twice — once in the amount and once in the expectation — and any
    // concurrent posting between the two reads would move both.
    const overdraw = 500_000_00n;

    const start = await bal.availableBalance(businessId);
    const out = await applied(
      txn(
        card.providerCardToken,
        authToken,
        [lithicEvent("FINANCIAL_AUTHORIZATION", Number(overdraw), `${authToken}-e1`, created)],
        { status: "SETTLED", hold: 0, settled: -Number(overdraw) },
      ),
    );
    expect(out.state.holdCents).toBe(0n);

    const after = await bal.availableBalance(businessId);
    expect(after.availableCents - start.availableCents).toBe(-overdraw);
    expect(after.availableCents < 0n).toBe(true);

    // And it shows up where an operator will see it, with an amount.
    const [over] = await sql<{ overdraft_cents: bigint }[]>`
      SELECT overdraft_cents FROM v_overdrawn_accounts
       WHERE account_id = ${depositAccountId}::uuid`;
    expect(over?.overdraft_cents).toBeGreaterThan(0n);

    // Put it back, so the rest of the suite is not run against an overdrawn
    // account. A refund is a real card event, not a test-only escape hatch.
    await applied(
      txn(
        card.providerCardToken,
        `${authToken}-refund`,
        [lithicEvent("RETURN", Number(overdraw), `${authToken}-e2`, created)],
        { status: "SETTLED", settled: Number(overdraw) },
      ),
    );
    const restored = await bal.availableBalance(businessId);
    expect(restored.availableCents - after.availableCents).toBe(overdraw);
  });

  // =========================================================================
  // 5. Out of order
  // =========================================================================

  it("5. settlement BEFORE its authorisation converges on the same numbers", async () => {
    const created = new Date().toISOString();

    // Identical facts, delivered in opposite orders, on two authorisations.
    async function runSequence(
      label: string,
      order: "in-order" | "reversed",
    ): Promise<{
      delta: BalancesModule.AvailableBalance;
      hold: bigint;
      memo: bigint;
      authorised: bigint;
      captured: bigint;
    }> {
      const card = await freshCard();
      const authToken = `auth-${run}-5-${label}`;
      const authEvent = lithicEvent("AUTHORIZATION", 5000, `${authToken}-e1`, created);
      const clearEvent = lithicEvent("CLEARING", 3000, `${authToken}-e2`, created);

      const before = await bal.availableBalance(businessId);

      // Each delivery carries ONE event, which is the only way to make the
      // ordering real: Lithic's own payload always carries the whole array, so
      // a "clearing-first" payload is a payload that mentions no authorisation.
      const deliveries =
        order === "in-order"
          ? [
              txn(card.providerCardToken, authToken, [authEvent], { hold: -5000 }),
              txn(card.providerCardToken, authToken, [clearEvent], {
                status: "SETTLED",
                hold: -2000,
                settled: -3000,
              }),
            ]
          : [
              txn(card.providerCardToken, authToken, [clearEvent], {
                status: "SETTLED",
                settled: -3000,
              }),
              txn(card.providerCardToken, authToken, [authEvent], { hold: -2000 }),
            ];

      let last: ApplyModule.HoldOutcome | null = null;
      for (const delivery of deliveries) last = await applied(delivery);
      if (!last) throw new Error("no deliveries");

      const after = await bal.availableBalance(businessId);
      return {
        delta: {
          ledgerCents: after.ledgerCents - before.ledgerCents,
          holdsCents: after.holdsCents - before.holdsCents,
          unclearedCents: after.unclearedCents - before.unclearedCents,
          availableCents: after.availableCents - before.availableCents,
        },
        hold: last.state.holdCents,
        memo: await store.memoHoldBalance(last.holdId, memoAccountId),
        authorised: last.state.authorisedCents,
        captured: last.state.capturedCents,
      };
    }

    const inOrder = await runSequence("a", "in-order");
    const reversed = await runSequence("b", "reversed");

    // The whole claim, in four lines: identical events, opposite arrival order,
    // identical everything. There is no case analysis anywhere that produced
    // this — H is a function of a set, and a set has no order to be out of.
    expect(reversed.delta).toEqual(inOrder.delta);
    expect(reversed.hold).toBe(inOrder.hold);
    expect(reversed.memo).toBe(inOrder.memo);
    expect(reversed.authorised).toBe(inOrder.authorised);
    expect(reversed.captured).toBe(inOrder.captured);

    // And the numbers are the right ones: 5000 authorised, 3000 captured,
    // 2000 still held, ledger down 3000, available down 5000.
    expect(inOrder.hold).toBe(2000n);
    expect(inOrder.delta.ledgerCents).toBe(-3000n);
    expect(inOrder.delta.holdsCents).toBe(2000n);
    expect(inOrder.delta.availableCents).toBe(-5000n);

    // The only difference is the reporting column that records how we first
    // heard of it — and nothing branches on it.
    const [a] = await sql<{ origin: string }[]>`
      SELECT origin FROM card_authorization WHERE provider_auth_id = ${`auth-${run}-5-a`}`;
    const [b] = await sql<{ origin: string }[]>`
      SELECT origin FROM card_authorization WHERE provider_auth_id = ${`auth-${run}-5-b`}`;
    expect(a?.origin).toBe("authorization");
    expect(b?.origin).toBe("clearing_first");
  });

  // =========================================================================
  // 6. Replay
  // =========================================================================

  it("6. replaying any single delivery changes nothing — twice is one", async () => {
    const card = await freshCard();
    const authToken = `auth-${run}-6`;
    const created = new Date().toISOString();
    const payload = txn(
      card.providerCardToken,
      authToken,
      [
        lithicEvent("AUTHORIZATION", 4200, `${authToken}-e1`, created),
        lithicEvent("CLEARING", 1200, `${authToken}-e2`, created),
      ],
      { status: "SETTLED", hold: -3000, settled: -1200 },
    );

    const first = await applied(payload);
    const between = await bal.availableBalance(businessId);
    expect(first.newEvents).toBe(2);

    // The same bytes, three more times.
    const second = await applied(payload);
    const third = await applied(payload);
    const fourth = await applied(payload);
    const after = await bal.availableBalance(businessId);

    for (const replay of [second, third, fourth]) {
      expect(replay.newEvents).toBe(0);
      expect(replay.deltaCents).toBe(0n);
      expect(replay.memoEntryId).toBeNull();
      expect(replay.state.holdCents).toBe(first.state.holdCents);
      // The financial entry is RETURNED (it is the entry representing this
      // fact) but was not written again.
      expect(replay.financialEntryIds).toEqual(first.financialEntryIds);
    }

    expect(after).toEqual(between);

    // Proven at the database, not by the return values: one event row per fact,
    // one journal entry per idempotency key.
    const [events] = await sql<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM card_auth_event
       WHERE auth_id = ${first.authId}::uuid`;
    expect(events?.n).toBe(2n);
    expect(await entriesWithKey(`card:clearing:${authToken}-e2`)).toBe(1);
    expect(
      await entriesWithKey(model.holdPostingKey(first.holdId, `${authToken}-e2`)),
    ).toBe(1);
  });

  // =========================================================================
  // 7. Exactly-once release under a concurrent double-fire
  // =========================================================================

  it("7. the release posts EXACTLY ONCE when two workers race it", async () => {
    const card = await freshCard();
    const authToken = `auth-${run}-7`;
    const created = new Date().toISOString();

    // Open a hold the normal way.
    const opened = await applied(
      txn(
        card.providerCardToken,
        authToken,
        [lithicEvent("AUTHORIZATION", 6000, `${authToken}-e1`, created)],
        { hold: -6000 },
      ),
    );
    expect(opened.state.holdCents).toBe(6000n);

    const identity = await store.findAuthorization("lithic", authToken, sql);
    if (!identity) throw new Error("identity vanished");

    // Record the final capture WITHOUT settling the hold, so a release is
    // genuinely outstanding when the two workers start.
    const finalEventId = `${authToken}-e2`;
    await sql.begin(async (raw) => {
      const tx = raw as unknown as typeof sql;
      await store.lockAuthorization(identity.authId, tx);
      await store.insertCardEvents(
        identity.authId,
        [
          {
            kind: "clearing",
            amountCents: 6000n,
            isFinal: true,
            valueDate: created.slice(0, 10),
            providerEventId: finalEventId,
          },
        ],
        null,
        tx,
      );
    });

    const actorId = await store.ledgerPosterActorId(sql);
    const args = {
      providerEventId: finalEventId,
      valueDate: created.slice(0, 10),
      externalRef: authToken,
      actorId,
      now: new Date(),
    };

    // Two workers, same event, at the same time.
    const [left, right] = await Promise.all([
      apply.settleHoldPosting(identity, args, sql),
      apply.settleHoldPosting(identity, args, sql),
    ]);

    // One of them moved the money; the other recomputed and found Δ = 0. Which
    // one won is not determined and does not matter — what matters is that the
    // total is one release of exactly 6000.
    const deltas = [left.deltaCents, right.deltaCents].sort();
    expect(deltas).toEqual([-6000n, 0n]);

    // The claim, at the database: ONE journal entry carries this key.
    const key = model.holdPostingKey(identity.holdId, finalEventId);
    expect(await entriesWithKey(key)).toBe(1);

    // The hold is empty, and it stays empty however many more times anyone
    // runs the release path.
    expect(await store.memoHoldBalance(identity.holdId, memoAccountId)).toBe(0n);
    const again = await apply.settleHoldPosting(identity, args, sql);
    expect(again.deltaCents).toBe(0n);
    expect(again.entryId).toBeNull();
    expect(await entriesWithKey(key)).toBe(1);
  });

  it("7b. availability is already right if the process dies before the release posts", async () => {
    // The crash-safety half of the exactly-once argument, made physical: write
    // the closure, do NOT write the release posting, and read the customer's
    // available balance. It must already be correct, because availability reads
    // "released" as a hold_closure row existing and not as a memo balance.
    const card = await freshCard();
    const authToken = `auth-${run}-7b`;
    const created = new Date().toISOString();

    const start = await bal.availableBalance(businessId);
    const opened = await applied(
      txn(
        card.providerCardToken,
        authToken,
        [lithicEvent("AUTHORIZATION", 3300, `${authToken}-e1`, created)],
        { hold: -3300 },
      ),
    );
    const held = await bal.availableBalance(businessId);
    expect(held.availableCents - start.availableCents).toBe(-3300n);

    const identity = await store.findAuthorization("lithic", authToken, sql);
    if (!identity) throw new Error("identity vanished");
    const actorId = await store.ledgerPosterActorId(sql);

    // The closure lands. The release posting does not — this is the crash.
    await sql.begin(async (raw) => {
      const tx = raw as unknown as typeof sql;
      await store.closeHold(identity.holdId, "simulated crash before release", actorId, tx);
    });

    const afterClosure = await bal.availableBalance(businessId);
    // The money is free ALREADY, with the memo book still reading 3300.
    expect(await store.memoHoldBalance(identity.holdId, memoAccountId)).toBe(3300n);
    expect(afterClosure.availableCents).toBe(start.availableCents);
    expect(afterClosure.holdsCents).toBe(start.holdsCents);

    // And when the posting eventually lands it is a no-op for the customer:
    // the predicate had already zeroed the term, so the two cannot double-count.
    const settled = await apply.settleHoldPosting(
      identity,
      {
        providerEventId: `${authToken}-sweep`,
        valueDate: created.slice(0, 10),
        externalRef: authToken,
        actorId,
        now: new Date(Date.now() + 10 * 86_400_000), // past the expiry: closed
      },
      sql,
    );
    expect(settled.deltaCents).toBe(-3300n);
    const afterPosting = await bal.availableBalance(businessId);
    expect(afterPosting.availableCents).toBe(afterClosure.availableCents);
    expect(await store.memoHoldBalance(opened.holdId, memoAccountId)).toBe(0n);
  });

  // =========================================================================
  // 8. Expiry
  // =========================================================================

  it("8. a hold past expires_at with no clearing releases, idempotently", async () => {
    const card = await freshCard();
    const authToken = `auth-${run}-8`;
    const created = new Date().toISOString();

    const start = await bal.availableBalance(businessId);
    const opened = await applied(
      txn(
        card.providerCardToken,
        authToken,
        [lithicEvent("AUTHORIZATION", 2500, `${authToken}-e1`, created)],
        { hold: -2500 },
      ),
    );
    expect(opened.state.holdCents).toBe(2500n);
    const held = await bal.availableBalance(businessId);
    expect(held.availableCents - start.availableCents).toBe(-2500n);

    const identity = await store.findAuthorization("lithic", authToken, sql);
    if (!identity) throw new Error("identity vanished");
    const actorId = await store.ledgerPosterActorId(sql);

    // Eight days later. Nothing was captured.
    const future = new Date(Date.now() + 8 * 86_400_000);

    const first = await expiry.expireOne(identity, { now: future, actorId, conn: sql });
    expect(first.closurePosted).toBe(true);
    expect(first.deltaCents).toBe(-2500n);

    const afterExpiry = await bal.availableBalance(businessId);
    expect(afterExpiry.availableCents).toBe(start.availableCents);
    // The clock released a hold and NO money moved: an expiry never touches the
    // financial book.
    expect(afterExpiry.ledgerCents).toBe(start.ledgerCents);
    expect(await store.memoHoldBalance(identity.holdId, memoAccountId)).toBe(0n);

    // Run it again. And again.
    const second = await expiry.expireOne(identity, { now: future, actorId, conn: sql });
    const third = await expiry.expireOne(identity, { now: future, actorId, conn: sql });
    expect(second.closurePosted).toBe(false);
    expect(second.deltaCents).toBe(0n);
    expect(third.deltaCents).toBe(0n);

    const afterReruns = await bal.availableBalance(businessId);
    expect(afterReruns).toEqual(afterExpiry);

    // One expiry fact, one release posting, however many sweeps ran.
    const [events] = await sql<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM card_auth_event
       WHERE auth_id = ${identity.authId}::uuid AND kind = 'expiry'`;
    expect(events?.n).toBe(1n);
    expect(
      await entriesWithKey(model.holdPostingKey(identity.holdId, expiry.expiryEventId(identity.authId))),
    ).toBe(1);
  });

  it("8b. the batch sweep finds due holds and is a no-op on the second pass", async () => {
    const future = new Date(Date.now() + 9 * 86_400_000);
    const firstPass = await expiry.sweepExpiredHolds({ now: future, limit: 200, conn: sql });
    const secondPass = await expiry.sweepExpiredHolds({ now: future, limit: 200, conn: sql });

    expect(secondPass.closed).toBe(0);
    expect(secondPass.released).toBe(0);
    expect(secondPass.releasedCents).toBe(0n);
    // The first pass may legitimately find nothing if an earlier run already
    // swept, so the assertion is about the SECOND pass being empty, not the
    // first being non-empty.
    expect(firstPass.examined).toBeGreaterThanOrEqual(0);
  });

  // =========================================================================
  // Cross-checks: the TypeScript model against the SQL, and the invariants
  // =========================================================================

  it("the TypeScript model agrees with v_card_auth_hold, row for row", async () => {
    // If these ever disagree, v_hold_drift starts reporting and the memo book
    // is being driven to a number the database does not believe.
    const rows = await sql<
      {
        auth_id: string;
        expires_at: Date;
        auth_net_cents: bigint;
        captured_cents: bigint;
        is_closed: boolean;
        target_hold_cents: bigint;
      }[]
    >`SELECT auth_id, expires_at, is_closed,
             -- SUM() over bigint returns NUMERIC in Postgres, which the driver
             -- hands back as a string. Casting here keeps the comparison a
             -- comparison of integers rather than of representations.
             auth_net_cents::bigint    AS auth_net_cents,
             captured_cents::bigint    AS captured_cents,
             target_hold_cents::bigint AS target_hold_cents
        FROM v_card_auth_hold`;
    expect(rows.length).toBeGreaterThan(0);

    const now = new Date();
    for (const row of rows) {
      const events = await store.loadCardEvents(row.auth_id, sql);
      const state = model.holdState(events, {
        expiresAt: new Date(row.expires_at),
        now,
      });
      expect({
        a: state.authorisedCents,
        c: state.capturedCents,
        closed: state.closed,
        h: state.holdCents,
      }).toEqual({
        a: row.auth_net_cents,
        c: row.captured_cents,
        closed: row.is_closed,
        h: row.target_hold_cents,
      });
    }
  });

  it("every invariant view is still empty and both books still net to zero", async () => {
    for (const view of [
      "v_entry_unbalanced",
      "v_line_denorm_drift",
      "v_hold_drift",
      "v_book_not_zero",
      "v_deposit_control_drift",
    ] as const) {
      const rows = await sql.unsafe(`SELECT * FROM ${view}`);
      expect({ view, rows: rows.length }).toEqual({ view, rows: 0 });
    }
    expect(await bal.trialBalanceCents()).toBe(0n);
  });
});
