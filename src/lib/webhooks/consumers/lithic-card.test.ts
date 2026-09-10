/**
 * The Lithic consumer.
 *
 * Two halves, and the split is on purpose:
 *
 *   The decision half runs everywhere, including CI with no credentials. Every
 *   path it covers returns before the consumer touches a database, so a
 *   placeholder connection string is enough to import the module and the
 *   assertions are still about real behaviour.
 *
 *   The ledger half runs against the LIVE database behind RUN_DB_TESTS=1, and
 *   it finishes by dispatching the REAL Lithic deliveries that are sitting in
 *   `webhook_inbox` right now — two `card_transaction.updated` bodies for a
 *   $50.00 authorisation at "FUEL PUMP 42", signed by Lithic and verified by
 *   the route handler on 2026-09-10. Processing those is the difference
 *   between a pipeline that is tested and a pipeline that has run.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ConsumerContext } from "../dispatch";
import type { InboxEvent } from "../inbox";

// `env.ts` parses eagerly at import and APP_DATABASE_URL is the one variable
// required to boot, while `postgres()` opens no socket until the first query.
// The decision paths below never issue one, so a placeholder is enough — and
// it means CI, which holds no credentials, still exercises this module rather
// than skipping it wholesale.
process.env["APP_DATABASE_URL"] ??= "postgres://placeholder/none";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

/** The real card token from the deliveries in `webhook_inbox`. */
const REAL_CARD_TOKEN = "56db7b80-a103-4adf-acdd-4cab460c2963";
/** The two real Lithic transaction tokens, from those same deliveries. */
const REAL_AUTH_TOKENS = [
  "69d2f4f3-8101-4a08-9524-98ae5edd96c8",
  "764aacaa-c156-493f-9781-45b6f1934c65",
] as const;

const NULL_LOGGER: ConsumerContext["logger"] = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function inboxEvent(overrides: Partial<InboxEvent>): InboxEvent {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    provider: "lithic",
    providerEventId: "msg_test",
    eventType: "card_transaction.updated",
    payload: {},
    headers: {},
    rawBody: "{}",
    receivedAt: new Date(),
    signatureVerifiedAt: new Date(),
    state: "pending",
    attempts: 1,
    parkAttempts: 0,
    nextAttemptAt: new Date(),
    lockedUntil: null,
    processedAt: null,
    parkedOnKind: null,
    parkedOnRef: null,
    parkedReason: null,
    processingError: null,
    deadLetteredAt: null,
    ...overrides,
  };
}

const ctx: ConsumerContext = { now: new Date(), attempt: 1, logger: NULL_LOGGER };

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

describe("parseStoredPayload — the double-encoding from DECISIONS 020", () => {
  it("returns a genuine jsonb object untouched", async () => {
    const { parseStoredPayload } = await import("./lithic-card");
    const payload = { token: "t", card_token: "c" };
    expect(parseStoredPayload(payload)).toBe(payload);
  });

  it("parses a jsonb STRING, which is what the pre-fix rows actually hold", async () => {
    const { parseStoredPayload } = await import("./lithic-card");
    // This is the exact shape `SELECT payload FROM webhook_inbox` returns for
    // the two real deliveries: the body arrived already JSON.stringify'd and a
    // bare `::jsonb` quoted it a second time.
    const doubleEncoded = JSON.stringify({ token: "t", card_token: "c" });
    expect(parseStoredPayload(doubleEncoded)).toEqual({ token: "t", card_token: "c" });
  });

  it("returns null for a scalar, for garbage, and for nothing at all", async () => {
    const { parseStoredPayload } = await import("./lithic-card");
    expect(parseStoredPayload('"just a string"')).toBeNull();
    expect(parseStoredPayload("{not json")).toBeNull();
    expect(parseStoredPayload(null)).toBeNull();
    expect(parseStoredPayload(42)).toBeNull();
  });
});

