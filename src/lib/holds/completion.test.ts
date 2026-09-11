/**
 * The opening whose memo posting never landed — reached on purpose.
 *
 * `v_hold_drift` caught this defect in production. It caught it because a
 * human ran `dbcheck` and looked, and because the view compares two numbers
 * that do not share an input. What nothing in this repository did was make the
 * view FAIL on purpose in this direction: the eight live-fire attacks do not
 * kill a process mid-apply, and `dbcheck --prove` proves the refused-auth and
 * wire views, not this one.
 *
 * Decision 023 already wrote the rule this suite exists to satisfy: *a view
 * that is asserted to be empty and never seen to fail is a comment.* So every
 * scenario below drives `v_hold_drift` to exactly one row, from a state a real
 * process really produced, and then clears it through the production path.
 *
 * ─── The two ways this state is reachable, and only one of them was the bug ──
 *
 *   1. A CRASH between the two transactions `apply.ts` used to use. The facts
 *      commit, the memo posting does not, the process dies. This is the
 *      hypothesis migration 0036 investigated and DISPROVED for the live
 *      incident — and it is the shape nothing had ever reproduced, so it is
 *      reproduced here, with `apply.ts`'s own store primitives, stopping where
 *      the old transaction one stopped.
 *
 *   2. A BYPASS. Something writes the hold, the authorisation and the event
 *      with raw SQL and never posts a memo entry, because it never knew it had
 *      to. This is what actually happened: `team.integration.test.ts` §9 does
 *      exactly this against the live book, under the comment "No money — this
 *      suite never posts". The memo book is not money; it is the withholding.
 *
 * Atomicity kills (1). Only the sweep can reach (2), which is why both exist.
 *
 * ─── Why nothing below writes SQL against journal_entry ─────────────────────
 *
 * `src/lib/ledger/boundary.test.ts` holds test suites to the same boundary as
 * modules, and it is right to: a test that reaches into `journal_line` to
 * check a balance is a test asserting its own definition of the balance. So
 * entries are read through `findEntryByIdempotencyKey()` and memo balances
 * through `memoHoldBalance()`, and the fixture business is found through
 * `card` rather than through the chart.
 *
 * Gated on RUN_DB_TESTS=1, like every other suite that talks to Neon:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test completion
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import { findEntryByIdempotencyKey } from "@/lib/ledger/readers";
import type { sql as SqlHandle } from "@/lib/ledger/db";
import type { Transaction } from "@/lib/rails/lithic/types";

import type * as ApplyModule from "./apply";
import type * as CompletionModule from "./completion";
import type * as ExpiryModule from "./expiry";
import type * as ModelModule from "./model";
import type * as StoreModule from "./store";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** The card-hold suite's fixture business, reused rather than re-provisioned. */
const TEST_BUSINESS_ID = "7e57b115-0000-5000-a000-000000000001";

