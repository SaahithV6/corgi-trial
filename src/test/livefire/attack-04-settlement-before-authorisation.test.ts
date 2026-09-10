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
 * So the SECOND episode is constructed: the two REAL delivery bodies from the
 * first episode are taken from `webhook_inbox`, given a fresh transaction
 * token, split so the clearing body carries only its CLEARING event, re-signed
 * with THIS DEPLOYMENT'S OWN `LITHIC_WEBHOOK_SECRET` under the Standard
 * Webhooks scheme, and POSTed to production clearing-first.
 *
 * That is a construction and it is labelled as one everywhere it appears. It is
 * not a mock of our system: the bodies are Lithic's own wire shape, the
 * signature is verified by the same verifier that verifies Lithic, and every
 * assertion below is read back out of the live database. What is simulated is
 * the ORDER, which is the only part the provider will not give us.
 * ============================================================================
 *
 * SKIPS TODAY for the same reason as attacks 1 and 2: nothing consumes the
 * delivery, so neither episode reaches the ledger and there is nothing to
 * compare.
 */
import { createHmac } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import type * as BalancesModule from "@/lib/ledger/balances";
import type { sql as SqlHandle } from "@/lib/ledger/db";
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

const PIPELINE_MISSING =
  "the card authorisation pipeline does not exist yet. src/lib/holds/* is unwritten, so no webhook consumer is registered for Lithic 'card_transaction.updated' in src/lib/webhooks/dispatch.ts and nothing runs dispatchOnce() in production. Neither the in-order episode nor the clearing-first episode reaches the ledger, so there are no final balances to compare. Waiting on src/lib/holds/* plus a dispatcher run reachable from the deployment.";

const PIPELINE_PRESENT = existsSync(resolve(process.cwd(), "src/lib/holds"));

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

const READY = MISSING.length === 0 && PIPELINE_PRESENT;
if (!READY) {
  record("skip", MISSING.length > 0 ? `missing: ${MISSING.join(", ")}` : PIPELINE_MISSING);
}

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
type Effect = { ledgerCents: bigint; availableCents: bigint; holdsCents: bigint };

