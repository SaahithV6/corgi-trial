/**
 * ATTACK 3 — "Reverse that settlement the next day and pull up the statement
 * for settlement day."
 *
 * ============================================================================
 * WHY THIS TEST WAS REWRITTEN.
 *
 * The previous version of this file imported `reverseAndRebook` and called it
 * on entries it had posted itself, thirty lines earlier, through `postEntry`.
 * Every assertion passed and every one of them was about the MACHINERY: no
 * provider event was involved, no webhook was verified, no consumer ran, and
 * `src/lib/holds/*` — the code that actually decides what a card settlement
 * does to the ledger — was not on the call path at all. `reverseAndRebook`'s
 * only non-test callers were two demo harnesses.
 *
 * So the claim "a merchant reverses a settlement and the corrected position
 * appears on the day it happened" was true of a function and false of the
 * card rail, and this test was the reason nobody could tell.
 *
 * It now drives the correction from the PROVIDER end, twice, and says exactly
 * which single step of the second run was synthesised and why.
 * ============================================================================
 *
 * PART A — NOTHING SYNTHESISED.
 *   Lithic's sandbox originates a real card settlement (`/v1/simulate/return`,
 *   a $73.40 credit clearing) and then REVERSES it (`/v1/simulate/return_reversal`,
 *   a real `RETURN_REVERSAL` step). Lithic signs both deliveries and sends them
 *   over the internet to the deployed endpoint. Everything after that is
 *   production: signature verification, the inbox, the dispatcher, the
 *   `rail_event_semantics` lookup, and the correction posting.
 *
 * PART B — THE BRIEF'S SENTENCE, LITERALLY, with ONE step synthesised.
 *   A real $50 fuel-pump authorisation and a real $73.40 CLEARING, both from
 *   Lithic. Then the reversal of THAT settlement — which Lithic's sandbox
 *   cannot originate. Measured, this run:
 *
 *     POST /v1/simulate/return_reversal {token: <the cleared txn>}
 *       -> 400 "Return reversal is not supported for debit transactions"
 *     POST /v1/simulate/correction, /correction_debit, /correction_credit
 *       -> 404 Not Found (no such endpoints exist)
 *
 *   So the CORRECTION_CREDIT step is fabricated — and nothing else is. It is
 *   attached to the real transaction beside its real events, signed with the
 *   real `LITHIC_WEBHOOK_SECRET` using Standard Webhooks, and POSTed to the
 *   deployed webhook endpoint over the internet. A negative control proves the
 *   signature is being checked. The one thing this run cannot claim is that
 *   Lithic emitted the step; every other link in the chain is real.
 *
 * WHAT IS ASSERTED, IN BOTH PARTS.
 *   1. The provider event produced a `reversal` entry against the entry it
 *      corrects, in the same correction group.
 *   2. That reversal carries the ORIGINAL entry's value date — in Part B the
 *      correction event's own value date is the NEXT DAY, and the money still
 *      lands on settlement day, which is the whole difference between a
 *      statement that corrects itself and one that grows a second line.
 *   3. The correction did NOT post as an ordinary entry at its own date: the
 *      idempotency key it would have used does not exist.
 *   4. The statement for settlement day, rendered by the real renderer, gives
 *      two different answers at two booking watermarks, and the line the
 *      correction added to the later one is dated settlement day and carries
 *      exactly minus the settled amount, while the entry it corrects reads
 *      identically in both. Both are true at once. The two whole-day figures
 *      are asserted to differ by exactly the settled amount when nothing else
 *      was booked to that day inside the window, and reported with the
 *      interfering lines named when something was — see `addedBetween`.
 *   4b. And the correction put NOTHING on the day we learned: no entry under
 *      the key such a posting would carry, no financial entry of this
 *      transaction or its correction group dated anywhere but settlement day,
 *      and not one line of ours on that day's rendered statement. What that
 *      day carries otherwise is other people's traffic and is not this
 *      attack's to assert about.
 *   5. Nothing was edited: the original row is byte-identical afterwards and
 *      the database refuses an UPDATE to it.
 *   6. The financial book still nets to zero and `v_hold_drift` /
 *      `v_hold_release_drift` are still empty — the hold model and the SQL
 *      view are held equal by invariant and a correction moved neither.
 *
 * ============================================================================
 * HOW THIS TEST FAILED AGAINST A CORRECT LEDGER, AND WHAT RETIRED IT.
 *
 * Part A reported "no reversal entry was produced by the provider's
 * correction". Lithic had produced it, and the ledger had booked it correctly.
 * What the test got wrong was HOW IT IDENTIFIED THE ROW: it waited for the
 * transaction's SECOND financial entry and then looked for a reversal among
 * whatever had arrived.
 *
 * A card settlement no longer produces one financial entry. `interchangeHook()`
 * prices it in the same delivery, so a settlement posts the money AND its
 * interchange under the same `external_ref`. MEASURED on the deployed tip, on
 * Lithic transaction 8b119c1b-748a-4315-aa48-b74026361c57:
 *
 *   07:08:13.787  card:refund:141db235-…   entry b181c6e0   the money
 *   07:08:13.952  interchange:141db235-…   entry 2a2589fc   +165ms
 *   07:08:50.009  reversal:b181c6e0-…      entry 8a57b3fa   +36s, THE REPAIR
 *   07:08:50.126  reversal:2a2589fc-…      entry 069c14ad   the unbooking
 *
 * "The second entry" was therefore the interchange, 36 seconds before the
 * provider's asynchronous RETURN_REVERSAL, and its absence of a reversal was
 * read as the provider having failed. The repair then landed at the original's
 * value date, in the original's correction group, exactly as claimed — after
 * the test had already given up on it.
 *
 * The same file passed 3/3 a few hours earlier because interchange was then
 * being priced by a LATER reconcile pass: measured 819s behind the settlement
 * at 05:46 and 0-1s from 06:58 onward. A green that depended on how far behind
 * a second, unrelated posting was running was never evidence about the
 * correction.
 *
 * So neither wait counts rows any more. Both parts wait for THE SUBJECT — the
 * entry whose `reverses_entry_id` is the entry the provider corrected — which
 * no interchange line, no other attack and no other process can satisfy. See
 * `waitForReversalOf`. Nothing was loosened: the claim is narrower than the one
 * that failed, not wider.
 * ============================================================================
 *
 * ============================================================================
 * AND THEN PART B BROKE ON A TOKEN THAT WAS NOT A TRANSACTION YET.
 *
 * The second failure of this file was not about the ledger at all. Part B threw
 * `LithicApiError: Transaction was not found` out of `simulateClearing`, before
 * any assertion ran, in 1 of 4 consecutive runs — and it started on the day the
 * Lithic sandbox account's daily spend cap was raised from $5,000 to $500,000
 * and authorisations stopped declining.
 *
 * That correlation is real and it is not the obvious explanation. A declined
 * authorisation is NOT unclearable, and the token is not invalid: the exact
 * transaction a failing run could not clear —
 * `19676a84-1748-4bb5-8d34-0d6089469ae4` — reads `PENDING / APPROVED` on
 * `GET /v1/transactions` today. It existed. The clearing was early.
 *
 * `/v1/simulate/authorize` answers `201 {token}` before the transaction is
 * readable, and everything keyed on that token answers 404 until it is. The
 * delay depends on the verdict, MEASURED here 2026-09-11, six trials each,
 * polling `GET /v1/transactions/{token}` every 200ms from the authorize
 * response:
 *
 *   APPROVED   969  1166  1177  1184  1450  1759 ms   (mean 1284)
 *   DECLINED   781   788   829   875  1047  1051 ms   (mean  895)
 *
 * `simulateLimiter` admits one request per second counting STARTS, so the
 * clearing reaches Lithic at about t+1100-1200ms. Past the declined tail;
 * through the middle of the approved one. The race was always there — the
 * declined era was simply always on the safe side of it, and raising the cap
 * moved the distribution, not the code.
 *
 * The repair is a wait on the PROVIDER, not on the ledger and not on anything
 * this attack asserts: `waitForProviderVisibility` polls until Lithic can see
 * its own transaction, and a token still 404 after 30s fails hard with the
 * measurement quoted, because that would be a different fault. The same read
 * now supplies the network's verdict, which part B reports rather than assumes.
 * ============================================================================
 *
 * ISOLATION. Money tables are append-only, so there is no teardown. This
 * attack opens its OWN business (deterministic id, idempotent, owner role) and
 * mints its own Lithic card and its own transactions, so nothing it measures
 * can be moved by another attack, another suite or another agent — see
 * `openOwnBusiness`. That is belt as well as braces: every assertion is ALSO
 * attributed to entries this run created, because a shared database is the
 * normal case in this build and an attack that needs a quiet one is not
 * measuring what it claims.
 */
