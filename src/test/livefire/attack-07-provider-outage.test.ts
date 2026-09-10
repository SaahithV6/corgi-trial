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
 * posts exactly once however many times it arrives.
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
 * ONE LIMIT, RECORDED ON THE SCOREBOARD RATHER THAN ASSERTED AWAY. A stale
 * Lithic feed is REPORTED by `webhookHealth` but does not ESCALATE: the
 * top-level `status` stays `ok`, because escalation is gated on the provider's
 * integration being probed live and `route.ts` derives that as EVERY Lithic
 * slot reading `live` — while `card_webhooks` is permanently `unprobed` and so
 * labelled `simulated` (DECISIONS 026). The test asserts the claim the attack
 * makes (the endpoint reports it) and records the escalation gap as evidence.
 */
import { createHmac, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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

  interface HealthDoc {
    readonly status?: string;
    readonly integrations?: { readonly webhookHealth?: WebhookHealth };
  }

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

      // Reported, but NOT escalated — and the scoreboard says which, because a
      // report a monitor watching `status` never sees is a weaker thing than
      // the attack's wording implies.
      if (lithic.degradesDeployment !== true) {
        record(
          "evidence",
          `LIMIT OF THIS PASS — the outage is REPORTED but does not ESCALATE: degradesDeployment=false, degradedBy=[${degradedBy.join(", ")}], top-level status="${String(current.doc.status)}" while lithic is stale. delivery-health.ts gates escalation on the provider's integration being probed live, and route.ts derives that as EVERY lithic slot reading 'live'; card_webhooks is permanently 'unprobed' -> 'simulated' (DECISIONS 026), so that clause can never be satisfied and no webhook outage can move the top-level status on this deployment. A reader of webhookHealth sees the outage; a monitor watching status alone does not.`,
        );
      } else {
        record(
          "evidence",
          `escalated: degradesDeployment=true, degradedBy=[${degradedBy.join(", ")}], top-level status="${String(current.doc.status)}".`,
        );
      }
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
    expect(html).toContain("Deposit accounts");

    record(
      "evidence",
      `the deployed console at ${BASE_URL}/accounts renders data-provider-status="provider-down" while lithic is stale: "Issuing provider feed is quiet — lithic", detail "${(minutes ?? seconds)?.[0] ?? ""}" against /api/health's ${publishedSeconds}s, and the deposit-account balances are still rendered underneath rather than blanked.`,
    );
  });
});