d("the hold completion sweep, against the live database", () => {
  let sql: typeof SqlHandle;
  let apply: typeof ApplyModule;
  let store: typeof StoreModule;
  let model: typeof ModelModule;
  let expiry: typeof ExpiryModule;
  let completion: typeof CompletionModule;

  let businessId: string;
  let actorId: string;

  const run = Date.now();
  let seq = 0;

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    apply = await import("./apply");
    store = await import("./store");
    model = await import("./model");
    expiry = await import("./expiry");
    completion = await import("./completion");

    // Prefer the holds suite's own fixture business, and fall back to any
    // business that already carries a card — which is a business that provably
    // has the 2100/9100 pair, since `registerCard()` refuses to bind one
    // without it. Asked of `card` rather than of the chart: opening an account
    // is an OWNER action this suite deliberately does not hold, and reading the
    // chart directly is the boundary this repository enforces by test.
    const [b] = await sql<{ business_id: string }[]>`
      SELECT business_id FROM card
       ORDER BY (business_id = ${TEST_BUSINESS_ID}::uuid) DESC, business_id
       LIMIT 1`;
    if (!b) throw new Error("no business carries a card; run node scripts/seed.mjs");
    businessId = b.business_id;
    actorId = await store.ledgerPosterActorId(sql);
  });

  async function freshCard(): Promise<StoreModule.CardBinding> {
    seq += 1;
    return store.registerCard(
      {
        provider: "lithic",
        providerCardToken: `completion-card-${run}-${seq}`,
        businessId,
        lastFour: "4242",
        nickname: `completion sweep ${run}-${seq}`,
      },
      sql,
    );
  }

  async function driftRowsFor(holdId: string): Promise<number> {
    const [row] = await sql<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM v_hold_drift WHERE hold_id = ${holdId}::uuid`;
    return Number(row?.n ?? 0n);
  }

  /**
   * The entry one idempotency key wrote, through the ledger's own named
   * reader. `journal_entry.idempotency_key` is UNIQUE, so "this returns a row"
   * and "exactly one entry exists under this key" are the same statement.
   */
  async function entryForKey(
    key: string,
  ): Promise<{ entryId: string; valueDate: string } | null> {
    return findEntryByIdempotencyKey(key, sql);
  }

  /**
   * Put the hold beyond the reach of every invariant, the way scenario 7b of
   * `holds.integration.test.ts` does: record the expiry the nightly sweep
   * would have recorded. Without this the suite leaves a live $50 hold on a
   * real customer's account every run.
   */
  async function tidy(identity: StoreModule.AuthorizationIdentity): Promise<void> {
    await expiry.expireOne(identity, {
      now: new Date(Date.now() + 10 * 86_400_000),
      actorId,
      conn: sql,
    });
  }

  // =========================================================================
  // 1. The crash the split made possible
  // =========================================================================

  it("1. facts without their memo posting: v_hold_drift reports it, the sweep clears it", async () => {
    const card = await freshCard();
    const authToken = `completion-${run}-crash`;
    const eventId = `${authToken}-e1`;
    const valueDate = new Date().toISOString().slice(0, 10);

    // EXACTLY the old transaction one, and then nothing. `ensureAuthorization`,
    // the row lock, the facts — every statement `recordFacts()` issued before
    // migration 0036 moved the compare-and-append in beside them. The process
    // dies at the closing brace.
    const identity = await sql.begin(async (raw) => {
      const tx = raw as unknown as typeof sql;
      const id = await store.ensureAuthorization(
        {
          provider: "lithic",
          providerAuthId: authToken,
          card,
          origin: "authorization",
          valueDate,
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
        },
        tx,
      );
      await store.lockAuthorization(id.authId, tx);
      await store.insertCardEvents(
        id.authId,
        [
          {
            kind: "authorization",
            amountCents: 5000n,
            isFinal: false,
            valueDate,
            providerEventId: eventId,
          },
        ],
        null,
        tx,
      );
      return id;
    });

    // THE GUARD FIRES. This is the assertion the whole file exists for: the
    // view is reachable in the under-withholding direction, from a state a
    // killed process really leaves, and it reports the right hold.
    expect(await driftRowsFor(identity.holdId)).toBe(1);
    expect(await store.memoHoldBalance(identity.holdId, card.memoAccountId, sql)).toBe(0n);

    // And the work queue sees the same hold, with the provenance that tells an
    // operator which of the two causes this is. `through_apply` is TRUE here:
    // the identity came out of `ensureAuthorization()`, so this is a crash,
    // not a bypass.
    const due = await completion.findIncompleteHoldPostings({ conn: sql, limit: 500 });
    const mine = due.find((r) => r.identity.holdId === identity.holdId);
    expect(mine).toBeDefined();
    expect(mine?.missingCents).toBe(5000n);
    expect(mine?.targetHoldCents).toBe(5000n);
    expect(mine?.memoBalanceCents).toBe(0n);
    expect(mine?.lastEventId).toBe(eventId);
    expect(mine?.lastEventValueDate).toBe(valueDate);
    expect(mine?.throughApply).toBe(true);
    expect(mine?.fromWebhook).toBe(false);

    if (!mine) throw new Error("unreachable");
    const completed = await completion.completeOne(mine, { actorId, conn: sql });
    expect(completed.deltaCents).toBe(5000n);
    expect(completed.entryId).not.toBeNull();

    // The money is withheld, the guard is quiet, and the entry carries the key
    // the LOST DELIVERY would have used — so a redelivery of that payload
    // computes Δ = 0 and appends nothing rather than racing a second entry in.
    expect(await store.memoHoldBalance(identity.holdId, card.memoAccountId, sql)).toBe(5000n);
    expect(await driftRowsFor(identity.holdId)).toBe(0);

    const entry = await entryForKey(model.holdPostingKey(identity.holdId, eventId));
    expect(entry?.entryId).toBe(completed.entryId);
    // It books at the ORIGINAL value date. Today's date would put the
    // withholding on today's statement and leave the day it belongs to wrong
    // for ever, which is the failure the whole correction machinery exists for.
    expect(entry?.valueDate).toBe(valueDate);

    await tidy(identity);
  });

  // =========================================================================
  // 2. The bypass that actually happened
  // =========================================================================

  it("2. a hold written by raw SQL is reported as a bypass and swept", async () => {
    const card = await freshCard();
    // `team.integration.test.ts` §9's shape, byte for byte in the part that
    // matters: ONE string is used for both `provider_auth_id` and
    // `hold.external_ref`, where `ensureAuthorization()` would have prefixed
    // the provider onto the second. That difference is what `through_apply`
    // reads, and it is what identified the source of the live incident.
    const ref = `lithic:completion-${run}-bypass`;
    const valueDate = new Date().toISOString().slice(0, 10);

    const [hold] = await sql<{ id: string }[]>`
      INSERT INTO hold (account_id, memo_account_id, kind, external_ref, value_date, expires_at)
      VALUES (${card.accountId}::uuid, ${card.memoAccountId}::uuid, 'card_auth',
              ${ref}, ${valueDate}::date, now() + interval '7 days')
      RETURNING id`;
    const [auth] = await sql<{ id: string }[]>`
      INSERT INTO card_authorization (provider, provider_auth_id, card_id, account_id,
                                      hold_id, origin, expires_at)
      VALUES ('lithic', ${ref}, ${card.cardId}::uuid, ${card.accountId}::uuid,
              ${hold?.id ?? ""}::uuid, 'authorization', now() + interval '7 days')
      RETURNING id`;
    await sql`
      INSERT INTO card_auth_event (auth_id, kind, amount_cents, is_final, value_date, provider_event_id)
      VALUES (${auth?.id ?? ""}::uuid, 'authorization', 5000, false, ${valueDate}::date, ${`${ref}-e1`})`;

    const holdId = hold?.id ?? "";
    expect(await driftRowsFor(holdId)).toBe(1);

    const due = await completion.findIncompleteHoldPostings({ conn: sql, limit: 500 });
    const mine = due.find((r) => r.identity.holdId === holdId);
    expect(mine).toBeDefined();
    // The provenance that names the cause: nothing is coming for this hold.
    expect(mine?.throughApply).toBe(false);
    expect(mine?.fromWebhook).toBe(false);

    const result = await completion.sweepIncompleteHoldPostings({ conn: sql, limit: 500 });
    expect(result.failures).toEqual([]);
    expect(result.examined).toBeGreaterThanOrEqual(1);

    expect(await driftRowsFor(holdId)).toBe(0);
    expect(await store.memoHoldBalance(holdId, card.memoAccountId, sql)).toBe(5000n);

    const identity = await store.findAuthorization("lithic", ref, sql);
    if (!identity) throw new Error("identity vanished");
    await tidy(identity);
  });

  // =========================================================================
  // 3. Running it twice, and running it against a live delivery
  // =========================================================================

  it("3. the sweep is idempotent and safe to race — one posting, exactly", async () => {
    const card = await freshCard();
    const authToken = `completion-${run}-race`;
    const eventId = `${authToken}-e1`;
    const valueDate = new Date().toISOString().slice(0, 10);

    const identity = await sql.begin(async (raw) => {
      const tx = raw as unknown as typeof sql;
      const id = await store.ensureAuthorization(
        {
          provider: "lithic",
          providerAuthId: authToken,
          card,
          origin: "authorization",
          valueDate,
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
        },
        tx,
      );
      await store.lockAuthorization(id.authId, tx);
      await store.insertCardEvents(
        id.authId,
        [
          {
            kind: "authorization",
            amountCents: 5000n,
            isFinal: false,
            valueDate,
            providerEventId: eventId,
          },
        ],
        null,
        tx,
      );
      return id;
    });

    const due = await completion.findIncompleteHoldPostings({ conn: sql, limit: 500 });
    const mine = due.find((r) => r.identity.holdId === identity.holdId);
    if (!mine) throw new Error("the guard did not report the hold the test just created");

    // Two sweepers on one hold, at the same time. Safety here is the ROW LOCK
    // and not a delay: one of them computes Δ and the other recomputes under
    // the same lock and finds Δ = 0. Same argument as scenario 7 of
    // holds.integration.test.ts, pointed at the opening instead of the release.
    const [left, right] = await Promise.all([
      completion.completeOne(mine, { actorId, conn: sql }),
      completion.completeOne(mine, { actorId, conn: sql }),
    ]);
    const deltas = [left.deltaCents, right.deltaCents].sort();
    expect(deltas).toEqual([0n, 5000n]);

    // The money is the proof, not the row count: 5000 and not 10000 is what
    // "exactly once" means to the customer.
    expect(await store.memoHoldBalance(identity.holdId, card.memoAccountId, sql)).toBe(5000n);
    expect(await driftRowsFor(identity.holdId)).toBe(0);
    expect(await entryForKey(model.holdPostingKey(identity.holdId, eventId))).not.toBeNull();

    // A third run, serial, long after. Still nothing.
    const again = await completion.completeOne(mine, { actorId, conn: sql });
    expect(again.deltaCents).toBe(0n);
    expect(again.entryId).toBeNull();
    expect(await store.memoHoldBalance(identity.holdId, card.memoAccountId, sql)).toBe(5000n);

    await tidy(identity);
  });

  // =========================================================================
  // 4. The window itself, closed
  // =========================================================================

  it("4. an ordinary delivery leaves nothing for the sweep to find", async () => {
    const card = await freshCard();
    const authToken = `completion-${run}-atomic`;
    const eventId = `${authToken}-e1`;
    const created = new Date().toISOString();

    const txn: Transaction = {
      token: authToken,
      account_token: "2742964f-478f-47ef-a4e9-852dc50d9c44",
      card_token: card.providerCardToken,
      created,
      updated: created,
      status: "PENDING",
      result: "APPROVED",
      amounts: {
        cardholder: { amount: 0, conversion_rate: "1.000000", currency: "USD" },
        hold: { amount: -5000, currency: "USD" },
        merchant: { amount: 0, currency: "USD" },
        settlement: { amount: 0, currency: "USD" },
      },
      events: [
        {
          token: eventId,
          type: "AUTHORIZATION",
          created,
          amount: 5000,
          amounts: {
            cardholder: { amount: 5000, conversion_rate: "1.000000", currency: "USD" },
            merchant: { amount: 5000, currency: "USD" },
            settlement: null,
          },
          effective_polarity: "DEBIT",
          result: "APPROVED",
        },
      ],
    };

    const outcome = await apply.applyCardTransaction(txn, { now: new Date() });
    if (outcome.status !== "applied") throw new Error(`expected applied, got ${outcome.status}`);

    // ONE CALL, and the withholding is already on the book. Before migration
    // 0036 the memo entry was a second transaction, and this assertion was
    // still true — what was not true was that it was true CONTINUOUSLY. The
    // difference is not visible from out here, which is the honest thing to
    // say about it: the atomicity claim is structural, one `conn.begin()` in
    // `recordFacts()`, and the DEMONSTRATION of it is that scenarios 1 and 3
    // above cannot use `applyCardTransaction()` to reach the drifted state and
    // have to rebuild the old transaction one out of store primitives instead.
    expect(outcome.deltaCents).toBe(5000n);
    expect(outcome.memoEntryId).not.toBeNull();
    expect(await store.memoHoldBalance(outcome.holdId, card.memoAccountId, sql)).toBe(5000n);
    expect(await driftRowsFor(outcome.holdId)).toBe(0);

    const entry = await entryForKey(model.holdPostingKey(outcome.holdId, eventId));
    expect(entry?.entryId).toBe(outcome.memoEntryId);

    // And the sweep, run immediately behind a live delivery, finds nothing to
    // do for it — which is the property that lets it be scheduled at all.
    const due = await completion.findIncompleteHoldPostings({ conn: sql, limit: 500 });
    expect(due.map((r) => r.identity.holdId)).not.toContain(outcome.holdId);

    const identity = await store.findAuthorization("lithic", authToken, sql);
    if (!identity) throw new Error("identity vanished");
    await tidy(identity);
  });
});