import { createHmac, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import type * as BalancesModule from "@/lib/ledger/balances";
import type { sql as SqlHandle } from "@/lib/ledger/db";
import type * as HoldsModule from "@/lib/holds";
import type * as LithicClient from "@/lib/rails/lithic/client";
import type * as StatementRead from "@/lib/statements/read";

const ATTACK = 3;
const NAME = "Provider-driven settlement reversal: corrected statement and as-believed, both true at once";

/** Append one evidence line for scripts/livefire.mjs. Silent when unset. */
function record(kind: "evidence" | "skip", text: string): void {
  const path = process.env["LIVEFIRE_EVIDENCE"];
  if (path === undefined || path === "") return;
  // Recreate the directory if something removed it under us. A run has already
  // lost its evidence to a concurrent `next build` wiping the folder it was
  // written into: every record() after that threw ENOENT and an attack whose
  // assertions had all passed was scored as a failure with a filesystem error
  // as its reason. Evidence must never be the thing that fails a live-fire run.
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ attack: ATTACK, name: NAME, kind, text })}\n`, "utf8");
}

const BASE_URL = (
  process.env["LIVEFIRE_BASE_URL"] ?? "https://corgi-trial-psi.vercel.app"
).replace(/\/+$/, "");

const MISSING: string[] = [];
if (process.env["LIVEFIRE"] !== "1") MISSING.push("LIVEFIRE=1");
if (typeof process.env["APP_DATABASE_URL"] !== "string") MISSING.push("APP_DATABASE_URL");
if (typeof process.env["LITHIC_API_KEY"] !== "string" || process.env["LITHIC_API_KEY"] === "") {
  MISSING.push("LITHIC_API_KEY (Lithic must originate the settlement and its reversal)");
}
if (
  typeof process.env["LITHIC_WEBHOOK_SECRET"] !== "string" ||
  process.env["LITHIC_WEBHOOK_SECRET"] === ""
) {
  MISSING.push("LITHIC_WEBHOOK_SECRET (part B signs a real delivery with it)");
}

const READY = MISSING.length === 0;
if (!READY) {
  record("skip", `missing: ${MISSING.join(", ")}; run scripts/livefire.mjs`);
}

const d = READY ? describe : describe.skip;

const SETTLED_CENTS = 73_40n;
const AUTH_CENTS = 50_00n;

/**
 * `POST /v1/simulate/return_reversal` — the one card correction Lithic's
 * sandbox will originate, and the only simulate endpoint this suite needs that
 * `src/lib/rails/lithic/client.ts` does not wrap.
 *
 * It is called here rather than added to the adapter because the adapter is
 * another agent's file this run. It still goes through the shared
 * `simulateLimiter`, so it obeys the sandbox's 1 request/second simulate cap
 * alongside every other call in the suite rather than racing them into a 429.
 *
 * Body is `{ token }` and nothing else, per Lithic's own SDK. Against a DEBIT
 * transaction it answers 400 — which is not an error here, it is the measured
 * evidence part B needs.
 */
async function simulateReturnReversal(
  token: string,
): Promise<{ ok: boolean; status: number; detail: string }> {
  const { simulateLimiter, LITHIC_SANDBOX_BASE_URL } = await import("@/lib/rails/lithic/client");
  return simulateLimiter.run(async () => {
    const response = await fetch(`${LITHIC_SANDBOX_BASE_URL}/simulate/return_reversal`, {
      method: "POST",
      headers: {
        authorization: process.env["LITHIC_API_KEY"] ?? "",
        "content-type": "application/json",
      },
      body: JSON.stringify({ token }),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      detail: `HTTP ${response.status} ${text.slice(0, 200)}`,
    };
  });
}

/** What the real renderer returns, and one of its lines. Named, not re-declared. */
type StatementDoc = Awaited<ReturnType<typeof StatementRead.renderStatement>>;
type StatementRow = StatementDoc["lines"][number];

/** Lithic's own transaction object, as the adapter returns it. */
type ProviderTransaction = Awaited<ReturnType<typeof LithicClient.getTransaction>>;

interface EntryRow {
  id: string;
  value_date: string;
  booking_seq: bigint;
  entry_type: string;
  description: string;
  idempotency_key: string;
  reverses_entry_id: string | null;
  correction_group_id: string;
  inbox_id: string | null;
}

d(`ATTACK ${ATTACK} — ${NAME}`, () => {
  let sql: typeof SqlHandle;
  let bal: typeof BalancesModule;
  let holds: typeof HoldsModule;
  let lithic: typeof LithicClient;
  let statements: typeof StatementRead;

  const tag = Date.now().toString(36).toUpperCase();
  let businessId = "";
  let accountId = "";
  let isolation = "";
  let pan = "";
  let cardToken = "";

  /**
   * THE BUSINESS THIS ATTACK OWNS.
   *
   * ======================================================================
   * WHY THIS IS NOT `ORDER BY business_id LIMIT 1` ANY MORE.
   *
   * Every attack in this suite used to reach for the same row — the lowest
   * business id carrying a 2100/9100 pair — and then measure that one
   * customer's whole position, or one of its days, across a window. So
   * attacks 1, 2, 3 and 7 measured the SAME customer at the same time as
   * each other, as the database-backed integration suites, as the demo
   * scripts, and as anything else running against this shared Neon branch.
   *
   * That is not flakiness, it is a measurement error: a global quantity
   * under concurrent writers is not the quantity being claimed. This
   * attack's own headline figure failed twice for it — nine Plaid funding
   * credits on the day it demanded be empty — and attacks 1 and 2 failed
   * by exactly 5000 on another agent's $50 hold landing in their window.
   * DECISIONS 028 recorded the vulnerability and left it because the tests
   * were passing; a green result produced by the weakness is not evidence
   * against the weakness.
   *
   * So the attack opens its own business and its own leaves, once,
   * idempotently, with a deterministic id — the pattern
   * `src/lib/holds/holds.integration.test.ts` already uses for the same
   * reason. Its card and its transactions were already per-run. The id
   * sorts ABOVE every seeded business deliberately, so the attacks that
   * still say `ORDER BY business_id LIMIT 1` cannot start picking it up.
   *
   * Type, book and parent come FROM THE HOUSE ROLLUP so the fixture cannot
   * drift from `src/lib/ledger/chart.ts`; `normal_side` is generated from
   * the type. Opening an account needs the OWNER role, because `corgi_app`
   * holds SELECT on `account` and nothing else — which is the point of
   * running this suite as `corgi_app`. Without an owner URL the attack
   * falls back to the shared seeded business and says so in its evidence:
   * every assertion here is attributed to rows this run created either
   * way, which is the other half of this fix.
   * ======================================================================
   */
  const OWN_BUSINESS_ID = "f1e1fa3e-0000-4000-8000-000000000003";
  const OWN_BUSINESS_NAME = "Live Fire — attack 3 (bitemporal correction)";

  async function openOwnBusiness(): Promise<{
    businessId: string;
    accountId: string;
    isolation: string;
  }> {
    const ownerUrl = process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"] ?? "";
    if (ownerUrl !== "") {
      const { default: postgres } = await import("postgres");
      const owner = postgres(ownerUrl, { max: 1, onnotice: () => {} });
      try {
        await owner`
          INSERT INTO business (id, entity_id, legal_name, ein)
          SELECT ${OWN_BUSINESS_ID}::uuid, e.id, ${OWN_BUSINESS_NAME}, '00-0000003'
            FROM book_entity e LIMIT 1
          ON CONFLICT DO NOTHING`;
        for (const code of ["2100", "9100", "9200"] as const) {
          await owner`
            INSERT INTO account (entity_id, code, name, parent_id, type, book,
                                 currency, business_id, is_postable)
            SELECT p.entity_id, p.code, ${OWN_BUSINESS_NAME} || ' — ' || p.name,
                   p.id, p.type, p.book, 'USD', ${OWN_BUSINESS_ID}::uuid, true
              FROM account p
             WHERE p.code = ${code} AND p.business_id IS NULL
            ON CONFLICT DO NOTHING`;
        }
      } finally {
        await owner.end();
      }
      const [own] = await sql<{ business_id: string; account_id: string }[]>`
        SELECT dep.business_id, dep.id AS account_id
          FROM account dep
          JOIN account memo ON memo.business_id = dep.business_id AND memo.code = '9100'
         WHERE dep.code = '2100' AND dep.business_id = ${OWN_BUSINESS_ID}::uuid`;
      if (own) {
        return {
          businessId: own.business_id,
          accountId: own.account_id,
          isolation: `this attack's OWN business ${OWN_BUSINESS_ID} (${OWN_BUSINESS_NAME}), opened idempotently — no other attack, suite or process writes to it`,
        };
      }
    }

    const [shared] = await sql<{ business_id: string; account_id: string }[]>`
      SELECT dep.business_id, dep.id AS account_id
        FROM account dep
        JOIN account memo ON memo.business_id = dep.business_id AND memo.code = '9100'
       WHERE dep.code = '2100' AND dep.business_id IS NOT NULL
       ORDER BY dep.business_id LIMIT 1`;
    if (!shared) throw new Error("no business has a 2100/9100 pair: run node scripts/seed.mjs");
    return {
      businessId: shared.business_id,
      accountId: shared.account_id,
      isolation: `the SHARED seeded business ${shared.business_id} — no owner URL (DIRECT_URL) was configured, so this attack could not open its own; every figure below is attributed to this run's own entries rather than isolated by construction`,
    };
  }

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    bal = await import("@/lib/ledger/balances");
    holds = await import("@/lib/holds");
    lithic = await import("@/lib/rails/lithic/client");
    statements = await import("@/lib/statements/read");

    // THE CUSTOMER THIS ATTACK OWNS. See `openOwnBusiness` below for why it
    // is no longer whichever customer sorts first.
    const chosen = await openOwnBusiness();
    businessId = chosen.businessId;
    accountId = chosen.accountId;
    isolation = chosen.isolation;

    const card = await lithic.createCard({
      type: "VIRTUAL",
      memo: `livefire correction ${tag}`,
      spend_limit: 5_000_00,
      spend_limit_duration: "TRANSACTION",
      state: "OPEN",
    });
    if (card.pan === undefined || card.pan === "") {
      throw new Error("Lithic returned a card with no PAN; the sandbox PCI shape has changed");
    }
    pan = card.pan;
    cardToken = card.token;

    await holds.registerCard(
      {
        provider: "lithic",
        providerCardToken: card.token,
        businessId,
        lastFour: card.last_four,
        nickname: `live-fire correction ${tag}`,
      },
      sql,
    );
  });

  /* ---------------------------------------------------------------------- */
  /* Shared helpers                                                         */
  /* ---------------------------------------------------------------------- */

  /** The current top of the transaction-time axis. */
  async function watermark(): Promise<bigint> {
    const [row] = await sql<{ seq: bigint }[]>`
      SELECT COALESCE(MAX(booking_seq), 0)::bigint AS seq FROM journal_entry`;
    return row?.seq ?? 0n;
  }

  /** Every financial entry this Lithic transaction has produced, in order. */
  async function entriesFor(txnToken: string): Promise<EntryRow[]> {
    return sql<EntryRow[]>`
      SELECT id, value_date::text AS value_date, booking_seq, entry_type::text AS entry_type,
             description, idempotency_key, reverses_entry_id, correction_group_id, inbox_id
        FROM journal_entry
       WHERE external_ref = ${txnToken} AND book = 'financial'
       ORDER BY booking_seq`;
  }

  /**
   * Nudge the DEPLOYED drain, the way an operator does in the debrief. Not a
   * local dispatcher: what is being exercised is production.
   */
  async function nudgeDrain(): Promise<string> {
    const token = process.env["DRAIN_TOKEN"];
    if (token === undefined || token === "") return "no DRAIN_TOKEN in the environment";
    try {
      const response = await fetch(`${BASE_URL}/api/drain`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      return `HTTP ${response.status}`;
    } catch (thrown) {
      return `unreachable: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
    }
  }

  /** Poll until the transaction has produced `want` financial entries. */
  async function waitForEntries(
    txnToken: string,
    want: number,
    budgetMs: number,
  ): Promise<{ rows: EntryRow[]; drainStatus: string }> {
    const deadline = Date.now() + budgetMs;
    let drainStatus = "not attempted";
    for (;;) {
      const rows = await entriesFor(txnToken);
      if (rows.length >= want) return { rows, drainStatus };
      if (Date.now() >= deadline) return { rows, drainStatus };
      drainStatus = await nudgeDrain();
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  /**
   * Poll until the entry that REVERSES a named entry exists.
   *
   * ------------------------------------------------------------------------
   * WHY THIS REPLACED `waitForEntries(txn, 2, …)`, AND WHY A COUNT WAS NEVER
   * THE RIGHT SHAPE.
   *
   * Part A used to wait for this transaction's SECOND financial entry and then
   * look for a reversal among what had arrived. That worked while a card
   * settlement produced exactly one financial entry. It does not any more, and
   * the reason is a feature rather than a regression: `interchangeHook()` in
   * `src/lib/holds/apply.ts` prices the clearing in the SAME delivery, so a
   * settlement now posts TWO entries under the same `external_ref` — the money
   * and its interchange.
   *
   * MEASURED on the deployed tip, Lithic transaction
   * 8b119c1b-748a-4315-aa48-b74026361c57:
   *
   *   07:08:13.787  card:refund:141db235-…        entry b181c6e0 (the money)
   *   07:08:13.952  interchange:141db235-…        entry 2a2589fc  (+165ms)
   *   07:08:50.009  reversal:b181c6e0-…           entry 8a57b3fa  (+36s)
   *   07:08:50.126  reversal:2a2589fc-…           entry 069c14ad  (the unbooking)
   *
   * So "the second entry" arrived 165ms in and was the interchange, 36 seconds
   * before Lithic's asynchronous RETURN_REVERSAL — and the test read the
   * absence of a reversal in that set as the provider having failed to produce
   * one. It had not: the correction landed, at the original's value date, in
   * the original's correction group, exactly as this attack claims.
   *
   * The same run passed 3/3 earlier in the night because interchange was then
   * being priced by a LATER reconcile pass rather than inline — measured at
   * 819s behind the settlement at 05:46, and at 0-1s from 06:58 onward. A test
   * whose verdict depends on how far behind a second, unrelated posting is
   * running was never measuring the correction.
   *
   * The repair is the one §1 of the README asks for: not a longer wait and not
   * a looser count, but a wait for THE SUBJECT. There is exactly one entry that
   * satisfies this attack's claim — the one whose `reverses_entry_id` is the
   * entry the provider corrected — and that is what is waited for and what is
   * asserted on. It cannot be satisfied by an interchange line, by another
   * attack's rows, or by anything else this or any other process books.
   * ------------------------------------------------------------------------
   */
  async function waitForReversalOf(
    txnToken: string,
    originalId: string,
    budgetMs: number,
  ): Promise<{ repair: EntryRow | undefined; rows: EntryRow[]; drainStatus: string }> {
    const deadline = Date.now() + budgetMs;
    let drainStatus = "not attempted";
    for (;;) {
      const rows = await entriesFor(txnToken);
      const repair = rows.find(
        (r) => r.entry_type === "reversal" && r.reverses_entry_id === originalId,
      );
      if (repair !== undefined) return { repair, rows, drainStatus };
      if (Date.now() >= deadline) return { repair: undefined, rows, drainStatus };
      drainStatus = await nudgeDrain();
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  /**
   * Wait until Lithic can see the transaction it has just issued us a token
   * for, and say how long that took.
   *
   * ------------------------------------------------------------------------
   * WHY THIS EXISTS. `/v1/simulate/authorize` answers `201 {token}` BEFORE the
   * transaction is readable, and every other endpoint keyed on that token —
   * `/v1/simulate/clearing` included — answers `404 "Transaction was not
   * found"` until it is. Part B used to POST the clearing straight after the
   * authorisation and failed, intermittently, on that 404 as a thrown
   * `LithicApiError` before a single assertion ran.
   *
   * MEASURED against this sandbox on 2026-09-11, on the card this attack
   * already owns, by polling `GET /v1/transactions/{token}` every 200ms from
   * the instant the authorize call returned:
   *
   *   AUTHORISATION APPROVED  ($0.01)   visible after  969 / 1166 / 1177 /
   *                                     1184 / 1450 / 1759 ms   (mean 1284)
   *   AUTHORISATION DECLINED  (over the card's TRANSACTION limit)
   *                                     visible after  781 / 788 / 829 /
   *                                      875 / 1047 / 1051 ms   (mean  895)
   *
   * `simulateLimiter` is 1 request per 1000ms with a 50ms safety margin and it
   * counts request STARTS, so the clearing that follows an authorisation is
   * admitted at roughly t+1050ms and reaches Lithic at t+1100-1200ms. Against
   * the declined distribution that is past the far tail and the call always
   * landed; against the approved one it straddles the middle, which is exactly
   * why this test turned intermittent — 1 failure in 4 consecutive runs — on
   * the day the sandbox account's daily spend cap was raised from $5,000 to
   * $500,000 and authorisations stopped declining. The clearing did not start
   * failing because the authorisation was approved; it started failing because
   * an APPROVED authorisation takes ~390ms longer to become readable, and the
   * fixed 1-second gap had been sitting on the wrong side of the tail.
   *
   * PROOF THAT THE 404 IS A VISIBILITY DELAY AND NOT A BAD TOKEN: the
   * transaction the failing run could not clear —
   * `19676a84-1748-4bb5-8d34-0d6089469ae4`, issued 14:09:03Z — reads
   * `PENDING / APPROVED / AUTHORIZATION:APPROVED:5000` on
   * `GET /v1/transactions` afterwards. It existed. We were early.
   *
   * So this is a wait on the PROVIDER, not a loosened assertion: nothing below
   * is relaxed, and a token that is still 404 after the budget is a hard
   * failure with the measurement quoted, because that would be a different
   * fault from the one measured here.
   * ------------------------------------------------------------------------
   */
  async function waitForProviderVisibility(
    token: string,
    budgetMs: number,
  ): Promise<{ txn: ProviderTransaction; afterMs: number; reads: number }> {
    const startedAt = Date.now();
    let reads = 0;
    for (;;) {
      reads += 1;
      try {
        const txn = await lithic.getTransaction(token);
        return { txn, afterMs: Date.now() - startedAt, reads };
      } catch (thrown) {
        const status = (thrown as { status?: unknown }).status;
        if (status !== 404) throw thrown;
        if (Date.now() - startedAt >= budgetMs) {
          throw new Error(
            `Lithic issued transaction token ${token} and then answered 404 "Transaction was not found" ` +
              `for ${Date.now() - startedAt}ms across ${reads} reads of GET /v1/transactions/${token}. ` +
              `The visibility delay measured in this sandbox is 781-1759ms, so this is not that: the token ` +
              `itself is bad, or the sandbox has lost the transaction, and neither is something a longer ` +
              `wait should paper over.`,
          );
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  /** Why a wait gave up, in the words of the rows that did arrive. */
  async function diagnose(txnToken: string, drainStatus: string): Promise<string> {
    const filed = await sql<
      { id: string; state: string; parked_on_kind: string | null; parked_reason: string | null }[]
    >`
      SELECT id, state::text AS state, parked_on_kind, parked_reason
        FROM webhook_inbox
       WHERE provider = 'lithic' AND payload->>'token' = ${txnToken}
       ORDER BY received_at`;
    const inbox = filed
      .map(
        (f) =>
          `${f.id.slice(0, 8)}:${f.state}${f.parked_on_kind ? ` parked on ${f.parked_on_kind} (${f.parked_reason ?? ""})` : ""}`,
      )
      .join(", ");
    return `Lithic transaction ${txnToken}: inbox [${inbox || "no rows arrived"}]; POST ${BASE_URL}/api/drain answered ${drainStatus}`;
  }

  /**
   * The statement for one business day, at one point in transaction time,
   * through the REAL renderer — the same `renderStatement` the /statements
   * screen and `publishStatement` use. Not a hand-rolled SUM.
   *
   * The whole document is kept, not just its closing figure, because every
   * assertion below is about the LINES THIS ATTACK PUT THERE. See
   * `addedBetween`.
   */
  async function statementFor(day: string, at: bigint): Promise<StatementDoc> {
    return statements.renderStatement(
      { accountId, periodStart: day, periodEnd: day, bookingWatermark: at },
      sql,
    );
  }

  /**
   * The lines that appeared on one day between two watermarks.
   *
   * ------------------------------------------------------------------------
   * WHY THIS EXISTS, AND WHAT IT REPLACED.
   *
   * Every figure this attack reads is a delta on ONE DAY of ONE ACCOUNT
   * between two watermarks this run captured, which was sound when the book
   * was small and is not a property of the correction. This deployment's
   * demo account takes Plaid funding credits, released ACH payments, card
   * clearings and an interest accrual all day, from the rest of the build and
   * from whoever else is running against the shared Neon branch.
   *
   * So "the day gained exactly one line" and "the day's closing figure moved
   * by exactly 7340" are claims about the whole book. The claim the ATTACK
   * makes is about the correction: it lands on settlement day, for minus the
   * settled amount, and it puts nothing on the day we learned. That is a
   * claim about rows this run created, so it is asserted on those rows — and
   * the whole-day figures are asserted too, but only when nothing else wrote
   * to the day in the window, and REPORTED with the interfering lines named
   * when something did.
   * ------------------------------------------------------------------------
   */
  function addedBetween(before: StatementDoc, after: StatementDoc): readonly StatementRow[] {
    const already = new Set(before.lines.map((l) => l.entryId));
    return after.lines.filter((l) => !already.has(l.entryId));
  }

  /**
   * What one entry did to the customer's own leaf, in STATEMENT terms: signed
   * by `normal_side`, so a credit to a liability account reads positive
   * exactly as the statement renders it.
   *
   * The two parts of this attack correct movements in opposite directions — a
   * refund in part A, a purchase clearing in part B — so the expected change
   * in the day's closing balance is read off the entry being corrected rather
   * than hard-coded with a sign that would be right in one part and wrong in
   * the other. A full reversal must move the day by exactly minus what the
   * original moved it, whichever way that was.
   */
  async function signedOnAccount(entryId: string): Promise<bigint> {
    const [row] = await sql<{ cents: bigint }[]>`
      SELECT (l.amount_cents * a.normal_side)::bigint AS cents
        FROM journal_line l JOIN account a ON a.id = l.account_id
       WHERE l.entry_id = ${entryId}::uuid AND l.account_id = ${accountId}::uuid`;
    if (row === undefined) throw new Error(`entry ${entryId} has no line on ${accountId}`);
    return row.cents;
  }

  /** The two invariant views that must never report, checked as a pair. */
  async function driftIsZero(): Promise<{ hold: number; release: number }> {
    const [h] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM v_hold_drift`;
    const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM v_hold_release_drift`;
    return { hold: h?.n ?? -1, release: r?.n ?? -1 };
  }

  /* ---------------------------------------------------------------------- */
  /* PART A — Lithic originates both halves. Nothing synthesised.           */
  /* ---------------------------------------------------------------------- */

  it("A. Lithic reverses a real settlement, and the ledger repairs the day it happened", async () => {
    // A real card settlement, originated by the provider. It is a CREDIT
    // clearing — a merchant refund — because that is the only settlement
    // Lithic's sandbox will reverse; the debit case is part B.
    const settlement = await lithic.simulateReturn({
      amount: Number(SETTLED_CENTS),
      descriptor: `CORGI CORRECT ${tag}`.slice(0, 25),
      pan,
    });
    const txn = settlement.token;
    expect(txn, "Lithic returned no transaction token for the settlement").toBeTruthy();
    if (txn === undefined || txn === "") return;

    const settled = await waitForEntries(txn, 1, 90_000);
    // BY KEY, NOT BY POSITION. `interchangeHook()` prices the settlement in the
    // same delivery, so this transaction's financial entries are the refund AND
    // its interchange — `rows[0]` happens to be the money today only because
    // `entriesFor` orders by `booking_seq` and the money commits first.
    const original = settled.rows.find((r) => r.idempotency_key.startsWith("card:refund:"));
    if (original === undefined) {
      throw new Error(
        `the $73.40 settlement never reached the ledger, so there is nothing to reverse and the attack is unproven. ${await diagnose(txn, settled.drainStatus)}`,
      );
    }

    // It came from a REAL delivery: the entry carries the inbox row Lithic's
    // signed webhook created. A test-authored entry has no inbox_id, which is
    // exactly what the previous version of this file produced.
    expect(original.inbox_id, "the settlement entry has no webhook provenance").not.toBeNull();
    expect(original.entry_type).toBe("original");
    expect(original.idempotency_key).toMatch(/^card:refund:/);

    const settlementDay = original.value_date;
    const beforeCorrection = await watermark();
    const asBelieved = await statementFor(settlementDay, beforeCorrection);

    // ---- Lithic reverses it, for real -----------------------------------
    const reversal = await simulateReturnReversal(txn);
    expect(reversal.ok, `Lithic refused the reversal: ${reversal.detail}`).toBe(true);

    // Measured: the sandbox applies a return reversal ASYNCHRONOUSLY, about 45
    // seconds later, and the transaction reads unchanged until it lands. A
    // shorter wait here reads as "the provider cannot do this", which is the
    // false negative that made an earlier note in the adapter README call void
    // "unproven".
    // Waited for BY SUBJECT — the entry that reverses THIS settlement — and not
    // by a count of what the transaction has produced. See `waitForReversalOf`
    // for the measurement that retired the count.
    const corrected = await waitForReversalOf(txn, original.id, 180_000);
    const repair = corrected.repair;
    if (repair === undefined) {
      throw new Error(
        `Lithic accepted the RETURN_REVERSAL but no entry reversing ${original.id} reached the ledger within 180s, ` +
          `so the rail is unproven. What DID arrive for this transaction: ` +
          `${corrected.rows.map((r) => `${r.idempotency_key} (${r.entry_type})`).join(", ") || "nothing"}. ` +
          `${await diagnose(txn, corrected.drainStatus)}`,
      );
    }

    // (1) It reverses the settlement, in the settlement's own correction group.
    expect(repair.reverses_entry_id).toBe(original.id);
    expect(repair.correction_group_id).toBe(original.correction_group_id);

    // (2) At the ORIGINAL's value date.
    expect(repair.value_date).toBe(settlementDay);
    // And it was learned later: this is a second axis, not a rewrite.
    expect(repair.booking_seq > original.booking_seq).toBe(true);

    // (3) It did NOT post as an ordinary entry at its own date. The correction
    //     step is a `force_post` in our vocabulary, so the key it would have
    //     used is `card:force_post:<its own token>` — and there is none.
    const [correctionEvent] = await sql<{ provider_event_id: string; value_date: string }[]>`
      SELECT cae.provider_event_id, cae.value_date::text AS value_date
        FROM card_auth_event cae
        JOIN card_authorization ca ON ca.id = cae.auth_id
       WHERE ca.provider = 'lithic' AND ca.provider_auth_id = ${txn}
         AND cae.kind = 'force_post'`;
    expect(correctionEvent, "the RETURN_REVERSAL fact was not recorded").toBeDefined();
    if (correctionEvent === undefined) return;
    const [stray] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM journal_entry
       WHERE idempotency_key = ${`card:force_post:${correctionEvent.provider_event_id}`}`;
    expect(stray?.n, "the correction ALSO posted at its own date — a second line, not a repair").toBe(0);

    // (4) Both time axes, from the real renderer. A settlement of $73.40 that
    //     never happened must move settlement day by exactly minus what it
    //     moved it by — here a refund, so the day comes back DOWN.
    const originalSigned = await signedOnAccount(original.id);
    expect(originalSigned).toBe(SETTLED_CENTS); // a refund credits the customer
    const asCorrected = await statementFor(settlementDay, await watermark());

    // ASSERTED ON THE LINE THE CORRECTION ADDED. The as-believed rendering
    // does not carry the repair; the as-corrected one does, once, dated
    // settlement day, for exactly minus the refund. Both renderings still
    // carry the original, with the same signed amount: two answers, neither
    // overwriting the other.
    const addedA = addedBetween(asBelieved, asCorrected);
    const mineA = addedA.filter((l) => l.entryId === repair.id);
    expect(mineA.map((l) => l.entryId)).toEqual([repair.id]);
    expect(mineA[0]?.valueDate).toBe(settlementDay);
    expect(mineA[0]?.signedCents).toBe(-originalSigned);
    expect(asBelieved.lines.some((l) => l.entryId === repair.id)).toBe(false);
    const originalBefore = asBelieved.lines.find((l) => l.entryId === original.id);
    const originalAfter = asCorrected.lines.find((l) => l.entryId === original.id);
    expect(originalBefore?.signedCents).toBe(originalSigned);
    expect(originalAfter?.signedCents).toBe(originalSigned);

    // AND ON THE WHOLE DAY when the day was otherwise idle in the window —
    // the headline figure, asserted when it is ours to assert and reported,
    // with the interfering lines named, when the shared database moved the
    // same day underneath the measurement.
    const foreignA = addedA.filter((l) => l.entryId !== repair.id);
    const quietA = foreignA.length === 0 && asCorrected.openingBalanceCents === asBelieved.openingBalanceCents;
    if (quietA) {
      expect(asCorrected.closingBalanceCents - asBelieved.closingBalanceCents).toBe(-originalSigned);
      expect(asCorrected.lineCount).toBe(asBelieved.lineCount + 1);
    }

    // (5) Nothing was edited.
    const [after] = await sql<{ description: string; entry_type: string }[]>`
      SELECT description, entry_type::text AS entry_type
        FROM journal_entry WHERE id = ${original.id}::uuid`;
    expect(after?.description).toBe(original.description);
    expect(after?.entry_type).toBe("original");

    // (6) The books, and the two views the hold model is held equal by.
    expect(await bal.trialBalanceCents()).toBe(0n);
    expect(await driftIsZero()).toEqual({ hold: 0, release: 0 });

    record(
      "evidence",
      `PART A — NOTHING SYNTHESISED. Measured on ${isolation}. Lithic transaction ${txn} on card ${cardToken}: ` +
        `/v1/simulate/return 201 posted entry ${original.id} (${original.idempotency_key}) at value date ${settlementDay} from webhook inbox row ${original.inbox_id}; ` +
        `/v1/simulate/return_reversal 201 produced RETURN_REVERSAL ${correctionEvent.provider_event_id}, which the consumer routed through reverseAndRebook to entry ${repair.id} — entry_type=reversal, reverses ${original.id}, correction group ${repair.correction_group_id}, VALUE DATE ${repair.value_date} (the original's), booking_seq ${original.booking_seq} -> ${repair.booking_seq}. ` +
        `No entry exists at key card:force_post:${correctionEvent.provider_event_id}: the correction did not post at its own date. ` +
        `Statement for ${settlementDay} via renderStatement(): as-believed@seq${beforeCorrection} closing ${asBelieved.closingBalanceCents} over ${asBelieved.lineCount} lines; as-corrected closing ${asCorrected.closingBalanceCents} over ${asCorrected.lineCount} lines. THE LINE THE CORRECTION ADDED: entry ${repair.id}, value date ${mineA[0]?.valueDate}, signed ${mineA[0]?.signedCents} = minus the original entry's ${originalSigned} on the customer's leaf — the refund taken back, on the day it was booked — and the original still reads ${originalAfter?.signedCents} in both renderings. ` +
        (quietA
          ? `Nothing else was booked to ${settlementDay} in the window, so the whole day's move was asserted too: ${asCorrected.closingBalanceCents - asBelieved.closingBalanceCents}.`
          : `${foreignA.length} other line(s) were booked to ${settlementDay} by another process inside the window (${foreignA.map((l) => l.entryId.slice(0, 8)).join(", ")}), so the whole-day figures are REPORTED rather than asserted: closing moved ${asCorrected.closingBalanceCents - asBelieved.closingBalanceCents} over ${asCorrected.lineCount - asBelieved.lineCount} new lines. The line-level assertion above is unaffected — it names our entry.`) +
        ` Trial balance 0; v_hold_drift 0; v_hold_release_drift 0.`,
    );
  }, 240_000);

  /* ---------------------------------------------------------------------- */
  /* PART B — the brief's sentence, with the one synthesised step named.     */
  /* ---------------------------------------------------------------------- */

  it("B. the $73.40 fuel-pump capture, reversed the NEXT DAY, repairs settlement day", async () => {
    // ---- Real: $50 fuel-pump authorisation, then a $73.40 capture --------
    const auth = await lithic.simulateAuthorize({
      amount: Number(AUTH_CENTS),
      descriptor: `CORGI FUEL ${tag}`.slice(0, 25),
      pan,
      status: "AUTHORIZATION",
      mcc: "5542", // automated fuel dispenser
    });
    const txn = auth.token;
    expect(txn, "Lithic returned no transaction token for the authorisation").toBeTruthy();
    if (txn === undefined || txn === "") return;

    // ---- WAIT FOR THE PROVIDER TO SEE ITS OWN TRANSACTION ----------------
    //
    // A token is not a transaction yet. See `waitForProviderVisibility` for
    // the measurement, and for why clearing straight after the authorisation
    // was a coin-flip against an APPROVED authorisation and was not against a
    // declined one.
    const seen = await waitForProviderVisibility(txn, 30_000);
    const authEvent = (seen.txn.events ?? []).find((e) => e.type === "AUTHORIZATION");
    const verdict: string = authEvent?.result ?? seen.txn.result;
    const verdictDetail = (authEvent?.detailed_results ?? []).join(", ");

    // WHAT THE NETWORK ACTUALLY SAID, read from the provider before anything
    // is asserted — and said FIRST when it was not an approval, so that this
    // attack can never read as having exercised a fuel-pump authorisation it
    // did not get. The correction claim below is unaffected either way: a
    // clearing lands whatever the authorisation's verdict was, and it is the
    // clearing that gets reversed. Nothing here is weakened for a decline;
    // one sentence is added to the evidence.
    if (verdict !== "APPROVED") {
      record(
        "evidence",
        `PART B — THE $50 FUEL-PUMP AUTHORISATION WAS NOT APPROVED. Lithic answered ` +
          `AUTHORIZATION ${AUTH_CENTS} result ${verdict}` +
          (verdictDetail === "" ? "" : ` [${verdictDetail}]`) +
          ` on transaction ${txn}, so the published sentence's FIRST half — "simulate a $50 fuel-pump ` +
          `auth" — was not exercised on this run and no hold was placed. Everything asserted below is ` +
          `about the $73.40 CLEARING and its backdated reversal, which are unaffected by the verdict: ` +
          `a clearing posts the money whether or not the authorisation that preceded it was approved. ` +
          `See README §2b for the account-level cap that produces this.`,
      );
    }

    await lithic.simulateClearing({ token: txn, amountCents: Number(SETTLED_CENTS) });

    const cleared = await waitForEntries(txn, 1, 90_000);
    const clearing = cleared.rows.find((r) => r.idempotency_key.startsWith("card:clearing:"));
    if (clearing === undefined) {
      throw new Error(
        `the $73.40 clearing never reached the ledger, so there is nothing to reverse. ${await diagnose(txn, cleared.drainStatus)}`,
      );
    }
    expect(clearing.inbox_id, "the clearing entry has no webhook provenance").not.toBeNull();

    const settlementDay = clearing.value_date;
    const beforeCorrection = await watermark();
    const asBelieved = await statementFor(settlementDay, beforeCorrection);

    // ---- Establish, by measurement, that Lithic cannot reverse this ------
    //
    // Not asserted from the docs and not skipped: the endpoint is called, and
    // its refusal is the evidence for the synthesis that follows.
    const refusal = await simulateReturnReversal(txn);
    expect(refusal.ok, "Lithic reversed a debit clearing — this test's premise is stale").toBe(
      false,
    );

    // ---- THE ONE SYNTHESISED STEP ---------------------------------------
    //
    // A CORRECTION_CREDIT, dated the NEXT DAY, attached to the REAL
    // transaction beside its REAL events. Everything from the signature
    // onwards is production.
    const real = await lithic.getTransaction(txn);
    const nextDay = new Date(`${settlementDay}T12:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const correctionToken = randomUUID();
    const correctionCreated = nextDay.toISOString().replace(/\.\d{3}Z$/, "Z");

    const body = {
      ...(real as unknown as Record<string, unknown>),
      event_type: "card_transaction.updated",
      updated: correctionCreated,
      events: [
        ...(real.events ?? []),
        {
          token: correctionToken,
          type: "CORRECTION_CREDIT",
          created: correctionCreated,
          result: "APPROVED",
          amount: Number(SETTLED_CENTS),
          effective_polarity: "CREDIT",
          amounts: {
            cardholder: { amount: Number(SETTLED_CENTS), conversion_rate: "1.000000", currency: "USD" },
            merchant: { amount: Number(SETTLED_CENTS), currency: "USD" },
            settlement: { amount: Number(SETTLED_CENTS), conversion_rate: "1.000000", currency: "USD" },
            hold: { amount: 0, currency: "USD" },
          },
          detailed_results: ["APPROVED"],
          rule_results: [],
          network_info: null,
          network_specific_data: null,
          account_type: null,
        },
      ],
    };
    const raw = JSON.stringify(body);

    // Standard Webhooks, signed with the REAL secret, exactly as Lithic signs:
    // `id.timestamp.body`, HMAC-SHA256 keyed on the base64-DECODED secret.
    const webhookId = `msg_lf3_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const secret = process.env["LITHIC_WEBHOOK_SECRET"] ?? "";
    const signature = createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64"))
      .update(`${webhookId}.${timestamp}.${raw}`, "utf8")
      .digest("base64");

    const delivered = await fetch(`${BASE_URL}/api/webhooks/lithic`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      },
      body: raw,
    });
    const deliveredBody = (await delivered.json()) as Record<string, unknown>;
    expect(delivered.status).toBe(202);
    expect(deliveredBody["status"]).toBe("accepted");

    // NEGATIVE CONTROL. Without it the 202 proves nothing about verification:
    // an endpoint that accepts anything would answer 202 too.
    const tampered = await fetch(`${BASE_URL}/api/webhooks/lithic`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": `${webhookId}X`,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${"A".repeat(43)}=`,
      },
      body: raw,
    });
    const tamperedBody = (await tampered.json()) as { error?: { code?: string } };
    expect(tampered.status).toBe(401);
    expect(tamperedBody.error?.code).toBe("WEBHOOK_SIGNATURE_INVALID");

    // ---- Production processes it ----------------------------------------
    // BY SUBJECT, like part A. This used to wait for one more entry than the
    // clearing had already produced and then take the first reversal it found
    // — a delta, which survived interchange being priced inline where part A's
    // absolute count did not, but which still identified the correction by
    // COUNT AND TYPE rather than by what it corrects. The correction unbooks
    // the interchange as well as the money (`reversal:<interchange entry>`), so
    // "the first reversal" is two rows, and which one arrives first is not a
    // property this attack should be resting on.
    const repaired = await waitForReversalOf(txn, clearing.id, 120_000);
    const repair = repaired.repair;
    if (repair === undefined) {
      throw new Error(
        `the signed CORRECTION_CREDIT was accepted (HTTP ${delivered.status}) but no entry reversing ` +
          `${clearing.id} reached the ledger within 120s. What DID arrive for this transaction: ` +
          `${repaired.rows.map((r) => `${r.idempotency_key} (${r.entry_type})`).join(", ") || "nothing"}. ` +
          `${await diagnose(txn, repaired.drainStatus)}`,
      );
    }

    // (1) and (2). The correction event's OWN value date is the next day; the
    //     money is repaired on settlement day. This one pair of assertions is
    //     the entire attack.
    const [fact] = await sql<{ value_date: string }[]>`
      SELECT cae.value_date::text AS value_date
        FROM card_auth_event cae
        JOIN card_authorization ca ON ca.id = cae.auth_id
       WHERE ca.provider = 'lithic' AND ca.provider_auth_id = ${txn}
         AND cae.provider_event_id = ${correctionToken}`;
    expect(fact?.value_date, "the correction fact was not recorded at its own date").toBe(
      correctionCreated.slice(0, 10),
    );
    expect(fact?.value_date).not.toBe(settlementDay);
    expect(repair.value_date).toBe(settlementDay);
    expect(repair.reverses_entry_id).toBe(clearing.id);
    expect(repair.correction_group_id).toBe(clearing.correction_group_id);
    expect(repair.booking_seq > clearing.booking_seq).toBe(true);

    // (3) THE CORRECTION PUT NOTHING ON THE DAY WE LEARNED.
    //
    // ------------------------------------------------------------------
    // THIS ASSERTION USED TO READ `statementFor(learnedDay).lines === 0`,
    // and it failed, twice, at 9. The nine were Plaid funding credits and
    // released ACH payments booked to that day by the rest of the build —
    // measured: value date 2026-09-11 on the demo account carried nine
    // entries at booking_seq 1395…1931 before this attack ran, and not one
    // of them was ours. The correction itself contributed nothing.
    //
    // So the old assertion tested "nobody else used the account that day",
    // which was true when the book was small and is not the property the
    // attack is about. It is not loosened here — it is pointed at the
    // entries this run created, from three directions, any one of which
    // would catch a correction that posted a second line at its own date:
    //
    //   (a) the key such a posting would carry — `card:<kind>:<event id>`
    //       for THIS correction event, whatever kind it was read as;
    //   (b) every financial row the correction produced, reached by
    //       external_ref and by correction group: all dated settlement day;
    //   (c) the rendered statement for the learning day: not one of its
    //       lines belongs to this run.
    // ------------------------------------------------------------------
    const learnedDay = fact?.value_date ?? "";
    // (a)
    const [strayKeyed] = await sql<{ n: number; keys: string | null }[]>`
      SELECT count(*)::int AS n, string_agg(idempotency_key, ', ') AS keys
        FROM journal_entry
       WHERE idempotency_key LIKE ${`card:%:${correctionToken}`}`;
    expect(
      strayKeyed?.n,
      `the correction ALSO posted at its own date: ${strayKeyed?.keys ?? ""}`,
    ).toBe(0);
    // (b) Every entry this transaction and this correction group produced,
    //     memo book included, with the day each landed on.
    const produced = await sql<{ id: string; book: string; value_date: string; key: string }[]>`
      SELECT id, book::text AS book, value_date::text AS value_date, idempotency_key AS key
        FROM journal_entry
       WHERE external_ref = ${txn}
          OR correction_group_id = ${clearing.correction_group_id}::uuid
          OR reverses_entry_id = ${clearing.id}::uuid
       ORDER BY booking_seq`;
    //     Asserted over the FINANCIAL book, which is what a statement renders
    //     (`readAccountPeriod` filters on it); the memo book is carried in the
    //     evidence because a hold movement is not a statement line and dating
    //     one at the correction's own instant would be correct.
    const producedFinancial = produced.filter((r) => r.book === "financial");
    expect(producedFinancial.length).toBeGreaterThan(0);
    expect(
      producedFinancial
        .filter((r) => r.value_date !== settlementDay)
        .map((r) => `${r.key}@${r.value_date}`),
      "a financial entry of this correction's own is dated off settlement day",
    ).toEqual([]);
    // (c) The same claim as the statement renders it. Other people's traffic
    //     on that day is not asserted about, ours is.
    const learnedBefore = await statementFor(learnedDay, beforeCorrection);
    const learnedAfter = await statementFor(learnedDay, await watermark());
    const oursEverywhere = new Set(produced.map((r) => r.id));
    const learnedLinesOfOurs = learnedAfter.lines.filter((l) => oursEverywhere.has(l.entryId));
    expect(
      learnedLinesOfOurs.map((l) => l.entryId),
      "the correction grew a line on the day we learned",
    ).toEqual([]);
    const learnedForeign = addedBetween(learnedBefore, learnedAfter);

    // (4) Settlement day, both axes, from the real renderer. The clearing took
    //     $73.40 off the customer, so undoing it puts exactly that back — on
    //     SETTLEMENT DAY, not on the day the correction arrived. Asserted on
    //     the line the correction added, for the reason given at
    //     `addedBetween`; the whole-day figures follow when the day was
    //     otherwise idle in the window.
    const clearingSigned = await signedOnAccount(clearing.id);
    expect(clearingSigned).toBe(-SETTLED_CENTS); // a capture debits the customer
    const asCorrected = await statementFor(settlementDay, await watermark());
    const addedB = addedBetween(asBelieved, asCorrected);
    const mineB = addedB.filter((l) => l.entryId === repair.id);
    expect(mineB.map((l) => l.entryId)).toEqual([repair.id]);
    expect(mineB[0]?.valueDate).toBe(settlementDay);
    expect(mineB[0]?.signedCents).toBe(-clearingSigned);
    expect(asBelieved.lines.some((l) => l.entryId === repair.id)).toBe(false);
    const clearingBefore = asBelieved.lines.find((l) => l.entryId === clearing.id);
    const clearingAfter = asCorrected.lines.find((l) => l.entryId === clearing.id);
    expect(clearingBefore?.signedCents).toBe(clearingSigned);
    expect(clearingAfter?.signedCents).toBe(clearingSigned);
    const foreignB = addedB.filter((l) => l.entryId !== repair.id);
    const quietB =
      foreignB.length === 0 &&
      asCorrected.openingBalanceCents === asBelieved.openingBalanceCents;
    if (quietB) {
      expect(asCorrected.closingBalanceCents - asBelieved.closingBalanceCents).toBe(-clearingSigned);
      expect(asCorrected.lineCount).toBe(asBelieved.lineCount + 1);
    }

    // (5) Nothing was edited.
    const [after] = await sql<{ description: string; entry_type: string }[]>`
      SELECT description, entry_type::text AS entry_type
        FROM journal_entry WHERE id = ${clearing.id}::uuid`;
    expect(after?.description).toBe(clearing.description);
    expect(after?.entry_type).toBe("original");

    // (6) Books and drift.
    expect(await bal.trialBalanceCents()).toBe(0n);
    expect(await driftIsZero()).toEqual({ hold: 0, release: 0 });

    // ---- Idempotence: redeliver the same signed bytes --------------------
    //
    // The before-figure is read HERE rather than taken from the poll that
    // found the reversal. The correction posts TWO entries — the money's
    // reversal and the unbooking of the interchange it priced, measured 117ms
    // and 132ms apart on two runs — so a poll that returns the instant the
    // first one lands can hold a count that is one short of settled, and the
    // replay would then be blamed for a row it did not write.
    const beforeReplay = await entriesFor(txn);
    const replay = await fetch(`${BASE_URL}/api/webhooks/lithic`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": webhookId,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      },
      body: raw,
    });
    expect(replay.status).toBe(200);
    await nudgeDrain();
    const afterReplay = await entriesFor(txn);
    expect(afterReplay.length).toBe(beforeReplay.length);

    record(
      "evidence",
      `PART B — ONE STEP SYNTHESISED, NAMED. Measured on ${isolation}. Real Lithic transaction ${txn} on card ${cardToken}: ` +
        `/v1/simulate/authorize 201 ($50.00 fuel pump, MCC 5542) -> AUTHORIZATION ${verdict}` +
        (verdictDetail === "" ? "" : ` [${verdictDetail}]`) +
        `; the provider could not see its own transaction for ${seen.afterMs}ms (${seen.reads} read(s) of GET /v1/transactions/${txn} before it answered 200) and clearing inside that window is what used to fail this test with 404 "Transaction was not found". ` +
        `Then /v1/simulate/clearing 201 ($73.40) posted entry ${clearing.id} (${clearing.idempotency_key}) at settlement day ${settlementDay} from webhook inbox row ${clearing.inbox_id}. ` +
        `Lithic CANNOT reverse it: POST /v1/simulate/return_reversal {token: ${txn}} -> ${refusal.detail}. ` +
        `SYNTHESISED: one CORRECTION_CREDIT step (token ${correctionToken}, created ${correctionCreated} — the next day), appended to the REAL transaction beside its real events. ` +
        `NOT synthesised: the signature (HMAC-SHA256 over "${webhookId}.<ts>.<body>" with LITHIC_WEBHOOK_SECRET), the transport (POST ${BASE_URL}/api/webhooks/lithic -> HTTP ${delivered.status}), verification (a one-character signature change -> HTTP ${tampered.status} ${tamperedBody.error?.code}), the inbox row ${String(deliveredBody["inboxId"])}, the drain, the rail_event_semantics lookup, or the posting. ` +
        `RESULT: the fact is dated ${fact?.value_date} (the day we learned) and the MONEY was repaired at ${repair.value_date} (settlement day) as entry ${repair.id}, entry_type=reversal, reverses ${clearing.id}, correction group ${repair.correction_group_id}. ` +
        `Statement for ${settlementDay} via renderStatement(): as-believed@seq${beforeCorrection} closing ${asBelieved.closingBalanceCents} over ${asBelieved.lineCount} lines; as-corrected closing ${asCorrected.closingBalanceCents} over ${asCorrected.lineCount} lines. THE LINE THE CORRECTION ADDED: entry ${repair.id} at value date ${mineB[0]?.valueDate}, signed ${mineB[0]?.signedCents} = minus the clearing's ${clearingSigned}, and the clearing itself still reads ${clearingAfter?.signedCents} in both renderings. ` +
        (quietB
          ? `Nothing else was booked to ${settlementDay} in the window, so the whole day's move was asserted too: ${asCorrected.closingBalanceCents - asBelieved.closingBalanceCents} over ${asCorrected.lineCount - asBelieved.lineCount} new line(s).`
          : `${foreignB.length} other line(s) reached ${settlementDay} from another process inside the window (${foreignB.map((l) => l.entryId.slice(0, 8)).join(", ")}), so the whole-day figures are REPORTED not asserted: closing moved ${asCorrected.closingBalanceCents - asBelieved.closingBalanceCents} over ${asCorrected.lineCount - asBelieved.lineCount} new lines.`) +
        ` THE DAY WE LEARNED (${learnedDay}): of the ${producedFinancial.length} financial entr${producedFinancial.length === 1 ? "y" : "ies"} this transaction and its correction group produced, ${producedFinancial.filter((r) => r.value_date === settlementDay).length} are dated settlement day and NONE is dated ${learnedDay}; no entry exists under key card:%:${correctionToken}; and of the ${learnedAfter.lineCount} lines that day's statement carries, 0 are ours (${learnedForeign.length} appeared during the window, all of them other people's traffic on a shared demo account — this assertion used to demand the whole day be EMPTY and failed at 9 for exactly that reason). ` +
        `Redelivery of the same signed bytes -> HTTP ${replay.status}, entries unchanged at ${afterReplay.length}. Trial balance 0; v_hold_drift 0; v_hold_release_drift 0.`,
    );
  }, 240_000);

  /* ---------------------------------------------------------------------- */

  it("the database itself refuses to edit the rows we just corrected", async () => {
    // Not decoration. The whole correction argument rests on the original row
    // being unchangeable, so the suite proves it rather than asserting it.
    await expect(
      sql`UPDATE journal_entry SET description = 'tampered' WHERE true`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      sql`DELETE FROM journal_line WHERE true`,
    ).rejects.toThrow(/permission denied/);
    record(
      "evidence",
      "UPDATE on journal_entry and DELETE on journal_line are both refused for corgi_app: permission denied. A correction is an append; there is no other kind available to this role.",
    );
  });
});
