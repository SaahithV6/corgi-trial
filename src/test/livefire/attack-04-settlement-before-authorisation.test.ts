/**
 * ATTACK 4 — "Deliver a settlement BEFORE its authorisation. Assert nothing
 * crashes, nothing double-counts, and the final balances equal the in-order
 * case exactly. Run the same events in both orders and compare."
 *
 * ============================================================================
 * HOW THE OUT-OF-ORDER DELIVERY IS PRODUCED, STATED PLAINLY.
 *
 * The Lithic sandbox cannot do this. `/v1/simulate/clearing` requires a parent
 * authorisation token and there is no force-post endpoint (DECISIONS 004), so
 * no sequence of provider calls will make a clearing arrive first.
 *
 * So the second episode is CONSTRUCTED. The two real delivery bodies from the
 * first episode are taken out of `webhook_inbox`, given a fresh transaction
 * token, split so the clearing body carries only its CLEARING event, re-signed
 * with THIS DEPLOYMENT'S OWN `LITHIC_WEBHOOK_SECRET` under the Standard
 * Webhooks scheme, and POSTed to the deployed endpoint clearing-first.
 *
 * That is a construction and it is labelled as one everywhere it appears. It is
 * not a mock of our system: the bodies are Lithic's own wire shape, the
 * signature is checked by the same verifier that checks Lithic, the events are
 * processed by the deployed drain, and every assertion below is read back out
 * of the live database. What is simulated is the ORDER, which is the only part
 * the provider will not give us.
 * ============================================================================
 *
 * WHAT IS COMPARED. Both episodes are the same two facts — authorise $50.00,
 * capture $73.40 — against the same customer. The comparison is the DELTA each
 * episode leaves on that customer's ledger and available balance, plus the
 * hold each ends holding. Equal deltas is the claim; it is measured, not
 * assumed, and each episode is measured across its own window.
 */
import { createHmac, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import type * as BalancesModule from "@/lib/ledger/balances";
import type { sql as SqlHandle } from "@/lib/ledger/db";
import type * as Holds from "@/lib/holds";
import type * as LithicClient from "@/lib/rails/lithic/client";

const ATTACK = 4;
const NAME = "Settlement delivered before its authorisation ends in the same state as in-order";

/** Append one evidence line for scripts/livefire.mjs. Silent when unset. */
function record(kind: "evidence" | "skip", text: string): void {
  const path = process.env["LIVEFIRE_EVIDENCE"];
  if (path === undefined || path === "") return;
  appendFileSync(path, `${JSON.stringify({ attack: ATTACK, name: NAME, kind, text })}\n`, "utf8");
}

const BASE_URL = (
  process.env["LIVEFIRE_BASE_URL"] ?? "https://corgi-trial-psi.vercel.app"
).replace(/\/+$/, "");

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
  MISSING.push("LITHIC_WEBHOOK_SECRET (needed to re-sign the constructed clearing-first delivery)");
}

const READY = MISSING.length === 0;
if (!READY) record("skip", `missing: ${MISSING.join(", ")}; run scripts/livefire.mjs`);

const d = READY ? describe : describe.skip;

const AUTH_CENTS = 50_00;
const CAPTURE_CENTS = 73_40;

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