describe("asCardTransaction — three fields, and deliberately not the trap ones", () => {
  it("accepts a payload carrying token, card_token and created", async () => {
    const { asCardTransaction } = await import("./lithic-card");
    const txn = asCardTransaction({
      token: REAL_AUTH_TOKENS[0],
      card_token: REAL_CARD_TOKEN,
      created: "2026-09-10T16:23:11Z",
    });
    expect(txn?.token).toBe(REAL_AUTH_TOKENS[0]);
  });

  it("accepts one with NO status, hold or settled_amount at all", async () => {
    // Requiring them would reject payloads this consumer can process perfectly
    // well, because it never reads any of them.
    const { asCardTransaction } = await import("./lithic-card");
    expect(
      asCardTransaction({ token: "t", card_token: "c", created: "2026-09-10T16:23:11Z" }),
    ).not.toBeNull();
  });

  it("rejects a payload missing any of the three, or with an unparseable date", async () => {
    const { asCardTransaction } = await import("./lithic-card");
    expect(asCardTransaction({ card_token: "c", created: "2026-09-10T16:23:11Z" })).toBeNull();
    expect(asCardTransaction({ token: "t", created: "2026-09-10T16:23:11Z" })).toBeNull();
    expect(asCardTransaction({ token: "t", card_token: "c" })).toBeNull();
    expect(asCardTransaction({ token: "t", card_token: "c", created: "not a date" })).toBeNull();
    expect(asCardTransaction({ token: "", card_token: "c", created: "2026-09-10" })).toBeNull();
  });
});

