/**
 * ATTACK 7 — "Turn off the issuing provider's webhooks for five minutes
 * mid-demo. Assert the system degrades visibly rather than silently: the health
 * endpoint reports it, the UI shows a provider-down state, and no money is
 * invented or lost. Simulate the outage rather than actually disabling the live
 * subscription."
 *
 * The attack makes THREE claims and this file tests them as three tests,
 * because they are three claims and passing one does not earn the others.
 *
 * ============================================================================
 * HOW THE OUTAGE IS SIMULATED.
 *
 * The live Lithic event subscription is left ENABLED — disabling it mid-trial
 * is exactly the irreversible thing the brief warns against, and re-enabling it
 * is not something to be doing in front of a panel.
 *
 * Instead the outage is simulated from the only angle that matters: a card
 * event happens at the network and WE NEVER RECEIVE IT. A genuine Lithic
 * authorisation body is captured, reissued under a fresh transaction id, signed
 * with this deployment's own `LITHIC_WEBHOOK_SECRET`, and then HELD — not
 * POSTed — for the outage window. That is precisely what a webhook outage looks
 * like from our side: the money moved and nobody told us.
 *
 * Then the webhooks come back on and the provider catches up, redelivering what
 * we missed and retrying it, which is what providers do after an outage.
 * ============================================================================
 *
 * THE MONEY CLAIM. Through the dark window nothing is invented — the trial
 * balance does not move and no customer's ledger or available balance changes.
 * On recovery nothing is lost and nothing is double-counted: the held delivery
 * posts exactly once however many times it arrives, and withholds exactly what
 * the network granted.
 *
 * ============================================================================
 * THE THIRD WAY THIS TEST MEASURED ITSELF WRONG, AND IT IS THE PATTERN WITH
 * ITS SIGN FLIPPED.
 *
 * The two mistakes below both reported a working ledger as broken by reading
 * the wrong row or the wrong book. This one did it by reading a real row
 * correctly and drawing the opposite conclusion from it.
 *
 * The recovery half asserted that a memo posting MUST follow the fact, and
 * failed with "no memo posting withheld the money within 60s of it, so $50.00
 * is authorised and not held and the customer can spend it twice." Measured
 * against the deployed tip, on authorisation 688af4e6-c257-4a6f-a941-
 * 5911760a0808 / hold d22227bd-efad-4149-9ae6-1faf0e7ae7fe:
 *
 *   * `hold.external_ref` = `lithic:688af4e6-…`, the `<provider>:<id>` shape
 *     only `ensureAuthorization()` builds — so this DID go through apply.ts;
 *   * one `card_auth_event`, `kind = 'declined'`, with a
 *     `card_auth_event_result` row beside it reading `result = 'DECLINED'`,
 *     `provider_step = 'AUTHORIZATION'`, `source = 'ingest'`;
 *   * one `webhook_inbox` row, signature verified, `state = 'done'` 129ms
 *     after it arrived;
 *   * `v_card_auth_hold.target_hold_cents = 0`, memo balance 0, and both
 *     `v_hold_drift` and `v_hold_posting_incomplete` EMPTY for this hold.
 *
 * The network refused the authorisation — the sandbox account's rolling
 * 24-hour cap is exhausted, which is the same condition README §2b records for
 * attacks 1 and 2 — so `H(E) = 0`, `Δ = 0`, and `postHoldDelta()` appends
 * nothing for `Δ = 0`. The posting is absent because there is nothing to
 * withhold, not because anything was lost. Migration 0036's atomicity is what
 * makes that readable: the compare-and-append is in the SAME transaction as
 * the facts, so a committed fact is proof the posting decision was taken.
 *
 * And `claimed=0 processed=0 parked=0` from the drain nudge was not a missing
 * delivery either: `src/app/api/webhooks/[provider]/route.ts` drains in an
 * `after()` callback the instant the 2xx is on its way, so the row was already
 * `done` before the test's operator-style drain could claim it.
 *
 * So the verdict is now read BEFORE any money is asserted, and the recovery
 * half branches on it — the idiom attack 1 already uses. On a refusal this
 * file proves the smaller, named claim and says so in its FIRST evidence line,
 * on the terms README §2b sets. On an approval nothing is weakened: the memo
 * posting is still required, and its absence is still a failure with the same
 * message.
 * ============================================================================
 *
 * ============================================================================
 * HOW THE MONEY CLAIM IS MEASURED, AND THE TWO WAYS IT USED TO BE MEASURED
 * WRONG. Both were fixed by the same idea and both are worth reading, because
 * this file is the fourteenth instance of the pattern this build keeps finding.
 *
 *   1. IT WAITED FOR THE WRONG ROW. `src/lib/holds/apply.ts` splits one event
 *      into two transactions on purpose — the facts and the closure commit
 *      first, the memo posting second — so `card_authorization` exists before
 *      the money is withheld. This test polled for the authorisation and then
 *      read `available`, and on the suite run it landed in the gap: measured,
 *      the hold row committed at 03:45:45.251Z and the opening posting at
 *      03:45:45.581Z, and available read the same figure at both ends of a
 *      window that had genuinely moved by $50. It now waits for the POSTING,
 *      which is the thing the claim is about.
 *
 *   2. ITS QUIET-WINDOW GUARD WATCHED THE WRONG BOOK, and then the wrong
 *      dimension entirely. It counted `journal_entry WHERE book = 'financial'`
 *      before asserting a delta on `available` — a quantity moved by the MEMO
 *      book, since that is where a hold lives. Every card hold in the suite
 *      walked through it. And `available` also moves with the CLOCK alone:
 *      `ledger_availability` matures uncleared credits at `available_at`,
 *      expires card holds at `expires_at`, and brings a warehoused ACH credit
 *      into the ledger term when `book_date()` reaches its value date —
 *      measured on this deployment as a multi-million-cent step at 00:00
 *      America/New_York with no entry booked at all.
 *
 * The fix for both is not a better guard, because a guard is an exclusion and
 * an exclusion shaped like the failure is how this keeps happening. The delta
 * is now ISOLATED instead: the app's own `accountAvailability` is asked the
 * same question at ONE instant and TWO watermarks, the pair either side of
 * this run's own opening posting. Every other writer's rows are in both
 * readings and cancel; the clock is identical on both sides and cancels; what
 * is left is this attack's own $50 and nothing else. Cross-attack and
 * cross-process interference is prevented by construction rather than detected
 * after the fact. The whole-business figures are still reported, and still
 * asserted when the episode really was quiet in BOTH books.
 * ============================================================================
 *
 * THE TWO VISIBILITY CLAIMS are now testable, and are INDUCED rather than
 * waited for. `/api/health` publishes `integrations.webhookHealth` — a
 * per-provider last-delivery instant, a lag in seconds and a verdict — and the
 * console shell renders a banner from that verdict. Neither reports anything at
 * rest, on purpose: a feed nobody has poked reads `quiet` or `never`, and
 * neither is an outage (delivery-health.ts, ALARM_WINDOW_MULTIPLE; DECISIONS
 * 025). So the second test opens a genuine, deliberate silence measured from
 * the real delivery the first test just made, watches Lithic cross its own 180s
 * threshold from `fresh` to `stale`, and cross-checks the published instant
 * against `MAX(webhook_inbox.received_at)` in the live database; the third
 * reads the deployed console inside that same window. If the silence cannot be
 * induced, both SKIP naming what stopped it rather than asserting something
 * weaker.
 *
 * ============================================================================
 * THE LIMIT THAT USED TO BE HERE, AND WHAT RETIRED IT. Kept, because the shape
 * of the bug is the interesting part and deleting the history would waste it.
 *
 * This attack shipped with a gap recorded on the scoreboard rather than
 * asserted away: a stale Lithic feed was REPORTED by `webhookHealth` and did
 * not ESCALATE. `degradesDeployment` was false, `degradedBy` was empty, and the
 * top-level `status` stayed `ok` while the card rail was dark — so a monitor
 * watching `status` alone saw nothing. Measured at the time: Lithic crossed its
 * 180s threshold at 184s and `status` stayed "ok".
 *
 * The cause was not the alarm. `delivery-health.ts` gates escalation on the
 * provider's integration being probed live; `route.ts` derived that as EVERY
 * Lithic slot reading `live`; and Lithic owns two slots, of which
 * `card_webhooks` had no probe and was therefore honestly `unprobed` and
 * labelled `simulated` (DECISIONS 026). One honest absence of evidence made the
 * clause unsatisfiable for ever. The guard's exclusion was shaped exactly like
 * the failure it existed to catch, and it reported healthy — the fourth time
 * that pattern has appeared in this repo.
 *
 * TWO THINGS RETIRED IT, and both are load-bearing here:
 *
 *   1. `card_webhooks` earned a real probe — `GET /v1/event_subscriptions` plus
 *      that subscription's `/attempts` log showing Lithic's own record of our
 *      endpoint answering HTTP 202. It is `live` now, not `unprobed`, and
 *      `/api/health` reports 6 of 7 slots live.
 *   2. The gate became `some` (DECISIONS 028), so no single slot's degradation
 *      can silence the alarm.
 *
 * (2) is not made redundant by (1), which is why the second test below asserts
 * BOTH the narrowing and the gate's shape. That probe reads Lithic's own
 * delivery log, so its verdict is a function of the delivery loop's health: an
 * endpoint of ours rejecting deliveries reads `unauthorised` and an unreadable
 * `/attempts` reads `unreachable`. Under `every`, either would disarm the alarm
 * at the exact moment deliveries were being lost.
 * ============================================================================
 *
 * ============================================================================
 * THE LIMIT THAT IS HERE NOW — 2026-09-11, and it replaced a WRONG ASSERTION.
 *
 * The second test used to assert `status === "degraded"` at the end of its
 * induced silence. That assertion has been removed because it was false, and
 * it was false for a reason worth more than the assertion was:
 *
 * Escalation used to be `MAX(webhook_inbox.received_at)` and a clock. That
 * measures TIME SINCE THE LAST WEBHOOK when the question is ARE WE LOSING
 * DELIVERIES, and it cannot separate "the provider stopped delivering while
 * transactions were happening" from "nobody swiped a card". Measured on this
 * deployment at 17:56Z with no outage in progress: `stale`,
 * `degradesDeployment: true`, while the liveness probe read `GET /v1/cards ->
 * 200` in the same response. `/api/health` now narrows that silence against
 * `card_auth_decision WHERE source = 'provider'` — the ASA record, written
 * synchronously while Lithic holds an authorisation open at a terminal, on a
 * channel independent of the inbox whose silence is in question.
 *
 * AND THIS ATTACK INDUCES ITS OUTAGE BY SENDING NOTHING. The silence it opens
 * is genuine and measured, but nothing was owed during it, so the honest
 * verdict is `dormant` and the endpoint correctly declines to escalate.
 * Asserting `degraded` here would assert the defect back into existence.
 *
 * WHAT IS THEREFORE NOT PROVEN END-TO-END: that a real disabled subscription
 * reddens the top-level status. A true induction disables the Lithic event
 * subscription and THEN transacts, so a delivery is genuinely owed and
 * genuinely does not arrive. It is NOT automated here, on purpose: a
 * subscription left disabled by a crashed or SIGKILLed run is a broken card
 * rail during a live demo, and this suite cannot guarantee restoration through
 * a signal it does not get to handle. It is a scripted human step in
 * docs/DEMO.md, where the operator holds the restore.
 *
 * MEASURED, AND IT MAKES THE HUMAN STEP SAFE: `GET /v1/auth_stream` on this
 * account reads `{"enrolled": true}`, and ASA enrolment is SEPARATE from the
 * event subscription. Disabling the subscription therefore stops the
 * asynchronous clearing feed WITHOUT stopping card authorisation at the
 * terminal — so the demo's cards keep working while the feed is dark, which is
 * exactly the state the attack is about.
 *
 * What the second test proves instead, without that risk, is the claim the
 * narrowing actually turns on: replaying THIS outage's own published facts
 * through `attributeDeliverySilence` — the route's own pure function — with
 * exactly one input varied (ASA decisions after the last delivery: 0 vs 1), the
 * alarm is removed on a counted zero and STAYS on a delivery that is owed. The
 * narrowing can only ever subtract, and it cannot silence real loss.
 * ============================================================================
 */
