/**
 * THE INCREMENTAL AUTHORISATION, ON REAL PROVIDER INPUT.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists
 * ---------------------------------------------------------------------------
 *
 * `docs/GAUNTLET.md` item 2 reported one transition of the seven the brief
 * names with **no demonstration at all**: `incremental_authorization` had never
 * been written by any path, ever. The reason was not a missing branch. Eighteen
 * real, signature-verified `card_transaction.updated` deliveries carrying
 * `AUTHORIZATION_ADVICE` were sitting in `webhook_inbox`, all of them parked
 * behind the same sentence —
 *
 *     card 8286c472-2d19-4a1b-af0e-5adf0c735ee5 is not registered to a customer
 *
 * — which is requirement 4 working exactly as designed: the system had the
 * money event, refused to post it, and would not guess whose money to move.
 *
 * Six Lithic card tokens are involved, not one. Every one of them is a REAL
 * sandbox card on the program's own Lithic account
 * `2742964f-478f-47ef-a4e9-852dc50d9c44` (verified with `GET /v1/cards/{token}`
 * on 2026-09-11), created by `src/test/livefire/attack-02-*.test.ts` and by two
 * provider probes. Attack 2's measurement deliberately does NOT register its
 * card, and says so in its own comment — it is measuring the PROVIDER, not this
 * pipeline. The consequence is the eighteen parked deliveries: real provider
 * lifecycle that this build's ingestion path had never been handed.
 *
 * ---------------------------------------------------------------------------
 * What this runnable does, and why it is a test rather than a script
 * ---------------------------------------------------------------------------
 *
 * It performs the documented wake — `registerCard()`, then the SAME
 * `unparkWaitingFor([{kind:'card', ref}])` call the dispatcher makes when a
 * consumer reports it produced a card ref, then `drain()` — and then asserts
 * what the deployed pipeline did with eighteen payloads only unit tests had
 * ever seen. It is a test and not a script because the value is in the
 * assertions, not in the action: the action is one INSERT.
 *
 * It is IDEMPOTENT. After the first run the cards are registered, nothing is
 * parked on them, and every assertion below is a statement about the world
 * rather than about this run, so it passes again unchanged.
 *
 * Gated on RUN_DB_TESTS=1 so CI, which holds no credentials, skips:
 *
 *     set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/lib/cards/advice-wake
 *
 * ---------------------------------------------------------------------------
 * Which customer, and why that one
 * ---------------------------------------------------------------------------
 *
 * The rule is not invented here. `attack-02-over-capture-release.test.ts`
 * registers the cards it DOES register to
 *
 *     the first business with a 2100/9100 pair, ORDER BY business_id LIMIT 1
 *
 * and these six cards are that suite's own. Using the same rule keeps one
 * answer to "whose card is this"; inventing a second one to make a balance
 * look tidier would be a second opinion about attribution, which is the thing
 * this build refuses everywhere else.
 *
 * ---------------------------------------------------------------------------
 * What an advice MEANS, which is the claim under test
 * ---------------------------------------------------------------------------
 *
 * An `AUTHORIZATION_ADVICE` is ABSOLUTE: it states what the authorised amount
 * now IS, not what to add. `deriveCardEvents` converts it to a delta against
 * the running authorised total and emits `incremental_authorization` when the
 * delta is positive and `authorization_reversal` when it is negative. Getting
 * that backwards — treating 9000 as "add 9000" on top of 5000 — would withhold
 * $140.00 of a customer's money for a $90.00 fuel stop, and every invariant in
 * the book would stay green while it happened. So the conversion is asserted
 * here against the provider's own bytes, per event, not against a fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Sql } from "@/lib/ledger/db";
import type * as LedgerQueries from "@/lib/ledger/queries";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

const PROVIDER = "lithic";

/**
 * The application's OWN connection, imported dynamically in `beforeAll`.
 *
 * Not a second postgres.js client of this file's own: `@/lib/ledger/db`
 * configures `bigint` to parse as a JS BigInt rather than a Number, and money
 * is bigint cents. A local client without that option is a different database
 * as far as precision is concerned, and `registerCard()` will not accept one —
 * the type says so, which is the point.
 */
let sql: Sql;

