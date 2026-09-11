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
 *
 * ─── WHAT MIGRATION 0026 CHANGED ABOUT THIS TEST ────────────────────────────
 *
 * This attack used to pass while proving nothing. `deriveCardEvents` never read
 * `event.result`, so an authorisation the network DECLINED was ingested as an
 * ordinary `authorization`, raised A(E) by its full amount, and moved AVAILABLE
 * by exactly −5000 — which is the number this file asserts. The assertion went
 * green on a purchase that never happened.
 *
 * That is not hypothetical here. The sandbox account carries a $5,000 rolling
 * 24-hour spend limit and it is exhausted; live-fire attack 2's own
 * authorisation, Lithic transaction 041d610c-a71a-432e-ad62-ca16b6d882b0,
 * reads `AUTHORIZATION 5000 result DECLINED
 * detailed_results ["ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED"]` — and the ledger
 * placed the full $50.00 hold on it.
 *
 * So the test now READS THE PROVIDER'S VERDICT and asserts against that:
 *
 *   APPROVED  → the published attack, unchanged: available −5000, ledger flat.
 *   REFUSED   → the invariant 0026 installs: available and the hold book must
 *               not move AT ALL. Then the test FAILS, because the attack the
 *               debrief asks to see — available dropping on a fuel-pump auth —
 *               was not demonstrated. It is a red that names its own cause.
 *
 * A refusal is NOT skipped. A skip in this suite means "the pipeline did not
 * run, so the claim is unproven", and it is never counted as a pass; this is a
 * different thing — the pipeline ran perfectly and the demo could not be
 * performed. Converting that into a skip would be exactly the tuning this file
 * must not do, and the standing instruction is explicit: a red test telling the
 * truth beats a green one that is not.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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

    // ---- WHAT DID THE NETWORK ACTUALLY SAY? ------------------------------
    //
    // Asked of the provider, not of our own copy, because the whole class of
    // bug this guards against is our copy having dropped the answer. The
    // per-event verdict is the authoritative one; `txn.result` is the
    // transaction-level restatement and is used only if the event carries
    // none.
    const settledTxn = await lithic.getTransaction(transactionToken);
    const authEvent = (settledTxn.events ?? []).find((e) => e.type === "AUTHORIZATION");
    const verdict: string = authEvent?.result ?? settledTxn.result;
    const detail = (authEvent?.detailed_results ?? []).join(", ");

    if (verdict !== "APPROVED") {
      // ---- THE REFUSAL PATH ---------------------------------------------
      //
      // THE DIAGNOSIS IS RECORDED BEFORE ANYTHING IS ASSERTED. A failing
      // `expect` throws, and a throw skips every line after it — so an
      // assertion placed above the evidence leaves the operator reading a bare
      // "expected 30000n to be 25000n" with nothing to attach it to. That is
      // exactly what happened on the first run of this file. The panel is
      // being asked to watch a diagnosis, so the diagnosis has to survive the
      // failure it is diagnosing.
      const detailText = detail === "" ? "" : ` detailed_results [${detail}]`;
      const [refused] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM v_refused_auth_hold`;

      record(
        "evidence",
        `REFUSED BY THE NETWORK. Lithic transaction ${transactionToken}: AUTHORIZATION ` +
          `${AUTH_CENTS} result ${verdict}${detailText}. The ledger's answer, read live: holds ` +
          `${before.holdsCents} -> ${after.holdsCents} (must be UNCHANGED — a refused ` +
          `authorisation withholds nothing), available ${before.availableCents} -> ` +
          `${after.availableCents}, ledger ${before.ledgerCents} -> ${after.ledgerCents}, ` +
          `v_refused_auth_hold ${refused?.n}. Hold ${authRow.hold_id}. drain ${drainStatus}.` +
          (after.holdsCents === before.holdsCents
            ? ` The hold was correctly NOT placed.`
            : ` THE HOLD WAS PLACED ANYWAY: +${after.holdsCents - before.holdsCents} cents ` +
              `withheld from a business for a purchase the network refused. That is the bug ` +
              `migration 0026 fixes at ingest, and seeing it here means the code serving ` +
              `${BASE_URL} predates 0026 — the fix is in the repository and has not been ` +
              `deployed to the host that processed this delivery.`),
      );

      // The invariant migration 0026 installs: a refused authorisation must
      // move nothing. If these fail, money is being withheld for nothing.
      expect(after.holdsCents).toBe(before.holdsCents);
      expect(after.availableCents).toBe(before.availableCents);
      expect(after.ledgerCents).toBe(before.ledgerCents);
      expect(await bal.trialBalanceCents()).toBe(trialBefore);
      expect(refused?.n).toBe(0);

      const reason =
        `THE LEDGER IS RIGHT AND THE ATTACK IS UNDEMONSTRATED. Lithic REFUSED the $50.00 ` +
        `authorisation: transaction ${transactionToken}, AUTHORIZATION ${AUTH_CENTS} result ` +
        `${verdict}${detailText}. The ledger did exactly what it should — available stayed at ` +
        `${after.availableCents}, holds at ${after.holdsCents}, ledger at ${after.ledgerCents}, ` +
        `trial balance at ${trialBefore}, and v_refused_auth_hold is empty — but "AVAILABLE drops ` +
        `by 5000 on a fuel-pump auth" cannot be shown with an authorisation that never happened. ` +
        `CAUSE: the sandbox account's rolling 24-hour spend limit is exhausted — ` +
        `GET /v1/accounts/{token}/spend_limits reads available_spend_limit.daily = 0 against ` +
        `spend_limit.daily = 500000 with spend_velocity.daily = 760210. Raising it needs ` +
        `PATCH /v1/accounts/{token}, which the permission classifier deliberately blocks, so this ` +
        `red is a decision for a human and not something this test may tune away. ` +
        `Before migration 0026 this same refusal produced a PASS, because the decline was ingested ` +
        `as an approval and available really did drop by 5000. drain ${drainStatus}.`;
      record("evidence", reason);
      throw new Error(reason);
    }

    // ---- THE APPROVED PATH: the two assertions the attack is -------------
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
      `Lithic transaction ${transactionToken}: AUTHORIZATION ${AUTH_CENTS} result ${verdict} — the hold below stands on an authorisation the network actually granted, checked against the provider rather than against our own copy of it (migration 0026)`,
    );
    record(
      "evidence",
      `business ${businessId}: available ${before.availableCents} -> ${after.availableCents} (delta ${after.availableCents - before.availableCents}, expected -${AUTH_CENTS}); ledger ${before.ledgerCents} -> ${after.ledgerCents} (unchanged); card-auth holds +${after.holdsCents - before.holdsCents}; hold ${authRow.hold_id} origin ${authRow.origin} for Lithic transaction ${transactionToken}; drain ${drainStatus}; trial balance unchanged at ${trialBefore}`,
    );
  });
});
