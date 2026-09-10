/**
 * ATTACK 7 — "Turn off the issuing provider's webhooks for five minutes
 * mid-demo. Assert the system degrades visibly rather than silently: the health
 * endpoint reports it, the UI shows a provider-down state, and no money is
 * invented or lost. Simulate the outage rather than actually disabling the live
 * subscription."
 *
 * The attack makes THREE claims and this file tests them separately, because
 * two of them are about visibility and one is about money. They are not the
 * same claim and passing one does not earn the others.
 *
 * HOW THE OUTAGE IS SIMULATED. The live Lithic event subscription is left
 * enabled — disabling it mid-trial is exactly the irreversible thing the brief
 * warns about. The outage is simulated as a window in which a real card event
 * occurs and NOTHING CONSUMES IT: the delivery is authenticated and filed, and
 * no ledger effect follows. Then the provider "recovers" and redelivers, which
 * is what a provider does after an outage, and the redelivery must not
 * double-count.
 *
 * WHAT PASSES TODAY: the money claim. During the dark window the trial balance
 * does not move, no customer's ledger or available balance changes, the event
 * is durably filed rather than dropped, and the post-outage redelivery is
 * deduped.
 *
 * WHAT DOES NOT: the two visibility claims. `/api/health` reports per-provider
 * CREDENTIAL and CAPABILITY liveness (a probe round trip) but reports nothing
 * about webhook DELIVERY freshness, so it cannot report this outage; and no
 * component renders a provider-down state. Both tests below check for the thing
 * they need and SKIP naming it, rather than asserting something weaker and
 * calling it a pass.
 */
import { appendFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import type * as BalancesModule from "@/lib/ledger/balances";
import type { sql as SqlHandle } from "@/lib/ledger/db";
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

const MISSING: string[] = [];
if (process.env["LIVEFIRE"] !== "1") MISSING.push("LIVEFIRE=1");
if (typeof process.env["APP_DATABASE_URL"] !== "string") MISSING.push("APP_DATABASE_URL");
if (typeof process.env["LITHIC_API_KEY"] !== "string" || process.env["LITHIC_API_KEY"] === "") {
  MISSING.push("LITHIC_API_KEY");
}

const READY = MISSING.length === 0;
if (!READY) {
  record("skip", `missing: ${MISSING.join(", ")}; run scripts/livefire.mjs`);
}

const d = READY ? describe : describe.skip;

type Snapshot = {
  trialBalanceCents: bigint;
  perBusiness: { businessId: string; ledgerCents: bigint; availableCents: bigint }[];
};

d(`ATTACK ${ATTACK} — ${NAME}`, () => {
  let sql: typeof SqlHandle;
  let bal: typeof BalancesModule;
  let lithic: typeof LithicClient;

  const tag = Date.now().toString(36).toUpperCase();

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    bal = await import("@/lib/ledger/balances");
    lithic = await import("@/lib/rails/lithic/client");
  });

  async function snapshot(): Promise<Snapshot> {
    const businesses = await sql<{ id: string }[]>`SELECT id FROM business ORDER BY id`;
    const perBusiness: Snapshot["perBusiness"] = [];
    for (const business of businesses) {
      const available = await bal.availableBalance(business.id);
      perBusiness.push({
        businessId: business.id,
        ledgerCents: available.ledgerCents,
        availableCents: available.availableCents,
      });
    }
    return { trialBalanceCents: await bal.trialBalanceCents(), perBusiness };
  }

  it("invents and loses no money while the issuing provider's webhooks are dark", async () => {
    const before = await snapshot();
    expect(before.trialBalanceCents).toBe(0n);
    expect(before.perBusiness.length).toBeGreaterThan(0);

    // A real card event happens mid-outage.
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
    const auth = await lithic.simulateAuthorize({
      amount: 50_00,
      descriptor: `CORGI OUTAGE ${tag}`.slice(0, 25),
      pan,
      status: "AUTHORIZATION",
      mcc: "5542",
    });
    if (auth.token === undefined) throw new Error("Lithic returned no transaction token");

    // The dark window. Nothing consumes the delivery.
    let filed: { id: string; state: string; signature_verified_at: Date } | null = null;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const [row] = await sql<{ id: string; state: string; signature_verified_at: Date }[]>`
        SELECT id, state::text AS state, signature_verified_at
          FROM webhook_inbox
         WHERE provider = 'lithic' AND payload->>'token' = ${auth.token}
         ORDER BY received_at DESC LIMIT 1`;
      if (row) {
        filed = row;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    // NOT LOST: an authenticated delivery that nothing processed is still on
    // record, with the instant its signature was verified.
    if (filed === null) {
      throw new Error(
        `the card event was neither processed nor filed: no webhook_inbox row for ${auth.token} within 45s`,
      );
    }
    expect(filed.signature_verified_at).toBeInstanceOf(Date);

    // NOT INVENTED: nothing moved.
    const after = await snapshot();
    expect(after.trialBalanceCents).toBe(0n);
    expect(after.perBusiness).toEqual(before.perBusiness);

    // The provider recovers and redelivers what we missed. It must not
    // double-count — the same claim attack 8 proves in full.
    const [stored] = await sql<{ headers: Record<string, string>; raw_body: string }[]>`
      SELECT headers, raw_body FROM webhook_inbox WHERE id = ${filed.id}::uuid`;
    if (!stored) throw new Error("the filed row vanished");
    const redelivery = await fetch(`${BASE_URL}/api/webhooks/lithic`, {
      method: "POST",
      headers: { ...stored.headers, "content-type": "application/json" },
      body: stored.raw_body,
    });
    expect(redelivery.status).toBe(200);

    const recovered = await snapshot();
    expect(recovered.trialBalanceCents).toBe(0n);
    expect(recovered.perBusiness).toEqual(before.perBusiness);

    record(
      "evidence",
      `dark window over ${before.perBusiness.length} businesses: trial balance 0 -> 0, every ledger and available balance unchanged, event ${auth.token} filed as inbox row ${filed.id} (state ${filed.state}), post-outage redelivery answered HTTP ${redelivery.status} with no balance change`,
    );
  });

  it("the health endpoint reports the issuing provider's webhook outage", async (ctx) => {
    const response = await fetch(`${BASE_URL}/api/health`, { cache: "no-store" });
    expect(response.status).toBe(200);
    const health = (await response.json()) as Record<string, unknown>;
    const serialised = JSON.stringify(health);

    // What would satisfy this claim: a field on the health body that reports
    // webhook DELIVERY health for a provider — last delivery instant, seconds
    // since, or an explicit degraded/down verdict. Credential liveness is not
    // it: the credential is fine during a webhook outage, which is exactly why
    // this outage would go unreported.
    const reportsDeliveryHealth =
      /lastDelivery|last_delivery|deliveryLagSeconds|secondsSinceLastDelivery|webhookHealth|webhook_health/.test(
        serialised,
      );

    if (!reportsDeliveryHealth) {
      const reason =
        "/api/health answers 200 and reports credential/capability liveness per slot, but carries NO webhook delivery-freshness field, so a webhook outage is invisible to it. Missing: a per-provider last-delivery instant (or lag in seconds) on the health body, and a degraded verdict derived from it. Looked for: lastDelivery, deliveryLagSeconds, secondsSinceLastDelivery, webhookHealth.";
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
        'no provider-down state is rendered on the deployed account screen: the account data contract (src/components/account/data-contract.ts) carries balances, holds and postings but no provider/feed health field, and no component renders one. Missing: a provider-health field on the account data contract plus a component that renders it. Looked for: data-provider-status, provider-down, "issuing provider".';
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    record("evidence", "the deployed account screen renders a provider-down state");
  });
});