describe("handle — the paths that answer without touching the ledger", () => {
  it("ignores every Lithic event that is not the transaction lifecycle", async () => {
    const { lithicCardConsumer } = await import("./lithic-card");
    for (const eventType of ["card.created", "card.updated", "balance.updated", null]) {
      const result = await lithicCardConsumer.handle(inboxEvent({ eventType }), ctx);
      expect(result.status).toBe("ignored");
    }
  });

  it("ignores, rather than fails, a body it cannot read", async () => {
    // Throwing here would burn the eight-attempt retry budget on something that
    // will never parse and then dead-letter it. `ignored` says we looked.
    const { lithicCardConsumer } = await import("./lithic-card");
    expect((await lithicCardConsumer.handle(inboxEvent({ payload: "{oops" }), ctx)).status).toBe(
      "ignored",
    );
    expect((await lithicCardConsumer.handle(inboxEvent({ payload: {} }), ctx)).status).toBe(
      "ignored",
    );
  });

  it("registers under 'lithic' and refuses a silent second registration", async () => {
    const { registerLithicCardConsumer, lithicCardConsumer } = await import("./lithic-card");
    const { ConsumerRegistry } = await import("../dispatch");
    const registry = new ConsumerRegistry();
    registerLithicCardConsumer(registry);
    expect(registry.get("lithic")).toBe(lithicCardConsumer);
    expect(registry.providers()).toEqual(["lithic"]);
    // Last-wins registration is how two people ship two consumers for one
    // provider and nobody notices which one is live.
    expect(() => registerLithicCardConsumer(registry)).toThrow(/already registered/);
    expect(() => registerLithicCardConsumer(registry, { replace: true })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The ledger, and the real deliveries
// ---------------------------------------------------------------------------

d("the consumer against the live database", () => {
  let sql: Awaited<typeof import("@/lib/ledger/db")>["sql"];
  let consumer: Awaited<typeof import("./lithic-card")>["lithicCardConsumer"];

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    ({ lithicCardConsumer: consumer } = await import("./lithic-card"));
  });

  it("PARKS on a card it has never been told about, instead of guessing an account", async () => {
    // The dangerous alternative is picking "the" customer. A card token we do
    // not recognise is either a race with card creation or somebody else's
    // program, and both are better parked than posted to a stranger.
    const unknown = `unregistered-${Date.now()}`;
    const result = await consumer.handle(
      inboxEvent({
        id: null as unknown as string,
        payload: {
          token: `txn-${Date.now()}`,
          card_token: unknown,
          created: new Date().toISOString(),
          events: [],
        },
      }),
      ctx,
    );
    expect(result).toEqual({
      status: "parked",
      waitingFor: { kind: "card", ref: unknown },
      reason: `card ${unknown} is not registered to a customer`,
    });
  });

  it("processes the REAL Lithic deliveries sitting in webhook_inbox into the ledger", async () => {
    const { registerCard } = await import("@/lib/holds");
    const { availableBalance } = await import("@/lib/ledger/balances");
    const { createPostgresInboxStore, sqlExecutorFromPostgresJs } = await import("../inbox");
    const { ConsumerRegistry, dispatchUntilIdle } = await import("../dispatch");
    const { registerLithicCardConsumer } = await import("./lithic-card");

    // The card these deliveries were made on belongs to a customer, and the
    // system has to be told which. This is the operator step the pipeline
    // needs; it is idempotent on (provider, provider_card_token).
    const [biz] = await sql<{ id: string }[]>`
      SELECT b.id
        FROM business b
        JOIN account a ON a.business_id = b.id AND a.code = '2100'
       WHERE b.legal_name = 'Ridgeline Robotics, Inc.'`;
    if (!biz) throw new Error("seed first: node scripts/seed.mjs");
    await registerCard(
      {
        provider: "lithic",
        providerCardToken: REAL_CARD_TOKEN,
        businessId: biz.id,
        lastFour: "0000",
        nickname: "Lithic sandbox card (real deliveries)",
      },
      sql,
    );

    const before = await availableBalance(biz.id);

    const registry = new ConsumerRegistry();
    registerLithicCardConsumer(registry);
    const store = createPostgresInboxStore(sqlExecutorFromPostgresJs(sql));

    // The real dispatcher, the real Postgres inbox store, the real consumer.
    // Nothing about this path is a double.
    const summary = await dispatchUntilIdle({ store, registry, batchSize: 25 });
    expect(summary.deadLettered).toBe(0);

    // Both real deliveries are finished. (Idempotent across runs: on a second
    // run the dispatcher claims nothing and these are already 'done'.)
    for (const providerEventId of [
      "msg_3J8zH4rxpB2J0tq5h4btJsdI2RD",
      "msg_3J8yjFYaE5cor4TGss6aEwWmVeJ",
    ]) {
      const row = await store.findByProviderEventId("lithic", providerEventId);
      expect({ providerEventId, state: row?.state }).toEqual({ providerEventId, state: "done" });
    }

    // And the money is in the ledger: one authorisation each, $50.00 held, no
    // financial posting, because an authorisation moves no money.
    for (const authToken of REAL_AUTH_TOKENS) {
      const [row] = await sql<
        {
          origin: string;
          auth_net_cents: bigint;
          captured_cents: bigint;
          target_hold_cents: bigint;
          memo_balance_cents: bigint;
        }[]
      >`
        SELECT ca.origin,
               s.auth_net_cents::bigint    AS auth_net_cents,
               s.captured_cents::bigint    AS captured_cents,
               s.target_hold_cents::bigint AS target_hold_cents,
               hs.memo_balance_cents::bigint AS memo_balance_cents
          FROM card_authorization ca
          JOIN v_card_auth_hold s ON s.auth_id = ca.id
          JOIN v_hold_state   hs ON hs.hold_id = ca.hold_id
         WHERE ca.provider = 'lithic' AND ca.provider_auth_id = ${authToken}`;
      expect({ authToken, row: row ?? null }).toEqual({
        authToken,
        row: {
          origin: "authorization",
          auth_net_cents: 5000n,
          captured_cents: 0n,
          target_hold_cents: 5000n,
          memo_balance_cents: 5000n,
        },
      });
    }

    // The customer's AVAILABLE balance reflects both holds; the LEDGER does
    // not move, because Lithic told us about two authorisations and no capture.
    const after = await availableBalance(biz.id);
    expect(after.ledgerCents).toBe(before.ledgerCents);
    // On a re-run the holds are already open, so the delta is 0 the second
    // time — both readings are correct, and which one it is depends only on
    // whether this test has run before.
    expect([0n, 10_000n]).toContain(after.holdsCents - before.holdsCents);

    // Twice is one, at the dispatcher too: nothing is claimed on a second pass.
    const again = await dispatchUntilIdle({ store, registry, batchSize: 25 });
    expect(again.claimed).toBe(0);
    const settled = await availableBalance(biz.id);
    expect(settled).toEqual(after);
  });
});