/** The six tokens, discovered rather than hard-coded. */
let tokens: string[] = [];
let businessId = "";

/**
 * The ledger's NAMED READERS, bound in `beforeAll` with the connection.
 *
 * Every question this file asks of `journal_entry`, `journal_line` or `account`
 * goes through one of these. `src/lib/ledger/boundary.test.ts` is a ratchet
 * that holds integration tests to the same boundary as application code, and it
 * is right to: a test that re-expresses a balance query is a test asserting its
 * own definition of a balance, which is how this system once had four.
 */
let findEntryByIdempotencyKey: typeof LedgerQueries.findEntryByIdempotencyKey;
let listBusinesses: typeof LedgerQueries.listBusinesses;
let readLedgerCensus: typeof LedgerQueries.readLedgerCensus;

interface LithicEvent {
  readonly type: string;
  readonly token: string;
  readonly amount: number;
  readonly result: string;
  readonly created: string;
}
interface LithicTxn {
  readonly token: string;
  readonly card_token: string;
  readonly created: string;
  readonly events: readonly LithicEvent[];
}

/** Every inbox payload that mentions an advice, whatever its state. */
async function advicePayloads(): Promise<{ id: string; state: string; txn: LithicTxn }[]> {
  const rows = await sql<{ id: string; state: string; payload: unknown }[]>`
    SELECT id, state, payload
      FROM webhook_inbox
     WHERE provider = ${PROVIDER}
       AND payload::text LIKE '%AUTHORIZATION_ADVICE%'
     ORDER BY received_at`;
  return rows.map((r) => ({
    id: r.id,
    state: r.state,
    txn: (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as LithicTxn,
  }));
}

d("the incremental authorisation, woken from the inbox", () => {
  beforeAll(async () => {
    // `@/lib/holds` and the webhook modules reach `@/lib/ledger/db`, which
    // parses the environment at module scope and throws without it — on
    // purpose, so a malformed database URL kills the process at boot rather
    // than at the first request that needs money. A static import would make
    // this file fail to COLLECT on a credential-less runner, and
    // `describe.skip` cannot skip a module that threw while loading. Same
    // reasoning as `cards.integration.test.ts` and `holds.integration.test.ts`.
    sql = (await import("@/lib/ledger/db")).sql;
    ({ findEntryByIdempotencyKey, listBusinesses, readLedgerCensus } = await import(
      "@/lib/ledger/queries"
    ));
    const { registerCard, resolveCard } = await import("@/lib/holds");
    const { createPostgresInboxStore, sqlExecutorFromPostgresJs } = await import(
      "@/lib/webhooks/inbox"
    );
    const { drain } = await import("@/lib/webhooks/drain");

    // THE SAME BUSINESS attack-02 picks, asked through the ledger's own reader
    // rather than by re-expressing its join here. `listBusinesses` already
    // resolves both leaves — a module outside `src/lib/ledger/` writing its own
    // SQL against `account` is what `src/lib/ledger/boundary.test.ts` ratchets
    // against, and integration tests are held to it deliberately: a test that
    // reaches into the ledger's tables is a test asserting its own definition
    // of a balance. `listBusinesses` orders by legal name, so the ordering
    // attack-02 uses is applied here, on the id, and stated rather than implied.
    const eligible = [...(await listBusinesses(sql))]
      .filter((b) => b.depositAccountId !== null && b.memoAccountId !== null)
      .sort((a, b) => a.businessId.localeCompare(b.businessId));
    const customer = eligible[0];
    if (customer === undefined) {
      throw new Error("no business has a 2100/9100 pair: run node scripts/seed.mjs");
    }
    businessId = customer.businessId;

    // The tokens are DISCOVERED, from the inbox, not hard-coded: six uuids in
    // a source file would make this a record of one afternoon rather than a
    // runnable. `tokens` is every card an advice payload names — which is the
    // population the assertions range over, and does not shrink to nothing once
    // the wake has already happened. `waiting` is the subset still stuck, which
    // is the population the wake acts on and is EMPTY on a second run.
    const carrying = await sql<{ card_token: string }[]>`
      SELECT DISTINCT payload ->> 'card_token' AS card_token
        FROM webhook_inbox
       WHERE provider = ${PROVIDER}
         AND payload::text LIKE '%AUTHORIZATION_ADVICE%'
         AND payload ->> 'card_token' IS NOT NULL
       ORDER BY 1`;
    tokens = carrying.map((r) => r.card_token);

    const waiting = await sql<{ parked_on_ref: string }[]>`
      SELECT DISTINCT parked_on_ref
        FROM webhook_inbox
       WHERE provider = ${PROVIDER}
         AND parked_on_kind = 'card'
         AND state IN ('parked', 'dead')
         AND payload::text LIKE '%AUTHORIZATION_ADVICE%'
       ORDER BY parked_on_ref`;

    const store = createPostgresInboxStore(sqlExecutorFromPostgresJs(sql));

    for (const token of waiting.map((r) => r.parked_on_ref)) {
      if ((await resolveCard(PROVIDER, token, sql)) === null) {
        await registerCard(
          {
            provider: PROVIDER,
            providerCardToken: token,
            businessId,
            lastFour: token.slice(-4),
            nickname: `live-fire advice probe ${token.slice(0, 8)}`,
          },
          sql,
        );
      }

      // A dead letter is never retried by anything. Requeueing one after the
      // reason it died has been removed is the staff action `requeueDeadLetter`
      // exists for, and the trigger in 0002 permits exactly this transition:
      // dead -> pending, with both counters zeroed together.
      const dead = await sql<{ id: string }[]>`
        SELECT id FROM webhook_inbox
         WHERE provider = ${PROVIDER} AND state = 'dead'
           AND parked_on_kind = 'card' AND parked_on_ref = ${token}`;
      for (const row of dead) await store.requeueDeadLetter(row.id, new Date());

      // The SAME call the dispatcher makes when a consumer reports a card ref.
      // This is not reaching around the park mechanism; it is telling it the
      // truth it was waiting for.
      await store.unparkWaitingFor([{ kind: "card", ref: token }], new Date());
    }

    // Drain to idle. Each delivery is a snapshot of the whole transaction, so
    // the later ones subsume the earlier ones and order does not matter.
    for (let i = 0; i < 8; i += 1) {
      const summary = await drain({ maxBatches: 20 });
      if (summary.claimed === 0) break;
    }
  }, 300_000);

  afterAll(async () => {
    if (sql !== undefined) await sql.end();
  });

  it("every card the advice payloads were parked on is now registered to a customer", async () => {
    expect(tokens.length).toBeGreaterThan(0);
    const rows = await sql<{ provider_card_token: string; business_id: string }[]>`
      SELECT provider_card_token, business_id FROM card
       WHERE provider = ${PROVIDER} AND provider_card_token = ANY(${tokens})`;
    expect(rows.map((r) => r.provider_card_token).sort()).toEqual([...tokens].sort());
    for (const row of rows) expect(row.business_id).toBe(businessId);
  });

  it("no advice payload is left parked or dead-lettered", async () => {
    const rows = await advicePayloads();
    expect(rows.length).toBeGreaterThanOrEqual(18);
    const stuck = rows.filter((r) => r.state === "parked" || r.state === "dead");
    expect(stuck.map((r) => r.id)).toEqual([]);
  });

  it("the advice branch has now run on live input: incremental_authorization exists", async () => {
    const [row] = await sql<{ n: number; cents: string }[]>`
      SELECT count(*)::int AS n, COALESCE(SUM(amount_cents), 0)::text AS cents
        FROM card_auth_event WHERE kind = 'incremental_authorization'`;
    expect(row?.n ?? 0).toBeGreaterThan(0);
  });

  /**
   * THE CLAIM THAT MATTERS. An advice REPLACES the authorised amount; it does
   * not add to it. Re-derived here from the provider's own bytes, event by
   * event, and compared with what was stored — so a future change that turned
   * the conversion into an addition would fail on real payloads rather than on
   * a fixture that agrees with it by construction.
   */
  /**
   * THE IDENTITY THAT DEFINES "REPLACES", and the reason it is stated this way
   * rather than as a per-event re-derivation.
   *
   * The naive check — recompute each advice's delta from the payload and
   * compare it to the stored one — is WRONG, and finding out why is the most
   * useful thing this file did. The eighteen deliveries are eighteen SNAPSHOTS
   * of six transactions: delivery 3 of a transaction carries a prefix of the
   * events delivery 4 carries. `deriveCardEvents` converts an advice against
   * the running total OF THE SNAPSHOT IT IS GIVEN, and `insertCardEvents`
   * writes with `ON CONFLICT (auth_id, provider_event_id) DO NOTHING` — so the
   * FIRST snapshot to carry an advice fixes that advice's delta for ever, and a
   * later, fuller snapshot cannot correct it. Re-deriving against the fullest
   * snapshot therefore disagrees with the stored row whenever a partial one was
   * processed first. Measured here on
   * `535f87ec-7e6a-4599-8b8f-db3c8e0c5957` — see docs/GAUNTLET.md item 2.
   *
   * What IS true, and is the actual content of "an advice replaces": fold the
   * STORED events in `created` order and, immediately after each advice, the
   * running authorised total equals that advice's ABSOLUTE amount. If the
   * conversion ever became an addition, or a stale prior total leaked into it,
   * this identity breaks; nothing else in the book would.
   */
  it("an advice replaces: after each advice, A(E) equals the advice's absolute amount", async () => {
    const rows = await advicePayloads();
    const checked: string[] = [];

    // The FULLEST snapshot per transaction — the one that carries every event.
    const fullest = new Map<string, LithicTxn>();
    for (const { txn } of rows) {
      const seen = fullest.get(txn.token);
      if (seen === undefined || (txn.events ?? []).length > (seen.events ?? []).length) {
        fullest.set(txn.token, txn);
      }
    }

    for (const txn of fullest.values()) {
      const stored = await sql<{ provider_event_id: string; kind: string; amount_cents: string }[]>`
        SELECT e.provider_event_id, e.kind::text AS kind, e.amount_cents::text AS amount_cents
          FROM card_auth_event e
          JOIN card_authorization ca ON ca.id = e.auth_id
         WHERE ca.provider = ${PROVIDER} AND ca.provider_auth_id = ${txn.token}`;
      if (stored.length === 0) continue;
      const byToken = new Map(stored.map((s) => [s.provider_event_id, s]));

      // BY `created`, NOT BY ARRAY ORDER. Lithic does not promise the array is
      // chronological and measurably is not: transaction
      // 5892c550-b966-4afb-b681-a6456e1cf3c4 carries its two
      // AUTHORIZATION_REVERSALs (22:35:31Z, 22:35:32Z) AFTER a CLEARING stamped
      // 22:35:37Z. `deriveCardEvents` sorts before folding, so anything that
      // walks the array in delivered order computes a different total.
      const ordered = [...(txn.events ?? [])].sort((a, b) => {
        const ta = Date.parse(a.created ?? txn.created);
        const tb = Date.parse(b.created ?? txn.created);
        if (Number.isNaN(ta) || Number.isNaN(tb) || ta === tb) return 0;
        return ta - tb;
      });

      let running = 0;
      for (const ev of ordered) {
        const row = byToken.get(ev.token);
        if (row === undefined) continue;
        if (row.kind === "authorization" || row.kind === "incremental_authorization") {
          running += Number(row.amount_cents);
        } else if (row.kind === "authorization_reversal") {
          running -= Number(row.amount_cents);
        }
        if (ev.type === "AUTHORIZATION_ADVICE" && ev.result === "APPROVED") {
          expect([ev.token, running]).toEqual([ev.token, Math.abs(ev.amount)]);
          checked.push(
            `${txn.token.slice(0, 8)} advice ${ev.amount} stored as ${row.kind} ` +
              `${row.amount_cents} -> A(E) = ${running}`,
          );
        }
      }
    }

    // eslint-disable-next-line no-console -- this line IS the evidence
    console.log(`advice conversions checked against provider bytes:\n  ${checked.join("\n  ")}`);
    expect(checked.length).toBeGreaterThan(0);
  });

  /**
   * THE SHARPEST CASE ON THE BOOK, and the reason "replaces" is not a detail.
   *
   * Transaction 1df0baa5-319c-46cb-8e19-fcec89b55f56 carries TWO advices, 6000
   * then 9000, against an AUTHORIZATION the network DECLINED. If an advice
   * incremented, the pair would have authorised 15000. Because it replaces, the
   * second is a delta of 3000 and the authorisation settles at 9000. There is
   * no invariant that would have caught the other answer: the book would have
   * balanced, the hash chain would have verified, and $150.00 would have been
   * withheld from a customer for a $90.00 fuel stop.
   */
  it("two advices on one transaction are 6000 then +3000, never 6000 then +9000", async () => {
    const rows = await sql<{ kind: string; cents: string; provider_event_id: string }[]>`
      SELECT e.kind::text AS kind, e.amount_cents::text AS cents, e.provider_event_id
        FROM card_auth_event e
        JOIN card_authorization ca ON ca.id = e.auth_id
       WHERE ca.provider_auth_id = '1df0baa5-319c-46cb-8e19-fcec89b55f56'
         AND e.kind = 'incremental_authorization'
       ORDER BY e.amount_cents DESC`;
    if (rows.length === 0) return; // this transaction is not on every installation
    expect(rows.map((r) => `${r.kind}:${r.cents}`)).toEqual([
      "incremental_authorization:6000",
      "incremental_authorization:3000",
    ]);
  });

  it("the hold still releases exactly once — hold_closure is one row per hold", async () => {
    const [row] = await sql<{ closures: number; holds: number }[]>`
      SELECT count(*)::int AS closures, count(DISTINCT hold_id)::int AS holds FROM hold_closure`;
    expect(row?.closures).toBe(row?.holds);
  });

  /**
   * Every APPROVED clearing on a woken transaction posted EXACTLY ONE entry,
   * under a key derived from the clearing's own provider event token.
   *
   * Asked one key at a time through `findEntryByIdempotencyKey`, which is the
   * ledger's own reader for this question, rather than by grouping
   * `journal_entry` here. The uniqueness is Postgres's — `journal_entry` has a
   * UNIQUE index on `idempotency_key` — so what this actually proves is the
   * other half: that each clearing produced an entry AT ALL, and that eighteen
   * overlapping snapshots of six transactions did not produce nineteen.
   */
  it("nothing double-counts: exactly one entry per approved clearing event token", async () => {
    const rows = await advicePayloads();
    const clearings = new Set<string>();
    for (const { txn } of rows) {
      for (const ev of txn.events ?? []) {
        if (ev.type === "CLEARING" && ev.result === "APPROVED") clearings.add(ev.token);
      }
    }
    expect(clearings.size).toBeGreaterThan(0);

    const missing: string[] = [];
    for (const token of clearings) {
      const entry = await findEntryByIdempotencyKey(`card:clearing:${token}`, sql);
      if (entry === null) missing.push(token);
    }
    expect(missing).toEqual([]);
  });

  it("the book still balances and the hold invariants are still empty", async () => {
    // `readLedgerCensus` is the ledger's own count of itself; the trial balance
    // it reports is debits minus credits over the financial book. `v_book_not_zero`
    // below covers the memo book, so between them nothing is left unasserted and
    // this file does not need its own definition of "balances".
    const census = await readLedgerCensus(sql);
    expect(census.trialBalance.differenceCents).toBe(0n);

    for (const view of [
      "v_entry_unbalanced",
      "v_book_not_zero",
      "v_hold_drift",
      "v_hold_release_drift",
      "v_hold_closure_not_terminal",
      "v_hold_posting_incomplete",
      "v_line_denorm_drift",
    ]) {
      const [row] = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${view}`);
      expect([view, row?.n]).toEqual([view, 0]);
    }
  });

  /**
   * `v_refused_auth_hold` is the one guard `scripts/dbcheck.mjs` reports as
   * FAILING, deliberately and historically (149 rows at 2026-09-11T08:55Z,
   * fuzzer-written authorisations with no recorded verdict). This asserts that
   * waking eighteen real deliveries did not add to it — an advice the network
   * APPROVED must never leave money withheld against a refusal.
   */
  it("no woken card leaves money withheld against an authorisation the network refused", async () => {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM v_refused_auth_hold r
        JOIN card_authorization ca ON ca.hold_id = r.hold_id
        JOIN card c ON c.id = ca.card_id
       WHERE c.provider = ${PROVIDER} AND c.provider_card_token = ANY(${tokens})`;
    expect(row?.n).toBe(0);
  });
});
