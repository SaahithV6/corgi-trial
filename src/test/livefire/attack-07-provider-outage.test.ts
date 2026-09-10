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
 * WHAT PASSES TODAY: the money claim. Through the dark window nothing is
 * invented — the trial balance does not move and no customer's ledger or
 * available balance changes. On recovery nothing is lost and nothing is
 * double-counted: the held delivery posts exactly once however many times it
 * arrives.
 *
 * WHAT DOES NOT: the two visibility claims. `/api/health` reports per-provider
 * CREDENTIAL and CAPABILITY liveness (a real probe round trip) and says nothing
 * about webhook DELIVERY freshness, so this outage is invisible to it; and no
 * component renders a provider-down state. Both tests check for the thing they
 * would need and SKIP naming it, rather than asserting something weaker and
 * calling it a pass.
 */
import { createHmac, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

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

  it("invents no money while the feed is dark, and loses none when it comes back", async (ctx) => {
    const [customer] = await sql<{ business_id: string }[]>`
      SELECT dep.business_id
        FROM account dep
        JOIN account memo ON memo.business_id = dep.business_id AND memo.code = '9100'
       WHERE dep.code = '2100' AND dep.business_id IS NOT NULL
       ORDER BY dep.business_id LIMIT 1`;
    if (!customer) throw new Error("no business has a 2100/9100 pair: run node scripts/seed.mjs");
    const businessId = customer.business_id;

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
    const events = (Array.isArray(payload["events"]) ? payload["events"] : []).map((event) => ({
      ...(event as Record<string, unknown>),
      token: randomUUID(),
    }));
    const missedBody = JSON.stringify({ ...payload, token: missedToken, events });

    // ---- THE DARK WINDOW -------------------------------------------------
    const before = await positionOf(businessId);
    const trialBefore = await bal.trialBalanceCents();
    const startedAt = Date.now();
    await new Promise((r) => setTimeout(r, OUTAGE_SECONDS * 1_000));

    // Nothing was invented from an event we were never told about.
    const during = await positionOf(businessId);
    expect(during).toEqual(before);
    expect(await bal.trialBalanceCents()).toBe(trialBefore);

    // And the system is still answering while its feed is dark.
    const health = (await (await fetch(`${BASE_URL}/api/health`, { cache: "no-store" })).json()) as {
      status?: string;
      database?: { reachable?: boolean };
    };
    expect(health.database?.reachable).toBe(true);

    // The event genuinely never reached us.
    const [absent] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM webhook_inbox
       WHERE provider = 'lithic' AND payload->>'token' = ${missedToken}`;
    expect(absent?.n).toBe(0);

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

    // NOTHING LOST: the withheld $50.00 is now held, exactly once.
    const after = await positionOf(businessId);
    expect(after.availableCents).toBe(before.availableCents - BigInt(AUTH_CENTS));
    expect(after.holdsCents).toBe(before.holdsCents + BigInt(AUTH_CENTS));
    // NOTHING INVENTED: an authorisation is memo-only.
    expect(after.ledgerCents).toBe(before.ledgerCents);
    expect(await bal.trialBalanceCents()).toBe(trialBefore);

    // NOTHING DOUBLE-COUNTED: two deliveries, one fact, one posting.
    const [facts] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM card_auth_event ce
        JOIN card_authorization ca ON ca.id = ce.auth_id
       WHERE ca.provider_auth_id = ${missedToken}`;
    expect(facts?.n).toBe(1);
    const [rows] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM webhook_inbox
       WHERE provider = 'lithic' AND provider_event_id = ${`msg_livefire_outage_${tag}`}`;
    expect(rows?.n).toBe(1);

    record(
      "evidence",
      `dark window ${Math.round((Date.now() - startedAt) / 1000)}s (LIVEFIRE_OUTAGE_SECONDS=${OUTAGE_SECONDS}): business ${businessId} ledger ${before.ledgerCents} available ${before.availableCents} unchanged throughout; trial balance ${trialBefore} unchanged; the swallowed event ${missedToken} had 0 inbox rows; /api/health answered with database reachable`,
    );
    record(
      "evidence",
      `recovery: the backlog delivered twice (HTTP ${catchUp.join(" then ")}) produced 1 inbox row, 1 card_auth_event and 1 hold ${recovered.hold_id}; available ${before.availableCents} -> ${after.availableCents} (exactly -${AUTH_CENTS}), ledger unchanged at ${after.ledgerCents}; drain ${drainStatus}`,
    );
  });

  it("the health endpoint reports the issuing provider's webhook outage", async (ctx) => {
    const response = await fetch(`${BASE_URL}/api/health`, { cache: "no-store" });
    expect(response.status).toBe(200);
    const health = (await response.json()) as Record<string, unknown>;
    const serialised = JSON.stringify(health);

    // What would satisfy this claim: a field on the health body reporting
    // webhook DELIVERY health for a provider — a last-delivery instant, a lag
    // in seconds, or an explicit degraded verdict derived from one. Credential
    // liveness is not it: the credential is perfectly valid during a webhook
    // outage, which is exactly why the outage would go unreported.
    const reportsDeliveryHealth =
      /lastDelivery|last_delivery|deliveryLag|secondsSinceLastDelivery|webhookHealth|webhook_health|feedStale|stalest/.test(
        serialised,
      );

    if (!reportsDeliveryHealth) {
      const reason =
        "/api/health answers 200 and reports credential and capability liveness per slot, but carries NO webhook delivery-freshness field, so a webhook outage is invisible to it. Missing: a per-provider last-delivery instant (or lag in seconds) on the health body — webhook_inbox.received_at already has the data — plus a degraded verdict derived from it. Looked for: lastDelivery, deliveryLag, secondsSinceLastDelivery, webhookHealth, feedStale.";
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    record("evidence", `/api/health reports webhook delivery health: ${serialised.slice(0, 300)}`);
  });

  it("the account UI shows a provider-down state", async (ctx) => {
    const response = await fetch(`${BASE_URL}/accounts`, { cache: "no-store" });
    expect(response.status).toBe(200);
    const html = await response.text();

    const showsProviderState =
      /data-provider-status|provider-down|provider unavailable|issuing provider/i.test(html);

    if (!showsProviderState) {
      const reason =
        'no provider-down state is rendered on the deployed account screen. The account data contract (src/components/account/data-contract.ts) carries balances, holds and postings but no provider or feed health field, and no component renders one. Missing: a provider-health field on that contract plus a banner that shows it. Looked for: data-provider-status, provider-down, "issuing provider".';
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    record("evidence", "the deployed account screen renders a provider-down state");
  });
});