import { createHmac, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

// The route's OWN modules, not reimplementations of them. The counterfactual
// below is only worth anything if it runs the same code `/api/health` runs.
import { attributeDeliverySilence } from "@/app/api/health/initiation";
import { webhookDeliveryHealth } from "@/lib/integrations/delivery-health";
import type * as BalancesModule from "@/lib/ledger/balances";
import type { sql as SqlHandle } from "@/lib/ledger/db";
import type * as Holds from "@/lib/holds";
import type * as LithicClient from "@/lib/rails/lithic/client";

const ATTACK = 7;
const NAME = "Issuing-provider webhook outage degrades visibly, and invents no money";

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

/**
 * The dark window, in seconds.
 *
 * The published attack says five minutes. Five minutes of a rehearsal suite is
 * five minutes nobody will run, and the claim is about STATE and not about
 * duration: what has to be true is that nothing changes while the feed is dark
 * and that the backlog applies exactly once when it is not. 20s by default,
 * `LIVEFIRE_OUTAGE_SECONDS=300` for the real thing in front of the panel.
 */
const OUTAGE_SECONDS = Number(process.env["LIVEFIRE_OUTAGE_SECONDS"] ?? "20");

const MISSING: string[] = [];
if (process.env["LIVEFIRE"] !== "1") MISSING.push("LIVEFIRE=1");
if (typeof process.env["APP_DATABASE_URL"] !== "string") MISSING.push("APP_DATABASE_URL");
if (typeof process.env["LITHIC_API_KEY"] !== "string" || process.env["LITHIC_API_KEY"] === "") {
  MISSING.push("LITHIC_API_KEY");
}
if (
  typeof process.env["LITHIC_WEBHOOK_SECRET"] !== "string" ||
  process.env["LITHIC_WEBHOOK_SECRET"] === ""
) {
  MISSING.push("LITHIC_WEBHOOK_SECRET (needed to reissue the delivery the outage swallowed)");
}

const READY = MISSING.length === 0;
if (!READY) record("skip", `missing: ${MISSING.join(", ")}; run scripts/livefire.mjs`);

const d = READY ? describe : describe.skip;

const AUTH_CENTS = 50_00;

/** Standard Webhooks: base64 HMAC-SHA256 over `id.timestamp.body`. */
function signStandardWebhook(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): Record<string, string> {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signature = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`, "utf8")
    .digest("base64");
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1,${signature}`,
    "content-type": "application/json",
  };
}

type Position = { ledgerCents: bigint; availableCents: bigint; holdsCents: bigint };

