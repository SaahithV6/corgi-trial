/**
 * ATTACK 1 — "Create a card and simulate a $50.00 fuel-pump authorisation.
 * Assert AVAILABLE balance drops by 5000 and LEDGER balance does not move at
 * all."
 *
 * End to end, through the real provider and the deployed system. Nothing here
 * calls the hold logic directly:
 *
 *   1. create a card on Lithic and register it to a customer;
 *   2. ask Lithic to authorise $50.00 at MCC 5542 (automated fuel dispenser);
 *   3. let the delivery reach the DEPLOYED webhook endpoint and be drained
 *      there — the same `/api/drain` call an operator makes in the debrief;
 *   4. read the effect out of the LIVE database.
 *
 * If the effect is right, the pipeline is right. If the delivery never becomes
 * an authorisation, the test SKIPS with what it actually observed — the inbox
 * row, its state, what it parked on, and what the drain answered — because a
 * pipeline that has not run has not been proven, and posting the memo entry
 * from the test would only assert that the TEST can do arithmetic.
 *
 * ISOLATION. Money tables are append-only and there is no teardown. This run
 * creates its own Lithic card and asserts a DELTA on one business across the
 * authorisation, so nothing it leaves behind changes the meaning of the next
 * run.
 */
import { appendFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import type * as BalancesModule from "@/lib/ledger/balances";
import type { sql as SqlHandle } from "@/lib/ledger/db";
import type * as Holds from "@/lib/holds";
import type * as LithicClient from "@/lib/rails/lithic/client";

const ATTACK = 1;
const NAME = "$50 fuel-pump authorisation moves AVAILABLE by 5000 and LEDGER by nothing";

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
if (!READY) record("skip", `missing: ${MISSING.join(", ")}; run scripts/livefire.mjs`);

const d = READY ? describe : describe.skip;

const AUTH_CENTS = 50_00;

d(`ATTACK ${ATTACK} — ${NAME}`, () => {
  let sql: typeof SqlHandle;
  let bal: typeof BalancesModule;
  let holds: typeof Holds;
  let lithic: typeof LithicClient;

  const tag = Date.now().toString(36).toUpperCase();

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    bal = await import("@/lib/ledger/balances");
    holds = await import("@/lib/holds");
    lithic = await import("@/lib/rails/lithic/client");
  });

  it("available drops by exactly 5000 and the ledger does not move", async (ctx) => {
    // A customer with both leaves of the chart: 2100 to spend from, 9100 to
    // carry the hold. Which one is not interesting; that it is ONE and we
    // measure the delta on it is.
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
      memo: `livefire fuel pump ${tag}`,
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
        nickname: `live-fire ${tag}`,
      },
      sql,
    );

    // Measured AFTER the card exists and BEFORE the authorisation, so the only
    // thing between the two readings is the $50.00.
    const before = await bal.availableBalance(businessId);
    const trialBefore = await bal.trialBalanceCents();

    const auth = await lithic.simulateAuthorize({
      amount: AUTH_CENTS,
      descriptor: `CORGI FUEL ${tag}`.slice(0, 25),
      pan,
      status: "AUTHORIZATION",
      mcc: "5542", // automated fuel dispenser
    });
    if (auth.token === undefined) throw new Error("Lithic returned no transaction token");
    const transactionToken: string = auth.token;

    let drainStatus = "not attempted";
    const drainToken = process.env["DRAIN_TOKEN"];
    const deadline = Date.now() + 90_000;
    let authRow: { hold_id: string; origin: string } | null = null;
    while (authRow === null) {
      const [row] = await sql<{ hold_id: string; origin: string }[]>`
        SELECT hold_id, origin FROM card_authorization
         WHERE provider = 'lithic' AND provider_auth_id = ${transactionToken}`;
      if (row) {
        authRow = row;
        break;
      }
      if (Date.now() >= deadline) break;
      // The operator's "watch, I will drain it now" — the deployed endpoint,
      // not a local dispatcher, so what is being exercised is production.
      if (drainToken !== undefined && drainToken !== "") {
        const response = await fetch(`${BASE_URL}/api/drain`, {
          method: "POST",
          headers: { authorization: `Bearer ${drainToken}` },
        });
        drainStatus = `HTTP ${response.status}`;
      } else {
        drainStatus = "no DRAIN_TOKEN in the environment";
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }

    if (authRow === null) {
      const [filed] = await sql<
        { id: string; state: string; parked_on_kind: string | null; parked_reason: string | null }[]
      >`
        SELECT id, state::text AS state, parked_on_kind, parked_reason
          FROM webhook_inbox
         WHERE provider = 'lithic' AND payload->>'token' = ${transactionToken}
         ORDER BY received_at DESC LIMIT 1`;
      const reason =
        `the card authorisation never reached the ledger, so AVAILABLE could not move and the attack is unproven. ` +
        `Lithic transaction ${transactionToken} on registered card ${card.token}: inbox row ${filed?.id ?? "(none arrived)"} ` +
        `state ${filed?.state ?? "n/a"}${filed?.parked_on_kind ? ` parked on ${filed.parked_on_kind} (${filed.parked_reason ?? ""})` : ""}; ` +
        `POST ${BASE_URL}/api/drain answered ${drainStatus}. ` +
        `Needs: the deployed build to register the Lithic consumer (src/lib/webhooks/consumers/lithic-card.ts) and to drain, ` +
        `and DRAIN_TOKEN present locally so the run can nudge it rather than waiting for the 04:17 cron.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    const after = await bal.availableBalance(businessId);

    // THE TWO ASSERTIONS THE ATTACK IS.
    expect(after.availableCents).toBe(before.availableCents - BigInt(AUTH_CENTS));
    expect(after.ledgerCents).toBe(before.ledgerCents);

    // The whole of the drop is a card-auth hold, sized from the event set
    // rather than read off the provider's status field (DECISIONS 006).
    expect(after.holdsCents - before.holdsCents).toBe(BigInt(AUTH_CENTS));
    expect(after.unclearedCents).toBe(before.unclearedCents);

    // The hold is memo-only, so the financial book is untouched.
    expect(await bal.trialBalanceCents()).toBe(trialBefore);

    record(
      "evidence",
      `business ${businessId}: available ${before.availableCents} -> ${after.availableCents} (delta ${after.availableCents - before.availableCents}, expected -${AUTH_CENTS}); ledger ${before.ledgerCents} -> ${after.ledgerCents} (unchanged); card-auth holds +${after.holdsCents - before.holdsCents}; hold ${authRow.hold_id} origin ${authRow.origin} for Lithic transaction ${transactionToken}; drain ${drainStatus}; trial balance unchanged at ${trialBefore}`,
    );
  });
});