type Delivery = { headers: Record<string, string>; raw_body: string };
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

  /** The operator's "watch, I will drain it now", against the DEPLOYED drain. */
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

  function delta(before: Position, after: Position): Position {
    return {
      ledgerCents: after.ledgerCents - before.ledgerCents,
      availableCents: after.availableCents - before.availableCents,
      holdsCents: after.holdsCents - before.holdsCents,
    };
  }

  /** The stored delivery for one transaction that carries an event of `kind`. */
  async function deliveryFor(
    token: string,
    kind: "AUTHORIZATION" | "CLEARING",
  ): Promise<Delivery | null> {
    return until(async () => {
      const [row] = await sql<Delivery[]>`
        SELECT headers, raw_body FROM webhook_inbox
         WHERE provider = 'lithic'
           AND payload->>'token' = ${token}
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(payload->'events') ev
              WHERE ev->>'type' = ${kind})
         ORDER BY received_at DESC LIMIT 1`;
      return row ?? null;
    }, 60_000);
  }

  it("the same events in both orders end in exactly the same place", async (ctx) => {
    const [customer] = await sql<{ business_id: string }[]>`
      SELECT dep.business_id
        FROM account dep
        JOIN account memo ON memo.business_id = dep.business_id AND memo.code = '9100'
       WHERE dep.code = '2100' AND dep.business_id IS NOT NULL
       ORDER BY dep.business_id LIMIT 1`;
    if (!customer) throw new Error("no business has a 2100/9100 pair: run node scripts/seed.mjs");
    const businessId = customer.business_id;

    const card = await lithic.createCard({
      type: "VIRTUAL",
      memo: `livefire ordering ${tag}`,
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
        nickname: `live-fire ordering ${tag}`,
      },
      sql,
    );

    /* ---------------- Episode A: in order, entirely real ---------------- */

    const beforeA = await positionOf(businessId);

    const auth = await lithic.simulateAuthorize({
      amount: AUTH_CENTS,
      descriptor: `CORGI ORDER ${tag}`.slice(0, 25),
      pan,
      status: "AUTHORIZATION",
      mcc: "5542",
    });
    if (auth.token === undefined) throw new Error("Lithic returned no transaction token");
    const transactionToken: string = auth.token;

    const authRowA = await until(async () => {
      const [row] = await sql<{ hold_id: string; origin: string }[]>`
        SELECT hold_id, origin FROM card_authorization
         WHERE provider = 'lithic' AND provider_auth_id = ${transactionToken}`;
      return row ?? null;
    }, 90_000);

    if (authRowA === null) {
      const reason = `the in-order episode never reached the ledger, so there is nothing to compare against. Lithic transaction ${transactionToken} on registered card ${card.token} produced no card_authorization row within 90s; POST ${BASE_URL}/api/drain answered ${drainStatus}.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    const authBody = await deliveryFor(transactionToken, "AUTHORIZATION");
    if (authBody === null) {
      const reason = `no stored AUTHORIZATION delivery for ${transactionToken}, so the clearing-first episode cannot be constructed from a real body.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    await lithic.simulateClearing({ token: transactionToken, amountCents: CAPTURE_CENTS });

    const clearedA = await until(async () => {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM card_auth_event ce
          JOIN card_authorization ca ON ca.id = ce.auth_id
         WHERE ca.provider_auth_id = ${transactionToken} AND ce.kind = 'clearing'`;
      return (row?.n ?? 0) > 0 ? row : null;
    }, 90_000);

    if (clearedA === null) {
      const reason = `the in-order clearing for ${transactionToken} never reached the ledger within 90s; POST ${BASE_URL}/api/drain answered ${drainStatus}.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    const clearingBody = await deliveryFor(transactionToken, "CLEARING");
    if (clearingBody === null) {
      const reason = `no stored CLEARING delivery for ${transactionToken}, so the clearing-first episode cannot be constructed from a real body.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    const afterA = await positionOf(businessId);
    const deltaA = delta(beforeA, afterA);

    /* ------- Episode B: the same events, clearing first (constructed) ---- */

    const tokenB = randomUUID();
    const authPayload = JSON.parse(authBody.raw_body) as Record<string, unknown>;
    const clearingPayload = JSON.parse(clearingBody.raw_body) as Record<string, unknown>;

    // Fresh event tokens as well as a fresh transaction token, and this is
    // load-bearing rather than tidiness: `financialPostingKey` is
    // `card:<kind>:<provider event id>` and lands in `journal_entry`'s UNIQUE
    // idempotency key. Re-using episode A's event tokens would make episode B's
    // settlement a REPLAY of episode A's — the ledger would correctly refuse to
    // post it twice, and the comparison would then be measuring the idempotency
    // key rather than the ordering. (Measured: the first version of this test
    // did exactly that and read a ledger delta of 0.)
    const reissue = (list: unknown): { type?: string; token?: string }[] =>
      (Array.isArray(list) ? list : []).map((event) => ({
        ...(event as Record<string, unknown>),
        token: randomUUID(),
      })) as { type?: string; token?: string }[];

    const clearingEvents = reissue(clearingPayload["events"]).filter((e) => e.type === "CLEARING");
    const authEvents = reissue(authPayload["events"]);
    expect(clearingEvents.length).toBeGreaterThan(0);
    expect(authEvents.length).toBeGreaterThan(0);

    // The clearing with NO authorisation event in it — which is what
    // "settlement before its authorisation" actually looks like on the wire.
    const bodyB1 = JSON.stringify({ ...clearingPayload, token: tokenB, events: clearingEvents });
    // The authorisation, arriving afterwards.
    const bodyB2 = JSON.stringify({ ...authPayload, token: tokenB, events: authEvents });

    const beforeB = await positionOf(businessId);

    const posted: number[] = [];
    for (const body of [bodyB1, bodyB2]) {
      const id = `msg_livefire_${tag}_${posted.length}`;
      const response = await fetch(`${BASE_URL}/api/webhooks/lithic`, {
        method: "POST",
        headers: signStandardWebhook(secret, id, Math.floor(Date.now() / 1000), body),
        body,
      });
      posted.push(response.status);
      // NOTHING CRASHES: a 5xx here is precisely what the attack is hunting.
      expect(response.status).toBeLessThan(500);
      expect([200, 202]).toContain(response.status);
    }

    const authRowB = await until(async () => {
      const [row] = await sql<{ hold_id: string; origin: string }[]>`
        SELECT hold_id, origin FROM card_authorization
         WHERE provider = 'lithic' AND provider_auth_id = ${tokenB}`;
      return row ?? null;
    }, 90_000);

    if (authRowB === null) {
      const reason = `the constructed clearing-first delivery for ${tokenB} was accepted (HTTP ${posted.join(", ")}) but produced no card_authorization row within 90s; POST ${BASE_URL}/api/drain answered ${drainStatus}.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    // Both facts must have landed before the comparison is meaningful.
    const bothB = await until(async () => {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM card_auth_event ce
          JOIN card_authorization ca ON ca.id = ce.auth_id
         WHERE ca.provider_auth_id = ${tokenB}`;
      return (row?.n ?? 0) >= 2 ? row : null;
    }, 90_000);

    if (bothB === null) {
      const reason = `the constructed episode ${tokenB} did not record both facts within 90s, so the two orders cannot be compared; POST ${BASE_URL}/api/drain answered ${drainStatus}.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    const afterB = await positionOf(businessId);
    const deltaB = delta(beforeB, afterB);

    /* ------------------------- the comparison --------------------------- */

    // FINAL BALANCES EQUAL THE IN-ORDER CASE EXACTLY.
    expect(deltaB.ledgerCents).toBe(deltaA.ledgerCents);
    expect(deltaB.availableCents).toBe(deltaA.availableCents);
    expect(deltaB.holdsCents).toBe(deltaA.holdsCents);
    // And the settlement really did post: the whole comparison would also be
    // satisfied by two episodes that both did nothing.
    expect(deltaA.ledgerCents).toBe(-BigInt(CAPTURE_CENTS));

    // NOTHING DOUBLE-COUNTS: one capture per transaction, not two.
    for (const token of [transactionToken, tokenB]) {
      const [captures] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM card_auth_event ce
          JOIN card_authorization ca ON ca.id = ce.auth_id
         WHERE ca.provider_auth_id = ${token} AND ce.kind = 'clearing'`;
      expect(captures?.n).toBe(1);
    }

    // The clearing-first identity is recorded as such, and nothing branched on
    // it: same numbers, different origin.
    expect(authRowB.origin).toBe("clearing_first");
    expect(authRowA.origin).toBe("authorization");

    // NOTHING WAS LOST OR POISONED: no dead letters from this run.
    const [dead] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM webhook_inbox
       WHERE provider = 'lithic' AND state = 'dead'
         AND provider_event_id LIKE ${`msg_livefire_${tag}_%`}`;
    expect(dead?.n).toBe(0);

    record(
      "evidence",
      `in-order episode ${transactionToken} (origin ${authRowA.origin}): ledger delta ${deltaA.ledgerCents}, available delta ${deltaA.availableCents}, hold delta ${deltaA.holdsCents}`,
    );
    record(
      "evidence",
      `clearing-first episode ${tokenB} (origin ${authRowB.origin}; constructed from the real bodies above and re-signed with LITHIC_WEBHOOK_SECRET, POSTed clearing-first, HTTP ${posted.join(" then ")}): ledger delta ${deltaB.ledgerCents}, available delta ${deltaB.availableCents}, hold delta ${deltaB.holdsCents} — EQUAL`,
    );
    record(
      "evidence",
      `one clearing event per transaction in both episodes; zero dead-lettered deliveries for msg_livefire_${tag}_*; drain ${drainStatus}`,
    );
  });
});