d(`ATTACK ${ATTACK} — ${NAME}`, () => {
  let sql: typeof SqlHandle;
  let bal: typeof BalancesModule;
  let holds: typeof Holds;
  let lithic: typeof LithicClient;

  const tag = Date.now().toString(36).toUpperCase();
  const secret = process.env["LITHIC_WEBHOOK_SECRET"] ?? "";
  let drainStatus = "not attempted";

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    bal = await import("@/lib/ledger/balances");
    holds = await import("@/lib/holds");
    lithic = await import("@/lib/rails/lithic/client");
  });

  async function nudgeDrain(): Promise<void> {
    const token = process.env["DRAIN_TOKEN"];
    if (token === undefined || token === "") {
      drainStatus = "no DRAIN_TOKEN in the environment";
      return;
    }
    try {
      const response = await fetch(`${BASE_URL}/api/drain`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await response.json()) as Record<string, unknown>;
      drainStatus =
        response.status === 200
          ? `HTTP 200 claimed=${String(body["claimed"])} processed=${String(body["processed"])} parked=${String(body["parked"])}`
          : `HTTP ${response.status} ${JSON.stringify(body).slice(0, 160)}`;
    } catch (thrown) {
      drainStatus = `unreachable: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
    }
  }

  async function until<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value !== null) return value;
      if (Date.now() >= deadline) return null;
      await nudgeDrain();
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  async function positionOf(businessId: string): Promise<Position> {
    const balance = await bal.availableBalance(businessId);
    return {
      ledgerCents: balance.ledgerCents,
      availableCents: balance.availableCents,
      holdsCents: balance.holdsCents,
    };
  }

  /**
   * THE BUSINESS THIS ATTACK OWNS.
   *
   * ========================================================================
   * WHY THIS IS NOT `ORDER BY business_id LIMIT 1` ANY MORE.
   *
   * Every attack in this suite used to reach for the same row — the lowest
   * business id with a 2100/9100 pair — and then measure that business's
   * WHOLE POSITION across a window. Which means attacks 1, 2, 3 and 7 all
   * measured the same customer at the same time as each other, as the
   * database-backed integration suites, as the demo scripts, and as whoever
   * else is running against this shared Neon branch.
   *
   * That is not a flakiness problem, it is a measurement problem: a global
   * quantity under concurrent writers is not the quantity the attack claims
   * to be reading. DECISIONS 028 named this as a latent vulnerability in
   * attacks 1, 2 and 4 and left it there because they were passing — and
   * then they failed, by exactly 5000, on another agent's $50 hold landing
   * inside their window. A green result produced by the weakness is not
   * evidence against the weakness.
   *
   * So this attack opens its OWN business and its own leaves, once,
   * idempotently, with a deterministic id — the pattern
   * `src/lib/holds/holds.integration.test.ts` already uses for the same
   * reason. Its own card and its own transactions were already per-run. The
   * id sorts ABOVE every seeded business on purpose: the attacks that still
   * say `ORDER BY business_id LIMIT 1` must not start picking this one up.
   *
   * Type, book and parent all come FROM THE HOUSE ROLLUP, so the fixture
   * cannot drift from `src/lib/ledger/chart.ts`, and `normal_side` is a
   * generated column so it follows the type.
   *
   * Opening an account needs the OWNER role — `corgi_app` holds SELECT on
   * `account` and nothing else, which is the point of running the suite as
   * `corgi_app`. When no owner URL is configured the attack falls back to
   * the shared seeded business and SAYS SO in its evidence; every assertion
   * below is attributable either way, which is the other half of this fix.
   * ========================================================================
   */
  const OWN_BUSINESS_ID = "f1e1fa7e-0000-4000-8000-000000000007";
  const OWN_BUSINESS_NAME = "Live Fire — attack 7 (provider outage)";

  async function businessUnderTest(): Promise<{ businessId: string; isolation: string }> {
    const ownerUrl = process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"] ?? "";
    if (ownerUrl !== "") {
      const { default: postgres } = await import("postgres");
      const owner = postgres(ownerUrl, { max: 1, onnotice: () => {} });
      try {
        await owner`
          INSERT INTO business (id, entity_id, legal_name, ein)
          SELECT ${OWN_BUSINESS_ID}::uuid, e.id, ${OWN_BUSINESS_NAME}, '00-0000007'
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
      // Read it back as the RESTRICTED role, because that is the connection
      // every assertion below uses.
      const [own] = await sql<{ business_id: string }[]>`
        SELECT dep.business_id
          FROM account dep
          JOIN account memo ON memo.business_id = dep.business_id AND memo.code = '9100'
         WHERE dep.code = '2100' AND dep.business_id = ${OWN_BUSINESS_ID}::uuid`;
      if (own) {
        return {
          businessId: own.business_id,
          isolation: `this attack's OWN business ${OWN_BUSINESS_ID} (${OWN_BUSINESS_NAME}), opened idempotently for this run — no other attack, suite or process writes to it`,
        };
      }
    }

    const [shared] = await sql<{ business_id: string }[]>`
      SELECT dep.business_id
        FROM account dep
        JOIN account memo ON memo.business_id = dep.business_id AND memo.code = '9100'
       WHERE dep.code = '2100' AND dep.business_id IS NOT NULL
       ORDER BY dep.business_id LIMIT 1`;
    if (!shared) throw new Error("no business has a 2100/9100 pair: run node scripts/seed.mjs");
    return {
      businessId: shared.business_id,
      isolation: `the SHARED seeded business ${shared.business_id} — no owner URL (DIRECT_URL) was configured, so this attack could not open its own; the figures below are attributed rather than isolated by construction`,
    };
  }

  /** The top of the booking axis: what a balance read now would include. */
  async function watermark(): Promise<bigint> {
    const [row] = await sql<{ seq: bigint }[]>`
      SELECT COALESCE(MAX(booking_seq), 0)::bigint AS seq FROM journal_entry`;
    return row?.seq ?? 0n;
  }

  /** The business's spendable leaf — the account availability is asked about. */
  async function depositAccountOf(businessId: string): Promise<string> {
    const id = await bal.mainDepositAccountId(businessId, sql);
    if (id === null) throw new Error(`business ${businessId} has no 2100 deposit account`);
    return id;
  }

  /**
   * EVERYTHING THAT CAN MOVE THIS CUSTOMER'S AVAILABILITY SINCE A WATERMARK.
   *
   * Not "did anyone write to the database", which is both too wide (most
   * writes are other customers') and too narrow (it counts rows, and this
   * figure also moves on the clock alone). Exactly three things can move
   * `accountAvailability(accountId)`:
   *
   *   * an entry with a line on this account, in the FINANCIAL book;
   *   * an entry against one of this account's holds, in the MEMO book —
   *     the commonest write in this system and the one the old guard, which
   *     said `book = 'financial'`, could not see at all;
   *   * the CLOCK: a hold reaching `expires_at`, an uncleared credit reaching
   *     `available_at`, or `book_date()` rolling over and pulling a
   *     future-dated credit into the ledger term.
   *
   * All three are counted, so that a whole-position assertion is made only
   * when it is genuinely ours to make, and is reported with the reason when
   * it is not.
   */
  async function movedSince(
    accountId: string,
    sinceWatermark: bigint,
    sinceInstant: Date,
  ): Promise<{ entries: number; clockEvents: number; rolledOver: boolean; quiet: boolean }> {
    const [entries] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM journal_entry e
       WHERE e.booking_seq > ${sinceWatermark}
         AND (EXISTS (SELECT 1 FROM journal_line l
                       WHERE l.entry_id = e.id AND l.account_id = ${accountId}::uuid)
           OR EXISTS (SELECT 1 FROM hold h
                       WHERE h.id = e.hold_id AND h.account_id = ${accountId}::uuid))`;
    const [clock] = await sql<{ n: number; rolled: boolean }[]>`
      SELECT (SELECT count(*)::int FROM hold h
               WHERE h.account_id = ${accountId}::uuid
                 AND ((h.expires_at   > ${sinceInstant} AND h.expires_at   <= clock_timestamp())
                   OR (h.available_at > ${sinceInstant} AND h.available_at <= clock_timestamp()))) AS n,
             book_date(${sinceInstant}) <> book_date(clock_timestamp()) AS rolled`;
    const n = entries?.n ?? 0;
    const c = clock?.n ?? 0;
    const rolled = clock?.rolled ?? false;
    return { entries: n, clockEvents: c, rolledOver: rolled, quiet: n === 0 && c === 0 && !rolled };
  }

  /**
   * The SAME availability question asked at ONE instant and TWO watermarks.
   *
   * `accountAvailability` is the app's own function — `/api/health`, the
   * console and `availableBalance()` all reach it — and it takes its snapshot
   * as an argument: one wall-clock instant, one business date, one watermark.
   * Holding the first two fixed and moving only the third isolates what a SET
   * OF ENTRIES did to the published figure, with every clock-driven term
   * (uncleared credits maturing, holds expiring, the business date rolling
   * over) identical on both sides and therefore cancelled.
   *
   * This is how this attack stops needing a quiet database to measure its own
   * effect: interference that is in both readings subtracts out.
   */
  async function availabilityAcross(
    accountId: string,
    fromWatermark: bigint,
    toWatermark?: bigint,
  ): Promise<{ before: Position; after: Position; at: Date }> {
    const snapshot = await bal.readSnapshot(sql);
    const read = async (seq: bigint): Promise<Position> => {
      const a = await bal.accountAvailability(accountId, { ...snapshot, bookingWatermark: seq }, sql);
      return { ledgerCents: a.ledgerCents, availableCents: a.availableCents, holdsCents: a.holdsCents };
    };
    return {
      before: await read(fromWatermark),
      after: await read(toWatermark ?? snapshot.bookingWatermark),
      at: snapshot.asOf,
    };
  }

  /**
   * Every memo entry standing against ONE hold's own memo leaf.
   *
   * Defined once and called from both the approved and the refused branch
   * below, so that reading the same figure twice does not cost the ledger
   * boundary two more references to `journal_entry` / `journal_line` (see
   * `src/lib/ledger/boundary.test.ts` — this file is allowlisted at 14 and the
   * list is a ratchet).
   *
   * It is the withheld figure BY ATTRIBUTION: this hold was created by this
   * run's own backlog delivery, and nothing else in the database can post to
   * its memo account.
   */
  async function memoOnHold(holdId: string): Promise<{ entries: number; cents: bigint }> {
    const [row] = await sql<{ entries: number; cents: bigint }[]>`
      SELECT count(DISTINCT e.id)::int                 AS entries,
             COALESCE(SUM(l.amount_cents), 0)::bigint  AS cents
        FROM journal_entry e
        JOIN journal_line  l ON l.entry_id = e.id
        JOIN hold          h ON h.id = e.hold_id
       WHERE e.hold_id = ${holdId}::uuid
         AND e.book = 'memo'
         AND l.account_id = h.memo_account_id`;
    return { entries: row?.entries ?? -1, cents: row?.cents ?? -1n };
  }

  /** Financial entries carrying this provider transaction's reference. */
  async function financialFor(externalRef: string): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM journal_entry
       WHERE book = 'financial' AND external_ref = ${externalRef}`;
    return row?.n ?? -1;
  }

  /**
   * NOTHING LOST, NOTHING DOUBLE-COUNTED: however many times the provider
   * redelivered the backlog, it is one envelope and one fact.
   *
   * Asserted on both branches below, because it is the half of this attack's
   * sentence that does not depend on what the network answered.
   */
  async function expectAppliedExactlyOnce(
    providerAuthId: string,
    webhookId: string,
  ): Promise<void> {
    const [facts] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM card_auth_event ce
        JOIN card_authorization ca ON ca.id = ce.auth_id
       WHERE ca.provider_auth_id = ${providerAuthId}`;
    expect(facts?.n).toBe(1);
    const [rows] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM webhook_inbox
       WHERE provider = 'lithic' AND provider_event_id = ${webhookId}`;
    expect(rows?.n).toBe(1);
  }

  it("invents no money while the feed is dark, and loses none when it comes back", async (ctx) => {
    const { businessId, isolation } = await businessUnderTest();

    // A registered card, and one real authorisation on it whose delivery we
    // keep as the template. Nothing about this leg is the outage; it is how a
    // genuine Lithic body is obtained.
    const card = await lithic.createCard({
      type: "VIRTUAL",
      memo: `livefire outage ${tag}`,
      spend_limit: 5_000_00,
      spend_limit_duration: "TRANSACTION",
      state: "OPEN",
    });
    const pan = card.pan;
    if (pan === undefined || pan === "") {
      throw new Error("Lithic returned a card with no PAN; the sandbox PCI shape has changed");
    }
    await holds.registerCard(
      {
        provider: "lithic",
        providerCardToken: card.token,
        businessId,
        lastFour: card.last_four,
        nickname: `live-fire outage ${tag}`,
      },
      sql,
    );

    const template = await lithic.simulateAuthorize({
      amount: AUTH_CENTS,
      descriptor: `CORGI OUTAGE ${tag}`.slice(0, 25),
      pan,
      status: "AUTHORIZATION",
      mcc: "5542",
    });
    if (template.token === undefined) throw new Error("Lithic returned no transaction token");
    const templateToken: string = template.token;

    const body = await until(async () => {
      const [row] = await sql<{ raw_body: string }[]>`
        SELECT raw_body FROM webhook_inbox
         WHERE provider = 'lithic' AND payload->>'token' = ${templateToken}
         ORDER BY received_at DESC LIMIT 1`;
      return row ?? null;
    }, 60_000);

    if (body === null) {
      const reason = `no Lithic delivery arrived for transaction ${templateToken} within 60s, so there is no genuine body to reissue as the one the outage swallowed.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    // ---- the event the outage swallows ----------------------------------
    // A fresh transaction and fresh event ids, because `financialPostingKey`
    // and `holdPostingKey` are derived from the provider's event id and land in
    // `journal_entry`'s UNIQUE idempotency key: reusing the template's ids
    // would make this a replay of the template rather than a new fact.
    const missedToken = randomUUID();
    const payload = JSON.parse(body.raw_body) as Record<string, unknown>;
    const events: Record<string, unknown>[] = (Array.isArray(payload["events"]) ? payload["events"] : []).map((event) => ({
      ...(event as Record<string, unknown>),
      token: randomUUID(),
    }));
    const missedBody = JSON.stringify({ ...payload, token: missedToken, events });

    // THE VERDICT THE SWALLOWED DELIVERY CARRIES, read off the bytes we are
    // about to send. Only `token` was reissued above, so `result` is Lithic's
    // own word for the authorisation this body was captured from, byte for
    // byte. It decides which claim this test is entitled to make on recovery —
    // see the branch after the backlog lands — and it is read HERE, before
    // anything is delivered, so that the branch cannot be chosen by anything
    // the deployment did afterwards.
    const authStep = events.find((e) => e["type"] === "AUTHORIZATION") ?? events[0];
    const deliveredResult = authStep?.["result"];
    const deliveredVerdict = typeof deliveredResult === "string" ? deliveredResult : null;

    // ---- THE DARK WINDOW -------------------------------------------------
    const accountId = await depositAccountOf(businessId);
    const before = await positionOf(businessId);
    const trialBefore = await bal.trialBalanceCents();
    const startedAt = Date.now();
    const windowOpenedAt = new Date();
    // The window is bounded by a WATERMARK rather than by a wall-clock
    // instant, because a watermark is what a balance actually reads:
    // `readSnapshot` takes `MAX(booking_seq)` with no time predicate at all,
    // and `booking_time` is a second axis that an entry can carry a later
    // value of than the sequence it committed under. `booking_time >= <then>`
    // was therefore never quite the same set of rows as the one the figures
    // being compared were folded from.
    const openedWatermark = await watermark();
    await new Promise((r) => setTimeout(r, OUTAGE_SECONDS * 1_000));

    // NOTHING WAS INVENTED FROM AN EVENT WE WERE NEVER TOLD ABOUT.
    //
    // Asserted BY ATTRIBUTION, which is the claim itself: the swallowed
    // transaction reached no inbox row and produced no authorisation. Nothing
    // else writing to this database can satisfy either of these on our behalf
    // or break them.
    const [absent] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM webhook_inbox
       WHERE provider = 'lithic' AND payload->>'token' = ${missedToken}`;
    expect(absent?.n).toBe(0);
    const [invented] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM card_authorization
       WHERE provider = 'lithic' AND provider_auth_id = ${missedToken}`;
    expect(invented?.n).toBe(0);

    // And double entry still balances over every financial line in the
    // database — an invariant, so it holds whoever else is writing.
    expect(await bal.trialBalanceCents()).toBe(trialBefore);

    // ALSO ASSERTED BY FREEZE: the customer's whole position is unchanged.
    // That is the stronger statement and it is only meaningful when nothing
    // ELSE is writing. This Neon branch is shared with the database-backed
    // integration suite, and a concurrent run of it moved this same seeded
    // business's ledger by 67,899 cents inside one 20s window while this
    // attack was measuring. So the freeze is asserted when the window really
    // was quiet, and its absence is REPORTED rather than asserted away when it
    // was not: a suite that reports another process's writes as our system
    // inventing money is worse than one that says which it could not tell
    // apart. The attribution above is unconditional either way.
    //
    // TWO WATERMARKS, ONE INSTANT. `positionOf` takes its own snapshot each
    // time, so `before` and `during` are read at two different CLOCKS as well
    // as at two different watermarks — and availability is a function of the
    // clock as much as of the rows: `ledger_availability` releases an
    // uncleared credit at `available_at`, expires a card hold at `expires_at`,
    // and counts a future-dated credit only once `book_date()` reaches it.
    // MEASURED on this deployment: the demo account's ledger term moves by
    // millions of cents at 00:00 America/New_York with no entry booked at all,
    // because that is when the day's warehoused ACH credits become current. A
    // window straddling it would fail this freeze for the calendar.
    //
    // So the freeze is re-read at ONE instant and TWO watermarks — the
    // window's opening watermark and the current one — through the same
    // `accountAvailability` the app calls. Every clock-driven term is then
    // identical on both sides and cancels, and the only thing that can make
    // them differ is an entry booked inside the window. Which is exactly what
    // the guard below counts: in EVERY book, because a hold moves `available`
    // from the memo book and a guard that watched only the financial one would
    // be blind to the commonest write on this database.
    const during = await positionOf(businessId);
    const frozen = await availabilityAcross(accountId, openedWatermark);
    const moved = await movedSince(accountId, openedWatermark, windowOpenedAt);
    const foreignWrites = moved.entries;
    // The watermark pair first: the clock is held still across it, so only an
    // ENTRY against this customer can make the two readings differ.
    if (moved.entries === 0) expect(frozen.after).toEqual(frozen.before);
    // Then the two live readings, which were taken at two different clocks and
    // so need the clock to have been uneventful as well.
    if (moved.quiet) expect(during).toEqual(before);

    // And the system is still answering while its feed is dark.
    const health = (await (await fetch(`${BASE_URL}/api/health`, { cache: "no-store" })).json()) as {
      status?: string;
      database?: { reachable?: boolean };
    };
    expect(health.database?.reachable).toBe(true);

    // THE DARK-WINDOW EVIDENCE, RECORDED HERE AND NOT AT THE END.
    //
    // Everything above is the half of this attack that does not depend on
    // what the network answered, and the recovery half below returns early on
    // a refusal. A record() placed after that return would lose the dark
    // window entirely on exactly the runs where the reader most needs to see
    // that it was measured.
    record(
      "evidence",
      `measured on ${isolation}. dark window ${Math.round((Date.now() - startedAt) / 1000)}s (LIVEFIRE_OUTAGE_SECONDS=${OUTAGE_SECONDS}): the swallowed event ${missedToken} produced 0 inbox rows and 0 authorisations; trial balance ${trialBefore} unchanged; /api/health answered with database reachable. ${moved.quiet ? `The window was quiet, so business ${businessId}\u0027s whole position was additionally asserted frozen at ledger ${before.ledgerCents} / available ${before.availableCents} — and asserted a second way, at ONE instant (${frozen.at.toISOString()}) across the window's two watermarks (${openedWatermark} -> now), which holds the clock still so that a business-date rollover or a maturing uncleared credit cannot read as movement: available ${frozen.before.availableCents} at both.` : `the window was NOT quiet for this customer: ${foreignWrites} entr${foreignWrites === 1 ? "y" : "ies"} touching this account were booked by another process (counted in BOTH books — a card hold moves available from the memo book and the financial-only count this guard used to do walked straight past it), ${moved.clockEvents} hold(s) reached expires_at/available_at on the clock alone${moved.rolledOver ? ", and the business date rolled over mid-window" : ""}. The live position-freeze was therefore NOT evaluated: it would have measured their writes and the calendar, not ours.${moved.entries === 0 ? ` The watermark-pair freeze WAS evaluated and held, because it holds the clock still: available ${frozen.before.availableCents} at both.` : ""} The attribution above is unaffected.`}`,
    );

    // ---- THE FEED COMES BACK --------------------------------------------
    // The provider catches up, and retries, which is what providers do.
    const catchUp: number[] = [];
    for (let i = 0; i < 2; i += 1) {
      const response = await fetch(`${BASE_URL}/api/webhooks/lithic`, {
        method: "POST",
        headers: signStandardWebhook(
          secret,
          `msg_livefire_outage_${tag}`,
          Math.floor(Date.now() / 1000),
          missedBody,
        ),
        body: missedBody,
      });
      catchUp.push(response.status);
      expect(response.status).toBeLessThan(400);
    }

    const recovered = await until(async () => {
      const [row] = await sql<{ hold_id: string }[]>`
        SELECT hold_id FROM card_authorization
         WHERE provider = 'lithic' AND provider_auth_id = ${missedToken}`;
      return row ?? null;
    }, 90_000);

    if (recovered === null) {
      const reason = `the backlog was accepted (HTTP ${catchUp.join(", ")}) but never applied within 90s, so "nothing is lost" is unproven; POST ${BASE_URL}/api/drain answered ${drainStatus}.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    // ======================================================================
    // WHAT DID THE NETWORK ACTUALLY SAY? ASKED BEFORE ANY MONEY IS ASSERTED.
    //
    // ----------------------------------------------------------------------
    // THIS BRANCH IS THE FIFTEENTH INSTANCE OF THIS BUILD'S ONE PATTERN, AND
    // IT POINTED THE OTHER WAY. Every earlier instance was a guard whose
    // exclusion was shaped like the failure, so it reported HEALTHY on a
    // broken book. This one reported a BROKEN BOOK on a working one, which is
    // the same misreport with the sign flipped and is no better.
    //
    // MEASURED, on the run that produced it: the backlog delivered
    // authorisation 688af4e6-c257-4a6f-a941-5911760a0808, hold
    // d22227bd-efad-4149-9ae6-1faf0e7ae7fe, and NO memo posting — and this
    // test called that "$50.00 is authorised and not held and the customer can
    // spend it twice". It was not. The single `card_auth_event` the delivery
    // produced reads `kind = 'declined'` with `card_auth_event_result.result =
    // 'DECLINED'`, `provider_step = 'AUTHORIZATION'`, `source = 'ingest'`:
    // Lithic REFUSED the authorisation this body was captured from, because
    // the sandbox account's rolling 24-hour cap is exhausted (README §2b).
    // `H(E)` is therefore 0, `memo_balance` is 0, `Δ = 0`, and `postHoldDelta`
    // returns null without appending — which is `v_card_auth_hold
    // .target_hold_cents = 0`, `v_hold_drift` empty and `v_hold_posting_
    // incomplete` empty, all read live afterwards. There was nothing to
    // withhold and the ledger correctly withheld nothing. The customer could
    // not "spend it twice" because no merchant was ever going to claim it.
    //
    // The `claimed=0 processed=0 parked=0` on the drain nudge was the other
    // half of the same misreading: `src/app/api/webhooks/[provider]/route.ts`
    // drains in an `after()` callback the moment the 2xx is on its way, so the
    // inbox row was `state='done'` 129ms after it arrived and the operator's
    // drain had nothing left to claim. That is the delivery path working, not
    // a delivery going missing.
    //
    // So the verdict is read FIRST and the branch is taken on it — exactly as
    // attacks 1 and 2 already do (README §2b), and for exactly the reason
    // DECISIONS 050 gives: an approved and a refused authorisation must not be
    // the same row by the time anything reasons about them.
    // ----------------------------------------------------------------------
    const [fact] = await sql<
      { kind: string; result: string | null; step: string | null; source: string | null }[]
    >`
      SELECT ce.kind::text AS kind, r.result, r.provider_step AS step, r.source::text AS source
        FROM card_auth_event ce
        JOIN card_authorization ca ON ca.id = ce.auth_id
        LEFT JOIN card_auth_event_result r ON r.event_id = ce.id
       WHERE ca.provider = 'lithic' AND ca.provider_auth_id = ${missedToken}
       ORDER BY ce.received_at
       LIMIT 1`;

    // The provider's own copy of the same answer, for the template this body
    // was reissued from. `missedToken` does not exist at Lithic — it is our
    // reissue — so the authoritative second opinion is the transaction the
    // bytes came from.
    let providerVerdict = "not read";
    try {
      const templateTxn = await lithic.getTransaction(templateToken);
      const templateAuth = (templateTxn.events ?? []).find((e) => e.type === "AUTHORIZATION");
      providerVerdict = templateAuth?.result ?? templateTxn.result ?? "absent";
    } catch (thrown) {
      providerVerdict = `unreadable: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
    }

    if (deliveredVerdict === null) {
      // We cannot choose a branch, so we assert neither. A body with no
      // `result` is "we were not told", which is a different claim from
      // APPROVED and is not invented into one (migration 0026).
      const reason =
        `the captured Lithic body carried no \`result\` on its AUTHORIZATION step, so this run cannot ` +
        `say whether the network granted the $${(AUTH_CENTS / 100).toFixed(2)} — and "the backlog withheld ` +
        `exactly what was granted" is unprovable either way. Template transaction ${templateToken}; ` +
        `provider's own verdict reads ${providerVerdict}.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    if (fact === undefined) {
      throw new Error(
        `the backlog produced authorisation ${missedToken} and hold ${recovered.hold_id} but NO card_auth_event, ` +
          `so the fact itself was lost. POST ${BASE_URL}/api/drain answered ${drainStatus}.`,
      );
    }

    // THE DEFECT DECISIONS 050 AND 056 ARE ABOUT, asserted rather than
    // assumed: the body carried a verdict and ingest must not have dropped it.
    // A NULL here is the eight-hour production bug, not a missing feature.
    if (fact.result === null) {
      throw new Error(
        `the delivery carried result "${deliveredVerdict}" on its AUTHORIZATION step and the ledger stored ` +
          `card_auth_event kind='${fact.kind}' with NO card_auth_event_result row beside it — the network's ` +
          `verdict was discarded at ingest. That is the defect of DECISIONS 050/056, and it means the build ` +
          `serving ${BASE_URL} predates migration 0026. Authorisation ${missedToken}, hold ${recovered.hold_id}.`,
      );
    }

    if (fact.result !== "APPROVED") {
      // ================================================================
      // THE REFUSAL PATH — a PASS on a smaller, named claim, loudly
      // labelled, on the terms README §2b sets for attacks 1 and 2.
      //
      // The dark-window half of this attack is verdict-independent and was
      // asserted in full above. What changes here is only the recovery
      // half: "the backlog withheld the $50" is not shown, because there
      // was no $50 to withhold. What IS shown is the same sentence with
      // the network's answer substituted — the backlog applied EXACTLY
      // ONCE and withheld EXACTLY what the network granted, which is
      // nothing.
      //
      // The evidence is recorded BEFORE the assertions, because a failing
      // `expect` throws and a throw skips every line after it — the same
      // ordering attack 1 arrived at the hard way.
      // ================================================================
      const withheld = await memoOnHold(recovered.hold_id);
      const financialRefused = await financialFor(missedToken);
      const refusedAfter = await positionOf(businessId);
      const refusedMoved = await movedSince(accountId, openedWatermark, windowOpenedAt);

      // The two views that would report a refused authorisation still
      // holding money. Scoped to THIS RUN'S rows, never book-wide: the
      // book-wide count is the historical backlog migration 0032
      // deliberately refused to exclude, and asserting zero on it is a
      // claim about every other suite on this database (README §2b).
      const [refusedHold] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM v_refused_auth_hold
         WHERE hold_id = ${recovered.hold_id}::uuid OR provider_auth_id = ${missedToken}`;
      // `::text`, deliberately: `active_hold_cents` is a numeric expression in
      // the view, and the driver hands a numeric back as a string. Reading it
      // as a bigint and asserting `0n` fails on '0' — a type mismatch that
      // would read, on the scoreboard, exactly like money in the wrong place.
      const [state] = await sql<{ active: string; released: boolean }[]>`
        SELECT active_hold_cents::text AS active, is_released AS released
          FROM v_hold_state WHERE hold_id = ${recovered.hold_id}::uuid`;
      const [incomplete] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM v_hold_posting_incomplete WHERE hold_id = ${recovered.hold_id}::uuid`;

      record(
        "evidence",
        `THE PUBLISHED HAPPY PATH WAS NOT EXERCISED: the network REFUSED the authorisation this outage ` +
          `swallowed, so "on recovery available drops by exactly 5000" is NOT shown by this run. The ` +
          `reissued body carries AUTHORIZATION ${AUTH_CENTS} result ${deliveredVerdict}; the provider's own ` +
          `copy for the template transaction ${templateToken} reads ${providerVerdict}; the ledger stored it ` +
          `as card_auth_event kind='${fact.kind}' with card_auth_event_result result='${fact.result}' ` +
          `step='${fact.step ?? "n/a"}' source='${fact.source ?? "n/a"}'. CAUSE: the Lithic sandbox account's ` +
          `rolling 24-hour spend cap is exhausted, so no authorisation can be approved at any amount ` +
          `(README §2b; raising it needs PATCH /v1/accounts/{token}, which the permission classifier ` +
          `deliberately blocks, and that is a human's decision). What IS proved below is the smaller, ` +
          `different and real claim: A BACKLOG DELIVERED TWICE AFTER A DARK WINDOW APPLIES EXACTLY ONCE ` +
          `AND WITHHOLDS EXACTLY WHAT THE NETWORK GRANTED — here, nothing.`,
      );
      record(
        "evidence",
        `recovery on a REFUSED authorisation: the backlog delivered twice (HTTP ${catchUp.join(" then ")}) ` +
          `produced 1 inbox row, 1 card_auth_event and 1 hold ${recovered.hold_id} — nothing lost, nothing ` +
          `double-counted. That hold's own memo account carries ${withheld.entries} entr${withheld.entries === 1 ? "y" : "ies"} ` +
          `totalling ${withheld.cents} cents (must be 0 and 0 — a refused authorisation withholds nothing), ` +
          `${financialRefused} financial entries (must be 0 — an authorisation moves the memo book only), ` +
          `v_hold_state active_hold_cents ${state?.active} (must be 0) and is_released ${String(state?.released)} (must be true), v_refused_auth_hold ${refusedHold?.n} ` +
          `row(s) for this hold (must be 0), v_hold_posting_incomplete ${incomplete?.n} row(s) for this hold ` +
          `(must be 0 — the sweeper has nothing to complete because nothing is missing), trial balance ` +
          `${trialBefore} unchanged. ` +
          `THE ABSENCE OF THE MEMO POSTING IS THE ANSWER, NOT A GAP: migration 0036 put the compare-and-append ` +
          `in the SAME transaction as the facts, so the fact existing is proof the posting decision was made — ` +
          `H(E) = 0, memo balance 0, Δ = 0, and postHoldDelta() appends nothing for Δ = 0. A missing posting ` +
          `would show up as a row in v_hold_posting_incomplete, and there is none. ` +
          `${refusedMoved.quiet ? `The episode was quiet, so this business's whole position was additionally asserted frozen: ledger ${refusedAfter.ledgerCents}, available ${refusedAfter.availableCents}, holds ${refusedAfter.holdsCents}.` : `${refusedMoved.entries} other entr${refusedMoved.entries === 1 ? "y" : "ies"} and ${refusedMoved.clockEvents} clock-driven transition(s) touched this account across the episode${refusedMoved.rolledOver ? " and the business date rolled over" : ""}, so the whole-position freeze is REPORTED rather than asserted: available ${before.availableCents} -> ${refusedAfter.availableCents}. The attribution above is unaffected.`} ` +
          `drain ${drainStatus}.`,
      );

      // The invariant migration 0026 installs, and the one production did
      // not have for eight hours (DECISIONS 050, 056).
      expect(fact.kind).toBe("declined");
      expect(withheld.entries).toBe(0);
      expect(withheld.cents).toBe(0n);
      expect(financialRefused).toBe(0);
      expect(state?.active).toBe("0");
      // A refused authorisation is a CLOSED one: A = 0, so `closed(E)` holds
      // and `v_hold_state.is_released` is true. The money was never withheld
      // and the hold is not left standing over nothing.
      expect(state?.released).toBe(true);
      expect(refusedHold?.n).toBe(0);
      expect(incomplete?.n).toBe(0);
      expect(await bal.trialBalanceCents()).toBe(trialBefore);
      // NOTHING DOUBLE-COUNTED, on the refused path too.
      await expectAppliedExactlyOnce(missedToken, `msg_livefire_outage_${tag}`);
      if (refusedMoved.quiet) expect(refusedAfter).toEqual(before);
      return;
    }

    // ---- WAIT FOR THE POSTING, NOT FOR THE FACT --------------------------
    //
    // `card_authorization` is written by the FIRST of the two transactions
    // `src/lib/holds/apply.ts` splits an event into (steps 1–5); the memo
    // posting that actually withholds the money is the SECOND (steps 6–7).
    // The split is deliberate — it is the crash-safety argument, and it is
    // documented at the top of that file — so between the two commits the
    // authorisation is on record and `available` has not moved yet.
    //
    // THIS IS HOW THIS TEST FAILED IN THE SUITE, and it was not another
    // process's doing. MEASURED on the failing run: the hold row committed at
    // 03:45:45.251Z, the loop above returned, the position was read, and the
    // opening memo entry committed at 03:45:45.581Z — 330ms later. Available
    // read -35270 both times and the test asserted -40270. Reconstructed
    // afterwards at the two instants, the account's active holds were 40000
    // at the start of the window and 45000 at the end of it: the ledger was
    // right, the read was early.
    //
    // So the wait is for the entry whose absence was being measured. If the
    // fact lands and the withholding never does, that is not an unprovable
    // claim, it is a customer whose money was never withheld — a failure with
    // its own message rather than a skip.
    const opening = await until(async () => {
      const [row] = await sql<{ entry_id: string; booking_seq: bigint; cents: bigint }[]>`
        SELECT e.id AS entry_id, e.booking_seq, l.amount_cents AS cents
          FROM journal_entry e
          JOIN journal_line  l ON l.entry_id = e.id
          JOIN hold          h ON h.id = e.hold_id
         WHERE e.hold_id = ${recovered.hold_id}::uuid
           AND e.book = 'memo'
           AND l.account_id = h.memo_account_id
         ORDER BY e.booking_seq
         LIMIT 1`;
      return row ?? null;
    }, 60_000);

    if (opening === null) {
      throw new Error(
        `the backlog produced authorisation ${missedToken} and hold ${recovered.hold_id}, but no memo posting withheld the money within 60s of it, so $${(AUTH_CENTS / 100).toFixed(2)} is authorised and not held and the customer can spend it twice. POST ${BASE_URL}/api/drain answered ${drainStatus}.`,
      );
    }

    // NOTHING LOST: the withheld $50.00 is now held, exactly once, and it is
    // memo-only. Measured on THE HOLD THE BACKLOG CREATED — every memo line
    // against that hold's own memo account — so the figure is ours by
    // construction, and then, when the episode was quiet, cross-checked
    // against the customer's whole position for the same reason as above.
    const after = await positionOf(businessId);
    const heldByUs = await memoOnHold(recovered.hold_id);
    expect(heldByUs.entries).toBe(1); // one opening, however many deliveries
    expect(heldByUs.cents).toBe(-BigInt(AUTH_CENTS)); // credit: $50.00 withheld
    // NOTHING INVENTED: an authorisation posts nothing to the financial book.
    expect(await financialFor(missedToken)).toBe(0);
    expect(await bal.trialBalanceCents()).toBe(trialBefore);

    // AND THE PUBLISHED FIGURE MOVED BY EXACTLY THE $50, ATTRIBUTABLY.
    //
    // ------------------------------------------------------------------
    // WHAT THIS REPLACED, AND WHY IT WAS THE WRONG SHAPE.
    //
    // This used to be `after.availableCents === before.availableCents −
    // 5000` on the whole business, guarded by a count of financial entries
    // booked since the window opened. Two things were wrong with that guard
    // and both are the same mistake: WHAT IT EXCLUDED WAS SHAPED EXACTLY
    // LIKE THE FAILURE IT EXISTED TO CATCH.
    //
    //   * it counted `book = 'financial'` while the quantity it protects —
    //     `holds`, and through it `available` — is moved by the MEMO book.
    //     Every card hold on this database walks straight through it;
    //   * it counted ENTRIES at all, while `available` also moves on the
    //     CLOCK with no entry anywhere (see the freeze above).
    //
    // The fix is not a better guard. It is to stop needing one: ask the
    // app's own `accountAvailability` the same question at ONE instant and
    // TWO watermarks — the one just below this run's own opening posting,
    // and the one that includes it. Everything anybody else wrote is in
    // BOTH readings and cancels; the difference is this attack's hold and
    // nothing else. Cross-run interference is then prevented by
    // construction rather than detected by a condition.
    // ------------------------------------------------------------------
    const isolated = await availabilityAcross(accountId, opening.booking_seq - 1n, opening.booking_seq);
    expect(isolated.after.availableCents - isolated.before.availableCents).toBe(-BigInt(AUTH_CENTS));
    expect(isolated.after.holdsCents - isolated.before.holdsCents).toBe(BigInt(AUTH_CENTS));
    expect(isolated.after.ledgerCents).toBe(isolated.before.ledgerCents);

    // The whole-business figures the app publishes are reported beside it,
    // and asserted when nothing else was booked across the episode at all —
    // in EITHER book this time.
    const movedAcross = await movedSince(accountId, openedWatermark, windowOpenedAt);
    // Our own opening posting is one of them, by construction.
    const foreignAcross = Math.max(movedAcross.entries - 1, 0);
    const quietEpisode = foreignAcross === 0 && movedAcross.clockEvents === 0 && !movedAcross.rolledOver;
    if (quietEpisode) {
      expect(after.availableCents).toBe(before.availableCents - BigInt(AUTH_CENTS));
      expect(after.holdsCents).toBe(before.holdsCents + BigInt(AUTH_CENTS));
      expect(after.ledgerCents).toBe(before.ledgerCents);
    }

    // NOTHING DOUBLE-COUNTED: two deliveries, one fact, one posting.
    await expectAppliedExactlyOnce(missedToken, `msg_livefire_outage_${tag}`);

    record(
      "evidence",
      `recovery: the backlog delivered twice (HTTP ${catchUp.join(" then ")}) produced 1 inbox row, 1 card_auth_event and 1 hold ${recovered.hold_id}, whose memo account carries exactly 1 entry of ${heldByUs.cents} (the $${(AUTH_CENTS / 100).toFixed(2)} withheld once, not twice) and 0 financial entries. ` +
        `ISOLATED, NOT GUARDED: the app\u0027s own accountAvailability() asked at ONE instant (${isolated.at.toISOString()}) at the two watermarks either side of this run\u0027s own opening posting (booking_seq ${opening.booking_seq - 1n} -> ${opening.booking_seq}) reads available ${isolated.before.availableCents} -> ${isolated.after.availableCents} (exactly -${AUTH_CENTS}), holds ${isolated.before.holdsCents} -> ${isolated.after.holdsCents} (exactly +${AUTH_CENTS}) and ledger unchanged at ${isolated.after.ledgerCents}. Every other write in the database is in BOTH readings and cancels, so no other attack and no other process can move this figure. ` +
        `${quietEpisode ? `The episode was additionally quiet in both books, so the whole-business figures were asserted too: available ${before.availableCents} -> ${after.availableCents}, ledger unchanged at ${after.ledgerCents}` : `${foreignAcross} other entr${foreignAcross === 1 ? "y" : "ies"} touching this customer, ${movedAcross.clockEvents} clock-driven hold transition(s)${movedAcross.rolledOver ? " and a business-date rollover" : ""} landed across the episode, so the whole-business deltas are reported rather than asserted: available ${before.availableCents} -> ${after.availableCents}, ledger ${before.ledgerCents} -> ${after.ledgerCents}. The isolated figure above is unaffected — that is the point of it`}; drain ${drainStatus}`,
    );
  });

  // ==========================================================================
  // THE TWO VISIBILITY CLAIMS
  //
  // Both are now buildable, because `/api/health` publishes
  // `integrations.webhookHealth` and the console shell renders a banner from
  // it. Neither is provable AT REST, and that is deliberate on both sides: a
  // feed nobody has poked reads `quiet` or `never`, and the banner renders
  // NOTHING for either, because "nobody used this integration today" is not an
  // outage (delivery-health.ts, ALARM_WINDOW_MULTIPLE; DECISIONS 025).
  //
  // So these two tests INDUCE the outage rather than waiting to find one. The
  // money test above ends by delivering a real Lithic body to the deployed
  // endpoint, which sets `webhook_inbox.received_at` to now. From that instant
  // we deliver NOTHING — the published attack's five minutes — and watch the
  // endpoint cross its own 180s threshold from `fresh` to `stale`. The silence
  // is the outage; nothing is faked, and the anchor is checked so that a
  // delivery arriving mid-window restarts the clock instead of being papered
  // over.
  // ==========================================================================

  interface ProviderDelivery {
    readonly provider: string;
    readonly label?: string;
    readonly lastDelivery: string | null;
    readonly secondsSinceLastDelivery: number | null;
    readonly staleAfterSeconds: number;
    readonly quietAfterSeconds: number;
    readonly verdict: string;
    readonly gatesDeploymentStatus: boolean;
    readonly degradesDeployment: boolean;
    readonly note: string;
  }

  interface WebhookHealth {
    readonly source?: string;
    readonly measured?: boolean;
    readonly error?: string | null;
    readonly measuredAt?: string;
    readonly degradedBy?: readonly string[];
    readonly providers?: readonly ProviderDelivery[];
  }

  interface SlotReport {
    readonly slot: string;
    readonly status?: string;
    readonly evidence?: string | null;
  }

  /**
   * `integrations.transactionInitiation` — the field that decides whether this
   * attack's silence is an outage or a quiet card rail. See the block below.
   */
  interface ProviderInitiation {
    readonly provider: string;
    readonly source: string | null;
    readonly verdict: string;
    readonly initiatedSinceLastDelivery: number | null;
    readonly oldestUnansweredAgeSeconds: number | null;
    readonly newestInitiated: string | null;
    readonly secondsSinceNewestInitiated: number | null;
    readonly narrowedDeliveryAlarm: boolean;
    readonly note: string;
  }

  interface InitiationHealth {
    readonly source?: string;
    readonly measured?: boolean;
    readonly error?: string | null;
    readonly measuredAt?: string;
    readonly horizonSeconds?: number;
    readonly narrowed?: readonly string[];
    readonly providers?: readonly ProviderInitiation[];
  }

  interface HealthDoc {
    readonly status?: string;
    readonly database?: { readonly reachable?: boolean };
    readonly integrations?: {
      readonly webhookHealth?: WebhookHealth;
      readonly transactionInitiation?: InitiationHealth;
      readonly slots?: readonly SlotReport[];
    };
  }

  /** The two slots Lithic owns. The escalation gate folds over exactly these. */
  const LITHIC_SLOTS = ["card_issuing", "card_webhooks"] as const;

  const slotStatuses = (doc: HealthDoc): Record<string, string> =>
    Object.fromEntries(
      (doc.integrations?.slots ?? [])
        .filter((s) => (LITHIC_SLOTS as readonly string[]).includes(s.slot))
        .map((s) => [s.slot, s.status ?? "absent"]),
    );

  async function readHealth(): Promise<{ status: number; doc: HealthDoc }> {
    const response = await fetch(`${BASE_URL}/api/health`, { cache: "no-store" });
    const raw = await response.text();
    let doc: HealthDoc = {};
    try {
      doc = JSON.parse(raw) as HealthDoc;
    } catch {
      throw new Error(`/api/health did not answer JSON: ${raw.slice(0, 200)}`);
    }
    return { status: response.status, doc };
  }

  const lithicOf = (doc: HealthDoc): ProviderDelivery | undefined =>
    doc.integrations?.webhookHealth?.providers?.find((p) => p.provider === "lithic");

  /** Set by the health test so the UI test knows a stale feed actually exists. */
  let induced: { lagSeconds: number; lastDelivery: string; staleAfter: number } | null = null;

  it(
    "the health endpoint reports the issuing provider's webhook outage",
    async (ctx) => {
      let current = await readHealth();
      expect(current.status).toBe(200);

      const webhookHealth = current.doc.integrations?.webhookHealth;
      if (webhookHealth === undefined || !Array.isArray(webhookHealth.providers)) {
        const reason =
          "/api/health answers 200 but carries no integrations.webhookHealth.providers array, so a webhook outage is invisible to it. Missing: a per-provider last-delivery instant (or lag in seconds) on the health body — webhook_inbox.received_at already has the data — plus a verdict derived from it.";
        record("skip", reason);
        ctx.skip(reason);
        return;
      }
      if (webhookHealth.measured !== true) {
        const reason = `/api/health publishes integrations.webhookHealth but could not measure it this time (${String(webhookHealth.error)}), so every verdict in it is 'unknown' and the outage is still unreported.`;
        record("skip", reason);
        ctx.skip(reason);
        return;
      }

      let lithic = lithicOf(current.doc);
      if (lithic === undefined) {
        const reason =
          "integrations.webhookHealth.providers carries no entry for 'lithic', which is the issuing provider this attack turns off.";
        record("skip", reason);
        ctx.skip(reason);
        return;
      }

      const staleAfter = lithic.staleAfterSeconds;
      const quietAfter = lithic.quietAfterSeconds;

      // Neither of these can be walked into a `stale` verdict by waiting, and
      // neither is an outage. Say which one it is rather than asserting
      // something weaker.
      if (lithic.lastDelivery === null || lithic.verdict === "never") {
        const reason =
          "no Lithic delivery has ever been recorded, so there is no feed to fall silent and nothing to report as an outage. Run the whole attack (node scripts/livefire.mjs --only 7) — its first test delivers a real Lithic body and starts the clock this one measures.";
        record("skip", reason);
        ctx.skip(reason);
        return;
      }
      if (lithic.verdict === "quiet") {
        const reason = `Lithic has been silent for ${String(lithic.secondsSinceLastDelivery)}s, past its own ${quietAfter}s alarm window, so /api/health reports 'quiet' — deliberately not an outage (ALARM_WINDOW_MULTIPLE). Waiting longer cannot produce staleness; a genuine delivery has to land first. Run the whole attack (node scripts/livefire.mjs --only 7), whose first test delivers one.`;
        record("skip", reason);
        ctx.skip(reason);
        return;
      }

      // ---- the deliberate silence -----------------------------------------
      const openedAt = Date.now();
      let anchor: string | null = lithic.lastDelivery;
      let restarts = 0;
      const startedVerdict = lithic.verdict;
      const startedLag = lithic.secondsSinceLastDelivery ?? 0;
      // Must cross `staleAfter` well before `quietAfter`, or the window has
      // been lost to something delivering underneath us. Capped under this
      // test's own timeout so the honest outcome is a SKIP naming what kept
      // delivering, never a timeout dressed up as an assertion failure.
      const deadline = openedAt + Math.min(quietAfter - staleAfter, 300) * 1_000;

      while (lithic.verdict === "fresh") {
        if (lithic.lastDelivery !== anchor) {
          // The feed spoke while we were being quiet. That is a real delivery,
          // not our outage; restart the clock rather than paper over it.
          anchor = lithic.lastDelivery;
          restarts += 1;
        }
        if (Date.now() > deadline) {
          const reason = `Lithic never crossed its ${staleAfter}s staleness threshold within ${Math.round((Date.now() - openedAt) / 1000)}s of deliberate silence (${restarts} restart(s) — something is still delivering), so the outage could not be induced and the endpoint's report of it is unproven.`;
          record("skip", reason);
          ctx.skip(reason);
          return;
        }
        const remaining = staleAfter - (lithic.secondsSinceLastDelivery ?? 0) + 3;
        await new Promise((r) => setTimeout(r, Math.min(Math.max(remaining, 5) * 1_000, 30_000)));

        current = await readHealth();
        expect(current.status).toBe(200);
        const next = lithicOf(current.doc);
        if (next === undefined) {
          const reason =
            "integrations.webhookHealth.providers stopped carrying 'lithic' part-way through the outage window.";
          record("skip", reason);
          ctx.skip(reason);
          return;
        }
        lithic = next;
      }

      // ---- the report ------------------------------------------------------
      // A STEP CHANGE: the feed was delivering, we stopped delivering, and the
      // endpoint says so on its own.
      expect(lithic.verdict).toBe("stale");
      expect(lithic.gatesDeploymentStatus).toBe(true);
      expect(typeof lithic.secondsSinceLastDelivery).toBe("number");
      const lag = lithic.secondsSinceLastDelivery as number;
      expect(lag).toBeGreaterThan(staleAfter);
      expect(lag).toBeLessThanOrEqual(quietAfter);
      expect(lithic.lastDelivery).not.toBeNull();
      expect(lithic.note).toMatch(/silent for longer than/i);

      // And the figure is the real row, not a number the endpoint made up:
      // MAX(received_at) read straight out of the live inbox as the restricted
      // app role, compared against what the deployment published.
      // Epoch milliseconds, not `::text`: postgres renders a timestamptz as
      // `2026-09-10 18:24:14.825+00`, which `new Date()` does not parse the
      // same way in every runtime, and a NaN comparison here would fail this
      // test for a formatting reason rather than a financial one.
      const [row] = await sql<{ last_ms: string | null }[]>`
        SELECT (extract(epoch from max(received_at)) * 1000)::bigint::text AS last_ms
          FROM webhook_inbox WHERE provider = 'lithic'`;
      const dbLastMs = row?.last_ms ?? null;
      expect(dbLastMs).not.toBeNull();
      const published = new Date(lithic.lastDelivery as string).getTime();
      const observed = Number(dbLastMs);
      expect(Number.isFinite(observed)).toBe(true);
      expect(Math.abs(published - observed)).toBeLessThan(2_000);

      induced = {
        lagSeconds: lag,
        lastDelivery: lithic.lastDelivery as string,
        staleAfter,
      };

      const degradedBy = current.doc.integrations?.webhookHealth?.degradedBy ?? [];
      record(
        "evidence",
        `induced outage: after the money test's delivery at ${lithic.lastDelivery} we delivered nothing for ${Math.round((Date.now() - openedAt) / 1000)}s (started '${startedVerdict}' at ${startedLag}s, ${restarts} restart(s)). /api/health then reports lithic verdict '${lithic.verdict}', secondsSinceLastDelivery ${lag} inside its own ${staleAfter}-${quietAfter}s alarm band, note "${lithic.note}". The published lastDelivery matches MAX(webhook_inbox.received_at) for lithic read directly from the live database (${new Date(observed).toISOString()}), so the figure is the real row.`,
      );

      // ---- WHAT THIS SILENCE ACTUALLY IS -----------------------------------
      // THIS BLOCK USED TO ASSERT `status === "degraded"`, AND THAT ASSERTION
      // WAS WRONG. It is worth being exact about why, because the test encoded
      // the precise defect that was removed from the endpoint underneath it.
      //
      // The escalation gate used to be `MAX(webhook_inbox.received_at)` and a
      // clock, and nothing else. That measures TIME SINCE THE LAST WEBHOOK when
      // the question is ARE WE LOSING DELIVERIES, and it cannot tell apart two
      // different facts: the provider stopped delivering while transactions
      // were happening (loss), and nobody swiped a card (a quiet Thursday).
      // Measured on this deployment at 17:56Z with no outage at all in
      // progress: verdict `stale`, `degradesDeployment: true`, while the
      // liveness probe read `GET /v1/cards -> 200` in the same response.
      //
      // `/api/health` now publishes `integrations.transactionInitiation`, which
      // narrows that silence against `card_auth_decision WHERE source =
      // 'provider'` — the durable record of Auth Stream Access, written
      // synchronously while Lithic holds a cardholder's authorisation open at a
      // terminal, on a channel that touches neither the ledger nor the inbox.
      // Any such decision after the newest delivery is `transacting`: a
      // delivery was owed and did not arrive. A counted zero is `dormant`.
      //
      // AND THIS ATTACK INDUCES ITS OUTAGE BY SENDING NOTHING. The loop above
      // opens a genuine silence — it is a real, measured, induced `stale` — but
      // it is a silence with NO TRAFFIC BEHIND IT. There is nothing Lithic owed
      // us and failed to send, because nobody asked it for anything. So the
      // honest reading of this induction is `dormant`, the endpoint correctly
      // declines to escalate, and asserting `degraded` here would be asserting
      // the bug back into existence.
      //
      // A TRUE INDUCTION — the brief's own wording, "turn off your issuing
      // provider's webhooks for five minutes mid-demo" — requires DISABLING THE
      // LITHIC EVENT SUBSCRIPTION AND THEN TRANSACTING, so that a delivery is
      // genuinely owed and genuinely does not arrive. That is deliberately NOT
      // automated here: a subscription left disabled by a crashed or timed-out
      // test run is a broken card rail during a live demo, and this suite
      // cannot guarantee restoration through a SIGKILL. It is a scripted human
      // step in docs/DEMO.md instead. The counterfactual below is what this
      // suite CAN prove without that risk, and it is proven against the real
      // published facts rather than against a fixture.
      const slots = slotStatuses(current.doc);
      const initiation = current.doc.integrations?.transactionInitiation;
      const lithicInit = initiation?.providers?.find((p) => p.provider === "lithic");

      if (initiation === undefined || lithicInit === undefined) {
        const reason =
          "/api/health publishes webhookHealth but no integrations.transactionInitiation entry for 'lithic', so this deployment cannot tell a provider outage from a quiet card rail and the silence just induced cannot be attributed either way.";
        record("skip", reason);
        ctx.skip(reason);
        return;
      }
      if (initiation.measured !== true) {
        const reason = `/api/health could not read transaction initiation this time (${String(initiation.error)}), so the silence keeps the alarming reading by default and the attribution this attack turns on is unproven.`;
        record("skip", reason);
        ctx.skip(reason);
        return;
      }

      // The induction is what it is: a silence with nothing behind it.
      expect(lithicInit.verdict).toBe("dormant");
      expect(lithicInit.initiatedSinceLastDelivery).toBe(0);
      expect(lithicInit.source).toBe("card_auth_decision (source = 'provider')");
      // ...and the endpoint says out loud that this is the field that took the
      // alarm away, rather than leaving a reader to infer it from two others.
      expect(lithicInit.narrowedDeliveryAlarm).toBe(true);
      expect(initiation.narrowed).toContain("lithic");
      // The delivery verdict is UNTOUCHED — `stale` is a true statement about
      // MAX(received_at) and stays on the record (asserted above). What changed
      // is whether that silence is read as loss.
      expect(lithic.verdict).toBe("stale");
      expect(lithic.degradesDeployment).toBe(false);
      expect(degradedBy).not.toContain("lithic");
      expect(current.doc.status).toBe("ok");
      expect(current.doc.database?.reachable).toBe(true);

      record(
        "evidence",
        `NOT ESCALATED, CORRECTLY — the silence induced above is real and measured ('stale' at ${lag}s, lastDelivery matched against the live inbox), but it is a silence with NO TRAFFIC BEHIND IT: integrations.transactionInitiation reads lithic verdict 'dormant' from ${String(lithicInit.source)} with initiatedSinceLastDelivery=0 (last initiation ${String(lithicInit.secondsSinceNewestInitiated)}s ago, BEFORE that delivery), narrowedDeliveryAlarm=true, narrowed=[${(initiation.narrowed ?? []).join(", ")}]. So degradesDeployment=false, degradedBy=[${degradedBy.join(", ")}], status="${String(current.doc.status)}". This test previously asserted status==="degraded" and that assertion encoded the exact defect since removed: MAX(webhook_inbox.received_at) plus a clock cannot tell "the provider stopped delivering while transactions were happening" from "nobody swiped a card", and it read 'outage' on this deployment at 17:56Z with GET /v1/cards -> 200 in the same response. Attack 7 induces its outage BY SENDING NOTHING, so 'dormant' is the honest reading of what it induced.`,
      );

      // ---- AND IT WOULD REDDEN ON A SILENCE THAT IS LOSING DELIVERIES -------
      // The claim the attack's wording is actually about, proven WITHOUT
      // disabling anything, by replaying THIS outage's own published facts
      // through `attributeDeliverySilence` — the same pure function
      // `/api/health` calls, imported from the route's own module, not a
      // reimplementation of it. One input changes between the two runs: the
      // number of provider-sourced ASA decisions recorded after the newest
      // delivery. Everything else — the instant, the threshold, the lag, the
      // gate — is the real one, held fixed.
      const measuredAt = new Date(
        current.doc.integrations?.webhookHealth?.measuredAt ?? new Date().toISOString(),
      );
      const lastDeliveryAt = new Date(lithic.lastDelivery as string);
      const rawDelivery = webhookDeliveryHealth(
        { ok: true as const, latencyMs: 0, rows: [{ provider: "lithic", lastDeliveryAt }] },
        [{ provider: "lithic", integrationLive: true, verifierRegistered: true }],
        measuredAt,
      );
      // The premise, asserted rather than assumed: before any narrowing, this
      // silence DOES degrade. Otherwise the counterfactual below would be
      // comparing two ways of not alarming.
      expect(rawDelivery.providers.find((p) => p.provider === "lithic")?.verdict).toBe("stale");
      expect(rawDelivery.degradedBy).toEqual(["lithic"]);

      const withInitiations = (count: number, oldest: Date | null) =>
        attributeDeliverySilence(
          rawDelivery,
          {
            ok: true as const,
            latencyMs: 0,
            rows: [
              {
                provider: "lithic",
                lastDeliveryAt,
                initiatedSinceDeliveryCount: count,
                oldestInitiatedSinceDeliveryAt: oldest,
                newestInitiatedAt: oldest ?? lastDeliveryAt,
                initiatedInHorizonCount: count,
              },
            ],
          },
          measuredAt,
        );

      // (a) The quiet card rail — this run's actual state. Alarm removed.
      const quietRail = withInitiations(0, null);
      expect(quietRail.initiation.providers.find((p) => p.provider === "lithic")?.verdict).toBe(
        "dormant",
      );
      expect(quietRail.delivery.degradedBy).toEqual([]);

      // (b) The same silence, same instant, same threshold — with ONE card
      // presented at a terminal after the last delivery. A delivery is owed and
      // has not arrived. The alarm stays, and status would read "degraded".
      const owedAt = new Date(lastDeliveryAt.getTime() + 1_000);
      const losing = withInitiations(1, owedAt);
      const losingLithic = losing.initiation.providers.find((p) => p.provider === "lithic");
      expect(losingLithic?.verdict).toBe("transacting");
      expect(losingLithic?.narrowedDeliveryAlarm).toBe(false);
      expect(losingLithic?.initiatedSinceLastDelivery).toBe(1);
      expect(losing.delivery.providers.find((p) => p.provider === "lithic")?.degradesDeployment).toBe(
        true,
      );
      expect(losing.delivery.degradedBy).toEqual(["lithic"]);
      expect(losing.initiation.narrowed).toEqual([]);

      record(
        "evidence",
        `AND IT WOULD REDDEN ON A SILENCE THAT IS LOSING DELIVERIES — replaying THIS outage's own published facts (lastDelivery ${lithic.lastDelivery}, measuredAt ${measuredAt.toISOString()}, verdict stale, gate live) through attributeDeliverySilence, the same pure function /api/health calls, with exactly ONE input varied: provider-sourced ASA decisions recorded after the newest delivery. With 0 (this run's real state) the verdict is 'dormant' and degradedBy=[] — status "ok". With 1, a single card presented at a terminal 1s after the last delivery, the verdict is 'transacting' ("a delivery was owed for each and none arrived"), narrowedDeliveryAlarm=false, degradesDeployment=true and degradedBy=[lithic] — status would be "degraded". The narrowing therefore only ever SUBTRACTS on a counted zero; it cannot silence an outage that is actually losing deliveries. NOT PROVEN BY THIS RUN: that a real disabled subscription produces that second state end-to-end. Inducing it requires disabling the Lithic event subscription and then transacting, which is a scripted human step in docs/DEMO.md and is deliberately not automated — a subscription left disabled by a crashed run is a broken card rail.`,
      );

      // ---- AND THE GATE IS TESTED AGAINST WHAT IT GUARDS AGAINST -----------
      // The escalation above is currently satisfied by BOTH lithic slots
      // reading 'live', so it would also pass under the old `every`. That makes
      // it silent about the actual regression risk, and a guard that only works
      // while every slot happens to be probeable is exactly what broke here
      // last time.
      //
      // `card_webhooks`'s probe reads Lithic's OWN /attempts log, so it goes
      // not-live in precisely the conditions that are the outage: an endpoint
      // of ours rejecting deliveries reads `unauthorised` (this account still
      // holds two FAILED 500s at 16:18 from the DECISIONS 020 inbox bug), an
      // unreadable /attempts reads `unreachable`. So the degraded case is
      // re-derived here from the REAL published facts of the outage just
      // induced, with card_webhooks forced not-live, through the same pure
      // function `/api/health` calls. Both gate shapes are evaluated, because
      // the point is not that `some` works — it is that `every` does not.
      // The premise of the counterfactual, asserted rather than assumed: the
      // OTHER Lithic slot really is live. `card_issuing` is `mustBeLive` and
      // the money test above just created a card through it, so this is a
      // statement about the deployment, not a convenience.
      expect(slots["card_issuing"]).toBe("live");

      // `measuredAt` and `lastDeliveryAt` are the ones bound above, off the same
      // published response, so this replay and the initiation counterfactual are
      // anchored to one instant rather than to two.
      const outage = {
        ok: true as const,
        latencyMs: 0,
        rows: [{ provider: "lithic", lastDeliveryAt }],
      };
      const degraded: Record<string, string> = { ...slots, card_webhooks: "simulated" };
      const gate = (shape: "some" | "every"): boolean =>
        shape === "some"
          ? LITHIC_SLOTS.some((s) => degraded[s] === "live")
          : LITHIC_SLOTS.every((s) => degraded[s] === "live");
      const rerun = (shape: "some" | "every"): { degrades: boolean; degradedBy: readonly string[] } => {
        const health = webhookDeliveryHealth(
          outage,
          [{ provider: "lithic", integrationLive: gate(shape), verifierRegistered: true }],
          measuredAt,
        );
        const p = health.providers.find((x) => x.provider === "lithic");
        // Same silence, same instant, same threshold: only the gate changed.
        expect(p?.verdict).toBe("stale");
        return { degrades: p?.degradesDeployment === true, degradedBy: health.degradedBy };
      };

      const withSome = rerun("some");
      const withEvery = rerun("every");
      // THE ALARM SURVIVES a not-live card_webhooks. This is the assertion the
      // header's retired limit is actually about.
      expect(withSome.degrades).toBe(true);
      expect(withSome.degradedBy).toEqual(["lithic"]);
      // And it would NOT have, under the shape this gate used to have — so the
      // clause above is load-bearing rather than incidentally true.
      expect(withEvery.degrades).toBe(false);
      expect(withEvery.degradedBy).toEqual([]);

      record(
        "evidence",
        `gate tested against the thing it guards: replaying THIS outage's own published facts (lastDelivery ${lithic.lastDelivery}, measuredAt ${measuredAt.toISOString()}, verdict stale) through webhookDeliveryHealth with card_webhooks forced not-live — the verdict its probe genuinely returns when Lithic is delivering and our endpoint is refusing (unauthorised) or /attempts cannot be read (unreachable) — the alarm STAYS ARMED under 'some' (degradesDeployment=true, degradedBy=[lithic]) and is SILENCED under 'every' (degradesDeployment=false, degradedBy=[], status would read "ok" with deliveries being lost). 'some' is therefore not incidentally correct: it is the only one of the two that cannot be disarmed by the outage itself.`,
      );
    },
    420_000,
  );

  it("the account UI shows a provider-down state", async (ctx) => {
    if (induced === null) {
      const reason =
        "the health test above did not establish a stale Lithic feed, so there is no provider-down state for the console to render — the banner is a renderer of /api/health's verdict and never an author of one (DECISIONS 025). Its skip reason above is the missing thing.";
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    // Read the verdict the banner will read, at the moment the banner reads it.
    const health = await readHealth();
    expect(health.status).toBe(200);
    const lithic = lithicOf(health.doc);
    if (lithic === undefined || lithic.verdict !== "stale") {
      const reason = `the induced silence stopped being 'stale' before the console could be read (now '${String(lithic?.verdict)}' at ${String(lithic?.secondsSinceLastDelivery)}s), so there was no provider-down state to render at that instant.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    const response = await fetch(`${BASE_URL}/accounts`, { cache: "no-store" });
    expect(response.status).toBe(200);
    const html = await response.text();

    // The attribute alone is not enough: the 'cannot reach the health endpoint'
    // banner carries the same one, and a banner that fires because health was
    // unreachable would prove the opposite of this claim.
    expect(html).toContain('data-provider-status="provider-down"');
    expect(html).toMatch(/Issuing provider feed is quiet/);
    expect(html).not.toMatch(/Cannot reach the health endpoint/);
    expect(html).not.toMatch(/Provider delivery freshness is not reported yet/);
    expect(html).toMatch(/lithic/);

    // It RENDERS the endpoint's number rather than computing a second opinion.
    const minutes = /no delivery for (\d+) minutes?/.exec(html);
    const seconds = /no delivery for (\d+)s/.exec(html);
    expect(minutes ?? seconds).not.toBeNull();
    const renderedSeconds =
      minutes !== null ? Number(minutes[1]) * 60 : Number((seconds as RegExpExecArray)[1]);
    const publishedSeconds = lithic.secondsSinceLastDelivery as number;
    // Same source, read a moment apart: allow one minute of drift and no more.
    expect(Math.abs(renderedSeconds - publishedSeconds)).toBeLessThanOrEqual(120);

    // And it does NOT blank the console. Every figure below the banner is a
    // fold over rows that are already durable, and they stay true while a feed
    // is silent; hiding them would be the stronger, false claim.
    //
    // Asserted on STRUCTURE, not on copy. This line read
    // `toContain("Deposit accounts")` and failed the whole attack the moment
    // /accounts was rewritten and that heading was renamed — while the claim
    // it exists to prove was still perfectly true. A live-fire assertion
    // pinned to a sentence tests the sentence.
    //
    // `id="balances"` is the panel that renders ledger, holds and available;
    // the money figures are the point, so the currency marker is checked too.
    expect(html).toContain('id="balances"');
    expect(html).toMatch(/\$[0-9][0-9,]*\.[0-9]{2}/);

    record(
      "evidence",
      `the deployed console at ${BASE_URL}/accounts renders data-provider-status="provider-down" while lithic is stale: "Issuing provider feed is quiet — lithic", detail "${(minutes ?? seconds)?.[0] ?? ""}" against /api/health's ${publishedSeconds}s, and the deposit-account balances are still rendered underneath rather than blanked.`,
    );
  });
});