d(`ATTACK ${ATTACK} — ${NAME}`, () => {
  let sql: typeof SqlHandle;
  let bal: typeof BalancesModule;
  let lithic: typeof LithicClient;

  const tag = Date.now().toString(36).toUpperCase();
  const secret = process.env["LITHIC_WEBHOOK_SECRET"] ?? "";

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    bal = await import("@/lib/ledger/balances");
    lithic = await import("@/lib/rails/lithic/client");
  });

  async function until<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value !== null) return value;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  async function deliveryFor(token: string, kind: "AUTHORIZATION" | "CLEARING"): Promise<Delivery | null> {
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
    }, 90_000);
  }

  async function effectOn(businessId: string): Promise<Effect> {
    const balance = await bal.availableBalance(businessId);
    return {
      ledgerCents: balance.ledgerCents,
      availableCents: balance.availableCents,
      holdsCents: balance.holdsCents,
    };
  }

  function delta(before: Effect, after: Effect): Effect {
    return {
      ledgerCents: after.ledgerCents - before.ledgerCents,
      availableCents: after.availableCents - before.availableCents,
      holdsCents: after.holdsCents - before.holdsCents,
    };
  }

  it("the same events in both orders end in exactly the same place", async (ctx) => {
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

    /* ---------------- Episode A: in order, entirely real ---------------- */
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
      const [row] = await sql<{ account_id: string; hold_id: string }[]>`
        SELECT account_id, hold_id FROM card_authorization
         WHERE provider = 'lithic' AND provider_auth_id = ${transactionToken}`;
      return row ?? null;
    }, 90_000);

    if (authRowA === null) {
      const reason = `${PIPELINE_MISSING} Observed this run: Lithic transaction ${transactionToken} produced no card_authorization row within 90s.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    const [owner] = await sql<{ business_id: string | null }[]>`
      SELECT business_id FROM account WHERE id = ${authRowA.account_id}::uuid`;
    const businessId = owner?.business_id;
    if (businessId === undefined || businessId === null) {
      throw new Error(`card_authorization.account_id ${authRowA.account_id} has no business_id`);
    }

    const authBody = await deliveryFor(transactionToken, "AUTHORIZATION");
    if (authBody === null) throw new Error(`no authorisation delivery captured for ${transactionToken}`);

    // Measure episode A from BEFORE the authorisation was consumed is not
    // possible after the fact, so A's effect is measured over the clearing leg
    // and the hold it releases, which is the whole of A's remaining effect.
    const beforeA = await effectOn(businessId);
    await lithic.simulateClearing({ token: transactionToken, amountCents: CAPTURE_CENTS });

    const clearingBody = await deliveryFor(transactionToken, "CLEARING");
    if (clearingBody === null) throw new Error(`no clearing delivery captured for ${transactionToken}`);

    const settledA = await until(async () => {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM hold_closure WHERE hold_id = ${authRowA.hold_id}::uuid`;
      return (row?.n ?? 0) > 0 ? row : null;
    }, 90_000);
    if (settledA === null) {
      const reason = `${PIPELINE_MISSING} Observed this run: the clearing for ${transactionToken} released no hold within 90s.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }
    const afterA = await effectOn(businessId);
    const deltaA = delta(beforeA, afterA);

    /* ------- Episode B: the same events, clearing first (constructed) ---- */
    const tokenB = randomUUID();
    const authPayload = JSON.parse(authBody.raw_body) as Record<string, unknown>;
    const clearingPayload = JSON.parse(clearingBody.raw_body) as Record<string, unknown>;

    const events = (clearingPayload["events"] ?? []) as { type?: string }[];
    const clearingOnly = events.filter((e) => e.type === "CLEARING");
    expect(clearingOnly.length).toBeGreaterThan(0);

    // The clearing, with NO authorisation event in it — which is what
    // "settlement before its authorisation" actually looks like on the wire.
    const bodyB1 = JSON.stringify({ ...clearingPayload, token: tokenB, events: clearingOnly });
    // The authorisation, arriving afterwards.
    const bodyB2 = JSON.stringify({ ...authPayload, token: tokenB });

    const posted: number[] = [];
    for (const body of [bodyB1, bodyB2]) {
      const id = `msg_livefire_${tag}_${posted.length}`;
      const response = await fetch(`${BASE_URL}/api/webhooks/lithic`, {
        method: "POST",
        headers: signStandardWebhook(secret, id, Math.floor(Date.now() / 1000), body),
        body,
      });
      posted.push(response.status);
      // NOTHING CRASHES: a 5xx here is the failure the attack is looking for.
      expect(response.status).toBeLessThan(500);
      expect([200, 202]).toContain(response.status);
    }

    const beforeB = await effectOn(businessId);
    const authRowB = await until(async () => {
      const [row] = await sql<{ id: string; hold_id: string; origin: string }[]>`
        SELECT id, hold_id, origin FROM card_authorization
         WHERE provider = 'lithic' AND provider_auth_id = ${tokenB}`;
      return row ?? null;
    }, 90_000);

    if (authRowB === null) {
      const reason = `${PIPELINE_MISSING} Observed this run: the constructed clearing-first delivery for ${tokenB} was accepted (HTTP ${posted.join(", ")}) but produced no card_authorization row within 90s.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }
    const afterB = await effectOn(businessId);
    const deltaB = delta(beforeB, afterB);

    /* ------------------------- the comparison --------------------------- */

    // FINAL BALANCES EQUAL THE IN-ORDER CASE EXACTLY.
    expect(deltaB.ledgerCents).toBe(deltaA.ledgerCents);
    expect(deltaB.availableCents).toBe(deltaA.availableCents);
    expect(deltaB.holdsCents).toBe(0n);

    // NOTHING DOUBLE-COUNTS: one settlement per transaction, not two.
    for (const token of [transactionToken, tokenB]) {
      const [entries] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM card_auth_event ce
          JOIN card_authorization ca ON ca.id = ce.auth_id
         WHERE ca.provider_auth_id = ${token} AND ce.kind = 'clearing'`;
      expect(entries?.n).toBe(1);
    }

    // NOTHING WAS LOST OR POISONED: no dead letters from this run.
    const [dead] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM webhook_inbox
       WHERE provider = 'lithic' AND state = 'dead'
         AND provider_event_id LIKE ${`msg_livefire_${tag}_%`}`;
    expect(dead?.n).toBe(0);

    record(
      "evidence",
      `in-order episode ${transactionToken}: ledger delta ${deltaA.ledgerCents}, available delta ${deltaA.availableCents}. Clearing-first episode ${tokenB} (constructed, re-signed with LITHIC_WEBHOOK_SECRET, HTTP ${posted.join(" then ")}): ledger delta ${deltaB.ledgerCents}, available delta ${deltaB.availableCents}, origin ${authRowB.origin}, hold delta ${deltaB.holdsCents}. Equal.`,
    );
    record(
      "evidence",
      `one clearing event per transaction for both episodes; zero dead-lettered deliveries for msg_livefire_${tag}_*`,
    );
  });
});
